import { buildUtcTimeConversionNotes } from "../../date_utils.js";
import { t, tOptional } from "../../i18n.js";
import { collectorDefinition, draftCandidate, listingEntry } from "../base.js";
import { BaseNewsCollector } from "../runner.js";
import { ArticleParser } from "./article_parser.js";
import { OfficialNewsFetcher } from "./news_fetcher.js";

export const COLLECTOR_ID = "official_aniimo";
export const SOURCE_TYPE = "official_aniimo";

export const DEFINITION = collectorDefinition({
  collector_id: COLLECTOR_ID,
  source_type: SOURCE_TYPE,
  title_key: "collectors.official_aniimo.title",
  button_key: "buttons.collector_official_aniimo",
});

export class OfficialAniimoCollector extends BaseNewsCollector {
  static definition = DEFINITION;
  // The official site is the authoritative, full-detail source; never let it be
  // suppressed as a cross-source duplicate of a shorter social-media post.
  static participates_in_cross_source_dedup = false;

  constructor({ config, db, bot }) {
    super({ config, db, bot });
    this.fetcher = new OfficialNewsFetcher({
      news_url: config.official_news_url,
      api_url: config.official_news_api_url,
      region: config.official_news_region,
    });
    this.parser = new ArticleParser(this.fetcher, config.article_timezone);
  }

  missingGeminiWarning() {
    return t("collectors.official_aniimo.errors.missing_gemini_api_key");
  }

  async fetchListing() {
    const summaries = await this.fetcher.fetchRecentArticles();
    return summaries.map((summary) => listingEntry(summary.canonical_url, summary));
  }

  async parseEntry(entry) {
    const summary = entry.payload;
    const article = await this.parser.fetchAndParse(summary);
    const sourceId = article.canonical_url || summary.canonical_url;
    const sourceUrl = article.canonical_url || article.article_url;
    const hasMedia = Boolean(article.media_url && article.media_type === "photo");
    const articleDate = article.date_info !== null ? article.date_info.article_date : null;
    const articleDateDisplay = article.date_info !== null ? article.date_info.article_date_display : null;

    return draftCandidate({
      source_id: sourceId,
      source_url: sourceUrl,
      title: article.title,
      body_text: article.body_text || article.raw_excerpt || "",
      source_name: t("collectors.official_aniimo.source_name"),
      username: t("collectors.official_aniimo.username"),
      original_text: buildOriginalText(article, sourceUrl, this.config.article_timezone),
      article_date: articleDate,
      article_date_display: articleDateDisplay,
      has_media: hasMedia,
      media_url: article.media_url,
      media_type: article.media_type,
      additional_media_urls: hasMedia ? article.media_urls.slice(1) : null,
    });
  }
}

function buildOriginalText(article, sourceUrl, articleTimezone) {
  const parts = [
    t("collectors.common.original_text.article_title", { value: article.title }),
    t("collectors.common.original_text.article_url", { value: sourceUrl }),
  ];

  if (article.information_type) {
    // The API's `informationType`, so a moderator can tell a launch news post
    // from a maintenance/update notice at a glance. An unknown value is shown
    // as-is rather than hidden.
    const typeLabel = tOptional(
      `collectors.official_aniimo.original_text.types.${article.information_type}`,
      article.information_type,
    );
    parts.push(t("collectors.official_aniimo.original_text.information_type", { value: typeLabel }));
  }
  if (article.raw_date) {
    // The raw stamp carries no offset; label it so an admin reading the original
    // does not take it for Kyiv time.
    parts.push(t("collectors.common.original_text.original_article_date", { value: `${article.raw_date} (UTC+8)` }));
  }
  if (article.date_info !== null) {
    parts.push(
      t("collectors.common.original_text.converted_article_date", {
        value: article.date_info.article_date_display,
      }),
    );
  }

  const datetimeNotes = buildUtcTimeConversionNotes(article.body_text || article.raw_excerpt || "", {
    article_date: article.date_info !== null ? article.date_info.article_date : null,
    target_timezone: articleTimezone,
  });
  if (datetimeNotes) {
    parts.push("", "Конвертація UTC-часів для чернетки:", datetimeNotes);
  }

  if (article.body_text) {
    parts.push("", t("collectors.common.original_text.parsed_article_text"), article.body_text);
  } else if (article.raw_excerpt) {
    parts.push("", t("collectors.common.original_text.parsed_excerpt"), article.raw_excerpt);
  }

  if (article.media_urls.length) {
    const mediaLines = article.media_urls.map((mediaUrl) =>
      t("collectors.common.original_text.media_url", { value: mediaUrl }),
    );
    parts.push("", ...mediaLines, t("collectors.common.original_text.media_type", { value: article.media_type }));
  }

  return parts.join("\n").trim();
}
