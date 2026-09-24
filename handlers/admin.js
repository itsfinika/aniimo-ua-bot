import { Composer } from "grammy";

import { STATUS_PENDING } from "../database.js";
import {
  collectorSourceKeyboard,
  editPartKeyboard,
  moderationKeyboard,
  redraftSourceKeyboard,
  saveDraftKeyboard,
  unpackCollectorCallback,
  unpackModerationCallback,
  unpackModerationPartCallback,
  unpackRedraftCallback,
} from "../keyboards.js";
import {
  CollectionMode,
  createCollector,
  formatCollectionReport,
  getCollectorDefinition,
  listCollectorDefinitions,
  redraftByUrl,
} from "../services/collectors/registry.js";
import { runWikiAniimoOnce } from "../services/collectors/wiki_aniimo/collector.js";
import { isSafeHttpUrl } from "../services/urlutils.js";
import { runFanartDigestOnce } from "../services/digests/fanart.js";
import { runGuidesDigestOnce } from "../services/digests/guides.js";
import { formatAdminPreview } from "../services/formatter.js";
import { buildActivityReport } from "../services/reports.js";
import { t } from "../services/i18n.js";
import { getLogger } from "../services/logger.js";
import {
  formatPostHtml,
  stripRenderedCommunityFooter,
  submissionAllowsSourceLink,
} from "../services/post_footer.js";
import { htmlUnescape, isDigits, splitWhitespace } from "../services/pyutils.js";
import {
  DISABLED_LINK_PREVIEW,
  DOWNLOAD_VIDEO_SOURCE_TYPES,
  PublishingError,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  publishSubmission,
} from "../services/publisher.js";
import { isTelegramApiError, isTelegramBadRequest, telegramErrorText } from "../services/telegram_errors.js";

const logger = getLogger("handlers.admin");

/**
 * Serialises the approve path per submission.
 *
 * The Python version used `defaultdict(asyncio.Lock)` so two admins tapping
 * Approve at once could not both publish. JavaScript has no lock primitive, so
 * the same guarantee comes from chaining each submission's critical sections
 * onto a promise stored per id.
 */
const approveLocks = new Map();

async function withApproveLock(submissionId, work) {
  // Wait for whoever holds the submission's slot, then hand the slot on. Like
  // the `defaultdict(asyncio.Lock)` it replaces, an entry is kept per submission
  // for the process's lifetime — a handful of bytes per approved draft.
  const previous = approveLocks.get(submissionId) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  approveLocks.set(
    submissionId,
    previous.then(() => gate),
  );
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}

const editPromptMessageIds = new Map();
const URL_PATTERN = /https?:\/\/|www\./i;

/**
 * `registry` is a test seam. The collector registry is a module-level Map with
 * no injection point, and ESM bindings cannot be spied on, so the handler tests
 * would otherwise have to reach the network to exercise the run path.
 */
