import { t } from "../../i18n.js";
import { charLength, rsplitOnce, sliceChars } from "../../pyutils.js";
import { collectorDefinition, draftCandidate, listingEntry } from "../base.js";
import { BaseNewsCollector } from "../runner.js";
import { SteamFeedFetcher } from "./feed_fetcher.js";

export const COLLECTOR_ID = "steam";
export const SOURCE_TYPE = "steam";

export const TITLE_MAX_LENGTH = 140;
export const FALLBACK_TITLE = "Оголошення Aniimo у Steam";

export const DEFINITION = collectorDefinition({
  collector_id: COLLECTOR_ID,
  source_type: SOURCE_TYPE,
  title_key: "collectors.steam.title",
  button_key: "buttons.collector_steam",
});

export class SteamNewsCollector extends BaseNewsCollector {
  static definition = DEFINITION;

  // Steam repeats the announcements the site already published. The official
  // site runs first in the registry order, so a story that reached moderation
  // from there is dropped here as a cross-source duplicate instead of being
  // queued twice; an announcement Steam gets first still goes through.
  static participates_in_cross_source_dedup = true;

  constructor({ config, db, bot }) {
    super({ config, db, bot });
    this.fetcher = new SteamFeedFetcher(config.steam_feed_url);
  }

  missingGeminiWarning() {
    return t("collectors.steam.errors.missing_gemini_api_key");
  }

  async fetchListing() {
    const posts = await this.fetcher.fetchRecentPosts();
    return posts
      .filter((post) => post.title || post.body_text)
      .map((post) => listingEntry(post.post_id, post));
  }

  async parseEntry(entry) {
    const post = entry.payload;
    const hasMedia = Boolean(post.image_url);
    const extraImages = post.additional_image_urls ?? [];
    const title = deriveTitle(post.title);

    return draftCandidate({
      source_id: post.post_id,
      source_url: post.web_url,
      title,
      body_text: post.body_text,
      source_name: t("collectors.steam.source_name"),
      username: t("collectors.steam.username"),
      original_text: buildOriginalText(post, title),
      article_date: post.created_at,
      article_date_display: displayDate(post.created_at),
      has_media: hasMedia,
      media_url: hasMedia ? post.image_url : null,
      media_type: hasMedia ? "photo" : "none",
      // An update preview usually illustrates each headline feature; those
      // extra screenshots publish as one album instead of being thrown away.
      additional_media_urls: hasMedia && extraImages.length ? extraImages : null,
    });
  }
}

// Exported for the unit tests, which exercise the title rule directly.
export const __testing = { deriveTitle };

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

  if (post.body_text) {
    parts.push("", t("collectors.common.original_text.parsed_article_text"), post.body_text);
  }

  if (post.image_url) {
    parts.push(
      "",
      t("collectors.common.original_text.media_url", { value: post.image_url }),
      t("collectors.common.original_text.media_type", { value: "photo" }),
    );
  }

  return parts.join("\n").trim();
}
