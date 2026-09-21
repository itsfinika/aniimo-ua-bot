import { t } from "../../i18n.js";
import { getLogger } from "../../logger.js";
import { charLength, collapseWhitespace, rsplitOnce, sliceChars, WORD } from "../../pyutils.js";
import { collectorDefinition, draftCandidate, listingEntry } from "../base.js";
import { BaseNewsCollector } from "../runner.js";
import { YouTubeFeedFetcher } from "./feed_fetcher.js";

const logger = getLogger("services.collectors.youtube.collector");

export const COLLECTOR_ID = "youtube";
export const SOURCE_TYPE = "youtube";

export const TITLE_MAX_LENGTH = 140;
export const FALLBACK_TITLE = "Нове відео Aniimo (YouTube)";

export const DEFINITION = collectorDefinition({
  collector_id: COLLECTOR_ID,
  source_type: SOURCE_TYPE,
  title_key: "collectors.youtube.title",
  button_key: "buttons.collector_youtube",
});

export class YouTubeCollector extends BaseNewsCollector {
  static definition = DEFINITION;

  constructor({ config, db, bot }) {
    super({ config, db, bot });
    this.fetcher = new YouTubeFeedFetcher(config.youtube_channel_id);
    this.exclude_keywords = config.youtube_exclude_keywords;
  }

  missingGeminiWarning() {
    return t("collectors.youtube.errors.missing_gemini_api_key");
  }

  async fetchListing() {
    const videos = await this.fetcher.fetchRecentVideos();
    const bestByKey = new Map();
    const order = [];
    for (const video of videos) {
      if (!video.title && !video.description) {
        continue;
      }
      if (isExcluded(video.title, this.exclude_keywords)) {
        logger.info(`Skipping excluded YouTube video ${JSON.stringify(video.title)}`);
        continue;
      }

      // Collapse the channel's re-uploads of the same trailer (different video
      // IDs, identical normalised title) to a single entry. Among the collapsed
      // variants prefer the one that carries a description: the channel ships
      // the same trailer both as a Short (no description) and as a full /watch
      // upload (full description), and the AI draft needs that text — so a
      // description-less Short must never hide the richer upload, regardless of
      // feed order. Otherwise keep the newest (videos are sorted newest-first).
      const key = dedupKey(video);
      const existing = bestByKey.get(key);
      if (existing === undefined) {
        bestByKey.set(key, video);
        order.push(key);
      } else if (isRicherVariant(video, existing)) {
        bestByKey.set(key, video);
      }
    }

    return order.map((key) => listingEntry(key, bestByKey.get(key)));
  }

  async parseEntry(entry) {
    const video = entry.payload;
    const title = deriveTitle(video.title);

    // No attached photo: a YouTube post is published as text with the watch link
    // so Telegram renders a PLAYABLE video preview instead of a static thumbnail
    // (the publisher enables the link preview for the "youtube" source).
    return draftCandidate({
      // source_id mirrors the normalised-title dedup_key so a later re-upload of
      // the same trailer (new video id) is recognised as already seen.
      source_id: entry.dedup_key,
      source_url: video.web_url,
      title,
      body_text: video.description,
      source_name: t("collectors.youtube.source_name"),
      username: t("collectors.youtube.username"),
      original_text: buildOriginalText(video, title),
      article_date: video.published,
      article_date_display: displayDate(video.published),
      has_media: false,
      media_url: null,
      media_type: "none",
      additional_media_urls: null,
    });
  }
}

// Exported for the unit tests, which exercise the dedup/exclusion rules directly.
export const __testing = { dedupKey, isExcluded, normalizeTitle, deriveTitle };

function normalizeTitle(title) {
  // `[^\w\s]` with Python's Unicode `\w`: punctuation only, never a Cyrillic or
  // Latin letter — JavaScript's ASCII-only `\w` would strip both.
  const cleaned = title.toLowerCase().replace(new RegExp(`[^${WORD.slice(1, -1)}\\s]`, "gu"), " ");
  return collapseWhitespace(cleaned);
}

function dedupKey(video) {
  const normalized = normalizeTitle(video.title);
  if (normalized) {
    // Scope the title key to the publish DAY: the channel's same-trailer
    // re-uploads land minutes apart (same day) so they still collapse, while a
    // verbatim title legitimately reused on another day is treated as new
    // rather than dropped forever (seen_sources has no TTL).
    const day = video.published ? video.published.slice(0, 10) : "";
    return `yt-title:${day}:${normalized}`;
  }
  return `yt-video:${video.video_id}`;
}

/**
 * Whether `candidate` should replace an already-collapsed `current` of the same
 * trailer. Prefer a variant that actually carries a description (the full /watch
 * upload) over a description-less one (a Short). Equal cases keep the first-seen
 * (newest) variant.
 */
function isRicherVariant(candidate, current) {
  return Boolean(candidate.description.trim()) && !current.description.trim();
}

function isExcluded(title, excludeKeywords) {
  if (!title) {
    return false;
  }
  const lowered = title.toLowerCase();
  for (const keyword of excludeKeywords) {
    if (lowered.includes(keyword)) {
      return true;
    }
  }
  return false;
}

function deriveTitle(title) {
  const stripped = title.trim();
  if (!stripped) {
    return FALLBACK_TITLE;
  }

  if (charLength(stripped) <= TITLE_MAX_LENGTH) {
    return stripped;
  }

  const head = sliceChars(stripped, 0, TITLE_MAX_LENGTH);
  const parts = rsplitOnce(head, " ");
  const truncated = (parts.length === 2 ? parts[0] : parts[0]).trim();
  return `${truncated || head.trim()}…`;
}

function displayDate(published) {
  if (!published) {
    return null;
  }

  return published.slice(0, 10);
}

function buildOriginalText(video, title) {
  const parts = [
    t("collectors.common.original_text.article_title", { value: title }),
    t("collectors.common.original_text.article_url", { value: video.web_url }),
  ];

  if (video.published) {
    parts.push(t("collectors.common.original_text.original_article_date", { value: video.published }));
  }

  if (video.description) {
    parts.push("", t("collectors.common.original_text.parsed_article_text"), video.description);
  }

  if (video.thumbnail_url) {
    parts.push(
      "",
      t("collectors.common.original_text.media_url", { value: video.thumbnail_url }),
      t("collectors.common.original_text.media_type", { value: "photo (прев'ю відео)" }),
    );
  }

  return parts.join("\n").trim();
}
