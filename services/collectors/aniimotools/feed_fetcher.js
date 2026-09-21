/**
 * Fetch and parse the aniimotools.dev news RSS feed (a plain RSS 2.0 feed).
 *
 * aniimotools.dev is a third-party fan site that summarises the official Aniimo
 * notices, dev letters and patch logs, sourced and dated. The feed needs no
 * special User-Agent. Each <item> carries the headline, the article URL, a
 * pubDate and a <description> that is the summary (plain text or short HTML);
 * a <content:encoded> block is optional and wins when present. Any on-site
 * images in that HTML are the article's pictures, and an article with two or
 * more of them is published as one album.
 */

import { DateTime } from "luxon";

import { getText, loadHtml } from "../../html.js";
import { getLogger } from "../../logger.js";
import { errorText } from "../../pyutils.js";
import { urlsplit } from "../../urlutils.js";
import { child, children, findText, parseXml, XmlParseError } from "../../xml.js";

const logger = getLogger("services.collectors.aniimotools.feed_fetcher");

export const DEFAULT_FEED_URL = "https://aniimotools.dev/articles/rss.xml";
export const USER_AGENT = "AniimoUACollector/1.0 (Telegram news bot; +https://t.me/AniimoUABot)";
export const REQUEST_TIMEOUT_SECONDS = 25.0;

const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp)(?:\?|$)/i;
// The site's own host (incl. any subdomain/CDN). Only images here are trusted as
// the article's photo, so a third-party <img> embedded in the body is never sent.
const IMAGE_HOST_SUFFIX = "aniimotools.dev";
// Telegram's media-group maximum; an article never has this many pictures, but
// the cap keeps a malformed body from queueing an unbounded album.
const MAX_IMAGES_PER_POST = 10;

/**
 * @typedef {{post_id: string, web_url: string, title: string, body_text: string,
 *            created_at: string|null, image_url: string|null,
 *            additional_image_urls: string[]}} AniimoToolsPost
 */

export class AniimoToolsFeedFetcher {
  constructor(feedUrl) {
    this.feed_url = feedUrl;
  }

  async fetchRecentPosts() {
    const xmlText = await this.fetchFeed();
    if (xmlText === null) {
      return [];
    }

    const posts = parseFeed(xmlText);
    if (!posts.length) {
      logger.warning(`aniimotools feed ${this.feed_url} returned no usable posts`);
    } else {
      logger.info(`Fetched ${posts.length} aniimotools posts`);
    }
    return posts;
  }

  async fetchFeed() {
    try {
      const response = await fetch(this.feed_url, {
        redirect: "follow",
        headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/xml" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      logger.warning(`Failed to fetch aniimotools feed ${this.feed_url}: ${errorText(error)}`);
      return null;
    }
  }
}

export function parseFeed(xmlText) {
  let document;
  try {
    // The feed is untrusted, so DTDs/entity expansion (billion-laughs) and
    // external entities are refused up front.
    document = parseXml(xmlText);
  } catch (error) {
    if (!(error instanceof XmlParseError)) {
      throw error;
    }
    logger.warning(`Failed to parse aniimotools feed XML: ${errorText(error)}`);
    return [];
  }

  const root = child(document, "rss");
  const channel = root === null ? null : child(root, "channel");
  if (channel === null) {
    return [];
  }

  const parsed = [];
  const seenIds = new Set();
  for (const item of children(channel, "item")) {
    const post = parseItem(item);
    if (post === null || seenIds.has(post.post_id)) {
      continue;
    }
    seenIds.add(post.post_id);
    parsed.push(post);
  }

  return parsed.map((post) => finalizePost(post, recurringImages(parsed)));
}

/**
 * The image URLs that appear in more than one article of this fetch.
 *
 * A site-wide promo or "see also" banner is not the article's content:
 * publishing it would put the same picture under every news item. A picture
 * belongs to exactly one article, so showing up twice in one feed is the
 * signal — and it keeps working when the site swaps the banner for a new one,
 * which a hardcoded filename pattern would not.
 */
function recurringImages(posts) {
  const counts = new Map();
  for (const post of posts) {
    for (const url of new Set(post.images)) {
      counts.set(url, (counts.get(url) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([url]) => url));
}

function finalizePost({ images: allImages, ...fields }, recurring) {
  const images = allImages.filter((url) => !recurring.has(url)).slice(0, MAX_IMAGES_PER_POST);
  return Object.freeze({
    ...fields,
    image_url: images[0] ?? null,
    additional_image_urls: images.slice(1),
  });
}

function parseItem(item) {
  const link = findText(item, "link").trim();
  const guid = findText(item, "guid").trim();
  const postId = guid || link;
  if (!postId || !link) {
    return null;
  }

  const title = findText(item, "title").trim();
  const createdAt = normalizePubDate(findText(item, "pubDate"));
  // The feed usually carries only the summary in <description>; a full
  // <content:encoded> body is the better text when the site includes one.
  const encoded = findText(item, "encoded");
  const [bodyText, images] = parseContent(encoded.trim() ? encoded : findText(item, "description"));

  return {
    post_id: postId,
    web_url: link,
    title,
    body_text: bodyText,
    created_at: createdAt,
    images,
  };
}

/** Return [clean body text, the article's on-site image URLs] from its HTML (or plain text). */
export function parseContent(contentHtml) {
  if (!contentHtml || !contentHtml.trim()) {
    return ["", []];
  }

  const $ = loadHtml(contentHtml);
  const bodyText = getText($.root());

  const images = [];
  const seen = new Set();
  for (const image of $("img[src]").toArray()) {
    const src = String($(image).attr("src")).trim();
    if (!isAllowedImage(src) || seen.has(src)) {
      continue;
    }
    seen.add(src);
    images.push(src);
  }

  return [bodyText, images];
}

function isAllowedImage(url) {
  const parsed = urlsplit(String(url).trim());
  const host = parsed.netloc.toLowerCase();
  const onSite = host === IMAGE_HOST_SUFFIX || host.endsWith(`.${IMAGE_HOST_SUFFIX}`);
  return parsed.scheme === "https" && onSite && IMAGE_EXT_RE.test(url);
}

/** RFC-822 pubDate -> a UTC ISO timestamp `datetime.fromisoformat` can parse. */
export function normalizePubDate(value) {
  if (!value || !value.trim()) {
    return null;
  }
  const parsed = DateTime.fromRFC2822(value.trim(), { setZone: true });
  if (!parsed.isValid) {
    return null;
  }
  // "+00:00", not luxon's default "Z": this string is stored in seen_sources and
  // compared against dates written by every other collector, all of which use
  // Python's `isoformat()` spelling of the UTC offset.
  return parsed.toUTC().toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
}
