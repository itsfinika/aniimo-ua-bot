import { getLogger } from "../../logger.js";
import { errorText, rsplitOnce } from "../../pyutils.js";
import { urlsplit } from "../../urlutils.js";

const logger = getLogger("services.collectors.bluesky.feed_fetcher");

export const AUTHOR_FEED_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed";
export const USER_AGENT = "Mozilla/5.0 (compatible; AniimoUACollector/1.0; +https://t.me/AniimoUABot)";
export const REQUEST_TIMEOUT_SECONDS = 20.0;
export const DEFAULT_LIMIT = 20;

const TIMESTAMP_RE = /^(?<base>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?<frac>\.\d+)?(?<tz>Z|[+-]\d{2}:?\d{2})?/;

// Bluesky's own image CDN. The fullsize URL of a `#view` embed is server-generated
// from the author's uploaded blob, so it always lives here; anything else is a
// tampered/hostile URL that must never be fetched bot-side or handed to Telegram.
const BLUESKY_IMAGE_HOST = "cdn.bsky.app";

function isBlueskyImageUrl(url) {
  const parsed = urlsplit(String(url).trim());
  return parsed.scheme === "https" && parsed.hostname === BLUESKY_IMAGE_HOST;
}

// A CIDv1 in base32 (what Bluesky embeds use): "baf" + lowercase base32 chars. The
// value selects which of the AUTHOR's own blobs to fetch, so it just needs to be a
// well-formed CID — but validating it keeps junk out of the getBlob URL.
const CID_RE = /^baf[a-z2-7]{20,}$/;

function isValidCid(cid) {
  return CID_RE.test(cid);
}

/**
 * @typedef {{uri: string, web_url: string, text: string, created_at: string|null,
 *            image_urls: string[], has_video: boolean, video_cid: string|null,
 *            author_did: string}} BlueskyPost
 */

function blueskyPost({ uri, web_url, text, created_at, image_urls, has_video, video_cid = null }) {
  return Object.freeze({
    uri,
    web_url,
    text,
    created_at,
    image_urls,
    has_video,
    video_cid,
    // at://<did>/app.bsky.feed.post/<rkey> — the DID owns the video blob.
    get author_did() {
      const parts = uri.split("/");
      return parts.length > 2 ? parts[2] : "";
    },
  });
}

export class BlueskyFeedFetcher {
  constructor(actor, { limit = DEFAULT_LIMIT } = {}) {
    this.actor = actor;
    this.limit = limit;
  }

  async fetchRecentPosts() {
    const data = await fetchAuthorFeed(this.actor, this.limit);
    if (data === null) {
      return [];
    }

    const posts = parseAuthorFeed(data, { actor: this.actor });
    if (!posts.length) {
      logger.warning(`Bluesky feed for ${this.actor} returned no usable posts`);
    } else {
      logger.info(`Fetched ${posts.length} Bluesky posts for ${this.actor}`);
    }
    return posts;
  }
}

async function fetchAuthorFeed(actor, limit) {
  const params = new URLSearchParams({ actor, limit: String(limit), filter: "posts_no_replies" });
  try {
    const response = await fetch(`${AUTHOR_FEED_URL}?${params}`, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    logger.warning(`Failed to fetch Bluesky feed for ${actor}: ${errorText(error)}`);
    return null;
  }
}

export function parseAuthorFeed(data, { actor } = {}) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return [];
  }

  const posts = [];
  const seenUris = new Set();
  for (const item of data.feed ?? []) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    // Skip reposts: the account's own posts have no "reason"; reposts carry
    // a reasonRepost. Replies are already excluded via the API filter.
    if (item.reason) {
      continue;
    }

    let post;
    try {
      post = parsePost(item.post);
    } catch (error) {
      // One malformed entry must never abort the whole feed and drop every
      // other valid post; log it and move on.
      logger.exception("Skipping malformed Bluesky feed entry", error);
      continue;
    }
    if (post === null || seenUris.has(post.uri)) {
      continue;
    }

    seenUris.add(post.uri);
    posts.push(post);
  }

  return posts;
}

function parsePost(post) {
  if (post === null || typeof post !== "object" || Array.isArray(post)) {
    return null;
  }

  const uri = String(post.uri ?? "").trim();
  if (!uri) {
    return null;
  }

  let author = post.author;
  if (author === null || typeof author !== "object" || Array.isArray(author)) {
    author = {};
  }
  const handle = String(author.handle ?? "").trim();
  const uriParts = rsplitOnce(uri, "/");
  const rkey = uriParts.length === 2 ? uriParts[1] : uriParts[0];
  const webUrl = handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : uri;

  let record = post.record;
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    record = {};
  }
  const text = String(record.text ?? "").trim();
  const createdAt = normalizeTimestamp(record.createdAt ?? post.indexedAt);

  const [imageUrls, videoCid] = extractMedia(post.embed);

  return blueskyPost({
    uri,
    web_url: webUrl,
    text,
    created_at: createdAt,
    image_urls: imageUrls,
    has_video: videoCid !== null,
    video_cid: videoCid,
  });
}

/** Return [image URLs, video blob CID]. At most one of the two is populated. */
function extractMedia(embed) {
  if (embed === null || typeof embed !== "object" || Array.isArray(embed)) {
    return [[], null];
  }

  const embedType = String(embed.$type ?? "");
  if (embedType === "app.bsky.embed.images#view") {
    const urls = [];
    for (const image of embed.images ?? []) {
      if (image === null || typeof image !== "object" || Array.isArray(image)) {
        continue;
      }
      const url = String(image.fullsize ?? "").trim();
      // Drop anything not on Bluesky's image CDN so a tampered fullsize value
      // can never become an SSRF target or an arbitrary URL sent to Telegram.
      if (url && isBlueskyImageUrl(url)) {
        urls.push(url);
      }
    }
    return [urls, null];
  }

  if (embedType === "app.bsky.embed.video#view") {
    const cid = String(embed.cid ?? "").trim();
    return [[], isValidCid(cid) ? cid : null];
  }

  // A post can carry both a quote and media; the media lives under "media".
  if (embedType === "app.bsky.embed.recordWithMedia#view") {
    return extractMedia(embed.media);
  }

  return [[], null];
}

/**
 * Normalize Bluesky's ISO timestamp into one `datetime.fromisoformat` accepts.
 *
 * Bluesky emits up to nanosecond precision and a trailing `Z`; trim the fraction
 * to microseconds and convert `Z` to `+00:00` so downstream date-gating can
 * parse it. Returns null when there is nothing usable.
 */
export function normalizeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const match = TIMESTAMP_RE.exec(value.trim());
  if (match === null) {
    return value.trim();
  }

  const base = match.groups.base;
  let frac = match.groups.frac ?? "";
  if (frac) {
    frac = frac.slice(0, 7); // ".ffffff" — at most six fractional digits
  }
  let tz = match.groups.tz ?? "";
  if (tz === "Z") {
    tz = "+00:00";
  }

  return `${base}${frac}${tz}`;
}
