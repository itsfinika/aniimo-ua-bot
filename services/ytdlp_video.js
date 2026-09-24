/**
 * Download a YouTube video through `yt-dlp`, for a NATIVE Telegram upload at the
 * best quality Telegram's 50 MB bot limit allows.
 *
 * Why this exists next to {@link ./youtube_video.js}: YouTube now serves most
 * videos only over SABR, its server-side adaptive protocol, where the format
 * list carries no directly fetchable URLs. youtubei.js can negotiate exactly one
 * stream that way, the combined 360p one, so every native video the bot posted
 * was 360p regardless of what the source offered. yt-dlp speaks the protocol and
 * reaches the separate video and audio tracks, which are then merged with
 * ffmpeg. Measured on a 116-second clip: 640x360 before, 1280x720 after.
 *
 * Both binaries are external, so every failure path here returns null and the
 * caller falls back to the pure-JavaScript downloader, and from there to a link
 * preview. A container without them behaves exactly as it did before.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { getLogger } from "./logger.js";
import { errorText } from "./pyutils.js";

const execFileAsync = promisify(execFile);

const logger = getLogger("services.ytdlp_video");

// Metadata is one small request; the download is capped separately because a
// slow CDN on a 45 MB file is normal and must not look like a hang.
const METADATA_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// yt-dlp prints the whole format table on -J; a big video can exceed the default
// 1 MB stdout buffer and fail the call for no real reason.
const METADATA_MAX_BUFFER = 64 * 1024 * 1024;

// Telegram re-muxes what it is given, and the merged file always lands a little
// above the sum of the two tracks. Leaving a margin keeps a pick that fits on
// paper from failing on upload.
export const SIZE_SAFETY_MARGIN = 0.97;

// Above 1080p the file cannot fit the upload limit at any useful length, and a
// 1440p track would only ever be downloaded to be rejected.
export const MAX_HEIGHT = 1080;

let availability = null;

/**
 * Whether `yt-dlp` can be executed, probed once per process.
 *
 * The result is cached because this is checked on every video post and a missing
 * binary should cost one failed spawn, not one per video.
 */
export async function ytDlpAvailable(binary) {
  if (availability !== null && availability.binary === binary) {
    return availability.ok;
  }
  let ok = false;
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], { timeout: METADATA_TIMEOUT_MS });
    ok = true;
    logger.info(`yt-dlp available (${String(stdout).trim()}); native videos will use it.`);
  } catch (error) {
    logger.info(`yt-dlp is not usable (${errorText(error)}); falling back to the built-in downloader.`);
  }
  availability = { binary, ok };
  return ok;
}

/** Test seam: forget the cached probe. */
export function resetAvailability() {
  availability = null;
}

/**
 * True for a format the bot can actually fetch and Telegram can actually play.
 *
 * HLS (`m3u8`) variants are excluded: they duplicate the plain-HTTPS tracks,
 * their sizes are estimates, and they need a second merge step for nothing.
 */
function isDirectHttp(format) {
  return String(format?.protocol ?? "").startsWith("http");
}

function sizeOf(format) {
  return Number(format?.filesize ?? format?.filesize_approx ?? 0);
}

/**
 * Score an audio track. The ORIGINAL language must win: a YouTube video can
 * carry twenty auto-dubbed tracks, all the same size and bitrate, and picking by
 * bitrate alone would publish a clip dubbed into a language nobody asked for.
 */
function audioScore(format) {
  const note = String(format?.format_note ?? "").toLowerCase();
  const original = note.includes("original") || Number(format?.language_preference ?? 0) > 0;
  const aac = String(format?.acodec ?? "").startsWith("mp4a") || String(format?.ext ?? "") === "m4a";
  return (original ? 1_000_000 : 0) + (aac ? 100_000 : 0) + Number(format?.abr ?? 0);
}

/**
 * Pick the video and audio tracks to download, or null when nothing fits.
 *
 * H.264 in MP4 is preferred over VP9 and AV1 even though those are smaller for
 * the same picture: Telegram plays H.264 everywhere, while AV1 silently fails to
 * open on older clients. Among the tracks that fit the budget the tallest wins,
 * so a 720p post is only ever downgraded because of the byte budget.
 *
 * Pure on purpose — the whole selection policy is unit-tested without a network.
 *
 * @returns {{video: object, audio: object|null, height: number}|null}
 */