export function buildAdminComposer({
  config,
  db,
  bot,
  registry = {
    create: createCollector,
    definition: getCollectorDefinition,
    list: listCollectorDefinitions,
    redraftUrl: redraftByUrl,
  },
}) {
  const composer = new Composer();

  const isAdminUser = (userId) => userId !== undefined && config.admin_user_ids.has(userId);
  const chatType = (ctx) => ctx.chat?.type;
  /**
   * Chat-scope-only gate: the admin chat or a private DM.
   *
   * Used for /fetch_news so the bot never answers it in the public moderated
   * group — there the message falls through to the moderation router instead
   * (flood-counted and filtered like any other member message).
   */
  const adminOrPrivateChat = (ctx) => ctx.chat?.id === config.admin_chat_id || chatType(ctx) === "private";
  const adminCommandChat = (ctx) => isAdminUser(ctx.from?.id) && adminOrPrivateChat(ctx);

  const adminEditMessage = async (ctx) => {
    if (!isAdminUser(ctx.from?.id)) return false;
    if (ctx.chat?.id !== config.admin_chat_id && chatType(ctx) !== "private") return false;
    const state = await db.getAdminEditState(ctx.from.id);
    return state !== null && state.mode === "add_part";
  };

  const adminChannelEditPost = async (ctx) => {
    if (ctx.chat?.id !== config.admin_chat_id || chatType(ctx) !== "channel") return false;
    const state = await db.getLatestAdminEditState();
    return state !== null && state.mode === "add_part";
  };

  const adminDraftMessage = async (ctx) => {
    if (!isAdminUser(ctx.from?.id)) return false;
    if (ctx.chat?.id !== config.admin_chat_id && chatType(ctx) !== "private") return false;
    const state = await db.getAdminEditState(ctx.from.id);
    return state !== null && state.mode === "draft_part";
  };

  // --- callback queries ------------------------------------------------------

  composer.on("callback_query:data", async (ctx, next) => {
    const callbackData = unpackModerationCallback(ctx.callbackQuery.data);
    if (callbackData === null) return next();

    const adminId = ctx.callbackQuery.from.id;
    if (!isAdminUser(adminId)) {
      logger.warning(`User ${adminId} tried to use admin action ${callbackData.action}`);
      await answerCallback(ctx, t("admin.alert.admin_only"), { showAlert: true });
      return;
    }

    if (callbackData.action === "approve") {
      await approveSubmission(ctx, callbackData.submission_id, bot, config, db);
    } else if (callbackData.action === "reject") {
      await rejectSubmission(ctx, callbackData.submission_id, bot, config, db);
    } else if (callbackData.action === "edit") {
      await startEdit(ctx, callbackData.submission_id, bot, config, db);
    } else {
      logger.warning(`Unknown moderation action: ${callbackData.action}`);
      await answerCallback(ctx, t("admin.alert.unknown_action"), { showAlert: true });
    }
  });

  composer.on("callback_query:data", async (ctx, next) => {
    const callbackData = unpackModerationPartCallback(ctx.callbackQuery.data);
    if (callbackData === null) return next();

    const adminId = ctx.callbackQuery.from.id;
    if (!isAdminUser(adminId)) {
      logger.warning(`User ${adminId} tried to use admin part action ${callbackData.action}`);
      await answerCallback(ctx, t("admin.alert.admin_only"), { showAlert: true });
      return;
    }

    if (callbackData.action === "select") {
      await startPartDraft(ctx, callbackData.submission_id, callbackData.part_index, bot, config, db);
    } else if (callbackData.action === "add") {
      await startAddPart(ctx, callbackData.submission_id, bot, config, db);
    } else if (callbackData.action === "save") {
      await savePartDraft(ctx, callbackData.submission_id, callbackData.part_index, bot, config, db);
    } else {
      logger.warning(`Unknown moderation part action: ${callbackData.action}`);
      await answerCallback(ctx, t("admin.alert.unknown_action"), { showAlert: true });
    }
  });

  // --- commands --------------------------------------------------------------

  composer.command("fetch_news", async (ctx, next) => {
    if (!adminOrPrivateChat(ctx)) return next();
    if (!isAdminUser(ctx.from?.id)) {
      await ctx.reply(t("admin.news_fetch.no_permission"));
      return;
    }

    if (ctx.chat.id !== config.admin_chat_id && chatType(ctx) !== "private") {
      await ctx.reply(t("admin.news_fetch.wrong_chat"));
      return;
    }

    await ctx.reply(t("admin.news_fetch.choose_source"), {
      reply_markup: collectorSourceKeyboard(registry.list(config)),
    });
  });

  /**
   * Re-draft the newest item of a source even though it has already been posted.
   *
   * A source that has been collecting for a while reports "found 9, duplicates
   * 9, new 0" and produces nothing, so there is no way to check the pipeline
   * after a change. /cleanup cannot help: it deliberately leaves `seen_sources`
   * alone, because clearing it would re-queue every old article at once. This
   * makes exactly ONE draft from the newest item and writes nothing to
   * `seen_sources`, so rejecting the result leaves no trace.
   */
  composer.command("redraft", async (ctx, next) => {
    if (!adminOrPrivateChat(ctx)) return next();
    if (!isAdminUser(ctx.from?.id)) {
      await ctx.reply(t("admin.news_fetch.no_permission"));
      return;
    }

    if (ctx.chat.id !== config.admin_chat_id && chatType(ctx) !== "private") {
      await ctx.reply(t("admin.news_fetch.wrong_chat"));
      return;
    }

    // With a link, redraft THAT article instead of offering the source buttons:
    // the buttons can only reach a source's newest item, which is no use for
    // re-running an old article through a fix.
    const target = String(ctx.match ?? "").trim();
    if (target) {
      if (!isRedraftableUrl(target)) {
        await ctx.reply(t("admin.redraft.bad_url"));
        return;
      }
      await ctx.reply(t("admin.redraft.url_started"));
      let stats;
      try {
        stats = await registry.redraftUrl({ config, db, bot, url: target });
      } catch (error) {
        logger.exception("Redraft by URL failed", error);
        await ctx.reply(t("admin.redraft.url_failed"));
        return;
      }
      if (stats === null) {
        await ctx.reply(t("admin.redraft.url_not_found"));
        return;
      }
      await ctx.reply(`${formatCollectionReport(stats)}\n\n${t("admin.redraft.notice")}`, {
        link_preview_options: DISABLED_LINK_PREVIEW,
      });
      return;
    }

    await ctx.reply(t("admin.redraft.choose_source"), {
      reply_markup: redraftSourceKeyboard(registry.list(config)),
    });
  });

  /**
   * Manually build this week's fan-art digest into the moderation queue. Pass
   * `force` to bypass the once-a-week guard (useful for testing).
   *
   * Unlike /aniimoweek this runs even when the feature flag is off — an admin who
   * typed the command wants the digest — but it says so, since
   * ENABLE_FANART_DIGEST being off means no digest will appear on its own.
   */
  composer.command("fanartdigest", async (ctx, next) => {
    if (!adminOrPrivateChat(ctx)) return next();
    if (!isAdminUser(ctx.from?.id)) {
      await ctx.reply(t("admin.fanart_digest.no_permission"));
      return;
    }

    if (ctx.chat.id !== config.admin_chat_id && chatType(ctx) !== "private") {
      await ctx.reply(t("admin.fanart_digest.wrong_chat"));
      return;
    }

    const force = String(ctx.match ?? "").trim().toLowerCase() === "force";
    if (!config.enable_fanart_digest) {
      await ctx.reply(t("admin.fanart_digest.scheduler_disabled"));
    }
    await ctx.reply(t("admin.fanart_digest.started"));
    let created;
    try {
      created = await runFanartDigestOnce(bot, config, db, { force });
    } catch (error) {
      logger.exception("Manual fan-art digest failed", error);
      await ctx.reply(t("admin.fanart_digest.failed"));
      return;
    }

    await ctx.reply(created ? t("admin.fanart_digest.queued") : t("admin.fanart_digest.skipped"));
  });

  /**
   * Manually build this week's guides digest into the moderation queue. Same
   * shape as /fanartdigest, including the `force` argument and the note when the
   * scheduler itself is off.
   */
  composer.command("guidesdigest", async (ctx, next) => {
    if (!adminOrPrivateChat(ctx)) return next();
    if (!isAdminUser(ctx.from?.id)) {
      await ctx.reply(t("admin.guides_digest.no_permission"));
      return;
    }

    if (ctx.chat.id !== config.admin_chat_id && chatType(ctx) !== "private") {
      await ctx.reply(t("admin.guides_digest.wrong_chat"));
      return;
    }

    const force = String(ctx.match ?? "").trim().toLowerCase() === "force";
    if (!config.enable_guides_digest) {
      await ctx.reply(t("admin.guides_digest.scheduler_disabled"));
    }
    await ctx.reply(t("admin.guides_digest.started"));
    let created;
    try {
      created = await runGuidesDigestOnce(bot, config, db, { force });
    } catch (error) {
      logger.exception("Manual guides digest failed", error);
      await ctx.reply(t("admin.guides_digest.failed"));
      return;
    }

    await ctx.reply(created ? t("admin.guides_digest.queued") : t("admin.guides_digest.skipped"));
  });

  /**
   * Queue one "Аніімо тижня" creature post on demand.
   *
   * The rubric also has a /fetch_news button, but only this command reports WHY
   * it is idle: the button simply disappears when the rubric is off, while this
   * replies with the failing precondition (ENABLE_WIKI_ANIIMO or GEMINI_API_KEY).
   */
  composer.command("aniimoweek", async (ctx, next) => {
    if (!adminOrPrivateChat(ctx)) return next();
    if (!isAdminUser(ctx.from?.id)) {
      await ctx.reply(t("admin.aniimo_week.no_permission"));
      return;
    }

    if (ctx.chat.id !== config.admin_chat_id && chatType(ctx) !== "private") {
      await ctx.reply(t("admin.aniimo_week.wrong_chat"));
      return;
    }

    // Report the same two conditions the weekly scheduler checks at startup, so a
    // silent "the rubric never posts" is diagnosable without reading server logs.
    if (!config.enable_wiki_aniimo) {
      await ctx.reply(t("admin.aniimo_week.disabled"));
      return;
    }
    if (!config.gemini_api_key) {
      await ctx.reply(t("admin.aniimo_week.no_gemini"));
      return;
    }

    await ctx.reply(t("admin.aniimo_week.started"));
    let created;
    try {
      created = await runWikiAniimoOnce(bot, config, db);
    } catch (error) {
      logger.exception("Manual Aniimo-of-the-week run failed", error);
      await ctx.reply(t("admin.aniimo_week.failed"));
      return;
    }

    await ctx.reply(created ? t("admin.aniimo_week.queued") : t("admin.aniimo_week.skipped"));
  });

  /**
   * Delete finished submissions from the database.
   *
   * Two-step by design: without `confirm` it only reports what WOULD go, because
   * this is the one admin command that destroys data. Pending submissions and the
   * seen-sources memory are never touched — dropping the latter would re-queue
   * news the channel already handled.
   */
  composer.command("cleanup", async (ctx, next) => {
    if (!adminOrPrivateChat(ctx)) return next();
    if (!isAdminUser(ctx.from?.id)) {
      await ctx.reply(t("admin.cleanup.no_permission"));
      return;
    }

    if (ctx.chat.id !== config.admin_chat_id && chatType(ctx) !== "private") {
      await ctx.reply(t("admin.cleanup.wrong_chat"));
      return;
    }

    const { days, confirmed, includePending, invalid } = parseCleanupArgs(ctx.match);
    if (invalid !== null) {
      await ctx.reply(t("admin.cleanup.bad_argument", { value: invalid }));
      return;
    }

    let total;
    let breakdown;
    try {
      total = await db.countProcessedSubmissions({ older_than_days: days, include_pending: includePending });
      breakdown = await db.countSubmissionsByStatus();
    } catch (error) {
      logger.exception("Cleanup count failed", error);
      await ctx.reply(t("admin.cleanup.failed"));
      return;
    }

    if (!total) {
      // Say what IS in the database: "nothing matched" is confusing when the
      // moderation chat is visibly full of drafts that are merely still pending.
      await ctx.reply(t("admin.cleanup.nothing", { days, breakdown: formatStatusBreakdown(breakdown) }));
      return;
    }

    if (!confirmed) {
      const key = includePending ? "admin.cleanup.preview_all" : "admin.cleanup.preview";
      await ctx.reply(t(key, { count: total, days }));
      return;
    }

    const sizeBefore = db.sizeBytes();
    let deleted;
    try {
      deleted = await db.deleteProcessedSubmissions({
        older_than_days: days,
        include_pending: includePending,
      });
      await db.vacuum();
    } catch (error) {
      logger.exception("Cleanup failed", error);
      await ctx.reply(t("admin.cleanup.failed"));
      return;
    }

    const freed = Math.max(0, sizeBefore - db.sizeBytes());
    logger.info(`Cleanup removed ${deleted} submissions older than ${days} days`);
    await ctx.reply(t("admin.cleanup.done", { count: deleted, days, freed: formatKilobytes(freed) }));
  });

  composer.on("callback_query:data", async (ctx, next) => {
    // The same picker serves /fetch_news and /redraft; only the run mode and the
    // status line differ, so they share one handler rather than two near-copies.
    const redraftData = unpackRedraftCallback(ctx.callbackQuery.data);
    const callbackData = redraftData ?? unpackCollectorCallback(ctx.callbackQuery.data);
    if (callbackData === null) return next();
    const forced = redraftData !== null;

    const adminId = ctx.callbackQuery.from.id;
    if (!isAdminUser(adminId)) {
      logger.warning(`User ${adminId} tried to run collector ${callbackData.collector_id}`);
      await answerCallback(ctx, t("admin.alert.admin_only"), { showAlert: true });
      return;
    }

    const definition = registry.definition(callbackData.collector_id);
    const collector = registry.create(callbackData.collector_id, { config, db, bot });
    if (definition === null || collector === null) {
      await answerCallback(ctx, t("admin.news_fetch.unknown_source"), { showAlert: true });
      return;
    }

    const callbackMessage = ctx.callbackQuery.message;
    const targetChatId = callbackMessage ? callbackMessage.chat.id : config.admin_chat_id;
    let targetMessageId = callbackMessage ? callbackMessage.message_id : null;
    const startedText = forced
      ? t("admin.redraft.started", { source: definition.title })
      : t("admin.news_fetch.started", { source: definition.title });

    if (targetMessageId !== null) {
      try {
        await bot.api.editMessageText(targetChatId, targetMessageId, startedText, {
          reply_markup: undefined,
          link_preview_options: DISABLED_LINK_PREVIEW,
        });
      } catch (error) {
        if (!isTelegramApiError(error)) throw error;
        logger.info("Could not edit collector selector message; sending parsing status separately");
        const statusMessage = await bot.api.sendMessage(targetChatId, startedText, {
          link_preview_options: DISABLED_LINK_PREVIEW,
        });
        targetMessageId = statusMessage.message_id;
      }
    } else {
      const statusMessage = await bot.api.sendMessage(targetChatId, startedText, {
        link_preview_options: DISABLED_LINK_PREVIEW,
      });
      targetMessageId = statusMessage.message_id;
    }

    await answerCallback(ctx);
    const stats = await collector.runOnce(
      forced ? CollectionMode.FORCE_LATEST : CollectionMode.MANUAL_LATEST,
    );
    const report = forced
      ? `${formatCollectionReport(stats)}

${t("admin.redraft.notice")}`
      : formatCollectionReport(stats);

    try {
      await bot.api.editMessageText(targetChatId, targetMessageId, report, {
        link_preview_options: DISABLED_LINK_PREVIEW,
      });
    } catch (error) {
      if (!isTelegramApiError(error)) throw error;
      logger.info("Could not edit collector status message; sending a new report");
      await bot.api.sendMessage(targetChatId, report, { link_preview_options: DISABLED_LINK_PREVIEW });
    }
  });

  /**
   * The same report the weekly message sends, on demand and over any window:
   * `/stats` covers the last 7 days, `/stats 30` the last 30.
   */
  composer.command("stats", async (ctx, next) => {
    if (!adminOrPrivateChat(ctx)) return next();
    if (!isAdminUser(ctx.from?.id)) {
      await ctx.reply(t("admin.stats.no_permission"));
      return;
    }
    if (ctx.chat.id !== config.admin_chat_id && chatType(ctx) !== "private") {
      await ctx.reply(t("admin.stats.wrong_chat"));
      return;
    }

    const days = parseStatsDays(ctx.match);
    if (days === null) {
      await ctx.reply(t("admin.stats.bad_argument", { value: String(ctx.match).trim() }));
      return;
    }

    let report;
    try {
      report = await buildActivityReport(db, config, { days });
    } catch (error) {
      logger.exception("Building the activity report failed", error);
      await ctx.reply(t("admin.stats.failed"));
      return;
    }

    await ctx.reply(report, { parse_mode: "HTML", link_preview_options: DISABLED_LINK_PREVIEW });
    logger.info(`Admin ${ctx.from.id} requested the ${days}-day activity report`);
  });

  composer.command("cancel", async (ctx, next) => {
    if (!adminCommandChat(ctx)) return next();
    const state = await db.getAdminEditState(ctx.from.id);
    if (state === null) {
      await ctx.reply(t("admin.edit.no_active_edit"));
      return;
    }

    await db.clearAdminEditState(ctx.from.id);
    await deleteEditPrompts(bot, ctx.from.id);
    logger.info(`Admin ${ctx.from.id} cancelled editing submission ${state.submission_id}`);
    await ctx.reply(t("admin.edit.cancelled"));
  });

  // --- add-part capture (admin chat / DM) ------------------------------------

  composer.command("start", async (ctx, next) => {
    if (!(await adminEditMessage(ctx))) return next();
    const state = await db.getAdminEditState(ctx.from.id);
    if (state === null) {
      return;
    }

    await ctx.reply(t("admin.edit.active_reminder", { submission_id: state.submission_id }));
  });

  composer.on("message:photo", async (ctx, next) => {
    if (!(await adminEditMessage(ctx))) return next();
    const photos = ctx.message.photo;
    const photo = photos?.length ? photos[photos.length - 1] : null;
    if (photo === null) {
      return;
    }

    await receiveAdminPartMessage({
      ctx,
      bot,
      config,
      db,
      messageType: "photo",
      text: ctx.message.caption ?? "",
      fileId: photo.file_id,
    });
  });

  composer.on("message:video", async (ctx, next) => {
    if (!(await adminEditMessage(ctx))) return next();
    if (!ctx.message.video) {
      return;
    }

    await receiveAdminPartMessage({
      ctx,
      bot,
      config,
      db,
      messageType: "video",
      text: ctx.message.caption ?? "",
      fileId: ctx.message.video.file_id,
    });
  });

  composer.on("message:document", async (ctx, next) => {
    if (!(await adminEditMessage(ctx))) return next();
    if (!ctx.message.document) {
      return;
    }

    await receiveAdminPartMessage({
      ctx,
      bot,
      config,
      db,
      messageType: "document",
      text: ctx.message.caption ?? "",
      fileId: ctx.message.document.file_id,
    });
  });

  composer.on("message:text", async (ctx, next) => {
    if (!(await adminEditMessage(ctx))) return next();
    await receiveAdminPartMessage({
      ctx,
      bot,
      config,
      db,
      messageType: containsLink(ctx.message.text ?? "") ? "link" : "text",
      text: ctx.message.text ?? "",
      fileId: null,
    });
  });

  // --- add-part capture (admin channel posts) --------------------------------

  composer.on("channel_post:photo", async (ctx, next) => {
    if (!(await adminChannelEditPost(ctx))) return next();
    const photos = ctx.channelPost.photo;
    const photo = photos?.length ? photos[photos.length - 1] : null;
    if (photo === null) {
      return;
    }

    await receiveChannelPartMessage({
      ctx,
      bot,
      config,
      db,
      messageType: "photo",
      text: ctx.channelPost.caption ?? "",
      fileId: photo.file_id,
    });
  });

  composer.on("channel_post:video", async (ctx, next) => {
    if (!(await adminChannelEditPost(ctx))) return next();
    if (!ctx.channelPost.video) {
      return;
    }

    await receiveChannelPartMessage({
      ctx,
      bot,
      config,
      db,
      messageType: "video",
      text: ctx.channelPost.caption ?? "",
      fileId: ctx.channelPost.video.file_id,
    });
  });

  composer.on("channel_post:document", async (ctx, next) => {
    if (!(await adminChannelEditPost(ctx))) return next();
    if (!ctx.channelPost.document) {
      return;
    }

    await receiveChannelPartMessage({
      ctx,
      bot,
      config,
      db,
      messageType: "document",
      text: ctx.channelPost.caption ?? "",
      fileId: ctx.channelPost.document.file_id,
    });
  });

  composer.on("channel_post:text", async (ctx, next) => {
    if (!(await adminChannelEditPost(ctx))) return next();
    if (isChannelPrompt(ctx.channelPost.text)) {
      return;
    }

    await receiveChannelPartMessage({
      ctx,
      bot,
      config,
      db,
      messageType: containsLink(ctx.channelPost.text ?? "") ? "link" : "text",
      text: ctx.channelPost.text ?? "",
      fileId: null,
    });
  });

  // --- live draft editing ----------------------------------------------------

  composer.on("message", async (ctx, next) => {
    if (!(await adminDraftMessage(ctx))) return next();
    const state = await db.getAdminEditState(ctx.from.id);
    if (state === null) {
      return;
    }

    const submissionId = Number(state.submission_id);
    const partIndex = Number(state.part_index);
    const part = await db.getSubmissionPart(submissionId, partIndex);
    if (part === null) {
      await ctx.reply(t("admin.alert.submission_not_found"));
      return;
    }

    const newText = messageText(ctx.message).trim();
    const validationError = validatePartText(part, newText);
    if (validationError !== null) {
      await ctx.reply(validationError);
      return;
    }

    if (!(await editDraftPartMessage(bot, config, state, part, newText))) {
      await ctx.reply(t("admin.alert.save_failed"));
      return;
    }

    await deleteMessageSafely(bot, ctx.chat.id, ctx.message.message_id, "draft source");
  });

  return composer;
}

