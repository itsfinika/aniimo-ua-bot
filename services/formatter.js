import { t, tOptional } from "./i18n.js";
import { formatPostHtml } from "./post_footer.js";
import { charLength, htmlEscape, pyTitle, rstrip, sliceChars } from "./pyutils.js";

export const MAX_PREVIEW_TEXT_LENGTH = 1200;
export const MAX_SOURCE_DRAFT_PREVIEW_LENGTH = 800;

export function formatAdminPreview(submission) {
  if (submission.source_type) {
    return formatSourceAdminPreview(submission);
  }

  const username = submission.username;
  const usernameText = username ? `@${htmlEscape(username)}` : t("formatter.none");
  const status = String(submission.status);
  const statusText = tOptional(`status.${status}`, status);

  return [
    `<b>${htmlEscape(t("formatter.labels.title", { submission_id: submission.id }))}</b>`,
    `<b>${htmlEscape(t("formatter.labels.author"))}:</b> ${usernameText}`,
    `<b>${htmlEscape(t("formatter.labels.user_id"))}:</b> <code>${submission.user_id}</code>`,
    `<b>${htmlEscape(t("formatter.labels.type"))}:</b> <code>${htmlEscape(String(submission.message_type))}</code>`,
    ...albumMediaLines(submission),
    `<b>${htmlEscape(t("formatter.labels.file"))}:</b> ${formatFileId(submission.file_id)}`,
    `<b>${htmlEscape(t("formatter.labels.media_url"))}:</b> ${formatInlineValue(submission.media_url)}`,
    `<b>${htmlEscape(t("formatter.labels.source_url"))}:</b> ${formatInlineValue(submission.source_url)}`,
    `<b>${htmlEscape(t("formatter.labels.article_date"))}:</b> ` +
      `${formatInlineValue(submission.article_date_display)}`,
    `<b>${htmlEscape(t("formatter.labels.tags"))}:</b> ${formatTags(submission.tags)}`,
    `<b>${htmlEscape(t("formatter.labels.media_message"))}:</b> ` +
      `${formatMessageId(submission.admin_media_message_id)}`,
    "",
    `<b>${htmlEscape(t("formatter.labels.status"))}:</b> <code>${htmlEscape(statusText)}</code>`,
    `<b>${htmlEscape(t("formatter.labels.created_at"))}:</b> <code>${htmlEscape(String(submission.created_at))}</code>`,
    `<b>${htmlEscape(t("formatter.labels.updated_at"))}:</b> <code>${htmlEscape(String(submission.updated_at))}</code>`,
    `<b>${htmlEscape(t("formatter.labels.published_at"))}:</b> ` +
      `<code>${htmlEscape(String(submission.published_at || t("formatter.dash")))}</code>`,
  ].join("\n");
}

function formatSourceAdminPreview(submission) {
  const status = String(submission.status);
  const statusText = tOptional(`status.${status}`, status);
  const title = extractArticleTitle(String(submission.original_text || ""));
  const sourceLabel = formatSourceLabel(String(submission.source_type || ""));
  const category = detectSourceCategory(submission.tags);

  return [
    `<b>${htmlEscape(t("formatter.labels.title", { submission_id: submission.id }))}</b>`,
    `<b>Джерело:</b> <code>${htmlEscape(sourceLabel)}</code>`,
    `<b>Заголовок:</b> ${formatInlinePlain(title)}`,
    `<b>Тип:</b> ${formatInlinePlain(category)}`,
    `<b>${htmlEscape(t("formatter.labels.article_date"))}:</b> ` +
      `${formatInlineValue(submission.article_date_display)}`,
    "",
    "<b>Чернетка:</b>",
    formatSourcePublicDraftBlock(submission),
    "",
    `<b>${htmlEscape(t("formatter.labels.source_url"))}:</b> ${formatInlineValue(submission.source_url)}`,
    `<b>${htmlEscape(t("formatter.labels.media_url"))}:</b> ${formatInlineValue(submission.media_url)}`,
    `<b>${htmlEscape(t("formatter.labels.tags"))}:</b> ${formatTags(submission.tags)}`,
    `<b>${htmlEscape(t("formatter.labels.status"))}:</b> <code>${htmlEscape(statusText)}</code>`,
  ].join("\n");
}

function formatSourcePublicDraftBlock(submission) {
  return formatPostHtml(String(submission.draft_text || ""), {
    source_url: String(submission.source_url || ""),
    source_type: submission.source_type,
    allow_source_link: true,
    include_community_footer: true,
  });
}

/**
 * For an album, what the group actually holds — "3 (фото 2, відео 1)".
 *
 * The media group is previewed above the card, but the counts say at a glance
 * whether every item made it through, and of what kind.
 */
