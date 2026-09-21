/**
 * grammY composer for Telegram group-chat moderation.
 *
 * This composer owns the chats listed in `config.telegram_moderation_chat_ids`
 * and mirrors the feature set of the independent Discord module
 * (discord_moderation.js): anti-flood, Telegram invite/scam/link filtering, a
 * bad-word filter, a persistent warning system with auto-actions, a mod-log, and
 * a welcome message for new members. All pure rule logic lives in
 * services/chat_moderation.js; this file holds the Telegram I/O only.
 *
 * Important design points:
 *   * A composer-level chat filter scopes EVERY message handler here to the
 *     allowlisted chats, so non-moderated chats are never touched and ordinary
 *     group messages never reach the private-only submission flow in user.js.
 *   * Moderator commands gate on chat admins / creator (cached) OR the bot's
 *     configured ADMIN_USER_IDS.
 *   * Every enforcement call goes through a `safe*` wrapper that swallows
 *     Telegram errors (missing rights, target is an admin, 48h delete window, …),
 *     so a permission problem logs once and never crashes the polling loop.
 *   * Anonymous group admins (`sender_chat`) and channel/bot posts bypass the
 *     content filters, and the content handler never touches service messages.
 */

import { Composer } from "grammy";
import { performance } from "node:perf_hooks";

import { modLogActionKeyboard, unpackModLogActionCallback } from "../keyboards.js";
import {
  SPAM_MAX_MESSAGES,
  SPAM_MUTE_SECONDS,
  SPAM_WINDOW_SECONDS,
  SpamTracker,
  WARN_ESCALATION_THRESHOLD,
  WARN_MUTE_THRESHOLDS,
  clampMuteSeconds,
  hasBadWord,
  hasBlockedInvite,
  loadWelcomeRules,
  parseDuration,
  suspiciousReason,
} from "../services/chat_moderation.js";
import { t } from "../services/i18n.js";
import { getLogger } from "../services/logger.js";
import { DISABLED_LINK_PREVIEW } from "../services/publisher.js";
import {
  errorText,
  fromIsoFormat,
  hasIsoOffset,
  htmlEscape,
  sliceChars,
  sortedNumbers,
  splitWhitespace,
} from "../services/pyutils.js";
import {
  isTelegramApiError,
  isTelegramBadRequest,
  isTelegramForbidden,
  telegramErrorText,
} from "../services/telegram_errors.js";
import { fullName, messageHtmlText } from "../services/telegram_html.js";
import { DateTime } from "luxon";

const logger = getLogger("handlers.moderation");

// Anti-flood state (per process). Pruned internally so it does not grow unbounded.
const spamTracker = new SpamTracker();

// Cache of chat admin user IDs to avoid a getChatMember round-trip per message.
// chat_id -> [monotonic_expiry, Set<admin ids> | null]. null = the list could not
// be fetched (negative cache, so a flood doesn't hammer the failing call).
const adminCache = new Map();
const ADMIN_CACHE_TTL = 300.0;
const ADMIN_CACHE_FAILURE_TTL = 30.0;

// Warn-once-per-chat about missing bot rights, so logs are not spammed every msg.
const rightsWarned = new Set();
const notAdminWarned = new Set();

// Background auto-delete timers (welcome / transient notices). Kept referenced so
// they are not garbage-collected mid-flight; discarded on completion.
const backgroundTimers = new Set();

// How long a transient in-chat moderation notice stays before self-deleting.
const NOTICE_DELETE_SECONDS = 15;

// Light anti-abuse for /report: at most this many reports per user per window.
const REPORT_WINDOW_SECONDS = 60.0;
const REPORT_MAX_PER_WINDOW = 3;
const reportTimes = new Map();

// Full mute: every can_send_* flag explicitly false (Telegram does not guarantee a
// full mute from can_send_messages alone when the granular flags are omitted).
export const MUTED_PERMISSIONS = Object.freeze({
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
});

// Fallback used to unmute when the chat's default permissions cannot be read.
const UNMUTE_FALLBACK_PERMISSIONS = Object.freeze({
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_invite_users: true,
});

const NUMERIC_ID_RE = /^-?\d+$/;