const CLEANUP_DEFAULT_DAYS = 30;

/**
 * Return {days, confirmed, includePending, invalid}.
 *
 * Tokens may come in any order: a number is the age window, "confirm" arms the
 * deletion, and "all" widens it to pending submissions as well. "all" on its own
 * means the whole queue, so it drops the age window to 0 unless a number was
 * given too.
 */
export /**
 * `/stats` or `/stats <days>`. Returns null for anything that is not a whole
 * number of days between 1 and 90 — beyond that the message stops being a
 * report and starts being a wall.
 */
function parseStatsDays(match) {
  const raw = String(match ?? "").trim();
  if (!raw) {
    return 7;
  }
  if (!isDigits(raw)) {
    return null;
  }
  const days = Number(raw);
  return days >= 1 && days <= 90 ? days : null;
}

function parseCleanupArgs(args) {
  let days = null;
  let confirmed = false;
  let includePending = false;
  for (const token of splitWhitespace(args ?? "")) {
    const lowered = token.toLowerCase();
    if (lowered === "confirm") {
      confirmed = true;
    } else if (lowered === "all") {
      includePending = true;
    } else if (isDigits(lowered)) {
      days = Number(lowered);
    } else {
      return { days: CLEANUP_DEFAULT_DAYS, confirmed, includePending, invalid: token };
    }
  }

  if (days === null) {
    days = includePending ? 0 : CLEANUP_DEFAULT_DAYS;
  }
  return { days, confirmed, includePending, invalid: null };
}

