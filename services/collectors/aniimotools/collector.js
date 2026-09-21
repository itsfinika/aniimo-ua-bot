import { t } from "../../i18n.js";
import { charLength, rsplitOnce, sliceChars } from "../../pyutils.js";
import { collectorDefinition, draftCandidate, listingEntry } from "../base.js";
import { BaseNewsCollector } from "../runner.js";
import { AniimoToolsFeedFetcher } from "./feed_fetcher.js";

export const COLLECTOR_ID = "aniimotools";
export const SOURCE_TYPE = "aniimotools";

export const TITLE_MAX_LENGTH = 140;
export const FALLBACK_TITLE = "Новина Aniimo (Aniimo Tools)";

export const DEFINITION = collectorDefinition({
  collector_id: COLLECTOR_ID,
  source_type: SOURCE_TYPE,
  title_key: "collectors.aniimotools.title",
  button_key: "buttons.collector_aniimotools",
});

export class AniimoToolsCollector extends BaseNewsCollector {
  static definition = DEFINITION;

  constructor({ config, db, bot }) {
    super({ config, db, bot });
    this.fetcher = new AniimoToolsFeedFetcher(config.aniimotools_feed_url);
  }

  missingGeminiWarning() {
    return t("collectors.aniimotools.errors.missing_gemini_api_key");
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
      source_name: t("collectors.aniimotools.source_name"),
      username: t("collectors.aniimotools.username"),
      original_text: buildOriginalText(post, title),
      article_date: post.created_at,
      article_date_display: displayDate(post.created_at),
      has_media: hasMedia,
      media_url: hasMedia ? post.image_url : null,
      media_type: hasMedia ? "photo" : "none",
      // An article often illustrates a notice with several screenshots; those
      // extra pictures publish as one album instead of being thrown away.
      additional_media_urls: hasMedia && extraImages.length ? extraImages : null,
    });
  }
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
