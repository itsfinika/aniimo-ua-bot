import { getLogger } from "../../logger.js";
import { PHOTO_EXTENSIONS } from "../../media_parser.js";
import { collapseWhitespace, errorText } from "../../pyutils.js";
import { urljoin, urlsplit } from "../../urlutils.js";

const logger = getLogger("services.collectors.official_aniimo.news_fetcher");

export const USER_AGENT = "AniimoUACollector/1.0 (Telegram news bot; +https://t.me/AniimoUABot)";
export const REQUEST_TIMEOUT_SECONDS = 20.0;

// The JSON API behind www.aniimo.com/newslist. The listing is fetched with
// `hasContent=false` (bodies come from the detail endpoint one article at a
// time) and sized to comfortably cover a whole day of posts plus the pinned one.
export const LISTING_PATH = "/api/information/list";
export const DETAIL_PATH = "/api/information/new";
export const LISTING_PAGE_SIZE = 20;

// Only the site's own CDN (worldx-website-cdn.aniimo.com) hosts article images.
// The suffix check keeps a hotlinked third-party picture from ever being sent to
// Telegram as an "official" photo.
const IMAGE_HOST_SUFFIX = "aniimo.com";

/**
 * @typedef {{id: string, title: string, canonical_url: string, article_url: string,
 *            information_type: string|null, raw_date: string|null,
 *            raw_excerpt: string|null, cover_image_url: string|null}} NewsArticleSummary
 */

/**
 * GET a JSON endpoint of the official API. Returns the decoded body, or null on
 * any transport/HTTP/decoding failure — the collector treats every failure as
 * "nothing new this tick" and never lets it propagate out of a poll.
 */
export async function fetchJson(url, region) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", Region: region },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    logger.warning(`Failed to fetch ${url}: ${errorText(error)}`);
    return null;
  }
}

export class OfficialNewsFetcher {
  constructor({ news_url, api_url, region }) {
    this.news_url = news_url;
    this.api_url = api_url;
    this.region = region;
  }

  listingUrl() {
    const params = new URLSearchParams({
      pageNum: "1",
      pageSize: String(LISTING_PAGE_SIZE),
      hasPublish: "1",
      type: "latest",
      hasContent: "false",
      region: this.region,
    });
    return `${apiBase(this.api_url)}${LISTING_PATH}?${params}`;
  }

  detailUrl(id) {
    const params = new URLSearchParams({ id: String(id) });
    return `${apiBase(this.api_url)}${DETAIL_PATH}?${params}`;
  }

  /** @returns {Promise<NewsArticleSummary[]>} newest first. */
  async fetchRecentArticles() {
    const payload = await fetchJson(this.listingUrl(), this.region);
    if (payload === null) {
      return [];
    }

    let articles;
    try {
      articles = parseOfficialNewsList(payload, this.news_url);
    } catch (error) {
      logger.exception("Failed to parse official Aniimo news list", error);
      return [];
    }

    if (!articles.length) {
      logger.warning(`No articles found in the official news listing ${this.listingUrl()}`);
    } else {
      logger.info(`Found ${articles.length} official Aniimo news articles`);
    }

    return articles;
  }

  /**
   * The full article object (the listing item plus its `content` HTML), or null
   * when the detail endpoint fails or answers with anything but a 200 envelope.
   */
  async fetchArticle(id) {
    const url = this.detailUrl(id);
    const payload = await fetchJson(url, this.region);
    if (payload === null) {
      return null;
    }

    if (!isOkEnvelope(payload) || !isRecord(payload.data)) {
      logger.warning(`Official news detail ${url} answered ${describeEnvelope(payload)}`);
      return null;
    }

    return payload.data;
  }
}

/**
 * The listing envelope -> summaries, newest `publishTime` first.
 *
 * The API keeps the `is_top` item pinned at the head regardless of its date and
 * the rest are not strictly chronological either, so the order is rebuilt here:
 * the runner's "latest unseen" modes assume entries[0] is the newest article.
 *
 * @returns {NewsArticleSummary[]}
 */