function formatStatusBreakdown(counts) {
  const labels = [
    [STATUS_PENDING, t("admin.cleanup.status.pending")],
    ["published", t("admin.cleanup.status.published")],
    ["rejected", t("admin.cleanup.status.rejected")],
  ];
  return labels.map(([status, label]) => `${label} — ${counts[status] ?? 0}`).join("\n");
}

function formatKilobytes(sizeBytes) {
  return `${Math.round(sizeBytes / 1024)} КБ`;
}

async function receiveAdminPartMessage({ ctx, bot, config, db, messageType, text, fileId }) {
  const state = await db.getAdminEditState(ctx.from.id);
  if (state === null || state.mode !== "add_part") {
    return;
  }

  const submissionId = Number(state.submission_id);
  const copiedMessageId = await copyNewPartMessage({ bot, config, submissionId, messageType, text, fileId });
  if (copiedMessageId === null) {
    await ctx.reply(t("admin.alert.save_failed"));
    return;
  }

  await addPartAndRefreshMetadata({
    db,
    bot,
    config,
    adminId: ctx.from.id,
    submissionId,
    messageType,
    text,
    fileId,
    adminMessageId: copiedMessageId,
  });
  await deleteMessageSafely(bot, ctx.chat.id, ctx.message.message_id, "new part source");
}

