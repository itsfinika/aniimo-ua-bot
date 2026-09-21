/**
 * Download a YouTube video so it can be re-uploaded as a NATIVE Telegram video
 * (plays inline) instead of a tap-to-open link preview.
 *
 * This is a pure-JavaScript implementation on top of `youtubei.js`, a client for
 * YouTube's private InnerTube API — the same API the official apps use. It
 * replaces the external `yt-dlp` executable the Python version shelled out to, so
 * the container needs nothing but Node.
 *
 * Two details make it work:
 *
 *  * **The URL cipher.** YouTube scrambles stream URLs with a function inside its
 *    player script. youtubei.js extracts that function but deliberately refuses
 *    to run it — the caller must supply a JavaScript evaluator. {@link
 *    installPlayerEvaluator} runs it in a `node:vm` realm with an EMPTY global
 *    object and a hard timeout, so the player script sees no filesystem, no
 *    network and no process globals.
 *  * **The client.** The `WEB` client now needs a Proof-of-Origin token and
 *    answers 403 to plain downloads. {@link CLIENT_PREFERENCE} tries the app
 *    clients first, which still serve progressive streams.
 *
 * Only a progressive MP4 (audio+video in one stream) is requested, so no ffmpeg
 * merge is needed. Anything that fails — a missing format, a blocked request, an
 * oversized file — returns null and the caller falls back to the link preview,
 * exactly as before.
 */

import vm from "node:vm";

import { getLogger } from "./logger.js";
import { errorText, sliceChars, WORD } from "./pyutils.js";
import { urlsplit } from "./urlutils.js";

const logger = getLogger("services.youtube_video");

/**
 * Clients to try, in order. `ANDROID` is first because it hands back a
 * progressive MP4 with no Proof-of-Origin token at all — which is enough from a
 * home connection. From a datacenter IP YouTube answers every client with "Video
 * is login required", and only WEB/MWEB accept a PO token as proof the request
 * is genuine, so those come next.
 */
const CLIENT_PREFERENCE = ["ANDROID", "WEB", "MWEB", "IOS", "TV_EMBEDDED"];

// The integrity token behind a PO token is good for ~12h. The client (and with
// it the token) is rebuilt well inside that, so a bot that has been up for days
// never sends a stale one.
const PO_TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Progressive (combined audio+video) MP4 only — no ffmpeg merge required.
const FORMAT_OPTIONS = Object.freeze({ type: "video+audio", quality: "best", format: "mp4" });

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// The player script is small and straight-line; anything slower is a runaway loop.
const PLAYER_EVAL_TIMEOUT_MS = 5000;

let clientPromise = null;
let clientBuiltAt = 0;
let evaluatorInstalled = false;

/**
 * Return `{data, filename}` for `url` within `maxBytes`, or null when the video
 * is unavailable, too large, or the download fails.
 *
 * `cookie` (optional) is a Google cookie header, for the case where even a PO
 * token is not enough for the server's IP; `usePoToken` turns the token off.
 */
export async function downloadYoutubeVideo(url, { maxBytes, cookie = "", usePoToken = true }) {
  if (!url || !url.trim()) {
    return null;
  }

  const videoId = extractVideoId(url.trim());
  if (videoId === null) {
    logger.warning(`Could not read a video id from ${url}; using the link preview`);
    return null;
  }

  let client;
  try {
    client = await getClient({ cookie, usePoToken });
  } catch (error) {
    logger.warning(`Could not start the YouTube client; cannot download ${url}: ${errorText(error)}`);
    return null;
  }

  for (const clientName of CLIENT_PREFERENCE) {
    let stream;
    try {
      stream = await client.download(videoId, { ...FORMAT_OPTIONS, client: clientName });
    } catch (error) {
      // "No matching formats found" simply means this client offers no
      // progressive MP4; move on to the next one rather than giving up.
      logger.info(`YouTube ${clientName} client has no usable stream for ${url}: ${errorText(error)}`);
      continue;
    }

    const data = await readCappedStream(stream, maxBytes, url);
    if (data === null) {
      return null; // over the limit or a mid-stream failure: fall back to the preview
    }
    if (!data.length) {
      continue;
    }

    return { data, filename: `${safeFilename(await videoTitle(client, videoId, clientName))}.mp4` };
  }

  logger.info(`No YouTube stream within the ${maxBytes}-byte limit for ${url}`);
  return null;
}

/**
 * Read the stream into memory, stopping the moment it exceeds `maxBytes`.
 *
 * Returns the bytes, or null when the video is too large or the transfer fails —
 * both of which mean "publish the link preview instead".
 */
async function readCappedStream(stream, maxBytes, url) {
  const reader = stream.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {});
  }, DOWNLOAD_TIMEOUT_MS);
  timer.unref?.();

  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > maxBytes) {
        logger.info(`YouTube video for ${url} exceeds the byte limit (${total}+); using link preview`);
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    logger.warning(`YouTube download failed for ${url}: ${errorText(error)}`);
    return null;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }

  if (timedOut) {
    logger.warning(`YouTube download for ${url} timed out; using link preview`);
    return null;
  }

  return Buffer.concat(chunks, total);
}

