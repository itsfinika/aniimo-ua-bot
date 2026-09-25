import { getText, loadHtml } from "../../html.js";
import { getLogger } from "../../logger.js";
import { errorText } from "../../pyutils.js";
import { quoteAll, urlsplit } from "../../urlutils.js";
import { attr, child, children, findText, parseXml, XmlParseError } from "../../xml.js";

const logger = getLogger("services.collectors.reddit.feed_fetcher");

export const SEARCH_URL_TEMPLATE = "https://www.reddit.com/r/{subreddit}/search.rss";
// Reddit requires a descriptive, non-browser User-Agent and rate-limits hard
// (a burst of requests returns 429). The collector makes ONE request per run.
export const USER_AGENT = "AniimoUACollector/1.0 (Telegram news bot; +https://t.me/AniimoUABot)";
export const REQUEST_TIMEOUT_SECONDS = 25.0;
export const DEFAULT_LIMIT = 25;

const IMAGE_EXT_RE = /\.(?:jpe?g|png|gif|webp)(?:\?|$)/i;

// Reddit-owned image hosts. We match on the EXACT host (never a substring) so a
// link post pointing at e.g. https://i.redd.it.attacker.com/x.png or
// https://evil.com/i.redd.it/x.jpg can never be served as the post's photo.
const REDDIT_DIRECT_IMAGE_HOST = "i.redd.it";
const REDDIT_THUMBNAIL_HOSTS = new Set(["preview.redd.it", "external-preview.redd.it", "i.redd.it"]);

// A preview.redd.it thumbnail mirrors a Reddit-hosted image under the SAME file
// name on i.redd.it, so the tiny (often 140px) preview can be upgraded to the
// full-resolution original by swapping the host. external-preview.redd.it mirrors
// images hosted ELSEWHERE and has no i.redd.it twin, so it is never upgraded.
const REDDIT_PREVIEW_HOST = "preview.redd.it";
// Single-segment image file name only — anything else is left as-is rather than
// guessed at. The host is hardcoded, so a crafted path can never retarget the URL.
const PREVIEW_FILENAME_RE = /^\/[A-Za-z0-9_-]+\.(?:jpe?g|png|gif|webp)$/i;
const UPGRADE_TIMEOUT_SECONDS = 10.0;
const MAX_CONCURRENT_UPGRADES = 5;

function isRedditImageUrl(url, allowedHosts) {
  const parsed = urlsplit(String(url).trim());
  return parsed.scheme === "https" && allowedHosts.has(parsed.netloc.toLowerCase());
}

/**
 * @typedef {{post_id: string, web_url: string, title: string, body_text: string,
 *            created_at: string|null, image_url: string|null,
 *            author: string}} RedditPost
 */

/**
 * Fetches ONE flair-filtered search.rss feed (leaks use sort=new; the weekly
 * fan-art digest uses sort=top + time_filter=week).
 */
export class RedditSearchFetcher {
  /**
   * `query` searches the subreddit for a phrase instead of filtering by flair,
   * which is what a topic watch needs: the interesting posts about, say, the
   * Mysterious Vendor carry whatever flair their author happened to pick. When
   * it is set the flairs are ignored; the two are alternative ways to build the
   * same `q` parameter.
   */
  constructor(subreddit, flairs, { sort = "new", time_filter = null, limit = DEFAULT_LIMIT, query = "" } = {}) {
    this.subreddit = subreddit;
    this.flairs = [...flairs];
    this.query = String(query ?? "").trim();
    this.sort = sort;
    this.time_filter = time_filter;
    this.limit = limit;
  }

  async fetchRecentPosts() {
    const xmlText = await this.fetchFeed();
    if (xmlText === null) {
      return [];
    }

    const posts = parseFeed(xmlText);
    if (!posts.length) {
      logger.warning(`Reddit feed for r/${this.subreddit} returned no usable posts`);
      return posts;
    }

    logger.info(`Fetched ${posts.length} Reddit posts for r/${this.subreddit}`);
    return upgradePreviewImages(posts);
  }

