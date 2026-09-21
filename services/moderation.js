import { moderationKeyboard } from "../keyboards.js";
import { formatAdminPreview } from "./formatter.js";
import { t } from "./i18n.js";
import { getLogger } from "./logger.js";
import { formatPostHtml, submissionAllowsSourceLink } from "./post_footer.js";
import { htmlUnescape } from "./pyutils.js";
import {
  DISABLED_LINK_PREVIEW,
  TELEGRAM_CAPTION_LIMIT,
  albumCaptionHtml,
  albumItems,
  linkPreviewOptionsFor,
  youtubeVideoUrl,
  needsExternalVideoDownload,
  sendAlbumMessage,
  sendDocument,
  sendDownloadedVideoPost,
  sendPhoto,
  sendVideo,
  sendYoutubePost,
} from "./publisher.js";
import { isTelegramSendFailure } from "./telegram_errors.js";
import { delayBetweenTelegramSends, sendWithRetries } from "./telegram_retry.js";

const logger = getLogger("services.moderation");

export class ModerationSendError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "ModerationSendError";
  }
}

/** @typedef {{content_message_id: number, media_message_id: number|null}} SentModerationPart */

function sentModerationPart(contentMessageId, mediaMessageId = null) {
  return { content_message_id: contentMessageId, media_message_id: mediaMessageId };
}

export async function sendSubmissionToModeration(bot, config, db, submissionId) {
  let submission = await db.getSubmission(submissionId);
  if (submission === null) {
    throw new ModerationSendError(`Submission ${submissionId} was not found`);
  }

  await sendSubmissionPartsToModeration(bot, config, db, submission);

  submission = (await db.getSubmission(submissionId)) || submission;
  let adminMessage;
  try {
    await delayBetweenTelegramSends();
    adminMessage = await sendWithRetries(
      (signal) =>
        bot.api.sendMessage(
          config.admin_chat_id,
          formatAdminPreview(submission),
          {
            reply_markup: moderationKeyboard(submissionId),
            parse_mode: "HTML",
            link_preview_options: DISABLED_LINK_PREVIEW,
          },
          signal,
        ),
      { label: `admin moderation preview for submission ${submissionId}` },
    );
  } catch (error) {
    if (!isTelegramSendFailure(error)) {
      throw error;
    }
    throw new ModerationSendError("Failed to send admin moderation preview", { cause: error });
  }

  await db.setAdminMessageId(submissionId, adminMessage.message_id);
  logger.info(
    `Sent submission ${submissionId} to admin moderation queue as message ${adminMessage.message_id}`,
  );
}

async function sendSubmissionPartsToModeration(bot, config, db, submission) {
  if (String(submission.message_type || "") === "album") {
    await sendAlbumToModeration(bot, config, submission);
    return;
  }

  const parts = [...(submission.parts ?? [])];
  for (let position = 0; position < parts.length; position += 1) {
    const part = parts[position];
    const partIndex = Number(part.part_index);
    const partWithContext = { ...submission, ...part, id: submission.id };
    let sentPart;
    try {
      sentPart = await sendPartMessage(bot, config, config.admin_chat_id, partWithContext);
    } catch (error) {
      if (!isTelegramSendFailure(error)) {
        throw error;
      }
      throw new ModerationSendError(
        `Failed to send submission ${submission.id} part ${partIndex} to moderation`,
        { cause: error },
      );
    }

    await db.setSubmissionPartAdminMessageId(Number(submission.id), partIndex, sentPart.content_message_id);
    if (hasMedia(part) && partIndex === 1) {
      await db.setAdminMediaMessageId(Number(submission.id), sentPart.media_message_id);
    }

    logger.info(
      `Sent submission ${submission.id} part ${partIndex} to admin moderation queue ` +
        `as message ${sentPart.content_message_id}`,
    );
    if (position < parts.length - 1) {
      await delayBetweenTelegramSends();
    }
  }
}

/**
 * Preview an album submission for the admins: the media group plus the same
 * caption (with footer/links) that will be published.
 */
async function sendAlbumToModeration(bot, config, submission) {
  const items = albumItems(submission);
  const caption = albumCaptionHtml(submission);
  try {
    await sendAlbumMessage(bot, config.admin_chat_id, items, caption);
  } catch (error) {
    if (!isTelegramSendFailure(error)) {
      throw error;
    }
    throw new ModerationSendError(`Failed to send album submission ${submission.id} to moderation`, {
      cause: error,
    });
  }
}

