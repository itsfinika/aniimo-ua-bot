import { getLogger } from "../../logger.js";
import { errorText } from "../../pyutils.js";
import { asArray, attr, child, children, findText, nodeText, parseXml, XmlParseError } from "../../xml.js";

const logger = getLogger("services.collectors.youtube.feed_fetcher");

export const FEED_URL_TEMPLATE = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}";
export const USER_AGENT = "Mozilla/5.0 (compatible; AniimoUACollector/1.0; +https://t.me/AniimoUABot)";
export const REQUEST_TIMEOUT_SECONDS = 20.0;

/**
 * @typedef {{video_id: string, web_url: string, title: string, description: string,
 *            published: string|null, thumbnail_url: string|null,
 *            channel_name: string}} YouTubeVideo
 */

export class YouTubeFeedFetcher {
  constructor(channelId) {
    this.channel_id = channelId;
  }

  async fetchRecentVideos() {
    const xmlText = await fetchFeed(this.channel_id);
    if (xmlText === null) {
      return [];
    }

    const videos = parseFeed(xmlText);
    if (!videos.length) {
      logger.warning(`YouTube feed for ${this.channel_id} returned no usable videos`);
    } else {
      logger.info(`Fetched ${videos.length} YouTube videos for ${this.channel_id}`);
    }
    return videos;
  }
}

async function fetchFeed(channelId) {
  const url = FEED_URL_TEMPLATE.replace("{channel_id}", channelId);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, Accept: "application/atom+xml, application/xml" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    logger.warning(`Failed to fetch YouTube feed for ${channelId}: ${errorText(error)}`);
    return null;
  }
}

export function parseFeed(xmlText) {
  let document;
  try {
    document = parseXml(xmlText);
  } catch (error) {
    if (!(error instanceof XmlParseError)) {
      throw error;
    }
    logger.warning(`Failed to parse YouTube feed XML: ${errorText(error)}`);
    return [];
  }

  const root = child(document, "feed");
  if (root === null) {
    return [];
  }

  const channelName = findText(root, "title").trim();

  const videos = [];
  const seenIds = new Set();
  for (const entry of children(root, "entry")) {
    const video = parseEntry(entry, channelName);
    if (video === null || seenIds.has(video.video_id)) {
      continue;
    }
    seenIds.add(video.video_id);
    videos.push(video);
  }

  // entry[0] in the feed can be backdated, so sort newest-first by <published>.
  // Plain code-point comparison, not localeCompare: these are ISO timestamps and
  // locale collation would reorder them by rules that have nothing to do with time.
  videos.sort((left, right) => {
    const leftValue = left.published || "";
    const rightValue = right.published || "";
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? 1 : -1;
  });
  return videos;
}

function parseEntry(entry, channelName) {
  const videoId = findText(entry, "videoId").trim();
  if (!videoId) {
    return null;
  }

  const title = findText(entry, "title").trim();
  const published = normalizeTimestamp(findText(entry, "published"));
  const webUrl = extractLink(entry) || `https://www.youtube.com/watch?v=${videoId}`;

  let description = "";
  let thumbnailUrl = null;
  const group = child(entry, "group");
  if (group !== null) {
    description = findText(group, "description").trim();
    const thumbnail = child(group, "thumbnail");
    if (thumbnail !== null) {
      thumbnailUrl = (attr(thumbnail, "url") ?? "").trim() || null;
    }
  }
  if (thumbnailUrl === null) {
    thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  }

  const authorNode = child(entry, "author");
  const authorName = (authorNode !== null ? findText(authorNode, "name").trim() : "") || channelName;

  return Object.freeze({
    video_id: videoId,
    web_url: webUrl,
    title,
    description,
    published,
    thumbnail_url: thumbnailUrl,
    channel_name: authorName,
  });
}

function extractLink(entry) {
  const links = asArray(entry.link);
  const alternate = links.find((link) => attr(link, "rel") === "alternate");
  if (alternate !== undefined) {
    const href = (attr(alternate, "href") ?? "").trim();
    if (href) {
      return href;
    }
  }

  for (const link of links) {
    const href = (attr(link, "href") ?? "").trim();
    if (href) {
      return href;
    }
  }

  return null;
}

/**
 * YouTube emits RFC-3339 timestamps `datetime.fromisoformat` already accepts;
 * normalise a trailing `Z` to `+00:00` for the rare feed that uses it, and
 * return null when there is nothing usable.
 */
function normalizeTimestamp(value) {
  const text = nodeText(value === null ? "" : value);
  if (!text || !text.trim()) {
    return null;
  }

  const trimmed = text.trim();
  if (trimmed.endsWith("Z")) {
    return `${trimmed.slice(0, -1)}+00:00`;
  }
  return trimmed;
}