async function receiveChannelPartMessage({ ctx, bot, config, db, messageType, text, fileId }) {
  const state = await db.getLatestAdminEditState();
  if (state === null || state.mode !== "add_part") {
    return;
  }

  const submissionId = Number(state.submission_id);
  const adminId = Number(state.admin_id);
  logger.info(
    `Received channel part for submission ${submissionId} from admin state ${adminId} as ${messageType}`,
  );
  const copiedMessageId = await copyNewPartMessage({ bot, config, submissionId, messageType, text, fileId });
  if (copiedMessageId === null) {
    return;
  }

  await addPartAndRefreshMetadata({
    db,
    bot,
    config,
    adminId,
    submissionId,
    messageType,
    text,
    fileId,
    adminMessageId: copiedMessageId,
  });
  await deleteMessageSafely(bot, ctx.chat.id, ctx.channelPost.message_id, "new part source");
}

async function approveSubmission(ctx, submissionId, bot, config, db) {
  await withApproveLock(submissionId, async () => {
    const submission = await db.getSubmission(submissionId);
    if (submission === null) {
      await answerCallback(ctx, t("admin.alert.submission_not_found"), { showAlert: true });
      return;
    }

    if (submission.status !== STATUS_PENDING) {
      await answerCallback(ctx, t("admin.alert.submission_already_processed"), { showAlert: true });
      return;
    }

    try {
      await publishSubmission(bot, config, submission);
    } catch (error) {
      if (!(error instanceof PublishingError)) throw error;
      logger.exception(`Failed to publish submission ${submissionId}: ${error.message}`, error);
      await answerCallback(ctx, t("admin.alert.publish_failed"), { showAlert: true });
      return;
    }

    await db.markPublished(submissionId);
    const updatedSubmission = await db.getSubmission(submissionId);
    if (updatedSubmission !== null) {
      await updateAdminPreview(bot, config, updatedSubmission, { keepButtons: false });
    }

    logger.info(`Admin ${ctx.callbackQuery.from.id} approved submission ${submissionId}`);
    await answerCallback(ctx, t("admin.alert.published"));
  });
}

async function rejectSubmission(ctx, submissionId, bot, config, db) {
  const submission = await db.getSubmission(submissionId);
  if (submission === null) {
    await answerCallback(ctx, t("admin.alert.submission_not_found"), { showAlert: true });
    return;
  }

  if (submission.status !== STATUS_PENDING) {
    await answerCallback(ctx, t("admin.alert.submission_already_processed"), { showAlert: true });
    return;
  }

  await db.markRejected(submissionId);
  const updatedSubmission = await db.getSubmission(submissionId);
  if (updatedSubmission !== null) {
    await updateAdminPreview(bot, config, updatedSubmission, { keepButtons: false });
  }

  logger.info(`Admin ${ctx.callbackQuery.from.id} rejected submission ${submissionId}`);
  await answerCallback(ctx, t("admin.alert.rejected"));
}

async function startEdit(ctx, submissionId, bot, config, db) {
  const submission = await db.getSubmission(submissionId);
  if (submission === null) {
    await answerCallback(ctx, t("admin.alert.submission_not_found"), { showAlert: true });
    return;
  }

  if (submission.status !== STATUS_PENDING) {
    await answerCallback(ctx, t("admin.alert.submission_already_processed"), { showAlert: true });
    return;
  }

  // Album digests (one grouped post) and native-video posts (YouTube, or a
  // downloaded Bluesky video) are not edited in place — the per-part edit flow
  // can't edit a media group / video message's text — so admins approve or
  // reject them as a whole.
  const messageType = String(submission.message_type || "");
  const sourceType = String(submission.source_type || "");
  if (
    messageType === "album" ||
    sourceType === "youtube" ||
    (messageType === "video" && DOWNLOAD_VIDEO_SOURCE_TYPES.has(sourceType))
  ) {
    await answerCallback(ctx, t("admin.alert.media_post_edit_unsupported"), { showAlert: true });
    return;
  }

  const parts = submission.parts ?? [];
  logger.info(`Admin ${ctx.callbackQuery.from.id} opened part selector for submission ${submissionId}`);

  if (ctx.callbackQuery.message) {
    try {
      const promptMessage = await bot.api.sendMessage(
        config.admin_chat_id,
        t("admin.edit.choose_part", { submission_id: submissionId }),
        {
          reply_markup: editPartKeyboard(submissionId, Math.max(1, parts.length)),
          link_preview_options: DISABLED_LINK_PREVIEW,
        },
      );
      rememberEditPrompt(ctx.callbackQuery.from.id, config.admin_chat_id, promptMessage.message_id);
    } catch (error) {
      if (!isTelegramApiError(error)) throw error;
      logger.exception(`Could not send edit part selector for submission ${submissionId}`, error);
      await answerCallback(ctx, t("admin.edit.draft_unavailable"), { showAlert: true });
      return;
    }
  }

  await answerCallback(ctx);
}