export function buildModerationComposer({ config, db, bot }) {
  const root = new Composer();

  // Scope every message/edited_message handler to the moderated chats, so the
  // composer never inspects DMs/admin chat and ordinary group messages never fall
  // through to the submission flow.
  const moderated = root.filter((ctx) => {
    const update = ctx.message ?? ctx.editedMessage;
    return Boolean(update) && config.telegram_moderation_chat_ids.has(ctx.chat?.id);
  });

  // ------------------------------------------------------------------------- //
  // Welcome
  // ------------------------------------------------------------------------- //

  moderated.on("message:new_chat_members", async (ctx) => {
    try {
      const me = bot.botInfo ?? (await bot.api.getMe());
      for (const member of ctx.message.new_chat_members ?? []) {
        if (member.is_bot || member.id === me.id) {
          continue;
        }
        await sendWelcome(bot, config, ctx.chat.id, member);
      }
    } catch (error) {
      // Never let a welcome error reach the polling loop.
      logger.exception("Error while sending a Telegram welcome message.", error);
    }
    // Keep the chat clean: drop the "X joined" service message.
    await safeDelete(bot, ctx.chat.id, ctx.message.message_id);
  });

  moderated.on("message:left_chat_member", async (ctx) => {
    // Keep the chat clean: drop the "X left" service message.
    await safeDelete(bot, ctx.chat.id, ctx.message.message_id);
  });

  // ------------------------------------------------------------------------- //
  // Moderator commands (gated inside each handler so non-mods get a clear reply)
  // ------------------------------------------------------------------------- //

  moderated.command("modhelp", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) {
      return; // command-shaped spam: filtered exactly like any other message
    }
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }

    const warnRules = sortedNumbers([...WARN_MUTE_THRESHOLDS.keys()])
      .map((count) => `${count} → ${humanizeDuration(WARN_MUTE_THRESHOLDS.get(count))}`)
      .join(", ");
    const body = t("moderation.help.body", {
      spam_max: SPAM_MAX_MESSAGES,
      spam_window: Math.trunc(SPAM_WINDOW_SECONDS),
      warn_rules: warnRules,
      escalation: WARN_ESCALATION_THRESHOLD,
    });
    await reply(ctx, `${t("moderation.help.title")}\n\n${body}`, { html: true });
  });

  moderated.command("del", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }
    const targetMessage = ctx.message.reply_to_message;
    if (!targetMessage) {
      await reply(ctx, t("moderation.cmd.reply_required"));
      return;
    }

    await safeDelete(bot, ctx.chat.id, targetMessage.message_id);
    await safeDelete(bot, ctx.chat.id, ctx.message.message_id);
    await sendModLog(bot, config, {
      action: t("moderation.action.del"),
      targetHtml: targetMessage.from ? userHtml(targetMessage.from) : "—",
      moderatorHtml: actorHtml(ctx.message),
      reason: t("moderation.reason.none"),
      preview: targetMessage.text || targetMessage.caption,
    });
  });

  moderated.command("mute", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }

    const [targetId, targetHtml, rest] = resolveTarget(ctx.message, ctx.match);
    if (targetId === null) {
      await reply(ctx, t("moderation.cmd.target_required"));
      return;
    }
    if (await isAdminId(bot, config, ctx.chat.id, targetId)) {
      await reply(ctx, t("moderation.cmd.cannot_target_moderator"));
      return;
    }

    let [seconds, reasonText] = splitDurationAndReason(rest);
    if (seconds === null) {
      seconds = 60 * 60; // default mute: 60 minutes
    }
    const reason = reasonText || t("moderation.reason.none");

    if (!(await safeMute(bot, ctx.chat.id, targetId, seconds, reason))) {
      await reply(ctx, t("moderation.cmd.action_failed"));
      return;
    }

    if (seconds <= 0) {
      await reply(ctx, t("moderation.cmd.muted_permanent", { target: targetHtml, reason: htmlEscape(reason) }), {
        html: true,
      });
    } else {
      await reply(
        ctx,
        t("moderation.cmd.muted", {
          target: targetHtml,
          duration: humanizeDuration(seconds),
          reason: htmlEscape(reason),
        }),
        { html: true },
      );
    }
    await sendModLog(bot, config, {
      action: `${t("moderation.action.mute")} — ${humanizeDuration(seconds)}`,
      targetHtml,
      moderatorHtml: actorHtml(ctx.message),
      reason,
    });
  });

  moderated.command("unmute", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }

    const [targetId, targetHtml] = resolveTarget(ctx.message, ctx.match);
    if (targetId === null) {
      await reply(ctx, t("moderation.cmd.target_required"));
      return;
    }

    if (!(await safeUnmute(bot, ctx.chat.id, targetId))) {
      await reply(ctx, t("moderation.cmd.action_failed"));
      return;
    }

    await reply(ctx, t("moderation.cmd.unmuted", { target: targetHtml }), { html: true });
    await sendModLog(bot, config, {
      action: t("moderation.action.unmute"),
      targetHtml,
      moderatorHtml: actorHtml(ctx.message),
      reason: t("moderation.reason.none"),
    });
  });

  moderated.command("ban", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }

    const [targetId, targetHtml, rest] = resolveTarget(ctx.message, ctx.match);
    if (targetId === null) {
      await reply(ctx, t("moderation.cmd.target_required"));
      return;
    }
    if (await isAdminId(bot, config, ctx.chat.id, targetId)) {
      await reply(ctx, t("moderation.cmd.cannot_target_moderator"));
      return;
    }

    let [seconds, reasonText] = splitDurationAndReason(rest);
    if (seconds === null) {
      seconds = 0; // default ban: permanent
    }
    const reason = reasonText || t("moderation.reason.none");

    if (!(await safeBan(bot, ctx.chat.id, targetId, seconds))) {
      await reply(ctx, t("moderation.cmd.action_failed"));
      return;
    }

    const confirmation =
      seconds > 0
        ? t("moderation.cmd.banned_temp", {
            target: targetHtml,
            duration: humanizeDuration(seconds),
            reason: htmlEscape(reason),
          })
        : t("moderation.cmd.banned", { target: targetHtml, reason: htmlEscape(reason) });
    await reply(ctx, confirmation, { html: true });
    await sendModLog(bot, config, {
      action: `${t("moderation.action.ban")} — ${humanizeDuration(seconds)}`,
      targetHtml,
      moderatorHtml: actorHtml(ctx.message),
      reason,
    });
  });

  moderated.command("unban", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }

    const [targetId, targetHtml] = resolveTarget(ctx.message, ctx.match);
    if (targetId === null) {
      await reply(ctx, t("moderation.cmd.target_required"));
      return;
    }

    if (!(await safeUnban(bot, ctx.chat.id, targetId))) {
      await reply(ctx, t("moderation.cmd.action_failed"));
      return;
    }

    await reply(ctx, t("moderation.cmd.unbanned", { target: targetHtml }), { html: true });
    await sendModLog(bot, config, {
      action: t("moderation.action.unban"),
      targetHtml,
      moderatorHtml: actorHtml(ctx.message),
      reason: t("moderation.reason.none"),
    });
  });

  moderated.command("kick", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }

    const [targetId, targetHtml] = resolveTarget(ctx.message, ctx.match);
    if (targetId === null) {
      await reply(ctx, t("moderation.cmd.target_required"));
      return;
    }
    if (await isAdminId(bot, config, ctx.chat.id, targetId)) {
      await reply(ctx, t("moderation.cmd.cannot_target_moderator"));
      return;
    }

    const kickResult = await safeKick(bot, ctx.chat.id, targetId);
    if (kickResult === "failed") {
      await reply(ctx, t("moderation.cmd.action_failed"));
      return;
    }
    if (kickResult === "partial") {
      // The unban step failed: the member is still banned and needs a manual /unban.
      await reply(ctx, t("moderation.cmd.kick_partial", { target: targetHtml }), { html: true });
      await sendModLog(bot, config, {
        action: t("moderation.action.kick"),
        targetHtml,
        moderatorHtml: actorHtml(ctx.message),
        reason: t("moderation.cmd.kick_partial_reason"),
      });
      return;
    }

    const reason = t("moderation.reason.none");
    await reply(ctx, t("moderation.cmd.kicked", { target: targetHtml, reason }), { html: true });
    await sendModLog(bot, config, {
      action: t("moderation.action.kick"),
      targetHtml,
      moderatorHtml: actorHtml(ctx.message),
      reason,
    });
  });

  moderated.command("warn", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }

    const [targetId, targetHtml, rest] = resolveTarget(ctx.message, ctx.match);
    if (targetId === null) {
      await reply(ctx, t("moderation.cmd.target_required"));
      return;
    }
    if (await isAdminId(bot, config, ctx.chat.id, targetId)) {
      await reply(ctx, t("moderation.cmd.cannot_target_moderator"));
      return;
    }

    const reasonText = rest.join(" ").trim() || t("moderation.reason.none");
    const moderatorId = ctx.message.from ? ctx.message.from.id : 0;

    let count;
    try {
      count = await db.addTelegramWarning({
        chat_id: ctx.chat.id,
        user_id: targetId,
        moderator_id: moderatorId,
        reason: reasonText,
      });
    } catch (error) {
      // A history failure must not break the command.
      logger.exception("Failed to persist a Telegram warning.", error);
      await reply(ctx, t("moderation.cmd.action_failed"));
      return;
    }

    await reply(ctx, t("moderation.cmd.warned", { target: targetHtml, count, reason: htmlEscape(reasonText) }), {
      html: true,
    });
    await sendModLog(bot, config, {
      action: t("moderation.action.warn"),
      targetHtml,
      moderatorHtml: actorHtml(ctx.message),
      reason: reasonText,
    });

    // Best-effort DM to the warned member (works only if they started the bot).
    try {
      await bot.api.sendMessage(
        targetId,
        t("moderation.cmd.warn_dm", { chat: ctx.chat.title || "", reason: reasonText }),
      );
    } catch (error) {
      if (!isTelegramApiError(error)) throw error;
    }

    await applyWarningAutoactions(bot, config, ctx.chat.id, targetId, targetHtml, count);
  });

  moderated.command("warnings", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }

    const [targetId, targetHtml] = resolveTarget(ctx.message, ctx.match);
    if (targetId === null) {
      await reply(ctx, t("moderation.cmd.target_required"));
      return;
    }

    let records;
    try {
      records = await db.listTelegramWarnings({ chat_id: ctx.chat.id, user_id: targetId });
    } catch (error) {
      logger.exception("Failed to read Telegram warnings.", error);
      await reply(ctx, t("moderation.cmd.action_failed"));
      return;
    }

    if (!records.length) {
      await reply(ctx, t("moderation.cmd.warnings_empty", { target: targetHtml }), { html: true });
      return;
    }

    const lines = [t("moderation.cmd.warnings_header", { target: targetHtml, count: records.length })];
    const recent = records.slice(-20);
    const startIndex = records.length - recent.length + 1;
    recent.forEach((record, offset) => {
      lines.push(
        t("moderation.cmd.warnings_line", {
          index: startIndex + offset,
          when: formatWhen(String(record.created_at ?? "")),
          moderator: userHtmlFromId(Number(record.moderator_id ?? 0)),
          reason: htmlEscape(String(record.reason ?? "")),
        }),
      );
    });
    if (records.length > recent.length) {
      lines.push(t("moderation.cmd.warnings_more", { shown: recent.length, total: records.length }));
    }

    await reply(ctx, lines.join("\n"), { html: true });
  });

  moderated.command("clearwarnings", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;
    if (!(await isModerator(bot, config, ctx.message))) {
      await transientReply(ctx, bot, t("moderation.cmd.no_permission"));
      return;
    }

    const [targetId, targetHtml] = resolveTarget(ctx.message, ctx.match);
    if (targetId === null) {
      await reply(ctx, t("moderation.cmd.target_required"));
      return;
    }

    let removed;
    try {
      removed = await db.clearTelegramWarnings({ chat_id: ctx.chat.id, user_id: targetId });
    } catch (error) {
      logger.exception("Failed to clear Telegram warnings.", error);
      await reply(ctx, t("moderation.cmd.action_failed"));
      return;
    }

    await reply(ctx, t("moderation.cmd.warnings_cleared", { target: targetHtml, count: removed }), { html: true });
    await sendModLog(bot, config, {
      action: t("moderation.action.clearwarnings"),
      targetHtml,
      moderatorHtml: actorHtml(ctx.message),
      reason: t("moderation.reason.none"),
    });
  });

  // ------------------------------------------------------------------------- //
  // Member commands (available to EVERYONE in the moderated chat)
  // ------------------------------------------------------------------------- //

  /**
   * Let ANY member report a message to the moderators (mirrors Discord /report).
   *
   * Used as a reply to the offending message; the report goes to the mod-log chat.
   * The /report message and the confirmation are removed shortly after, so the
   * chat stays clean and reporting causes no public drama.
   */
  moderated.command("report", async (ctx) => {
    const reporter = ctx.message.from;
    if (!reporter || ctx.message.sender_chat) {
      return;
    }
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;

    const targetMessage = ctx.message.reply_to_message;
    if (!targetMessage || !targetMessage.from) {
      await transientReply(ctx, bot, t("moderation.report.reply_required"));
      return;
    }

    const reported = targetMessage.from;
    if (reported.id === reporter.id) {
      await transientReply(ctx, bot, t("moderation.report.self"));
      return;
    }
    if (reported.is_bot) {
      await transientReply(ctx, bot, t("moderation.report.bot"));
      return;
    }
    if (!reportAllowed(reporter.id)) {
      await transientReply(ctx, bot, t("moderation.report.too_many"));
      return;
    }

    const reason = String(ctx.match ?? "").trim() || t("moderation.reason.none");
    await sendReportLog(bot, config, {
      reporterHtml: userHtml(reporter),
      reportedHtml: userHtml(reported),
      reason,
      link: messageLink(ctx.chat.id, targetMessage.message_id),
      preview: targetMessage.text || targetMessage.caption,
      targetChatId: ctx.chat.id,
      reportedId: reported.id,
      reportedMessageId: targetMessage.message_id,
    });

    await safeDelete(bot, ctx.chat.id, ctx.message.message_id);
    await sendNotice(bot, ctx.chat.id, t("moderation.report.sent", { mention: userHtml(reporter) }));
  });

  /** Show the chat rules to ANY member. The reply auto-deletes to avoid clutter. */
  moderated.command("rules", async (ctx) => {
    if (await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true })) return;

    const rules = loadWelcomeRules();
    if (!rules.length) {
      await transientReply(ctx, bot, t("moderation.rules.empty"));
      return;
    }

    const lines = [t("moderation.rules.header")];
    rules.forEach((rule, index) => lines.push(`${index + 1}. ${htmlEscape(rule)}`));
    let sent;
    try {
      sent = await bot.api.sendMessage(ctx.chat.id, lines.join("\n"), {
        parse_mode: "HTML",
        link_preview_options: DISABLED_LINK_PREVIEW,
      });
    } catch (error) {
      if (!isTelegramApiError(error)) throw error;
      logger.info(`Could not send rules in chat ${ctx.chat.id}`);
      return;
    }

    const delay = config.telegram_welcome_delete_seconds;
    if (delay > 0) {
      scheduleDelete(bot, ctx.chat.id, sent.message_id, delay);
      scheduleDelete(bot, ctx.chat.id, ctx.message.message_id, delay);
    }
  });

  // ------------------------------------------------------------------------- //
  // Content moderation (registered AFTER commands so commands win)
  // ------------------------------------------------------------------------- //

  moderated.on(["message:text", "message:caption"], async (ctx) => {
    await enforce(ctx, bot, config, { runTextFilters: true, countFlood: true });
  });

  moderated.on(
    [
      "message:sticker",
      "message:photo",
      "message:video",
      "message:animation",
      "message:voice",
      "message:video_note",
      "message:document",
      "message:audio",
      "message:poll",
      "message:dice",
      "message:game",
    ],
    async (ctx) => {
      // Captionless media: nothing to text-filter, but still counts toward anti-flood.
      await enforce(ctx, bot, config, { runTextFilters: false, countFlood: true });
    },
  );

  moderated.on(["edited_message:text", "edited_message:caption"], async (ctx) => {
    // Anti-evasion: a benign message edited to add a scam link is re-checked.
    // Edits do NOT count toward anti-flood (an edit is not a new send).
    await enforce(ctx, bot, config, { runTextFilters: true, countFlood: false });
  });

  // ------------------------------------------------------------------------- //
  // Mod-log inline action buttons (Delete / Mute / Ban under report & filter logs)
  //
  // Registered on the UNSCOPED composer: the buttons live in the mod-log chat,
  // which is not itself a moderated chat.
  // ------------------------------------------------------------------------- //

  root.on("callback_query:data", async (ctx, next) => {
    const callbackData = unpackModLogActionCallback(ctx.callbackQuery.data);
    if (callbackData === null) return next();
    await modLogActionCallback(ctx, callbackData, bot, config);
  });

  return root;
}

