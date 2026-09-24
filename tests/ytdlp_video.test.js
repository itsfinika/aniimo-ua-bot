/**
 * Format picking for the yt-dlp downloader.
 *
 * The policy is what decides whether a channel post is 360p or 720p, and whether
 * it plays at all, so it is exercised directly with format tables shaped like
 * yt-dlp's real output. Nothing here spawns a binary or touches the network.
 */

import { expect, it } from "vitest";

import { chooseFormats, formatSelector, safeFilename, MAX_HEIGHT, SIZE_SAFETY_MARGIN } from "../services/ytdlp_video.js";

const MB = 1024 * 1024;

function video({ id, height, size, vcodec = "avc1.4d401f", ext = "mp4", protocol = "https" }) {
  return { format_id: id, height, filesize: size, vcodec, acodec: "none", ext, protocol };
}

function audio({ id, size = 1.8 * MB, note = "", lang = 0, acodec = "mp4a.40.2", ext = "m4a", abr = 130 }) {
  return {
    format_id: id,
    filesize: size,
    vcodec: "none",
    acodec,
    ext,
    abr,
    protocol: "https",
    format_note: note,
    language_preference: lang,
  };
}

// The real ladder for the clip this was built against: 720p60 H.264 is 44.6 MiB
// and only fits a 48 MB budget once, which is exactly the interesting case.
function ladder() {
  return [
    video({ id: "299", height: 1080, size: 73.26 * MB }),
    video({ id: "298", height: 720, size: 44.6 * MB }),
    video({ id: "135", height: 480, size: 14.62 * MB }),
    video({ id: "134", height: 360, size: 7.47 * MB }),
    video({ id: "398", height: 720, size: 27.63 * MB, vcodec: "av01.0.08M.08" }),
    video({ id: "302", height: 720, size: 36.57 * MB, vcodec: "vp9", ext: "webm" }),
    audio({ id: "140-20", note: "English (US) original (default), medium", lang: 10 }),
  ];
}

it("takes the tallest H.264 track that fits with the audio", () => {
  const choice = chooseFormats(ladder(), 48 * MB);

  expect(choice.video.format_id).toBe("298");
  expect(choice.height).toBe(720);
  expect(formatSelector(choice)).toBe("298+140-20");
});

it("steps down a rung when the budget cannot hold 720p", () => {
  const choice = chooseFormats(ladder(), 20 * MB);

  expect(choice.video.format_id).toBe("135");
  expect(choice.height).toBe(480);
});

it("never picks a track that would blow the upload limit", () => {
  // 5 MB cannot hold even the 360p track plus its audio, and refusing is the
  // correct answer there: the caller then falls back to a link preview.
  expect(chooseFormats(ladder(), 5 * MB)).toBeNull();

  for (const budget of [10 * MB, 20 * MB, 48 * MB]) {
    const choice = chooseFormats(ladder(), budget);
    const total = Number(choice.video.filesize) + Number(choice.audio?.filesize ?? 0);
    expect(total).toBeLessThanOrEqual(budget * SIZE_SAFETY_MARGIN);
  }
});

it("prefers H.264 over the smaller AV1 and VP9 tracks of the same height", () => {
  // 398 (AV1) is 17 MiB smaller than 298 at the same 720p, and 302 (VP9) is
  // smaller too. Both are rejected on purpose: Telegram plays H.264 everywhere.
  const choice = chooseFormats(ladder(), 48 * MB);

  expect(choice.video.vcodec).toMatch(/^avc1/);
  expect(choice.video.format_id).not.toBe("398");
  expect(choice.video.format_id).not.toBe("302");
});

it("picks the ORIGINAL audio, never an auto-dub", () => {
  // A real video carried 21 identical-looking m4a tracks, one per dub language.
  const dubs = ["ar", "de-DE", "ja", "uk", "ru"].map((code, index) =>
    audio({ id: `140-${index}`, note: `${code} dubbed-auto, medium`, lang: -1, abr: 130 }),
  );
  const original = audio({ id: "140-20", note: "English (US) original (default), medium", lang: 10, abr: 129 });

  const choice = chooseFormats([...dubs, original, video({ id: "134", height: 360, size: 7 * MB })], 48 * MB);

  // Chosen despite having the LOWEST bitrate of the set.
  expect(choice.audio.format_id).toBe("140-20");
});

it("ignores HLS variants, whose sizes are only estimates", () => {
  const choice = chooseFormats(
    [
      video({ id: "311", height: 720, size: 20 * MB, protocol: "m3u8_native" }),
      video({ id: "134", height: 360, size: 7.47 * MB }),
      audio({ id: "140-20", note: "original", lang: 10 }),
    ],
    48 * MB,
  );

  expect(choice.video.format_id).toBe("134");
});

it("does not reach above 1080p, which can never fit", () => {
  const choice = chooseFormats(
    [
      video({ id: "400", height: 1440, size: 30 * MB }),
      video({ id: "134", height: 360, size: 7.47 * MB }),
      audio({ id: "140-20", note: "original", lang: 10 }),
    ],
    48 * MB,
  );

  expect(choice.height).toBeLessThanOrEqual(MAX_HEIGHT);
  expect(choice.video.format_id).toBe("134");
});

it("falls back to a pre-merged stream when no pair fits", () => {
  const combined = {
    format_id: "18",
    height: 360,
    filesize: 8 * MB,
    vcodec: "avc1.42001E",
    acodec: "mp4a.40.2",
    ext: "mp4",
    protocol: "https",
  };
  const choice = chooseFormats([video({ id: "298", height: 720, size: 44.6 * MB }), combined], 10 * MB);

  expect(choice.video.format_id).toBe("18");
  expect(choice.audio).toBeNull();
  expect(formatSelector(choice)).toBe("18");
});

it("returns null when nothing at all fits", () => {
  expect(chooseFormats(ladder(), 1 * MB)).toBeNull();
  expect(chooseFormats([], 48 * MB)).toBeNull();
  expect(chooseFormats(null, 48 * MB)).toBeNull();
});

it("skips a track whose size yt-dlp could not determine", () => {
  const choice = chooseFormats(
    [
      { format_id: "999", height: 720, vcodec: "avc1.4d401f", acodec: "none", ext: "mp4", protocol: "https" },
      video({ id: "134", height: 360, size: 7.47 * MB }),
      audio({ id: "140-20", note: "original", lang: 10 }),
    ],
    48 * MB,
  );

  expect(choice.video.format_id).toBe("134");
});

it("uses filesize_approx when the exact size is missing", () => {
  const approx = {
    format_id: "298",
    height: 720,
    filesize_approx: 20 * MB,
    vcodec: "avc1.4d401f",
    acodec: "none",
    ext: "mp4",
    protocol: "https",
  };
  const choice = chooseFormats([approx, audio({ id: "140-20", note: "original", lang: 10 })], 48 * MB);

  expect(choice.video.format_id).toBe("298");
});

it("makes a filename Telegram accepts, keeping Ukrainian letters", () => {
  expect(safeFilename("NVIDIA ACE | Aniimo - Natural Interactions")).toBe("NVIDIA_ACE_Aniimo_-_Natural_Interactions");
  expect(safeFilename("Аніімо: нове відео!")).toBe("Аніімо_нове_відео");
  expect(safeFilename("")).toBe("video");
  expect(safeFilename(null)).toBe("video");
});