async function startPartDraft(ctx, submissionId, partIndex, bot, config, db) {
  const submission = await db.getSubmission(submissionId);
  if (submission === null) {
    await answerCallback(ctx, t("admin.alert.submission_not_found"), { showAlert: true });
    return;
  }

  if (submission.status !== STATUS_PENDING) {
    await answerCallback(ctx, t("admin.alert.submission_already_processed"), { showAlert: true });
    return;
  }

  const part = await db.getSubmissionPart(submissionId, partIndex);
  if (part === null) {
    await answerCallback(ctx, t("admin.alert.submission_not_found"), { showAlert: true });
    return;
  }

  const draftMessageId = await copyPartToDraftMessage(bot, config, submissionId, part);
  if (draftMessageId === null) {
    await answerCallback(ctx, t("admin.edit.draft_unavailable"), { showAlert: true });
    return;
  }

  const adminId = ctx.callbackQuery.from.id;
  await db.setAdminEditState(adminId, submissionId, {
    mode: "draft_part",
    part_index: partIndex,
    draft_message_id: draftMessageId,
  });
  rememberEditPrompt(adminId, config.admin_chat_id, draftMessageId);

  const callbackMessage = ctx.callbackQuery.message;
  if (callbackMessage) {
    await deleteMessageSafely(bot, callbackMessage.chat.id, callbackMessage.message_id, "edit part selector");
    forgetEditPrompt(adminId, callbackMessage.chat.id, callbackMessage.message_id);
  }

  logger.info(`Admin ${adminId} created draft for submission ${submissionId} part ${partIndex}`);
  await answerCallback(ctx);
}

async function startAddPart(ctx, submissionId, bot, config, db) {
  const submission = await db.getSubmission(submissionId);
  if (submission === null) {
    await answerCallback(ctx, t("admin.alert.submission_not_found"), { showAlert: true });
    return;
  }

  if (submission.status !== STATUS_PENDING) {
    await answerCallback(ctx, t("admin.alert.submission_already_processed"), { showAlert: true });
    return;
  }

  const adminId = ctx.callbackQuery.from.id;
  await db.setAdminEditState(adminId, submissionId, { mode: "add_part" });
  let promptMessage;
  try {
    const key =
      callbackChatType(ctx) === "channel" ? "admin.edit.add_part_channel_prompt" : "admin.edit.add_part_prompt";
    promptMessage = await bot.api.sendMessage(config.admin_chat_id, t(key, { submission_id: submissionId }), {
      link_preview_options: DISABLED_LINK_PREVIEW,
    });
    rememberEditPrompt(adminId, config.admin_chat_id, promptMessage.message_id);
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Could not send add-part prompt for submission ${submissionId}`, error);
    await db.clearAdminEditState(adminId);
    await answerCallback(ctx, t("admin.edit.draft_unavailable"), { showAlert: true });
    return;
  }

  const callbackMessage = ctx.callbackQuery.message;
  if (callbackMessage && callbackMessage.message_id !== promptMessage.message_id) {
    rememberEditPrompt(adminId, callbackMessage.chat.id, callbackMessage.message_id);
  }

  logger.info(`Admin ${adminId} started adding a new part to submission ${submissionId}`);
  await answerCallback(ctx);
}

async function savePartDraft(ctx, submissionId, partIndex, bot, config, db) {
  const submission = await db.getSubmission(submissionId);
  if (submission === null) {
    await answerCallback(ctx, t("admin.alert.submission_not_found"), { showAlert: true });
    return;
  }

  if (submission.status !== STATUS_PENDING) {
    await answerCallback(ctx, t("admin.alert.submission_already_processed"), { showAlert: true });
    return;
  }

  const part = await db.getSubmissionPart(submissionId, partIndex);
  const callbackMessage = ctx.callbackQuery.message;
  if (part === null || !callbackMessage) {
    await answerCallback(ctx, t("admin.alert.submission_not_found"), { showAlert: true });
    return;
  }

  const newText = stripRenderedCommunityFooter(messageText(callbackMessage)).trim();
  const validationError = validatePartText(part, newText);
  if (validationError !== null) {
    await answerCallback(ctx, validationError, { showAlert: true });
    return;
  }

  if (!(await editOriginalPartMessage(bot, config, part, newText))) {
    await answerCallback(ctx, t("admin.alert.save_failed"), { showAlert: true });
    return;
  }

  const adminId = ctx.callbackQuery.from.id;
  await db.updateSubmissionPartText(submissionId, partIndex, newText);
  await db.clearAdminEditState(adminId);
  await deleteMessageSafely(bot, callbackMessage.chat.id, callbackMessage.message_id, "draft part");
  forgetEditPrompt(adminId, callbackMessage.chat.id, callbackMessage.message_id);
  await deleteEditPrompts(bot, adminId);

  const updatedSubmission = await db.getSubmission(submissionId);
  if (updatedSubmission !== null) {
    await updateAdminPreview(bot, config, updatedSubmission, { keepButtons: true });
  }

  logger.info(`Admin ${adminId} saved submission ${submissionId} part ${partIndex}`);
  await answerCallback(ctx, t("admin.edit.saved"));
}

async function copyPartToDraftMessage(bot, config, submissionId, part) {
  const replyMarkup = saveDraftKeyboard(submissionId, Number(part.part_index));
  let message;
  try {
    message = await sendPartDraftMessage(bot, config.admin_chat_id, part, replyMarkup);
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.exception(
      `Could not send fallback draft for submission ${submissionId} part ${part.part_index}`,
      error,
    );
    return null;
  }

  return message.message_id;
}

/**
 * The editable copy of a part: the STORED body, verbatim and unrendered.
 *
 * It deliberately does not go through formatPartForModeration. Saving takes the
 * visible text of this message back as `part.text`, so anything rendering adds
 * here — the community footer above all — would be stored as if the admin had
 * typed it, and then appended a second time on the next render. Every other
 * consumer of `part.text` already assumes it is the bare body: validatePartText
 * renders it before measuring, and publishing renders it again.
 *
 * Sent without parse_mode for the same reason: the body is plain text, and
 * asking Telegram to parse it as HTML would both fail on a stray `<` and hand
 * back a de-tagged string on save.
 */
async function sendPartDraftMessage(bot, chatId, part, replyMarkup) {
  const messageType = String(part.message_type || "text");
  const text = stripRenderedCommunityFooter(String(part.text || ""));
  const mediaValue = part.file_id || part.media_url;
  if (partHasMedia(part) && messageType === "photo" && mediaValue) {
    return bot.api.sendPhoto(chatId, mediaValue, {
      caption: text || undefined,
      reply_markup: replyMarkup,
    });
  }
  if (partHasMedia(part) && messageType === "video" && mediaValue) {
    return bot.api.sendVideo(chatId, mediaValue, {
      caption: text || undefined,
      reply_markup: replyMarkup,
    });
  }
  if (partHasMedia(part) && messageType === "document" && mediaValue) {
    return bot.api.sendDocument(chatId, mediaValue, {
      caption: text || undefined,
      reply_markup: replyMarkup,
    });
  }

  return bot.api.sendMessage(chatId, text || t("formatter.empty"), {
    reply_markup: replyMarkup,
    link_preview_options: DISABLED_LINK_PREVIEW,
  });
}

async function copyNewPartMessage({ bot, config, submissionId, messageType, text, fileId }) {
  const displayText = formatPartForModeration(text);
  let copiedMessage;
  try {
    if (messageType === "photo" && fileId) {
      copiedMessage = await bot.api.sendPhoto(config.admin_chat_id, fileId, {
        caption: captionOrNone(displayText),
        parse_mode: "HTML",
      });
    } else if (messageType === "video" && fileId) {
      copiedMessage = await bot.api.sendVideo(config.admin_chat_id, fileId, {
        caption: captionOrNone(displayText),
        parse_mode: "HTML",
      });
    } else if (messageType === "document" && fileId) {
      copiedMessage = await bot.api.sendDocument(config.admin_chat_id, fileId, {
        caption: captionOrNone(displayText),
        parse_mode: "HTML",
      });
    } else {
      copiedMessage = await bot.api.sendMessage(config.admin_chat_id, displayText, {
        parse_mode: "HTML",
        link_preview_options: DISABLED_LINK_PREVIEW,
      });
    }
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to copy new part message for submission ${submissionId}`, error);
    return null;
  }

  return copiedMessage.message_id;
}