// Fixed duration for the one-tap mute button; the /mute command covers custom ones.
const MODLOG_MUTE_SECONDS = 60 * 60;

const MODLOG_ACTION_BUTTON_KEYS = {
  del: "buttons.modlog_delete",
  mute: "buttons.modlog_mute",
  ban: "buttons.modlog_ban",
};

/**
 * One-tap moderator actions on a mod-log entry.
 *
 * The clicker must moderate the TARGET chat (config admin or a chat admin
 * there) — membership in the mod-log chat alone is not enough.
 */
async function modLogActionCallback(ctx, callbackData, bot, config) {
  const actor = ctx.callbackQuery.from;
  if (!actor || !(await isAdminId(bot, config, callbackData.chat_id, actor.id))) {
    await answerCallback(ctx, t("moderation.modlog.not_allowed"), { showAlert: true });
    return;
  }

  const action = callbackData.action;
  let ok;
  let toast;
  if (action === "del") {
    ok = await safeDelete(bot, callbackData.chat_id, callbackData.message_id);
    toast = ok ? t("moderation.cmd.deleted") : t("moderation.modlog.delete_failed");
  } else if (action === "mute") {
    ok = await safeMute(
      bot,
      callbackData.chat_id,
      callbackData.user_id,
      MODLOG_MUTE_SECONDS,
      t("moderation.reason.none"),
    );
    toast = ok
      ? t("moderation.modlog.muted", { duration: humanizeDuration(MODLOG_MUTE_SECONDS) })
      : t("moderation.modlog.mute_failed");
  } else if (action === "ban") {
    ok = await safeBan(bot, callbackData.chat_id, callbackData.user_id, 0);
    toast = ok ? t("moderation.modlog.banned") : t("moderation.modlog.ban_failed");
  } else {
    await answerCallback(ctx, t("moderation.modlog.unknown_action"), { showAlert: true });
    return;
  }

  await answerCallback(ctx, toast, { showAlert: !ok });
  await appendModlogNote(ctx, bot, action, ok);
}

