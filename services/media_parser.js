import { getLogger } from "./logger.js";
import { urljoin, urlsplit } from "./urlutils.js";

const logger = getLogger("services.media_parser");

export const PHOTO_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
export const MAX_ARTICLE_MEDIA_ITEMS = 4;

/**
 * @typedef {{media_urls: string[], media_type: string, media_url: string|null}} ArticleMedia
 */

/**
 * Pick the article's images from a parsed page.
 *
 * `$` is the cheerio API for the whole document and `bodyContainer`, when given,
 * is the cheerio selection of the article body — the analogue of the
 * BeautifulSoup `soup` / `body_container` pair the Python version took.
 *
 * @returns {ArticleMedia}
 */
export function extractArticleMedia($, pageUrl, { bodyContainer = null, fallbackCoverUrl = null } = {}) {
  const candidates = [];

  for (const selector of [
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[property="twitter:image"]',
    'meta[name="twitter:image"]',
  ]) {
    const value = metaContent($, selector);
    if (value) {
      candidates.push([selector, value]);
    }
  }

  if (fallbackCoverUrl) {
    candidates.push(["list cover image", fallbackCoverUrl]);
  }

  const imageScope = bodyContainer ?? $.root();
  imageScope.find("img[src], img[data-src], img[data-original]").each((_index, element) => {
    const image = $(element);
    const src = image.attr("src") || image.attr("data-src") || image.attr("data-original");
    if (src) {
      candidates.push(["article image", String(src)]);
    }
  });

  const selectedUrls = [];
  const seenUrls = new Set();
  for (const [source, candidate] of candidates) {
    const mediaUrl = normalizeUrl(candidate, pageUrl);
    if (!mediaUrl || seenUrls.has(mediaUrl)) {
      continue;
    }
    seenUrls.add(mediaUrl);

    if (isMeaningfulPhotoUrl(mediaUrl)) {
      logger.info(`Selected article media from ${source}: ${mediaUrl}`);
      selectedUrls.push(mediaUrl);
      if (selectedUrls.length >= MAX_ARTICLE_MEDIA_ITEMS) {
        break;
      }
      continue;
    }

    logger.debug(`Skipped non-article media candidate from ${source}: ${mediaUrl}`);
  }

  if (selectedUrls.length) {
    return { media_urls: selectedUrls, media_type: "photo", media_url: selectedUrls[0] };
  }

  logger.info(`No safe article media found for ${pageUrl}`);
  return { media_urls: [], media_type: "none", media_url: null };
}

function metaContent($, selector) {
  const tag = $(selector).first();
  if (tag.length === 0) {
    return null;
  }

  const content = tag.attr("content");
  return content ? String(content).trim() : null;
}

function normalizeUrl(value, baseUrl) {
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  const url = urljoin(baseUrl, trimmed);
  const parsed = urlsplit(url);
  if ((parsed.scheme !== "http" && parsed.scheme !== "https") || !parsed.netloc) {
    return null;
  }

  return url;
}

function isMeaningfulPhotoUrl(url) {
  const parsed = urlsplit(url);
  const path = parsed.path.toLowerCase();
  const filename = path.slice(path.lastIndexOf("/") + 1);

  if (!PHOTO_EXTENSIONS.some((extension) => path.endsWith(extension))) {
    return false;
  }

  const blockedTokens = [
    "avatar",
    "badge",
    "blank",
    "button",
    "captcha",
    "favicon",
    "icon",
    "lan_",
    "logo",
    "pixel",
    "sprite",
    "tracking",
  ];
  if (blockedTokens.some((token) => path.includes(token))) {
    return false;
  }

  // The current official pages include a generic site share image in metadata.
  // Prefer article/list imagery over that global card.
  if (filename === "share.jpg" || path.endsWith("/data/share.jpg")) {
    return false;
  }

  return true;
}

// One HEAD per image, a handful at a time: an album is at most a few pictures,
// and the collector is already waiting on the article fetch.
const IDENTITY_PROBE_TIMEOUT_SECONDS = 10.0;
const MAX_CONCURRENT_IDENTITY_PROBES = 5;

/**
 * Ask the server what an image IS, without downloading it.
 *
 * Returns a key that two URLs share only when they serve the same bytes:
 * the validator the CDN itself computes over the content, paired with the
 * length so a weak or reused validator cannot collide two different pictures.
 * Null means "cannot tell" — a missing ETag, a rejected HEAD, a transport
 * error — and callers must treat that as "keep this image".
 */
async function imageIdentity(url) {
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(IDENTITY_PROBE_TIMEOUT_SECONDS * 1000),
    });
    if (!response.ok) {
      return null;
    }
    // Strip the weak-validator prefix and the quotes servers wrap ETags in, so
    // `W/"abc"` and `"abc"` compare equal.
    const etag = (response.headers.get("etag") ?? "").trim().replace(/^W\//i, "").replace(/^"|"$/g, "");
    if (!etag) {
      return null;
    }
    return `${etag}:${response.headers.get("content-length") ?? ""}`;
  } catch {
    return null;
  }
}

/**
 * Drop images that are byte-identical to an earlier one in the list.
 *
 * A publisher often uploads the same picture twice — once as the article's
 * cover and once inside the body — under different file names, so the URLs
 * differ and plain URL dedup cannot see it. The reader then gets the same
 * photo twice in one album. Comparing what the CDN reports for each URL
 * catches it for the price of a HEAD request.
 *
 * Conservative on purpose: an image whose identity cannot be established is
 * always kept, so a silent server never costs the post a picture.
 */
export async function dropDuplicateImages(urls) {
  const list = [...(urls ?? [])];
  if (list.length < 2) {
    return list;
  }

  const identities = new Array(list.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(MAX_CONCURRENT_IDENTITY_PROBES, list.length) }, async () => {
    for (let index = next++; index < list.length; index = next++) {
      identities[index] = await imageIdentity(list[index]);
    }
  });
  await Promise.all(workers);

  const kept = [];
  const seen = new Set();
  for (const [index, url] of list.entries()) {
    const identity = identities[index];
    if (identity !== null && seen.has(identity)) {
      logger.info(`Dropping ${url}: same image as an earlier one in this post`);
      continue;
    }
    if (identity !== null) {
      seen.add(identity);
    }
    kept.push(url);
  }
  return kept;
}