/** The video title, for the upload filename. Falls back to "video". */
async function videoTitle(client, videoId, clientName) {
  try {
    const info = await client.getBasicInfo(videoId, clientName);
    return info?.basic_info?.title || "video";
  } catch {
    return "video";
  }
}

/**
 * The shared InnerTube client.
 *
 * Creating one fetches and parses YouTube's player script and mints a PO token,
 * so it is built once and reused. The PROMISE is cached rather than the result,
 * so two downloads starting at the same moment share a single startup instead of
 * racing. It is rebuilt once the token is old enough to be worth refreshing.
 */
// `cookie` / `usePoToken` come from config, so they are the same on every call;
// the cached client does not need to be keyed by them.
async function getClient({ cookie, usePoToken }) {
  if (clientPromise !== null && Date.now() - clientBuiltAt > PO_TOKEN_MAX_AGE_MS) {
    logger.info("Refreshing the YouTube client so its PO token cannot go stale.");
    clientPromise = null;
  }
  if (clientPromise === null) {
    clientBuiltAt = Date.now();
    clientPromise = createClient({ cookie, usePoToken }).catch((error) => {
      clientPromise = null; // let a later download retry after a transient failure
      throw error;
    });
  }
  return clientPromise;
}

async function createClient({ cookie, usePoToken }) {
  const { Innertube } = await import("youtubei.js");
  await installPlayerEvaluator();

  const options = cookie ? { cookie } : {};
  if (!usePoToken) {
    return Innertube.create({ ...options, retrieve_player: true });
  }

  // The token is bound to this session's visitor data, so a cheap player-less
  // session is created first just to learn it.
  const probe = await Innertube.create({ ...options, retrieve_player: false });
  const { mintPoToken } = await import("./youtube_po_token.js");
  const minted = await mintPoToken(probe.session?.context?.client?.visitorData);
  if (minted === null) {
    return Innertube.create({ ...options, retrieve_player: true });
  }

  return Innertube.create({
    ...options,
    retrieve_player: true,
    po_token: minted.poToken,
    visitor_data: minted.visitorData,
  });
}

/**
 * Teach youtubei.js how to run YouTube's URL-decipher function.
 *
 * The script comes from YouTube over HTTPS, but it is still third-party code, so
 * it runs in a `node:vm` context whose global object is `Object.create(null)`:
 * no `process`, no `require`, no `fetch`, nothing to reach the bot's token or
 * database with. A wall-clock timeout stops a runaway loop from pinning the
 * event loop. (`node:vm` is not a security sandbox in the strict sense, but
 * removing every ambient capability leaves the script nothing to call.)
 */
async function installPlayerEvaluator() {
  if (evaluatorInstalled) {
    return;
  }
  const { Platform } = await import("youtubei.js");
  Platform.shim.eval = (data) => {
    // `data.output` ends in a `return`, so it has to be wrapped in a function.
    const script = new vm.Script(`(function(){${data.output}})()`);
    return script.runInContext(vm.createContext(Object.create(null)), {
      timeout: PLAYER_EVAL_TIMEOUT_MS,
    });
  };
  evaluatorInstalled = true;
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * The 11-character video id behind a watch / youtu.be / shorts / embed URL.
 *
 * Returns null for anything else, so a malformed source URL becomes a link
 * preview instead of a bogus API call.
 */
export function extractVideoId(url) {
  const parsed = urlsplit(url);
  const host = parsed.hostname.replace(/^www\./, "").replace(/^m\./, "");

  if (host === "youtu.be") {
    const candidate = parsed.path.split("/").filter(Boolean)[0] ?? "";
    return VIDEO_ID_RE.test(candidate) ? candidate : null;
  }

  if (host !== "youtube.com" && host !== "music.youtube.com" && host !== "youtube-nocookie.com") {
    return null;
  }

  const segments = parsed.path.split("/").filter(Boolean);
  if (segments[0] === "watch") {
    const candidate = new URLSearchParams(parsed.query).get("v") ?? "";
    return VIDEO_ID_RE.test(candidate) ? candidate : null;
  }
  if (["shorts", "embed", "live", "v"].includes(segments[0])) {
    const candidate = segments[1] ?? "";
    return VIDEO_ID_RE.test(candidate) ? candidate : null;
  }

  return null;
}

function safeFilename(title) {
  const cleaned = String(title)
    .replace(new RegExp(`[^${WORD.slice(1, -1)}\\-]+`, "gu"), "_")
    .replace(/^_+|_+$/g, "");
  return sliceChars(cleaned || "video", 0, 60);
}

// Exported for the unit tests, which check the sanitiser keeps Unicode letters
// and drive the download loop with a stub client.
export const __testing = {
  safeFilename,
  readCappedStream,
  CLIENT_PREFERENCE,
  setClient(client) {
    clientPromise = client === null ? null : Promise.resolve(client);
    clientBuiltAt = Date.now();
    evaluatorInstalled = true;
  },
};