/** Record who did what right inside the log entry; keep the buttons usable. */
async function appendModlogNote(ctx, bot, action, ok) {
  const message = ctx.callbackQuery.message;
  if (!message || !ctx.callbackQuery.from) {
    return;
  }
  const note = t("moderation.modlog.done_line", {
    action: t(MODLOG_ACTION_BUTTON_KEYS[action]),
    result: ok ? "✅" : "❌",
    moderator: userHtml(ctx.callbackQuery.from),
  });
  try {
    await bot.api.editMessageText(message.chat.id, message.message_id, `${messageHtmlText(message)}\n${note}`, {
      parse_mode: "HTML",
      reply_markup: message.reply_markup,
      link_preview_options: DISABLED_LINK_PREVIEW,
    });
  } catch (error) {
    if (isTelegramBadRequest(error)) {
      if (!telegramErrorText(error).toLowerCase().includes("message is not modified")) {
        logger.info(`Could not update mod-log entry ${message.message_id}: ${telegramErrorText(error)}`);
      }
      return;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Could not update mod-log entry ${message.message_id}`);
  }
}

async function answerCallback(ctx, text = undefined, { showAlert = false } = {}) {
  try {
    await ctx.answerCallbackQuery({ text, show_alert: showAlert });
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Failed to answer mod-log callback ${ctx.callbackQuery.id}`);
  }
}