function albumMediaLines(submission) {
  const parts = submission.parts ?? [];
  if (String(submission.message_type || "") !== "album" || parts.length < 2) {
    return [];
  }

  const counts = new Map();
  for (const part of parts) {
    const type = String(part.media_type || "photo");
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const breakdown = [...counts].map(([type, count]) => `${type} ${count}`).join(", ");

  return [
    `<b>${htmlEscape(t("formatter.labels.album_media"))}:</b> ` +
      `<code>${htmlEscape(`${parts.length} (${breakdown})`)}</code>`,
  ];
}

function formatFileId(fileId) {
  if (!fileId) {
    return `<i>${htmlEscape(t("formatter.none"))}</i>`;
  }

  return `<code>${htmlEscape(shortFileId(fileId))}</code>`;
}

function formatInlineValue(value) {
  if (value === null || value === undefined || value === "") {
    return `<i>${htmlEscape(t("formatter.none"))}</i>`;
  }

  return `<code>${htmlEscape(truncate(String(value), 160))}</code>`;
}

function formatInlinePlain(value) {
  if (value === null || value === undefined || value === "") {
    return `<i>${htmlEscape(t("formatter.none"))}</i>`;
  }

  return htmlEscape(truncate(String(value), 180));
}

function formatMessageId(messageId) {
  if (messageId === null || messageId === undefined) {
    return `<i>${htmlEscape(t("formatter.none"))}</i>`;
  }

  return `<code>${htmlEscape(String(messageId))}</code>`;
}

function formatTags(tags) {
  if (!tags || (Array.isArray(tags) && tags.length === 0)) {
    return `<i>${htmlEscape(t("formatter.none"))}</i>`;
  }

  const values = Array.isArray(tags)
    ? tags.map((tag) => String(tag)).filter((tag) => tag.trim())
    : [String(tags)];

  if (!values.length) {
    return `<i>${htmlEscape(t("formatter.none"))}</i>`;
  }

  return values.map((value) => `<code>${htmlEscape(value)}</code>`).join(", ");
}

function shortFileId(fileId) {
  if (fileId.length <= 24) {
    return fileId;
  }

  return `${fileId.slice(0, 10)}…${fileId.slice(-10)}`;
}

function extractArticleTitle(originalText) {
  const prefix = t("collectors.common.original_text.article_title", { value: "" });
  for (const line of originalText.split("\n")) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trim();
    }
  }

  return null;
}

export const SOURCE_LABELS = {
  official_aniimo: "Official Aniimo",
  steam: "Steam",
  bluesky: "Bluesky",
  youtube: "YouTube",
  reddit: "Reddit",
  aniimotools: "Aniimo Tools",
  wiki_aniimo: "Wiki Aniimo",
};

function formatSourceLabel(sourceType) {
  if (!sourceType) {
    return t("formatter.none");
  }

  return SOURCE_LABELS[sourceType] || pyTitle(sourceType.replaceAll("_", " "));
}

function detectSourceCategory(tags) {
  let normalizedTags;
  if (Array.isArray(tags)) {
    normalizedTags = new Set(tags.map((tag) => String(tag).trim().toLowerCase()));
  } else if (tags) {
    normalizedTags = new Set([String(tags).trim().toLowerCase()]);
  } else {
    normalizedTags = new Set();
  }

  // Keyed on the topic hashtags gemini.js stores (without the "#"), so the admin
  // card's "Тип" line follows the same rules that picked the post's tags.
  const categoryRules = [
    [["патч", "фікси", "баланс"], "Patch notes / game update"],
    [["магазин", "косметика"], "Shop / cosmetics / bundles"],
    [["івент"], "Event / rewards"],
    [["трейлер"], "Trailer / teaser"],
    [["спільнота"], "Vote / community"],
    [["аніімо", "сюжет"], "Aniimo / story"],
    [["локації", "геймплей"], "Map / gameplay"],
    [["технічніроботи"], "Maintenance"],
    [["рейтинг"], "Ranked / competitive"],
    [["версія"], "Version / roadmap"],
    [["мобільна", "платформи"], "Platforms / mobile"],
    [["бета"], "Beta / test"],
    [["креатори"], "Creators"],
    [["анонс"], "Short announcement"],
  ];
  for (const [ruleTags, label] of categoryRules) {
    if (ruleTags.some((tag) => normalizedTags.has(tag))) {
      return label;
    }
  }

  return t("formatter.none");
}

function truncate(value, maxLength) {
  if (charLength(value) <= maxLength) {
    return value;
  }
  return `${rstrip(sliceChars(value, 0, maxLength - 1))}…`;
}
