import { t } from "../../i18n.js";
import { charLength, rsplitOnce, sliceChars } from "../../pyutils.js";
import { collectorDefinition, draftCandidate, listingEntry } from "../base.js";
import { BaseNewsCollector } from "../runner.js";
import { BlueskyFeedFetcher } from "./feed_fetcher.js";
import { resolveVideoBlobUrl } from "./video.js";

export const COLLECTOR_ID = "bluesky";
export const SOURCE_TYPE = "bluesky";

export const TITLE_MAX_LENGTH = 120;
export const FALLBACK_TITLE = "Допис Aniimo (Bluesky)";

export const DEFINITION = collectorDefinition({
  collector_id: COLLECTOR_ID,
  source_type: SOURCE_TYPE,
  title_key: "collectors.bluesky.title",
  button_key: "buttons.collector_bluesky",
});

export class BlueskyCollector extends BaseNewsCollector {
  static definition = DEFINITION;

  constructor({ config, db, bot }) {
    super({ config, db, bot });
    this.fetcher = new BlueskyFeedFetcher(config.bluesky_actor);
  }

  missingGeminiWarning() {
    return t("collectors.bluesky.errors.missing_gemini_api_key");
  }

  async fetchListing() {
    const posts = await this.fetcher.fetchRecentPosts();
    return posts
      .filter((post) => post.text || post.image_urls.length)
      .map((post) => listingEntry(post.uri, post));
  }

  async parseEntry(entry) {
    const post = entry.payload;
    const title = deriveTitle(post.text);
    const [hasMedia, mediaType, mediaUrl, additionalMediaUrls] = await this.resolveMedia(post);

    return draftCandidate({
      source_id: post.uri,
      source_url: post.web_url,
      title,
      body_text: post.text,
      source_name: t("collectors.bluesky.source_name"),
      username: t("collectors.bluesky.username"),
      original_text: buildOriginalText(post, title),
      article_date: post.created_at,
      article_date_display: displayDate(post.created_at),
      has_media: hasMedia,
      media_url: mediaUrl,
      media_type: mediaType,
      additional_media_urls: additionalMediaUrls,
    });
  }

  /**
   * Return [hasMedia, mediaType, mediaUrl, additionalUrls]. Photos win when
   * present; otherwise a video post is resolved to its direct MP4 blob URL
   * (downloaded + re-uploaded natively at send time). Falls back to a text post
   * when video download is disabled or the blob URL cannot be resolved.
   */
  async resolveMedia(post) {
    if (post.image_urls.length) {
      const additional = post.image_urls.slice(1);
      return [true, "photo", post.image_urls[0], additional.length ? additional : null];
    }

    const downloadEnabled = this.config.enable_bluesky_video_download ?? true;
    if (post.has_video && post.video_cid && downloadEnabled) {
      const blobUrl = await resolveVideoBlobUrl(post.author_did, post.video_cid);
      if (blobUrl) {
        return [true, "video", blobUrl, null];
      }
    }

    return [false, "none", null, null];
  }
}

function deriveTitle(text) {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return FALLBACK_TITLE;
  }

  if (charLength(firstLine) <= TITLE_MAX_LENGTH) {
    return firstLine;
  }

  const head = sliceChars(firstLine, 0, TITLE_MAX_LENGTH);
  const parts = rsplitOnce(head, " ");
  const truncated = (parts.length === 2 ? parts[0] : parts[0]).trim();
  return `${truncated || head.trim()}…`;
}

function displayDate(createdAt) {
  if (!createdAt) {
    return null;
  }

  return createdAt.slice(0, 10);
}

function buildOriginalText(post, title) {
  const parts = [
    t("collectors.common.original_text.article_title", { value: title }),
    t("collectors.common.original_text.article_url", { value: post.web_url }),
  ];

  if (post.created_at) {
    parts.push(t("collectors.common.original_text.original_article_date", { value: post.created_at }));
  }

  if (post.text) {
    parts.push("", t("collectors.common.original_text.parsed_article_text"), post.text);
  }

  if (post.image_urls.length) {
    const mediaLines = post.image_urls.map((imageUrl) =>
      t("collectors.common.original_text.media_url", { value: imageUrl }),
    );
    parts.push("", ...mediaLines, t("collectors.common.original_text.media_type", { value: "photo" }));
  } else if (post.has_video) {
    parts.push("", t("collectors.common.original_text.media_type", { value: "video" }));
  }

  return parts.join("\n").trim();
}