async function addPartAndRefreshMetadata({
  db,
  bot,
  config,
  adminId,
  submissionId,
  messageType,
  text,
  fileId,
  adminMessageId,
}) {
  const submission = await db.getSubmission(submissionId);
  if (submission === null || submission.status !== STATUS_PENDING) {
    await db.clearAdminEditState(adminId);
    return;
  }

  await db.addSubmissionPart(submissionId, {
    message_type: messageType,
    text: stripRenderedCommunityFooter(text),
    file_id: fileId,
    media_url: null,
    media_type: mediaTypeFor(messageType),
    admin_message_id: adminMessageId,
  });
  await db.clearAdminEditState(adminId);
  await deleteEditPrompts(bot, adminId);

  const updatedSubmission = await db.getSubmission(submissionId);
  if (updatedSubmission !== null) {
    await moveAdminPreviewToBottom(bot, config, db, updatedSubmission, { keepButtons: true });
  }

  logger.info(`Admin ${adminId} added a new part to submission ${submissionId}`);
}

async function moveAdminPreviewToBottom(bot, config, db, submission, { keepButtons }) {
  const oldAdminMessageId = submission.admin_message_id;
  if (oldAdminMessageId !== null && oldAdminMessageId !== undefined) {
    const deleted = await deleteMessageSafely(
      bot,
      config.admin_chat_id,
      Number(oldAdminMessageId),
      "old admin preview",
    );
    if (!deleted) {
      try {
        await bot.api.editMessageReplyMarkup(config.admin_chat_id, Number(oldAdminMessageId), {
          reply_markup: undefined,
        });
      } catch (error) {
        if (!isTelegramApiError(error)) throw error;
        logger.info(`Could not remove buttons from old admin preview ${oldAdminMessageId}`);
      }
    }
  }

  const replyMarkup = keepButtons ? moderationKeyboard(submission.id) : undefined;
  const adminMessage = await bot.api.sendMessage(config.admin_chat_id, formatAdminPreview(submission), {
    reply_markup: replyMarkup,
    parse_mode: "HTML",
    link_preview_options: DISABLED_LINK_PREVIEW,
  });
  await db.setAdminMessageId(Number(submission.id), adminMessage.message_id);
}

async function editOriginalPartMessage(bot, config, part, newText) {
  const adminMessageId = part.admin_message_id;
  if (adminMessageId === null || adminMessageId === undefined) {
    logger.warning(`Submission part ${part.part_index} has no admin_message_id`);
    return false;
  }

  const displayText = formatPartForModeration(newText, part);
  try {
    if (partHasMedia(part)) {
      await bot.api.editMessageCaption(config.admin_chat_id, Number(adminMessageId), {
        caption: displayText || undefined,
        parse_mode: "HTML",
      });
    } else {
      await bot.api.editMessageText(config.admin_chat_id, Number(adminMessageId), displayText, {
        parse_mode: "HTML",
        link_preview_options: DISABLED_LINK_PREVIEW,
      });
    }
  } catch (error) {
    if (isTelegramBadRequest(error) && telegramErrorText(error).toLowerCase().includes("message is not modified")) {
      return true;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to edit original part message ${adminMessageId}`, error);
    return false;
  }

  return true;
}

async function editDraftPartMessage(bot, config, state, part, newText) {
  const draftMessageId = state.draft_message_id;
  if (draftMessageId === null || draftMessageId === undefined) {
    return false;
  }

  const replyMarkup = saveDraftKeyboard(Number(state.submission_id), Number(state.part_index));
  const displayText = formatPartForModeration(newText, part);
  try {
    if (partHasMedia(part)) {
      await bot.api.editMessageCaption(config.admin_chat_id, Number(draftMessageId), {
        caption: displayText || undefined,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      });
    } else {
      await bot.api.editMessageText(config.admin_chat_id, Number(draftMessageId), displayText, {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
        link_preview_options: DISABLED_LINK_PREVIEW,
      });
    }
  } catch (error) {
    if (isTelegramBadRequest(error) && telegramErrorText(error).toLowerCase().includes("message is not modified")) {
      return true;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to edit draft part message ${draftMessageId}`, error);
    return false;
  }

  return true;
}

