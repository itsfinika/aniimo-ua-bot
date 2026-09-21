/**
 * Keep the genuinely useful links a source post carries in its own body.
 *
 * Drafts are generated with every URL stripped: a model-written URL cannot be
 * trusted, and a raw source URL does not belong in a public post. That also threw
 * away links the post existed to share — a Spotify playlist, an event page, a
 * Twitch stream.
 *
 * So links are taken from the ORIGINAL post text rather than from the draft, and
 * only survive when they clear three gates:
 *
 * 1. the source is trusted enough to carry links at all (see LINK_SOURCE_TYPES);
 * 2. the destination host is on a small allowlist of official/known platforms;
 * 3. link shorteners are resolved one hop first, so a hidden destination is judged
 *    on where it actually goes.
 *
 * Anything else is dropped exactly as before. The bot never fetches the linked
 * page — a shortener is resolved by reading one redirect header.
 */

import { getLogger } from "./logger.js";
import { errorText, rstrip } from "./pyutils.js";
import { urlsplit } from "./urlutils.js";

const logger = getLogger("services.source_links");

// Only Bluesky for now. The official site's own articles are already reachable
// through the attribution link; YouTube descriptions are mostly boilerplate
// social-media links; Reddit is user-submitted leak content, which is exactly
// where an unvetted link is most likely to be hostile; and Aniimo Tools is a
// third-party site whose links have not been vetted either.
export const LINK_SOURCE_TYPES = new Set(["bluesky"]);

// Exact hosts, and hosts whose subdomains are equally acceptable.
const ALLOWED_HOSTS = new Set([
  "aniimo.com",
  "pawprintstudio.com",
  "youtube.com",
  "youtu.be",
  "twitch.tv",
  "spotify.com",
  "discord.gg",
  "discord.com",
  "store.steampowered.com",
  "store.epicgames.com",
  "apps.apple.com",
  "play.google.com",
]);
// aniimo.com subdomains cover the site, the wiki and the CDN the devs link to.
const ALLOWED_SUFFIXES = [".aniimo.com", ".pawprintstudio.com", ".youtube.com", ".twitch.tv", ".spotify.com"];

// Shorteners hide their destination, so they are resolved before being judged.
// The request goes to one of these fixed, well-known hosts and reads only the
// redirect header — the destination itself is never fetched.
const SHORTENER_HOSTS = new Set(["bit.ly", "t.co", "tinyurl.com", "ow.ly", "buff.ly"]);

const HOST_LABELS = new Map([
  ["aniimo.com", "Офіційний сайт"],
  ["pawprintstudio.com", "Pawprint Studio"],
  ["youtube.com", "YouTube"],
  ["youtu.be", "YouTube"],
  ["twitch.tv", "Twitch"],
  ["spotify.com", "Spotify"],
  ["discord.gg", "Discord"],
  ["discord.com", "Discord"],
  ["store.steampowered.com", "Steam"],
  ["store.epicgames.com", "Epic Games Store"],
  ["apps.apple.com", "App Store"],
  ["play.google.com", "Google Play"],
]);

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const TRAILING_PUNCTUATION = ".,;:!?'\"»)]}";

const RESOLVE_TIMEOUT_SECONDS = 10.0;
const MAX_LINKS = 2;
const USER_AGENT = "AniimoUACollector/1.0 (Telegram news bot; +https://t.me/AniimoUABot)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Return up to `limit` [label, url] pairs worth keeping in the public post.
 *
 * Empty for a source that does not carry links, and for any URL whose final
 * destination is not allowlisted.
 */
export async function collectPublishableLinks(bodyText, { source_type, article_url = "", limit = MAX_LINKS } = {}) {
  if (!LINK_SOURCE_TYPES.has(source_type) || !bodyText) {
    return [];
  }

  const candidates = uniqueUrls(bodyText, article_url);
  if (!candidates.length) {
    return [];
  }

  const resolved = await Promise.all(candidates.map((url) => resolve(url)));

  const links = [];
  const seen = new Set();
  for (const url of resolved) {
    if (url === null) {
      continue;
    }
    const label = labelFor(url);
    if (label === null || seen.has(url)) {
      continue;
    }
    seen.add(url);
    links.push([label, url]);
    if (links.length >= Math.max(1, limit)) {
      break;
    }
  }
  return links;
}

function uniqueUrls(text, skip) {
  const urls = [];
  const seen = new Set();
  for (const match of String(text).matchAll(URL_RE)) {
    const url = rstrip(match[0], TRAILING_PUNCTUATION);
    if (!url || seen.has(url) || (skip && url === skip)) {
      continue;
    }
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** The allowlisted destination of `url`, or null when it is not acceptable. */
async function resolve(url) {
  const accepted = accept(url);
  if (accepted !== null) {
    return accepted;
  }

  const hostname = host(url);
  if (hostname === null || !SHORTENER_HOSTS.has(hostname)) {
    return null;
  }

  const target = await redirectTarget(url);
  return target ? accept(target) : null;
}

/**
 * `url` normalised to https when its host is allowlisted, else null.
 *
 * Shorteners routinely resolve to an http URL (bit.ly hands back
 * `http://youtube.com/...`), and rejecting those would throw away good links on
 * a technicality. Since the link is only ever printed — never fetched — and
 * every allowlisted host serves https, upgrading the scheme is safe.
 */
function accept(url) {
  const hostname = host(url);
  if (hostname === null || !isAllowedHost(hostname)) {
    return null;
  }
  const parsed = urlsplit(String(url).trim());
  const query = parsed.query ? `?${parsed.query}` : "";
  const fragment = parsed.fragment ? `#${parsed.fragment}` : "";
  return `https://${parsed.netloc}${parsed.path}${query}${fragment}`;
}

/** Follow exactly one redirect hop by reading the Location header. */
async function redirectTarget(url) {
  let response;
  try {
    response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_SECONDS * 1000),
    });
  } catch (error) {
    logger.info(`Could not resolve shortened link ${url}: ${errorText(error)}`);
    return null;
  }

  if (!REDIRECT_STATUSES.has(response.status)) {
    return null;
  }
  const location = String(response.headers.get("location") ?? "").trim();
  return location || null;
}

function host(url) {
  const parsed = urlsplit(String(url).trim());
  if ((parsed.scheme !== "http" && parsed.scheme !== "https") || !parsed.hostname) {
    return null;
  }
  return parsed.hostname.toLowerCase();
}

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.has(hostname) || ALLOWED_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function labelFor(url) {
  const hostname = host(url);
  if (hostname === null) {
    return null;
  }
  if (HOST_LABELS.has(hostname)) {
    return HOST_LABELS.get(hostname);
  }
  for (const [known, label] of HOST_LABELS) {
    if (hostname.endsWith(`.${known}`)) {
      return label;
    }
  }
  return null;
}