async function sendWelcome(bot, config, chatId, member) {
  const rules = loadWelcomeRules();
  const lines = [t("moderation.welcome.title"), "", t("moderation.welcome.greeting", { mention: userHtml(member) })];
  if (rules.length) {
    lines.push("");
    lines.push(t("moderation.welcome.rules_header"));
    rules.forEach((rule, index) => lines.push(`${index + 1}. ${htmlEscape(rule)}`));
  }

  let sent;
  try {
    sent = await bot.api.sendMessage(chatId, lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: DISABLED_LINK_PREVIEW,
    });
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Could not send welcome message in chat ${chatId}`);
    return;
  }

  if (config.telegram_welcome_delete_seconds > 0) {
    scheduleDelete(bot, chatId, sent.message_id, config.telegram_welcome_delete_seconds);
  }
}

/** Run the content filters / flood counter. Returns true when the message was punished. */
async function enforce(ctx, bot, config, { runTextFilters, countFlood }) {
  const message = ctx.message ?? ctx.editedMessage;
  try {
    // Skip non-user senders: channel posts, linked-channel forwards, and
    // anonymous group admins (sender_chat) — they cannot/should not be punished.
    const user = message.from;
    if (!user || message.sender_chat || user.is_bot) {
      return false;
    }
    // Moderators bypass the content filters. default=true fails OPEN: when the
    // admin list is temporarily unknown (API error on a cold cache) we must
    // not punish someone who may well be an admin.
    if (await isAdminId(bot, config, message.chat.id, user.id, { fallback: true })) {
      return false;
    }

    let content = message.text || message.caption || "";
    // Hyperlinked text hides its URL outside message.text — scan text_link
    // entities too, or "натисни тут" pointing at t.me/scam passes every filter.
    const embeddedUrls = embeddedLinkUrls(message);
    if (embeddedUrls.length) {
      content = content ? [content, ...embeddedUrls].join("\n") : embeddedUrls.join("\n");
    }

    if (runTextFilters && content) {
      if (hasBlockedInvite(content, config.telegram_link_allowlist)) {
        await punish(message, bot, config, {
          actionKey: "invite_removed",
          reason: t("moderation.reason.invite"),
          muteSeconds: 0,
        });
        return true;
      }
      if (suspiciousReason(content)) {
        await punish(message, bot, config, {
          actionKey: "scam_removed",
          reason: t("moderation.reason.scam"),
          muteSeconds: 0,
        });
        return true;
      }
      if (hasBadWord(content)) {
        await punish(message, bot, config, {
          actionKey: "badword_removed",
          reason: t("moderation.reason.badword"),
          muteSeconds: 0,
        });
        return true;
      }
    }

    if (countFlood && spamTracker.registerAndCheck(message.chat.id, user.id)) {
      const floodReason = t("moderation.reason.flood", {
        count: SPAM_MAX_MESSAGES,
        seconds: Math.trunc(SPAM_WINDOW_SECONDS),
      });
      await punish(message, bot, config, {
        actionKey: "flood",
        reason: floodReason,
        muteSeconds: SPAM_MUTE_SECONDS,
        notice: true,
      });
      return true;
    }
  } catch (error) {
    // Moderation must never crash the polling loop.
    logger.exception(`Error while moderating a Telegram message in chat ${message?.chat?.id}`, error);
  }
  return false;
}

/** URLs hidden behind text_link entities (the visible text shows no URL). */
function embeddedLinkUrls(message) {
  const urls = [];
  for (const entity of [...(message.entities ?? []), ...(message.caption_entities ?? [])]) {
    if (entity.type === "text_link" && entity.url) {
      urls.push(entity.url);
    }
  }
  return urls;
}

async function punish(message, bot, config, { actionKey, reason, muteSeconds, notice = false }) {
  const user = message.from;
  const deleted = await safeDelete(bot, message.chat.id, message.message_id);

  if (muteSeconds > 0 && user) {
    await safeMute(bot, message.chat.id, user.id, muteSeconds, reason);
    if (notice) {
      await sendNotice(
        bot,
        message.chat.id,
        t("moderation.notice.flood", { mention: userHtml(user), duration: humanizeDuration(muteSeconds) }),
      );
    }
  }

  const action = t(`moderation.action.${actionKey}`);
  // Quick moderator actions right under the log entry; the delete button is
  // offered only when the offending message could not be removed.
  let keyboard = null;
  if (user) {
    keyboard = modLogActionKeyboard(message.chat.id, user.id, deleted ? 0 : message.message_id);
  }
  await sendModLog(bot, config, {
    action: deleted ? action : `${action} (видалити не вдалося)`,
    targetHtml: user ? userHtml(user) : "—",
    moderatorHtml: t("moderation.log.moderator_auto"),
    reason,
    preview: message.text || message.caption,
    replyMarkup: keyboard ?? undefined,
  });
}

/** Mute on warning thresholds; escalate at the top one. Never bans/kicks. */
async function applyWarningAutoactions(bot, config, chatId, userId, targetHtml, count) {
  const seconds = WARN_MUTE_THRESHOLDS.get(count);
  if (seconds) {
    const reason = t("moderation.reason.auto_warn", { count });
    const ok = await safeMute(bot, chatId, userId, seconds, reason);
    await sendModLog(bot, config, {
      action: t("moderation.action.auto_mute"),
      targetHtml,
      moderatorHtml: t("moderation.log.moderator_auto"),
      reason: ok
        ? t("moderation.auto.muted", { count, duration: humanizeDuration(seconds) })
        : t("moderation.auto.muted_failed", { count, duration: humanizeDuration(seconds) }),
    });
  }

  if (count === WARN_ESCALATION_THRESHOLD) {
    await sendModLog(bot, config, {
      action: t("moderation.action.review"),
      targetHtml,
      moderatorHtml: t("moderation.log.moderator_auto"),
      // No {target} here: the reason field is html-escaped by sendModLog, so an
      // embedded mention would render as raw markup. The log entry already shows
      // the clickable mention on its own line.
      reason: t("moderation.auto.review", { count }),
    });
  }
}

// --------------------------------------------------------------------------- //
// Permission helpers
// --------------------------------------------------------------------------- //

/** True if the command issuer may moderate this chat. */
async function isModerator(bot, config, message) {
  // Anonymous group admins post as the chat itself.
  if (message.sender_chat && message.sender_chat.id === message.chat.id) {
    return true;
  }
  const user = message.from;
  if (!user) {
    return false;
  }
  return isAdminId(bot, config, message.chat.id, user.id);
}

/**
 * True if the user moderates the chat. `fallback` applies while the admin list is
 * unknown (API failure): filters pass true (fail open — never punish a possible
 * admin), command gates keep false (fail closed).
 */
async function isAdminId(bot, config, chatId, userId, { fallback = false } = {}) {
  if (config.admin_user_ids.has(userId)) {
    return true;
  }
  const adminIds = await getChatAdminIds(bot, chatId);
  if (adminIds === null) {
    return fallback;
  }
  return adminIds.has(userId);
}

/** Cached admin ids for a chat, or null while the list cannot be fetched. */
async function getChatAdminIds(bot, chatId) {
  const now = performance.now() / 1000;
  const cached = adminCache.get(chatId);
  if (cached !== undefined && now < cached[0]) {
    return cached[1];
  }

  let admins;
  try {
    admins = await bot.api.getChatAdministrators(chatId);
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    if (cached !== undefined && cached[1] !== null) {
      return cached[1]; // a stale admin list beats no list at all
    }
    adminCache.set(chatId, [now + ADMIN_CACHE_FAILURE_TTL, null]);
    return null;
  }

  const ids = new Set(admins.filter((member) => member.user).map((member) => member.user.id));
  adminCache.set(chatId, [now + ADMIN_CACHE_TTL, ids]);

  // Loud one-time warning if the bot itself is not an admin here: without admin
  // rights, group privacy hides messages and the filters silently do nothing.
  try {
    const me = bot.botInfo ?? (await bot.api.getMe());
    if (!ids.has(me.id) && !notAdminWarned.has(chatId)) {
      logger.warning(
        `Bot is not an administrator in moderated chat ${chatId}; filters and ` +
          "commands will not work until it is promoted (Delete + Restrict/Ban).",
      );
      notAdminWarned.add(chatId);
    }
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
  }

  return ids;
}

// --------------------------------------------------------------------------- //
// Safe Telegram enforcement wrappers (mirror discord_moderation's safe* helpers)
// --------------------------------------------------------------------------- //

async function safeDelete(bot, chatId, messageId) {
  try {
    await bot.api.deleteMessage(chatId, messageId);
    return true;
  } catch (error) {
    if (isTelegramBadRequest(error)) {
      if (telegramErrorText(error).toLowerCase().includes("not found")) {
        return true; // already gone
      }
      logger.info(`Could not delete message ${messageId} in chat ${chatId}: ${telegramErrorText(error)}`);
      return false;
    }
    if (isTelegramForbidden(error)) {
      warnRightsOnce(chatId, "cannot delete messages");
      return false;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Could not delete message ${messageId} in chat ${chatId}`);
    return false;
  }
}