function messageText(message) {
  if (message.text !== undefined && message.text !== null) {
    return message.text;
  }
  if (message.caption !== undefined && message.caption !== null) {
    return message.caption;
  }
  return "";
}

function validatePartText(part, text) {
  const renderedText = formatPartForModeration(text, part);
  if (partHasMedia(part)) {
    if (htmlVisibleLength(renderedText) > TELEGRAM_CAPTION_LIMIT) {
      return t("admin.alert.text_too_long");
    }
    return null;
  }

  if (!text.trim()) {
    return t("admin.alert.empty_part");
  }
  if (htmlVisibleLength(renderedText) > TELEGRAM_TEXT_LIMIT) {
    return t("admin.alert.text_too_long");
  }
  return null;
}

function formatPartForModeration(text, part = null) {
  const source = part ?? {};
  return formatPostHtml(text, {
    source_url: String(source.source_url || ""),
    source_type: source.source_type,
    allow_source_link: submissionAllowsSourceLink(source),
    include_community_footer: true,
  });
}

function captionOrNone(text) {
  if (!text) {
    return undefined;
  }

  if (htmlVisibleLength(text) <= TELEGRAM_CAPTION_LIMIT) {
    return text;
  }

  return formatPostHtml("");
}

function htmlVisibleLength(text) {
  const withoutTags = text.replace(/<[^>]+>/g, "");
  return htmlUnescape(withoutTags).length;
}

function partHasMedia(part) {
  if (!["photo", "video", "document"].includes(String(part.message_type || ""))) {
    return false;
  }
  if (!(part.file_id || part.media_url)) {
    return false;
  }

  const adminMessageId = part.admin_message_id;
  const adminMediaMessageId = part.admin_media_message_id;
  const hasAdmin = adminMessageId !== null && adminMessageId !== undefined;
  const hasMedia = adminMediaMessageId !== null && adminMediaMessageId !== undefined;
  if (hasAdmin && !hasMedia) {
    return false;
  }
  if (!hasAdmin || !hasMedia) {
    return true;
  }

  return Number(adminMessageId) === Number(adminMediaMessageId);
}

function mediaTypeFor(messageType) {
  return ["photo", "video", "document"].includes(messageType) ? messageType : "none";
}

async function updateAdminPreview(bot, config, submission, { keepButtons }) {
  const adminMessageId = submission.admin_message_id;
  if (adminMessageId === null || adminMessageId === undefined) {
    logger.warning(`Submission ${submission.id} has no admin_message_id`);
    return;
  }

  const replyMarkup = keepButtons ? moderationKeyboard(submission.id) : undefined;
  try {
    await bot.api.editMessageText(config.admin_chat_id, adminMessageId, formatAdminPreview(submission), {
      reply_markup: replyMarkup,
      parse_mode: "HTML",
      link_preview_options: DISABLED_LINK_PREVIEW,
    });
  } catch (error) {
    if (isTelegramBadRequest(error) && telegramErrorText(error).toLowerCase().includes("message is not modified")) {
      return;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to update admin preview for submission ${submission.id}`, error);
  }
}

async function deleteEditPrompts(bot, adminId) {
  const prompts = editPromptMessageIds.get(adminId) ?? [];
  editPromptMessageIds.delete(adminId);
  for (const [chatId, messageId] of prompts) {
    await deleteMessageSafely(bot, chatId, messageId, "edit prompt");
  }
}

async function deleteMessageSafely(bot, chatId, messageId, label) {
  try {
    await bot.api.deleteMessage(chatId, messageId);
  } catch (error) {
    if (!isTelegramApiError(error)) throw error;
    logger.info(`Could not delete ${label} message ${messageId} in chat ${chatId}`);
    return false;
  }

  return true;
}

function rememberEditPrompt(adminId, chatId, messageId) {
  const prompts = editPromptMessageIds.get(adminId) ?? [];
  prompts.push([chatId, messageId]);
  editPromptMessageIds.set(adminId, prompts);
}

function forgetEditPrompt(adminId, chatId, messageId) {
  const refs = editPromptMessageIds.get(adminId);
  if (!refs || !refs.length) {
    return;
  }

  const remaining = refs.filter(
    ([storedChatId, storedMessageId]) => storedChatId !== chatId || storedMessageId !== messageId,
  );
  if (remaining.length) {
    editPromptMessageIds.set(adminId, remaining);
  } else {
    editPromptMessageIds.delete(adminId);
  }
}

async function answerCallback(ctx, text = undefined, { showAlert = false } = {}) {
  try {
    await ctx.answerCallbackQuery({ text, show_alert: showAlert });
  } catch (error) {
    if (isTelegramBadRequest(error)) {
      if (isExpiredCallbackError(error)) {
        logger.info(`Callback query ${ctx.callbackQuery.id} expired before the bot could answer it`);
        return;
      }
      logger.warning(`Failed to answer callback query ${ctx.callbackQuery.id}: ${telegramErrorText(error)}`);
      return;
    }
    if (!isTelegramApiError(error)) throw error;
    logger.exception(`Failed to answer callback query ${ctx.callbackQuery.id}`, error);
  }
}

function isExpiredCallbackError(error) {
  const message = telegramErrorText(error).toLowerCase();
  return message.includes("query is too old") || message.includes("query id is invalid");
}

function isChannelEditPrompt(text) {
  return Boolean(
    text &&
      text.startsWith(t("admin.edit.prompt_detection_prefix")) &&
      text.includes(t("admin.edit.prompt_detection_marker")),
  );
}

function isChannelAddPrompt(text) {
  return Boolean(
    text &&
      text.startsWith(t("admin.edit.add_prompt_detection_prefix")) &&
      text.includes(t("admin.edit.add_prompt_detection_marker")),
  );
}

function isChannelPrompt(text) {
  return isChannelEditPrompt(text) || isChannelAddPrompt(text);
}

function containsLink(text) {
  return URL_PATTERN.test(text);
}

function callbackChatType(ctx) {
  return ctx.callbackQuery.message?.chat?.type ?? null;
}

/**
 * Whether `/redraft <argument>` is a link rather than a stray word.
 *
 * Only the shape is checked here; whether any source actually lists the article
 * is answered by the search itself, which reports "not found" on its own.
 */
function isRedraftableUrl(value) {
  return isSafeHttpUrl(String(value ?? "").trim());
}
