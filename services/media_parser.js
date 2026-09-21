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