export function parseOfficialNewsList(payload, newsUrl) {
  if (!isOkEnvelope(payload)) {
    logger.warning(`Official news listing answered ${describeEnvelope(payload)}`);
    return [];
  }

  const list = isRecord(payload.data) ? payload.data.list : null;
  if (!Array.isArray(list)) {
    logger.warning("Official news listing carries no data.list array");
    return [];
  }

  const articles = [];
  const seenUrls = new Set();
  for (const item of list) {
    const article = summaryFromItem(item, newsUrl);
    if (article === null || seenUrls.has(article.canonical_url)) {
      continue;
    }

    seenUrls.add(article.canonical_url);
    articles.push(article);
  }

  // Stable sort: items with the same second (or no usable date at all, which
  // sorts last) keep the API's relative order.
  return articles
    .map((article, index) => ({ article, index, key: sortKey(article.raw_date) }))
    .sort((left, right) => right.key - left.key || left.index - right.index)
    .map(({ article }) => article);
}

/** @returns {NewsArticleSummary | null} */
export function summaryFromItem(item, newsUrl) {
  if (!isRecord(item)) {
    return null;
  }

  const id = cleanText(item.id ?? "");
  if (!id) {
    return null;
  }

  const articleUrl = articleUrlFor(newsUrl, id);
  const title = cleanText(item.title ?? "") || id;
  const rawExcerpt = cleanText(item.describe ?? "");
  const rawDate = pickRawDate(item);
  const informationType = cleanText(item.informationType ?? "");

  return {
    id,
    title,
    canonical_url: articleUrl,
    article_url: articleUrl,
    information_type: informationType || null,
    raw_date: rawDate,
    raw_excerpt: rawExcerpt || null,
    cover_image_url: normalizeImageUrl(item.mainPic, articleUrl),
  };
}

/**
 * The public page for an article: `${OFFICIAL_NEWS_URL}/detail/${id}`. This is
 * both the `source_url` a post links to and the `seen_sources` dedup key, so it
 * must not depend on the API host or the region.
 */
export function articleUrlFor(newsUrl, id) {
  return `${String(newsUrl ?? "").replace(/\/+$/, "")}/detail/${encodeURIComponent(String(id))}`;
}

/**
 * The article's own image URL (the listing cover or an `<img src>` from the
 * body), or null when it is not an http(s) photo on the site's own host.
 */
export function normalizeImageUrl(value, baseUrl) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const absoluteUrl = urljoin(baseUrl, trimmed);
  const parsed = urlsplit(absoluteUrl);
  if ((parsed.scheme !== "http" && parsed.scheme !== "https") || !parsed.netloc) {
    return null;
  }
  if (parsed.hostname !== IMAGE_HOST_SUFFIX && !parsed.hostname.endsWith(`.${IMAGE_HOST_SUFFIX}`)) {
    return null;
  }

  const path = parsed.path.toLowerCase();
  if (!PHOTO_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    return null;
  }

  return absoluteUrl;
}

/**
 * `publishTime` is when the article actually went live (a scheduled post gets
 * its real second there); `showTime` is the editor-chosen display date and
 * `createTime` the draft time, in that order of trust.
 */
function pickRawDate(item) {
  for (const field of ["publishTime", "showTime", "createTime"]) {
    const value = cleanText(item[field] ?? "");
    if (value) {
      return value;
    }
  }
  return null;
}

function sortKey(rawDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(rawDate ?? "");
  if (!match) {
    return Number.NEGATIVE_INFINITY;
  }
  // The server stamps are all UTC+8 wall time, so a plain UTC reading of the
  // digits orders them correctly without a zone conversion.
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  );
}

function apiBase(apiUrl) {
  return String(apiUrl ?? "").replace(/\/+$/, "");
}

function isOkEnvelope(payload) {
  return isRecord(payload) && Number(payload.code) === 200;
}

function describeEnvelope(payload) {
  if (!isRecord(payload)) {
    return "a non-object body";
  }
  return `code ${JSON.stringify(payload.code ?? null)} (${cleanText(payload.msg ?? "") || "no message"})`;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Titles arrive with literal newlines ("…Available!\nComing to…"); one line. */
function cleanText(value) {
  return collapseWhitespace(String(value));
}
