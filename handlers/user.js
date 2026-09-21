import { Composer } from "grammy";
import { DateTime } from "luxon";

import { getLogger } from "../services/logger.js";
import { ModerationSendError, sendSubmissionToModeration } from "../services/moderation.js";
import { fromIsoFormat, hasIsoOffset, splitWhitespace } from "../services/pyutils.js";
import { t } from "../services/i18n.js";

const logger = getLogger("handlers.user");

const URL_PATTERN = /https?:\/\/|www\./i;

/**
 * How long to keep collecting an album before turning it into one submission.
 *
 * Telegram has no "album finished" update: the items of a media group arrive as
 * separate messages sharing a `media_group_id`, normally within a few hundred
 * milliseconds. The window restarts with each item, so a slow upload still lands
 * in the same submission, and the reader waits at most this long for the reply.
 */
const ALBUM_GROUPING_WINDOW_MS = 2500;

/** Media groups still filling up, keyed by chat + media_group_id. */
const pendingAlbums = new Map();

/**
 * The user submission flow: a private DM to the bot becomes a moderation entry.
 *
 * aiogram registered these on a module-level `Router` and had the dispatcher
 * inject `config` / `db`; grammY has no such injection, so the composer is built
 * per run with those closed over. Handler ORDER is preserved exactly — /start
 * first, then the typed handlers, then the catch-all — because aiogram stopped
 * at the first matching handler and so does a composer that returns without
 * calling `next()`.
 */
export function buildUserComposer({ config, db, bot }) {
  const composer = new Composer();

  // Submissions come from private DMs only. This keeps the bot from treating
  // ordinary messages in the public/moderated group (where it now also runs
  // moderation) as news submissions. Moderated chats are excluded explicitly
  // too, as defence in depth.
  const submissionChat = (ctx) =>
    ctx.chat?.type === "private" && !config.telegram_moderation_chat_ids.has(ctx.chat.id);

  composer.command("start", async (ctx, next) => {
    if (!submissionChat(ctx)) return next();
    await ctx.reply(t("user.start"));
  });

  composer.on("message:text", async (ctx, next) => {
    if (!submissionChat(ctx)) return next();
    const message = ctx.message;
    if (!message.text) {
      await ctx.reply(t("user.unsupported"));
      return;
    }

    const messageType = containsLink(message) ? "link" : "text";
    // Bounce one- or two-word junk ("ы", "тест") before it reaches the queue. Only
    // plain text is checked: a link or a media caption carries content of its own.
    if (messageType === "text" && isTooShortText(message, config)) {
      await ctx.reply(t("user.too_short"));
      logger.info(
        `Rejected too-short submission from user ${message.from?.id ?? "unknown"}: ` +
          `${JSON.stringify(message.text)}`,
      );
      return;
    }

    await createAndSendSubmission({
      ctx,
      bot,
      config,
      db,
      messageType,
      originalText: message.text,
      fileId: null,
    });
  });

  composer.on("message:photo", async (ctx, next) => {
    if (!submissionChat(ctx)) return next();
    const photos = ctx.message.photo;
    const photo = photos?.length ? photos[photos.length - 1] : null;
    if (photo === null) {
      await ctx.reply(t("user.unsupported"));
      return;
    }

    await createMediaSubmission({
      ctx,
      bot,
      config,
      db,
      messageType: "photo",
      fileId: photo.file_id,
    });
  });

  composer.on("message:video", async (ctx, next) => {
    if (!submissionChat(ctx)) return next();
    if (!ctx.message.video) {
      await ctx.reply(t("user.unsupported"));
      return;
    }

    await createMediaSubmission({
      ctx,
      bot,
      config,
      db,
      messageType: "video",
      fileId: ctx.message.video.file_id,
    });
  });

  composer.on("message:document", async (ctx, next) => {
    if (!submissionChat(ctx)) return next();
    if (!ctx.message.document) {
      await ctx.reply(t("user.unsupported"));
      return;
    }

    await createMediaSubmission({
      ctx,
      bot,
      config,
      db,
      messageType: "document",
      fileId: ctx.message.document.file_id,
    });
  });

  composer.on("message", async (ctx, next) => {
    if (!submissionChat(ctx)) return next();
    await ctx.reply(t("user.unsupported"));
  });

  return composer;
}

/**
 * A media message: on its own it becomes one submission, but when it is part of
 * an album it joins the group that is still filling up.
 *
 * The caption rides on one item of the group (usually the first), so whichever
 * item carries it supplies the whole album's text.
 */
async function createMediaSubmission({ ctx, bot, config, db, messageType, fileId }) {
  const message = ctx.message;
  const mediaGroupId = message.media_group_id;
  if (!mediaGroupId) {
    await createAndSendSubmission({
      ctx,
      bot,
      config,
      db,
      messageType,
      originalText: message.caption ?? null,
      fileId,
    });
    return;
  }

  const key = `${ctx.chat.id}:${mediaGroupId}`;
  // The first message of the group owns the reply: the whole album is one
  // submission, so the reader is answered once, not once per photo.
  const pending = pendingAlbums.get(key) ?? { ctx, items: [], caption: null };
  pending.items.push({ file_id: fileId, media_type: messageType });
  if (!pending.caption && message.caption) {
    pending.caption = message.caption;
  }

  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    pendingAlbums.delete(key);
    flushAlbum({ pending, bot, config, db }).catch((error) => {
      logger.exception(`Failed to queue album ${mediaGroupId}`, error);
    });
  }, ALBUM_GROUPING_WINDOW_MS);
  pending.timer.unref?.();
  pendingAlbums.set(key, pending);
}