// BadRequest texts that genuinely mean the BOT lacks an admin right. Other
// BadRequests (target is an admin, bogus user id, ...) must NOT poison the
// warn-once flag, or the real missing-rights diagnostic is silenced forever.
const RIGHTS_ERROR_MARKERS = ["not enough rights", "need administrator rights", "chat_admin_required"];

function handleEnforcementError(error, chatId, what, detail) {
  if (isTelegramForbidden(error)) {
    warnRightsOnce(chatId, `${what} (Forbidden)`);
    return;
  }
  const messageText = telegramErrorText(error).toLowerCase();
  if (RIGHTS_ERROR_MARKERS.some((marker) => messageText.includes(marker))) {
    warnRightsOnce(chatId, `${what} (missing admin right)`);
    return;
  }
  logger.info(`${detail} in chat ${chatId}: ${errorText(error)}`);
}

function untilDateFor(seconds) {
  if (!seconds || seconds <= 0) {
    return undefined;
  }
  return Math.floor(Date.now() / 1000) + clampMuteSeconds(seconds);
}

async function safeMute(bot, chatId, userId, seconds, reason) {
  try {
    await bot.api.restrictChatMember(chatId, userId, MUTED_PERMISSIONS, { until_date: untilDateFor(seconds) });
    return true;
  } catch (error) {
    if (isTelegramBadRequest(error) || isTelegramForbidden(error)) {
      handleEnforcementError(error, chatId, "cannot restrict members", `Could not mute user ${userId}`);
      return false;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to mute user ${userId} in chat ${chatId}`, error);
    return false;
  }
}

async function safeUnmute(bot, chatId, userId) {
  let permissions = UNMUTE_FALLBACK_PERMISSIONS;
  try {
    const chat = await bot.api.getChat(chatId);
    if (chat.permissions) {
      permissions = chat.permissions;
    }
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
  }
  try {
    await bot.api.restrictChatMember(chatId, userId, permissions);
    return true;
  } catch (error) {
    if (isTelegramBadRequest(error) || isTelegramForbidden(error)) {
      handleEnforcementError(error, chatId, "cannot restrict members", `Could not unmute user ${userId}`);
      return false;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to unmute user ${userId} in chat ${chatId}`, error);
    return false;
  }
}

