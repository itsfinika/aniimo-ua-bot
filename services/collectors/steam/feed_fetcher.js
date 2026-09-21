/**
 * Fetch and parse the app's Steam "Community Announcements" feed (RSS 2.0).
 *
 * Steam publishes every announcement the developers post on the store page —
 * patch notes, maintenance notices, launch news — through one feed per app, so
 * every <item> is first-party. Each item carries the announcement title, a
 * CDATA-wrapped <link> to the store's news page, an RFC-822 <pubDate> in UTC, a
 * <guid> and the body in <description> as Steam's bbcode-rendered HTML
 * (`<p class="bb_paragraph">`, `<div class="bb_h2">`, `<img class="bb_img">`).
 * The images live on Steam's CDNs; a post with two or more of them is published
 * as one album.
 */

import { DateTime } from "luxon";

import { getText, loadHtml } from "../../html.js";
import { getLogger } from "../../logger.js";
import { charLength, collapseWhitespace, errorText, rsplitOnce, sliceChars } from "../../pyutils.js";
import { urlsplit } from "../../urlutils.js";
import { child, children, findText, parseXml, XmlParseError } from "../../xml.js";

const logger = getLogger("services.collectors.steam.feed_fetcher");

export const DEFAULT_FEED_URL = "https://store.steampowered.com/feeds/news/app/4126040/";
export const USER_AGENT = "AniimoUACollector/1.0 (Telegram news bot; +https://t.me/AniimoUABot)";
export const REQUEST_TIMEOUT_SECONDS = 25.0;
// The same cap the official-site parser applies: a patch-notes post can run to
// several screens, and the Gemini prompt budget is shared with the style guide.
export const MAX_BODY_TEXT_LENGTH = 12000;

const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp)(?:\?|$)/i;
// Steam serves announcement images from its own CDNs (clan.*.steamstatic.com,
// steamusercontent.com, the legacy akamaihd.net mirror). Only images there are
// trusted as the post's photos, so a third-party <img> in the body is never sent.
const IMAGE_HOST_SUFFIXES = ["steamstatic.com", "steamusercontent.com", "akamaihd.net"];
// Telegram's media-group maximum; it also keeps a malformed body from queueing
// an unbounded album.
const MAX_IMAGES_PER_POST = 10;
// Steam renders bbcode headings as classed <div>s rather than <h1>..<h3>, and
// those headings ("Maintenance Schedule", "Bug Fixes") are the structure a
// patch-notes draft needs — so they are picked up next to the real heading tags.
const BLOCK_SELECTOR = "p, h1, h2, h3, li, div.bb_h1, div.bb_h2, div.bb_h3";

/**
 * @typedef {{post_id: string, web_url: string, title: string, body_text: string,
 *            created_at: string|null, image_url: string|null,
 *            additional_image_urls: string[]}} SteamPost
 */

export class SteamFeedFetcher {
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
      logger.warning(`Steam feed ${this.feed_url} returned no usable posts`);
    } else {
      logger.info(`Fetched ${posts.length} Steam announcements`);
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
      logger.warning(`Failed to fetch Steam feed ${this.feed_url}: ${errorText(error)}`);
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
    logger.warning(`Failed to parse Steam feed XML: ${errorText(error)}`);
    return [];
  }

  const root = child(document, "rss");
  const channel = root === null ? null : child(root, "channel");
  if (channel === null) {
    return [];
  }

  const posts = [];
  const seenIds = new Set();
  for (const item of children(channel, "item")) {
    const post = parseItem(item);
    if (post === null || seenIds.has(post.post_id)) {
      continue;
    }
    seenIds.add(post.post_id);
    posts.push(post);
  }

  // Steam lists announcements newest-first, but the sort is cheap insurance
  // against a backdated repost: the manual mode drafts the first unseen entry,
  // so order decides which announcement goes to moderation. Plain code-point
  // comparison — these are ISO timestamps, not words for locale collation.
  posts.sort((left, right) => {
    const leftValue = left.created_at || "";
    const rightValue = right.created_at || "";
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? 1 : -1;
  });
  return posts;
}

function parseItem(item) {
  const link = findText(item, "link").trim();
  const guid = findText(item, "guid").trim();
  const postId = guid || link;
  if (!postId || !link) {
    return null;
  }

  const title = collapseWhitespace(findText(item, "title"));
  const createdAt = normalizePubDate(findText(item, "pubDate"));
  const [bodyText, images] = parseDescription(findText(item, "description"));

  return Object.freeze({
    post_id: postId,
    web_url: link,
    title,
    body_text: bodyText,
    created_at: createdAt,
    image_url: images[0] ?? null,
    additional_image_urls: images.slice(1),
  });
}

/** Return [clean body text, the post's Steam-hosted image URLs] from a post's HTML. */
export function parseDescription(descriptionHtml) {
  if (!descriptionHtml || !descriptionHtml.trim()) {
    return ["", []];
  }

  const $ = loadHtml(descriptionHtml);
  // An embedded YouTube player renders as an <iframe> plus a placeholder <img>
  // that is neither text nor a usable photo.
  $("script, style, noscript, iframe").remove();

  const blocks = [];
  const seen = new Set();
  $(BLOCK_SELECTOR).each((_index, element) => {
    const text = cleanText(getText($(element)));
    if (!text || seen.has(text)) {
      return;
    }
    seen.add(text);
    blocks.push(text);
  });

  const rawText = blocks.length ? blocks.join("\n") : cleanText(getText($.root()));
  const bodyText = truncateText(normalizeFullwidthParens(rawText), MAX_BODY_TEXT_LENGTH);

  const images = [];
  const imageSeen = new Set();
  for (const image of $("img[src]").toArray()) {
    const src = String($(image).attr("src")).trim();
    if (!isAllowedImage(src) || imageSeen.has(src)) {
      continue;
    }
    imageSeen.add(src);
    images.push(src);
    if (images.length >= MAX_IMAGES_PER_POST) {
      break;
    }
  }

  return [bodyText, images];
}

/**
 * The developers write their schedules with fullwidth parentheses —
 * `00:00 – 10:00（UTC+8）` — copied verbatim from the site. The time-zone
 * converter that turns those into Kyiv time looks for the ASCII form, so the
 * brackets are normalised here, before the text reaches the draft prompt.
 */
export function normalizeFullwidthParens(text) {
  return String(text ?? "").replaceAll("（", "(").replaceAll("）", ")");
}

function isAllowedImage(url) {
  const parsed = urlsplit(String(url).trim());
  const host = parsed.netloc.toLowerCase();
  const onSteam = IMAGE_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  return parsed.scheme === "https" && onSteam && IMAGE_EXT_RE.test(url);
}

function cleanText(value) {
  // Steam's bbcode renderer leaves a literal `\[` where the author typed a
  // square bracket ("\[Maintenance Window]: …"); that backslash is markup
  // residue, not text, and would otherwise end up in the draft.
  return collapseWhitespace(String(value).replaceAll(" ", " ").replaceAll("\\[", "["));
}

function truncateText(value, maxLength) {
  if (charLength(value) <= maxLength) {
    return value;
  }

  // Cut on a block boundary so the prompt never ends mid-sentence.
  const head = sliceChars(value, 0, maxLength);
  const parts = rsplitOnce(head, "\n");
  const truncated = (parts.length === 2 ? parts[0] : parts[0]).trim();
  return truncated || head.trim();
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