export function chooseFormats(formats, maxBytes) {
  const usable = (formats ?? []).filter(isDirectHttp);
  const budget = maxBytes * SIZE_SAFETY_MARGIN;

  const audioTracks = usable
    .filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"))
    .sort((a, b) => audioScore(b) - audioScore(a));
  const audio = audioTracks[0] ?? null;
  const audioBytes = audio === null ? 0 : sizeOf(audio);

  const videoTracks = usable
    .filter((f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none"))
    .filter((f) => Number(f.height ?? 0) > 0 && Number(f.height) <= MAX_HEIGHT)
    .filter((f) => String(f.ext ?? "") === "mp4" && String(f.vcodec).startsWith("avc1"))
    .filter((f) => sizeOf(f) > 0 && sizeOf(f) + audioBytes <= budget)
    .sort((a, b) => Number(b.height) - Number(a.height) || sizeOf(b) - sizeOf(a));

  if (audio !== null && videoTracks.length) {
    return { video: videoTracks[0], audio, height: Number(videoTracks[0].height) };
  }

  // Nothing separate fits: fall back to a pre-merged stream, which is what the
  // built-in downloader would have produced anyway.
  const combined = usable
    .filter((f) => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none")
    .filter((f) => sizeOf(f) > 0 && sizeOf(f) <= budget)
    .sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0));

  if (combined.length) {
    return { video: combined[0], audio: null, height: Number(combined[0].height ?? 0) };
  }
  return null;
}

/** The `-f` argument for a chosen pair. */
export function formatSelector(choice) {
  return choice.audio === null ? String(choice.video.format_id) : `${choice.video.format_id}+${choice.audio.format_id}`;
}

/**
 * Return `{data, filename}` for `url` within `maxBytes`, or null when yt-dlp is
 * unavailable, nothing fits the budget, or any step fails.
 */
export async function downloadWithYtDlp(url, { maxBytes, cookie = "", binary = "yt-dlp", ffmpegPath = "" } = {}) {
  if (!(await ytDlpAvailable(binary))) {
    return null;
  }

  const common = ["--no-playlist", "--no-warnings", "--no-progress"];
  if (cookie) {
    common.push("--add-header", `Cookie:${cookie}`);
  }

  let metadata;
  try {
    const { stdout } = await execFileAsync(binary, [...common, "-J", url], {
      timeout: METADATA_TIMEOUT_MS,
      maxBuffer: METADATA_MAX_BUFFER,
    });
    metadata = JSON.parse(stdout);
  } catch (error) {
    logger.warning(`yt-dlp could not read ${url}: ${errorText(error)}`);
    return null;
  }

  const choice = chooseFormats(metadata?.formats ?? [], maxBytes);
  if (choice === null) {
    logger.info(`No yt-dlp format for ${url} fits the ${maxBytes}-byte budget; falling back.`);
    return null;
  }
  const expectedBytes = sizeOf(choice.video) + (choice.audio === null ? 0 : sizeOf(choice.audio));
  logger.info(
    `yt-dlp picked ${formatSelector(choice)} (${choice.height}p, about ` +
      `${(expectedBytes / 1048576).toFixed(1)} MiB) for ${url}`,
  );

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "aniimo-video-"));
  const target = path.join(workDir, "video.mp4");
  try {
    const args = [...common, "-f", formatSelector(choice), "--merge-output-format", "mp4", "-o", target];
    if (ffmpegPath) {
      args.push("--ffmpeg-location", ffmpegPath);
    }
    args.push(url);
    await execFileAsync(binary, args, { timeout: DOWNLOAD_TIMEOUT_MS, maxBuffer: METADATA_MAX_BUFFER });

    const data = await fs.readFile(target);
    if (data.length > maxBytes) {
      logger.info(`yt-dlp produced ${data.length} bytes for ${url}, over the ${maxBytes} limit; falling back.`);
      return null;
    }
    return { data, filename: `${safeFilename(metadata?.title)}.mp4`, height: choice.height };
  } catch (error) {
    logger.warning(`yt-dlp failed to download ${url}: ${errorText(error)}`);
    return null;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

const UNSAFE_FILENAME_RE = /[^\p{L}\p{N}._-]+/gu;

/** A filename Telegram accepts, keeping Unicode letters. */
export function safeFilename(title) {
  const cleaned = String(title ?? "")
    .trim()
    .replace(UNSAFE_FILENAME_RE, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return cleaned || "video";
}

export const __testing = { audioScore, isDirectHttp, sizeOf };
