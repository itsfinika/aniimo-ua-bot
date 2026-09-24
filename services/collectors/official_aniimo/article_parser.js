import { parseArticleDate } from "../../date_utils.js";
import { getText, loadHtml } from "../../html.js";
import { getLogger } from "../../logger.js";
import { charLength, collapseWhitespace, rsplitOnce, sliceChars } from "../../pyutils.js";
import { normalizeImageUrl } from "./news_fetcher.js";

const logger = getLogger("services.collectors.official_aniimo.article_parser");

export const MAX_ARTICLE_TEXT_LENGTH = 12000;
// Four, not Telegram's media-group maximum of ten, and the same number the
// generic media parser has always used.
//
// The limit is about layout, not capacity. Telegram lays a media group out by
// count: four images of one aspect ratio become an even 2x2 grid where each is
// the same size and a UI screenshot stays readable, while five turn into one
// letterboxed strip, one large image and a row of three thumbnails — which is
// how a five-screenshot walkthrough ended up looking shuffled even though the
// images were in the article's own order. Anything past the fourth is left to
// the "full details on the official site" link.
export const MAX_ARTICLE_MEDIA_ITEMS = 4;

// Every timestamp the API returns is server wall time in UTC+8 with no offset
// attached ("2026-09-22 00:00:12" for a post scheduled at "00:00 (UTC+8)").
export const SERVER_TIMEZONE = "Asia/Shanghai";

/**
 * @typedef {{id: string, title: string, canonical_url: string, article_url: string,
 *            information_type: string|null, raw_date: string|null,
 *            date_info: object|null, body_text: string, raw_excerpt: string|null,
 *            media_url: string|null, media_urls: string[], media_type: string}} ParsedArticle
 */

export class ArticleParser {
  constructor(fetcher, articleTimezone) {
    this.fetcher = fetcher;
    this.article_timezone = articleTimezone;
  }

  async fetchAndParse(summary) {
    const item = await this.fetcher.fetchArticle(summary.id);
    if (item === null) {
      logger.warning(`Using news-list fallback data for article ${summary.article_url}`);
      return this.fromSummary(summary);
    }

    try {
      return this.parse({ item, summary });
    } catch (error) {
      logger.exception(`Failed to parse article ${summary.article_url}`, error);
      return this.fromSummary(summary);
    }
  }

  parse({ item, summary }) {
    const content = typeof item.content === "string" ? item.content : "";
    const rawDate = pickRawDate(item) ?? summary.raw_date;
    const title = cleanText(item.title ?? "") || summary.title;
    const rawExcerpt = cleanText(item.describe ?? "") || summary.raw_excerpt;
    const informationType = cleanText(item.informationType ?? "") || summary.information_type;

    let bodyText = extractBodyText(content);
    if (!bodyText && rawExcerpt) {
      bodyText = rawExcerpt;
    }
    bodyText = truncateText(bodyText, MAX_ARTICLE_TEXT_LENGTH);

    const coverUrl = normalizeImageUrl(item.mainPic, summary.article_url) ?? summary.cover_image_url;
    const media = collectArticleMedia(coverUrl, content, summary.article_url);

    return {
      id: summary.id,
      title,
      canonical_url: summary.canonical_url,
      article_url: summary.article_url,
      information_type: informationType,
      raw_date: rawDate,
      date_info: parseServerDate(rawDate, this.article_timezone),
      body_text: bodyText,
      raw_excerpt: rawExcerpt,
      media_url: media.media_url,
      media_urls: media.media_urls,
      media_type: media.media_type,
    };
  }

  fromSummary(summary) {
    return {
      id: summary.id,
      title: summary.title,
      canonical_url: summary.canonical_url,
      article_url: summary.article_url,
      information_type: summary.information_type,
      raw_date: summary.raw_date,
      date_info: parseServerDate(summary.raw_date, this.article_timezone),
      body_text: summary.raw_excerpt || "",
      raw_excerpt: summary.raw_excerpt,
      media_url: summary.cover_image_url,
      media_urls: summary.cover_image_url ? [summary.cover_image_url] : [],
      media_type: summary.cover_image_url ? "photo" : "none",
    };
  }
}