/**
 * Turn a finished media group into ONE submission.
 *
 * A group that somehow arrived with a single item is stored as an ordinary
 * single-media submission, so nothing is published as a one-item "album".
 */
async function flushAlbum({ pending, bot, config, db }) {
  const { ctx, items, caption } = pending;
  if (items.length === 1) {
    await createAndSendSubmission({
      ctx,
      bot,
      config,
      db,
      messageType: items[0].media_type,
      originalText: caption,
      fileId: items[0].file_id,
    });
    return;
  }

  const from = ctx.message.from;
  if (!from) {
    await ctx.reply(t("user.unsupported"));
    return;
  }

  const cooldownRemaining = await submissionCooldownRemaining(db, from.id, config);
  if (cooldownRemaining > 0) {
    await ctx.reply(t("user.cooldown", { seconds: cooldownRemaining }));
    logger.info(`Rejected album from user ${from.id} due to cooldown: ${cooldownRemaining} seconds remaining`);
    return;
  }

  const submissionId = await db.createUserAlbumSubmission({
    user_id: from.id,
    username: from.username ?? null,
    original_text: caption,
    items,
  });
  logger.info(`Created album submission ${submissionId} from user ${from.id} with ${items.length} media items`);

  try {
    await sendSubmissionToModeration(bot, config, db, submissionId);
  } catch (error) {
    if (!(error instanceof ModerationSendError)) {
      throw error;
    }
    logger.exception(`Failed to send album submission ${submissionId} to admin chat`, error);
    await ctx.reply(t("user.submission_error"));
    return;
  }

  await ctx.reply(t("user.thank_you"));
}

async function createAndSendSubmission({ ctx, bot, config, db, messageType, originalText, fileId }) {
  const from = ctx.message.from;
  if (!from) {
    await ctx.reply(t("user.unsupported"));
    return;
  }

  const cooldownRemaining = await submissionCooldownRemaining(db, from.id, config);
  if (cooldownRemaining > 0) {
    await ctx.reply(t("user.cooldown", { seconds: cooldownRemaining }));
    logger.info(
      `Rejected submission from user ${from.id} due to cooldown: ${cooldownRemaining} seconds remaining`,
    );
    return;
  }

  const submissionId = await db.createSubmission({
    user_id: from.id,
    username: from.username ?? null,
    message_type: messageType,
    original_text: originalText,
    file_id: fileId,
  });
  const submission = await db.getSubmission(submissionId);
  if (submission === null) {
    logger.error(`Submission ${submissionId} was created but could not be loaded`);
    await ctx.reply(t("user.submission_error"));
    return;
  }

  logger.info(`Created submission ${submissionId} from user ${from.id} as ${messageType}`);

  try {
    await sendSubmissionToModeration(bot, config, db, submissionId);
  } catch (error) {
    if (!(error instanceof ModerationSendError)) {
      throw error;
    }
    logger.exception(`Failed to send submission ${submissionId} to admin chat`, error);
    await ctx.reply(t("user.submission_error"));
    return;
  }

  await ctx.reply(t("user.thank_you"));
}

/**
 * Whether a plain-text submission is too short to be a real news tip.
 *
 * Rejected when it has fewer than the configured minimum words OR characters.
 * Admins are exempt (so the operator can test), as is any check whose threshold
 * is set to 0.
 */
// Exported for the unit tests, which cover the anti-spam floor on its own and
// drive the album grouping window without waiting it out in real time.
export const __testing = { isTooShortText, containsLink, ALBUM_GROUPING_WINDOW_MS, pendingAlbums };

function isTooShortText(message, config) {
  const user = message.from;
  if (user && config.admin_user_ids.has(user.id)) {
    return false;
  }

  const text = (message.text ?? "").trim();
  const minWords = config.min_submission_text_words;
  const minChars = config.min_submission_text_chars;

  if (minWords > 0 && splitWhitespace(text).length < minWords) {
    return true;
  }
  if (minChars > 0 && text.length < minChars) {
    return true;
  }
  return false;
}

function containsLink(message) {
  const text = message.text ?? "";
  if (URL_PATTERN.test(text)) {
    return true;
  }

  for (const entity of message.entities ?? []) {
    if (entity.type === "url" || entity.type === "text_link") {
      return true;
    }
  }

  return false;
}

async function submissionCooldownRemaining(db, userId, config) {
  if (config.admin_user_ids.has(userId)) {
    return 0;
  }

  const cooldownSeconds = config.submission_cooldown_seconds;
  if (cooldownSeconds <= 0) {
    return 0;
  }

  const latestSubmission = await db.getLatestUserSubmission(userId);
  if (latestSubmission === null) {
    return 0;
  }

  const createdAt = parseUtcDateTime(String(latestSubmission.created_at));
  if (createdAt === null) {
    return 0;
  }
  const elapsedSeconds = Math.trunc((Date.now() - createdAt) / 1000);
  const remainingSeconds = cooldownSeconds - elapsedSeconds;
  return Math.max(0, remainingSeconds);
}

/**
 * Timestamps are stored with an explicit `+00:00`; a naive value is
 * REINTERPRETED as UTC (Python's `replace(tzinfo=utc)`), not converted from the
 * server's local zone — which would move the cooldown by the local offset.
 */
function parseUtcDateTime(value) {
  const parsed = hasIsoOffset(value) ? fromIsoFormat(value) : DateTime.fromISO(String(value).trim(), { zone: "utc" });
  if (parsed === null || !parsed.isValid) {
    return null;
  }
  return parsed.toUTC().toMillis();
}