async function sendPartMessage(bot, config, chatId, part) {
  const messageType = String(part.message_type || "text");
  const text = formatPartForModeration(String(part.text || ""), part);
  const fileId = part.file_id;
  const mediaUrl = part.media_url;
  const mediaValue = fileId || mediaUrl;
  const usesExternalMedia = !fileId && Boolean(mediaUrl);

  // A YouTube post is text + a link; preview it the SAME way it will be published
  // — as a native inline video (downloaded), falling back to a playable link
  // preview — so the admin approves exactly what goes out. That covers both the
  // collector, whose link is the stored source URL, and a reader who dropped a
  // YouTube link into the bot, whose link is in the text they sent.
  const youtubeUrl = ["text", "link"].includes(messageType) ? youtubeVideoUrl(part) : null;
  if (config.enable_youtube_video_download && youtubeUrl) {
    const sent = await sendYoutubePost(bot, chatId, youtubeUrl, text, {
      parseMode: "HTML",
      linkPreview: linkPreviewOptionsFor(part),
      maxBytes: Math.max(1, config.youtube_video_max_mb) * 1024 * 1024,
      cookie: config.youtube_cookie,
      usePoToken: config.enable_youtube_po_token,
    });
    if (sent !== null && sent !== undefined) {
      return sentModerationPart(sent.message_id);
    }
  }

  // A Bluesky (or other external-URL) video is downloaded and previewed as a
  // native inline video — exactly as it will be published — with a text fallback.
  if (needsExternalVideoDownload(part)) {
    const sent = await sendDownloadedVideoPost(bot, chatId, String(part.media_url || ""), text, {
      parseMode: "HTML",
      linkPreview: linkPreviewOptionsFor(part),
      maxBytes: Math.max(1, config.bluesky_video_max_mb) * 1024 * 1024,
    });
    // The single returned message carries the preview (native video or text
    // fallback); point both ids at it so cleanup deletes the right message.
    return sentModerationPart(sent.message_id, sent.message_id);
  }

  if (messageType === "photo" && mediaValue) {
    return sendMediaPart(bot, sendPhoto(bot), {
      chatId,
      mediaValue,
      text,
      shortCaption: shortMediaCaption(part),
      usesExternalMedia,
      fallbackLabel: "photo",
    });
  }
  if (messageType === "video" && mediaValue) {
    return sendMediaPart(bot, sendVideo(bot), {
      chatId,
      mediaValue,
      text,
      shortCaption: shortMediaCaption(part),
      usesExternalMedia,
      fallbackLabel: "video",
    });
  }
  if (messageType === "document" && mediaValue) {
    return sendMediaPart(bot, sendDocument(bot), {
      chatId,
      mediaValue,
      text,
      shortCaption: shortMediaCaption(part),
      usesExternalMedia,
      fallbackLabel: "document",
    });
  }

  const message = await sendWithRetries(
    (signal) =>
      bot.api.sendMessage(
        chatId,
        text || t("formatter.empty"),
        { parse_mode: "HTML", link_preview_options: linkPreviewOptionsFor(part) },
        signal,
      ),
    { label: "moderation text part" },
  );
  return sentModerationPart(message.message_id);
}

async function sendMediaPart(
  bot,
  sendMedia,
  { chatId, mediaValue, text, shortCaption, usesExternalMedia, fallbackLabel },
) {
  try {
    if (text && htmlVisibleLength(text) > TELEGRAM_CAPTION_LIMIT) {
      const mediaMessage = await sendWithRetries(
        (signal) => sendMedia(chatId, mediaValue, { caption: shortCaption, parse_mode: "HTML" }, signal),
        { label: `moderation ${fallbackLabel} media without long caption` },
      );
      await delayBetweenTelegramSends();
      const textMessage = await sendWithRetries(
        (signal) =>
          bot.api.sendMessage(
            chatId,
            text,
            { parse_mode: "HTML", link_preview_options: DISABLED_LINK_PREVIEW },
            signal,
          ),
        { label: `moderation text fallback for long ${fallbackLabel} caption` },
      );
      return sentModerationPart(textMessage.message_id, mediaMessage.message_id);
    }

    const mediaMessage = await sendWithRetries(
      (signal) => sendMedia(chatId, mediaValue, { caption: text || undefined, parse_mode: "HTML" }, signal),
      { label: `moderation ${fallbackLabel} media part` },
    );
    return sentModerationPart(mediaMessage.message_id, mediaMessage.message_id);
  } catch (error) {
    if (!isTelegramSendFailure(error)) {
      throw error;
    }
    if (!usesExternalMedia) {
      throw error;
    }

    logger.exception(`Failed to send external ${fallbackLabel} to moderation. Falling back to text-only.`, error);
    const textMessage = await sendWithRetries(
      (signal) =>
        bot.api.sendMessage(
          chatId,
          text || t("formatter.empty"),
          { parse_mode: "HTML", link_preview_options: DISABLED_LINK_PREVIEW },
          signal,
        ),
      { label: `moderation text-only fallback for failed ${fallbackLabel}` },
    );
    return sentModerationPart(textMessage.message_id);
  }
}

function formatPartForModeration(text, part) {
  return formatPostHtml(text, {
    source_url: String(part.source_url || ""),
    source_type: part.source_type,
    allow_source_link: submissionAllowsSourceLink(part),
    include_community_footer: true,
  });
}

function htmlVisibleLength(text) {
  const withoutTags = text.replace(/<[^>]+>/g, "");
  return htmlUnescape(withoutTags).length;
}

function hasMedia(part) {
  return (
    ["photo", "video", "document"].includes(String(part.message_type || "")) &&
    Boolean(part.file_id || part.media_url)
  );
}

function shortMediaCaption(part) {
  const submissionId = part.submission_id;
  if (submissionId) {
    return `Медіа до заявки #${submissionId}`;
  }

  return "Медіа до заявки";
}