async function safeBan(bot, chatId, userId, seconds) {
  try {
    await bot.api.banChatMember(chatId, userId, {
      until_date: untilDateFor(seconds),
      revoke_messages: false,
    });
    return true;
  } catch (error) {
    if (isTelegramBadRequest(error) || isTelegramForbidden(error)) {
      handleEnforcementError(error, chatId, "cannot ban members", `Could not ban user ${userId}`);
      return false;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to ban user ${userId} in chat ${chatId}`, error);
    return false;
  }
}

async function safeUnban(bot, chatId, userId) {
  try {
    await bot.api.unbanChatMember(chatId, userId, { only_if_banned: true });
    return true;
  } catch (error) {
    if (isTelegramBadRequest(error) || isTelegramForbidden(error)) {
      handleEnforcementError(error, chatId, "cannot unban members", `Could not unban user ${userId}`);
      return false;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to unban user ${userId} in chat ${chatId}`, error);
    return false;
  }
}

/**
 * Remove a member without a lasting ban. Returns "ok", "partial", or "failed".
 *
 * "partial" means the ban succeeded but the unban step kept failing even after a
 * retry: the member is left BANNED and a moderator must run /unban to finish the
 * kick. Reporting that distinctly matters — a plain "failed" would suggest
 * nothing happened at all.
 */
async function safeKick(bot, chatId, userId) {
  try {
    await bot.api.banChatMember(chatId, userId, { revoke_messages: false });
  } catch (error) {
    if (isTelegramBadRequest(error) || isTelegramForbidden(error)) {
      handleEnforcementError(error, chatId, "cannot kick members", `Could not kick user ${userId}`);
      return "failed";
    }
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to kick user ${userId} in chat ${chatId}`, error);
    return "failed";
  }

  for (const attempt of [1, 2]) {
    try {
      await bot.api.unbanChatMember(chatId, userId, { only_if_banned: true });
      return "ok";
    } catch (error) {
      if (!isTelegramApiError(error)) throw error;
      logger.warning(`Kick of user ${userId} in chat ${chatId}: unban step failed (attempt ${attempt})`);
    }
  }
  return "partial";
}

async function sendModLog(bot, config, { action, targetHtml, moderatorHtml, reason, preview = null, replyMarkup = undefined }) {
  const chatId = config.telegram_mod_log_chat_id || config.admin_chat_id;
  let text = t("moderation.log.entry", {
    action,
    target: targetHtml,
    moderator: moderatorHtml,
    reason: reason ? htmlEscape(reason) : t("moderation.reason.none"),
  });
  if (preview) {
    // Truncate BEFORE escaping: cutting the escaped text can land inside an
    // entity ("A&amp;B" -> "A&a"), and Telegram rejects the whole mod-log
    // message with "can't parse entities". Slicing first also makes the 200 a
    // count of visible characters, which is what it was always meant to be.
    const safe = htmlEscape(sliceChars(preview, 0, 200));
    if (safe.trim()) {
      text += `\n${t("moderation.log.preview", { preview: safe })}`;
    }
  }
  try {
    await bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
      link_preview_options: DISABLED_LINK_PREVIEW,
    });
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Could not send moderation log to chat ${chatId}`);
  }
}

async function sendReportLog(
  bot,
  config,
  { reporterHtml, reportedHtml, reason, link, preview, targetChatId, reportedId, reportedMessageId },
) {
  const chatId = config.telegram_mod_log_chat_id || config.admin_chat_id;
  let text = t("moderation.report.log", {
    reporter: reporterHtml,
    reported: reportedHtml,
    reason: htmlEscape(reason),
  });
  if (preview) {
    // Truncate BEFORE escaping: cutting the escaped text can land inside an
    // entity ("A&amp;B" -> "A&a"), and Telegram rejects the whole mod-log
    // message with "can't parse entities". Slicing first also makes the 200 a
    // count of visible characters, which is what it was always meant to be.
    const safe = htmlEscape(sliceChars(preview, 0, 200));
    if (safe.trim()) {
      text += `\n${t("moderation.log.preview", { preview: safe })}`;
    }
  }
  if (link) {
    text += `\n${t("moderation.report.log_link", { link })}`;
  }
  try {
    await bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: modLogActionKeyboard(targetChatId, reportedId, reportedMessageId),
      link_preview_options: DISABLED_LINK_PREVIEW,
    });
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Could not send report log to chat ${chatId}`);
  }
}

async function sendNotice(bot, chatId, text) {
  let sent;
  try {
    sent = await bot.api.sendMessage(chatId, text, {
      parse_mode: "HTML",
      link_preview_options: DISABLED_LINK_PREVIEW,
    });
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    return;
  }
  scheduleDelete(bot, chatId, sent.message_id, NOTICE_DELETE_SECONDS);
}

// --------------------------------------------------------------------------- //
// Small helpers
// --------------------------------------------------------------------------- //

function scheduleDelete(bot, chatId, messageId, delay) {
  const timer = setTimeout(() => {
    backgroundTimers.delete(timer);
    safeDelete(bot, chatId, messageId).catch((error) => {
      logger.exception(`Auto-delete of message ${messageId} failed`, error);
    });
  }, delay * 1000);
  timer.unref?.();
  backgroundTimers.add(timer);
}

/** Drop every pending auto-delete timer — used when the process shuts down. */
export function cancelScheduledDeletes() {
  for (const timer of backgroundTimers) {
    clearTimeout(timer);
  }
  backgroundTimers.clear();
}

function warnRightsOnce(chatId, what) {
  if (rightsWarned.has(chatId)) {
    return;
  }
  logger.warning(`Missing rights in chat ${chatId}: ${what}. Check the bot's admin permissions.`);
  rightsWarned.add(chatId);
}