/**
 * The API's "2026-09-22 00:00:12" server stamp as the same `date_info` record
 * every other collector stores: the instant re-expressed in ARTICLE_TIMEZONE
 * with its offset, plus the Ukrainian display string. A bare "2026-09-22" keeps
 * its calendar date and no time, exactly as a date-only card date does.
 *
 * @returns {{original: string, article_date: string, article_date_display: string, has_time: boolean} | null}
 */
export function parseServerDate(value, targetTimezone) {
  return parseArticleDate(value, targetTimezone, { assumeZone: SERVER_TIMEZONE });
}

/**
 * The article body as one text block per heading/paragraph/list item, with the
 * editor's `<span style>` wrappers and empty `<p><br></p>` spacers dropped.
 * Repeated blocks are kept once, as the old HTML parser did.
 */
export function extractBodyText(html) {
  if (!String(html ?? "").trim()) {
    return "";
  }

  const $ = loadHtml(html);
  const container = $.root();
  container.find("script, style, noscript, iframe").remove();

  const blocks = [];
  const seen = new Set();
  container.find("h2, h3, h4, p, li").each((_index, element) => {
    const text = normalizeBodyText(getText($(element)));
    if (!text || seen.has(text)) {
      return;
    }

    seen.add(text);
    blocks.push(text);
  });

  if (blocks.length) {
    return blocks.join("\n");
  }

  return normalizeBodyText(getText(container));
}

/**
 * The editor emits the zone marker in CJK fullwidth parentheses — "10:00（UTC+8）"
 * — which the date converter's `(UTC+8)` pattern would not recognise. The
 * markup also splits a sentence across spans, so the joined text carries a
 * space before the punctuation that closes it ("(UTC+8) ."); it is tidied here
 * rather than left for the model to copy.
 */
export function normalizeBodyText(value) {
  return collapseWhitespace(String(value).replaceAll("（", "(").replaceAll("）", ")")).replace(
    /\s+([.,;:!?])(?=\s|$)/g,
    "$1",
  );
}

/**
 * The listing cover first, then every `<img src>` of the body in document
 * order — site-hosted photos only, deduplicated, at most MAX_ARTICLE_MEDIA_ITEMS.
 *
 * @returns {{media_urls: string[], media_type: string, media_url: string|null}}
 */
export function collectArticleMedia(coverUrl, html, pageUrl) {
  const candidates = [];
  if (coverUrl) {
    candidates.push(coverUrl);
  }

  if (String(html ?? "").trim()) {
    const $ = loadHtml(html);
    $("img[src], img[data-src], img[data-original]").each((_index, element) => {
      const image = $(element);
      const src = image.attr("src") || image.attr("data-src") || image.attr("data-original");
      if (src) {
        candidates.push(String(src));
      }
    });
  }

  const selectedUrls = [];
  const seenUrls = new Set();
  for (const candidate of candidates) {
    const mediaUrl = normalizeImageUrl(candidate, pageUrl);
    if (!mediaUrl || seenUrls.has(mediaUrl)) {
      continue;
    }
    seenUrls.add(mediaUrl);
    selectedUrls.push(mediaUrl);
    if (selectedUrls.length >= MAX_ARTICLE_MEDIA_ITEMS) {
      break;
    }
  }

  if (selectedUrls.length) {
    return { media_urls: selectedUrls, media_type: "photo", media_url: selectedUrls[0] };
  }

  return { media_urls: [], media_type: "none", media_url: null };
}

function pickRawDate(item) {
  for (const field of ["publishTime", "showTime", "createTime"]) {
    const value = cleanText(item[field] ?? "");
    if (value) {
      return value;
    }
  }
  return null;
}

function cleanText(value) {
  return collapseWhitespace(String(value));
}

function truncateText(value, maxLength) {
  if (charLength(value) <= maxLength) {
    return value;
  }

  const head = sliceChars(value, 0, maxLength);
  const parts = rsplitOnce(head, "\n");
  const truncated = (parts.length === 2 ? parts[0] : parts[0]).trim();
  return truncated || head.trim();
}