  async fetchFeed() {
    if (!this.query && !this.flairs.length) {
      logger.warning(`No Reddit query or flairs configured for r/${this.subreddit}; skipping`);
      return null;
    }

    const url = SEARCH_URL_TEMPLATE.replace("{subreddit}", quoteAll(this.subreddit));
    const params = new URLSearchParams({
      q: this.query || buildFlairQuery(this.flairs),
      restrict_sr: "on",
      sort: this.sort,
      limit: String(this.limit),
    });
    if (this.time_filter) {
      params.set("t", this.time_filter);
    }
    try {
      const response = await fetch(`${url}?${params}`, {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml, application/xml" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      logger.warning(`Failed to fetch Reddit feed for r/${this.subreddit}: ${errorText(error)}`);
      return null;
    }
  }
}

export function buildFlairQuery(flairs) {
  return flairs.map((flair) => `flair:"${flair}"`).join(" OR ");
}

/**
 * Replace signed preview.redd.it thumbnails with their full-resolution
 * i.redd.it original, where one exists.
 *
 * Reddit serves such thumbnails as small as 140px, which looks broken as a post
 * photo and makes the fan-art digest skip the art entirely (it accepts direct
 * i.redd.it images only). The upgrade is verified with a HEAD request per post —
 * posts whose twin is missing (video/gallery previews) keep the signed thumbnail.
 */
export async function upgradePreviewImages(posts) {
  const candidates = [];
  posts.forEach((post, index) => {
    if (upgradablePreviewUrl(post.image_url)) {
      candidates.push(index);
    }
  });
  if (!candidates.length) {
    return posts;
  }

  const results = await mapWithConcurrency(candidates, MAX_CONCURRENT_UPGRADES, async (index) => [
    index,
    await resolveFullRes(String(posts[index].image_url)),
  ]);

  const upgraded = [...posts];
  let changed = 0;
  for (const [index, fullRes] of results) {
    if (fullRes) {
      upgraded[index] = { ...upgraded[index], image_url: fullRes };
      changed += 1;
    }
  }
  if (changed) {
    logger.info(`Upgraded ${changed}/${candidates.length} Reddit preview thumbnails to full resolution`);
  }
  return upgraded;
}

/** `asyncio.gather` bounded by a semaphore, preserving input order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function upgradablePreviewUrl(url) {
  if (!url) {
    return false;
  }
  const parsed = urlsplit(url);
  return (
    parsed.scheme === "https" &&
    parsed.netloc.toLowerCase() === REDDIT_PREVIEW_HOST &&
    PREVIEW_FILENAME_RE.test(parsed.path)
  );
}

/** The i.redd.it twin of `previewUrl` when it really exists, else null. */
async function resolveFullRes(previewUrl) {
  // The host is hardcoded and only the validated file name is reused, so this URL
  // can never be pointed anywhere but Reddit's own image CDN.
  const candidate = `https://${REDDIT_DIRECT_IMAGE_HOST}${urlsplit(previewUrl).path}`;
  let response;
  try {
    response = await fetch(candidate, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(UPGRADE_TIMEOUT_SECONDS * 1000),
    });
  } catch (error) {
    logger.info(`Could not verify full-res Reddit image ${candidate}: ${errorText(error)}`);
    return null;
  }

  const contentType = String(response.headers.get("content-type") ?? "");
  if (response.status === 200 && contentType.toLowerCase().startsWith("image/")) {
    return candidate;
  }
  return null;
}

export function parseFeed(xmlText) {
  let document;
  try {
    // The feed is untrusted, so DTDs/entity expansion are refused up front.
    document = parseXml(xmlText);
  } catch (error) {
    if (!(error instanceof XmlParseError)) {
      throw error;
    }
    logger.warning(`Failed to parse Reddit feed XML: ${errorText(error)}`);
    return [];
  }

  const root = child(document, "feed");
  if (root === null) {
    return [];
  }

  const posts = [];
  const seenIds = new Set();
  for (const entry of children(root, "entry")) {
    const post = parseEntry(entry);
    if (post === null || seenIds.has(post.post_id)) {
      continue;
    }
    seenIds.add(post.post_id);
    posts.push(post);
  }

  return posts;
}

function parseEntry(entry) {
  const postId = findText(entry, "id").trim();
  if (!postId) {
    return null;
  }

  const title = findText(entry, "title").trim();
  const createdAt = normalizeTimestamp(findText(entry, "published"));

  const link = child(entry, "link");
  const webUrl = link !== null && attr(link, "href") ? String(attr(link, "href")).trim() : "";
  if (!webUrl) {
    return null;
  }

  const contentEl = child(entry, "content");
  const [bodyText, fullResImage] = parseContent(contentEl === null ? null : findTextValue(contentEl));

  const thumb = child(entry, "thumbnail");
  let thumbUrl = thumb !== null && attr(thumb, "url") ? String(attr(thumb, "url")).trim() : null;
  if (thumbUrl && !isRedditImageUrl(thumbUrl, REDDIT_THUMBNAIL_HOSTS)) {
    thumbUrl = null;
  }

  const authorNode = child(entry, "author");
  const author = authorNode !== null ? findText(authorNode, "name").trim() : "";

  return Object.freeze({
    post_id: postId,
    web_url: webUrl,
    title,
    body_text: bodyText,
    created_at: createdAt,
    // Prefer the clean full-resolution direct image; fall back to the preview
    // thumbnail (used by video / gallery / external-link posts that have no
    // i.redd.it image — its signed query string must be kept intact).
    image_url: fullResImage || thumbUrl,
    author,
  });
}

function findTextValue(node) {
  if (typeof node === "string") return node;
  const text = node?.["#text"];
  return text === undefined || text === null ? null : String(text);
}

/**
 * Return [clean body text, full-res direct image URL] from a post's content.
 *
 * Reddit wraps the selftext in `<div class="md">` and appends a
 * "submitted by ... [link] [comments]" footer; the `[link]` anchor of an image
 * post points at the full-resolution `i.redd.it` file. Returns an empty body and
 * no image when neither is present.
 */
export function parseContent(contentHtml) {
  if (!contentHtml || !contentHtml.trim()) {
    return ["", null];
  }

  const $ = loadHtml(contentHtml);

  const md = $("div.md").first();
  const bodyText = md.length ? getText(md) : "";

  let fullResImage = null;
  const anchors = $("a[href]").toArray();
  for (const anchor of anchors) {
    const href = String($(anchor).attr("href")).trim();
    if (isRedditImageUrl(href, new Set([REDDIT_DIRECT_IMAGE_HOST])) && IMAGE_EXT_RE.test(href)) {
      fullResImage = href.split("?")[0];
      break;
    }
  }

  return [bodyText, fullResImage];
}

function normalizeTimestamp(value) {
  if (!value || !value.trim()) {
    return null;
  }

  const text = value.trim();
  if (text.endsWith("Z")) {
    return `${text.slice(0, -1)}+00:00`;
  }
  return text;
}