async function reply(ctx, text, { html = false } = {}) {
  try {
    await ctx.reply(text, {
      parse_mode: html ? "HTML" : undefined,
      link_preview_options: DISABLED_LINK_PREVIEW,
      reply_parameters: { message_id: ctx.msg.message_id },
    });
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Could not reply in chat ${ctx.chat.id}`);
  }
}

/** Reply, then auto-delete both the reply and the triggering message. */
async function transientReply(ctx, bot, text) {
  let sent;
  try {
    sent = await ctx.reply(text, {
      link_preview_options: DISABLED_LINK_PREVIEW,
      reply_parameters: { message_id: ctx.msg.message_id },
    });
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Could not reply in chat ${ctx.chat.id}`);
    return;
  }
  scheduleDelete(bot, ctx.chat.id, sent.message_id, NOTICE_DELETE_SECONDS);
  scheduleDelete(bot, ctx.chat.id, ctx.msg.message_id, NOTICE_DELETE_SECONDS);
}

function reportAllowed(userId) {
  const now = performance.now() / 1000;
  let bucket = reportTimes.get(userId);
  if (bucket === undefined) {
    bucket = [];
    reportTimes.set(userId, bucket);
  }
  while (bucket.length && now - bucket[0] > REPORT_WINDOW_SECONDS) {
    bucket.shift();
  }
  if (bucket.length >= REPORT_MAX_PER_WINDOW) {
    return false;
  }
  bucket.push(now);
  return true;
}

/** Build a t.me/c/... deep link to a supergroup message, or null for other chats. */
function messageLink(chatId, messageId) {
  const raw = String(chatId);
  if (!raw.startsWith("-100")) {
    return null;
  }
  return `https://t.me/c/${raw.slice(4)}/${messageId}`;
}

/**
 * Resolve the command target from a reply or a leading numeric ID.
 *
 * Returns [user_id | null, display_html, remaining_arg_tokens]. When the command
 * is a reply, all arg tokens are returned as the remainder (duration/reason);
 * otherwise the first token must be a numeric user ID and is consumed.
 *
 * Replies to anonymous-admin or linked-channel posts are NOT resolvable targets:
 * their from is a shared service account (GroupAnonymousBot / Telegram), so
 * punishing it would hit the wrong entity in every chat at once.
 */
function resolveTarget(message, args) {
  const tokens = splitWhitespace(args ?? "");
  const replyTo = message.reply_to_message;
  if (replyTo && replyTo.from && !replyTo.sender_chat) {
    return [replyTo.from.id, userHtml(replyTo.from), tokens];
  }
  if (tokens.length && NUMERIC_ID_RE.test(tokens[0])) {
    const userId = Number(tokens[0]);
    return [userId, userHtmlFromId(userId), tokens.slice(1)];
  }
  return [null, "", tokens];
}

/**
 * Split command args into [duration_seconds, reason_text].
 *
 * Only the FIRST token is tried as a duration, so "/mute 2h спам" keeps the 2h
 * and the rest becomes the reason. parseDuration is anchored, so joining all
 * tokens would silently drop the duration whenever a reason follows it (for /ban
 * that meant a PERMANENT ban instead of the requested one). When the first token
 * does not parse, the whole text is the reason and the caller applies its own
 * default duration.
 */
function splitDurationAndReason(tokens) {
  if (!tokens.length) {
    return [null, ""];
  }
  const seconds = parseDuration(tokens[0]);
  if (seconds !== null) {
    return [seconds, tokens.slice(1).join(" ").trim()];
  }
  return [null, tokens.join(" ").trim()];
}

function userHtml(user) {
  const name = htmlEscape(fullName(user) || String(user.id));
  return `<a href="tg://user?id=${user.id}">${name}</a>`;
}

function userHtmlFromId(userId, name = null) {
  const label = name ? htmlEscape(name) : String(userId);
  return `<a href="tg://user?id=${userId}">${label}</a>`;
}

function actorHtml(message) {
  if (message.from) {
    return userHtml(message.from);
  }
  if (message.sender_chat) {
    return htmlEscape(message.sender_chat.title || String(message.sender_chat.id));
  }
  return "—";
}

function humanizeDuration(seconds) {
  if (seconds <= 0) {
    return t("moderation.duration.permanent");
  }
  if (seconds % 86400 === 0) {
    return t("moderation.duration.days", { n: seconds / 86400 });
  }
  if (seconds % 3600 === 0) {
    return t("moderation.duration.hours", { n: seconds / 3600 });
  }
  if (seconds % 60 === 0) {
    return t("moderation.duration.minutes", { n: seconds / 60 });
  }
  return t("moderation.duration.seconds", { n: seconds });
}

function formatWhen(raw) {
  const parsed = hasIsoOffset(raw) ? fromIsoFormat(raw) : DateTime.fromISO(String(raw).trim(), { zone: "utc" });
  if (parsed === null || !parsed.isValid) {
    return raw || "—";
  }
  return parsed.toUTC().toFormat("yyyy-MM-dd HH:mm 'UTC'");
}
