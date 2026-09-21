/**
 * Tests for native YouTube video publishing: video-id extraction, the download
 * loop (client fallback, size cap, failure handling), the filename sanitiser, and
 * the sendYoutubePost branch — native upload when a video is downloaded,
 * link-preview fallback when it is not.
 *
 * The InnerTube client is stubbed throughout, so nothing here touches YouTube.
 */

import { GrammyError } from "grammy";
import { afterEach, expect, it, vi } from "vitest";

import { DISABLED_LINK_PREVIEW, sendYoutubePost } from "../services/publisher.js";
import * as youtubeVideo from "../services/youtube_video.js";
import { __testing, downloadYoutubeVideo, extractVideoId } from "../services/youtube_video.js";

const { safeFilename, setClient } = __testing;

afterEach(() => {
  vi.restoreAllMocks();
  setClient(null);
});

/** A ReadableStream over the given chunks, matching what youtubei.js returns. */
function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new Uint8Array(chunk));
      }
      controller.close();
    },
  });
}

/**
 * A stub InnerTube client. `streams` maps a client name to the chunks it serves;
 * a missing entry throws "No matching formats found", as the real one does when
 * a client offers no progressive MP4.
 */
function stubClient({ streams, title = "Trailer: S8.5!", calls = [] }) {
  return {
    calls,
    async download(videoId, options) {
      calls.push(options.client);
      const chunks = streams[options.client];
      if (chunks === undefined) {
        throw new Error("No matching formats found");
      }
      if (chunks instanceof Error) {
        throw chunks;
      }
      return streamOf(chunks);
    },
    async getBasicInfo() {
      return { basic_info: { title } };
    },
  };
}

// --- video id extraction ---------------------------------------------------------

it("extracts the video id from every YouTube URL shape", () => {
  expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(extractVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toBe("dQw4w9WgXcQ");
});

it("rejects look-alike hosts and malformed ids", () => {
  // A collector-supplied URL must never send the downloader somewhere else.
  expect(extractVideoId("https://evil.example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  expect(extractVideoId("https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ")).toBeNull();
  expect(extractVideoId("https://www.youtube.com/watch?v=tooshort")).toBeNull();
  expect(extractVideoId("https://www.youtube.com/")).toBeNull();
  expect(extractVideoId("not a url")).toBeNull();
});

// --- the download loop -----------------------------------------------------------

const URL_UNDER_TEST = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

it("downloads a video and names it after the title", async () => {
  setClient(stubClient({ streams: { ANDROID: [[1, 2, 3, 4]] } }));

  const result = await downloadYoutubeVideo(URL_UNDER_TEST, { maxBytes: 1_000_000 });

  expect([...result.data]).toEqual([1, 2, 3, 4]);
  expect(result.filename).toBe("Trailer_S8_5.mp4");
});

it("falls through to the next client when one has no progressive stream", async () => {
  // The app clients serve a muxed MP4 to a home connection; from a datacenter IP
  // they answer "login required" and only WEB/MWEB accept the PO token, so those
  // must be tried before giving up.
  const calls = [];
  setClient(stubClient({ streams: { TV_EMBEDDED: [[9, 9]] }, calls }));

  const result = await downloadYoutubeVideo(URL_UNDER_TEST, { maxBytes: 1_000_000 });

  expect(calls).toEqual(["ANDROID", "WEB", "MWEB", "IOS", "TV_EMBEDDED"]);
  expect([...result.data]).toEqual([9, 9]);
});

it("tries the PO-token clients right after the app ones", async () => {
  // Order matters on a server: ANDROID fails there, and WEB is what the token
  // reopens, so it must come before the clients the token does nothing for.
  const calls = [];
  setClient(stubClient({ streams: { WEB: [[7]] }, calls }));

  const result = await downloadYoutubeVideo(URL_UNDER_TEST, { maxBytes: 1_000_000 });

  expect(calls).toEqual(["ANDROID", "WEB"]);
  expect([...result.data]).toEqual([7]);
});

it("returns null when no client can serve the video", async () => {
  setClient(stubClient({ streams: {} }));

  expect(await downloadYoutubeVideo(URL_UNDER_TEST, { maxBytes: 1_000_000 })).toBeNull();
});

it("aborts once the stream passes the byte cap", async () => {
  // The cap must stop mid-stream rather than buffer the whole file first.
  setClient(stubClient({ streams: { ANDROID: [[1, 2, 3, 4], [5, 6, 7, 8]] } }));

  expect(await downloadYoutubeVideo(URL_UNDER_TEST, { maxBytes: 5 })).toBeNull();
});

it("returns null when the transfer fails mid-stream", async () => {
  const failing = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.error(new Error("connection reset"));
    },
  });
  setClient({
    async download() {
      return failing;
    },
    async getBasicInfo() {
      return { basic_info: { title: "x" } };
    },
  });

  expect(await downloadYoutubeVideo(URL_UNDER_TEST, { maxBytes: 1_000_000 })).toBeNull();
});

it("does not call YouTube for an unusable URL", async () => {
  const calls = [];
  setClient(stubClient({ streams: { ANDROID: [[1]] }, calls }));

  expect(await downloadYoutubeVideo("https://evil.example.com/watch?v=dQw4w9WgXcQ", { maxBytes: 10 })).toBeNull();
  expect(await downloadYoutubeVideo("", { maxBytes: 10 })).toBeNull();
  expect(calls).toEqual([]);
});

it("sanitises the filename", () => {
  expect(safeFilename("Trailer: S8.5!")).toBe("Trailer_S8_5");
  expect(safeFilename("")).toBe("video");
  expect(safeFilename("x".repeat(200)).length).toBeLessThanOrEqual(60);
  // Unicode letters survive — an all-Cyrillic title must not become "video".
  expect(safeFilename("Трейлер сезону")).toBe("Трейлер_сезону");
});

// --- the publisher branch --------------------------------------------------------

function fakeBot({ rejectVideo = false } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      async sendVideo() {
        calls.push("sendVideo");
        if (rejectVideo) {
          throw new GrammyError(
            "Call to 'sendVideo' failed!",
            { ok: false, error_code: 400, description: "Request Entity Too Large" },
            "sendVideo",
            {},
          );
        }
        return { message_id: 1 };
      },
      async sendMessage() {
        calls.push("sendMessage");
        return { message_id: 2 };
      },
    },
  };
}

function send(bot) {
  return sendYoutubePost(bot, 1, "https://youtu.be/dQw4w9WgXcQ", "caption", {
    parseMode: "HTML",
    linkPreview: DISABLED_LINK_PREVIEW,
    maxBytes: 1_000_000,
  });
}

it("uploads a native video", async () => {
  vi.spyOn(youtubeVideo, "downloadYoutubeVideo").mockResolvedValue({
    data: Buffer.from("video-bytes"),
    filename: "clip.mp4",
  });
  const bot = fakeBot();

  await send(bot);

  expect(bot.calls).toContain("sendVideo");
  expect(bot.calls).not.toContain("sendMessage"); // short caption rides on the video
});

it("falls back to the link preview", async () => {
  vi.spyOn(youtubeVideo, "downloadYoutubeVideo").mockResolvedValue(null); // too large / unavailable
  const bot = fakeBot();

  await send(bot);

  expect(bot.calls).toContain("sendMessage");
  expect(bot.calls).not.toContain("sendVideo");
});

it("falls back when the upload is rejected", async () => {
  vi.spyOn(youtubeVideo, "downloadYoutubeVideo").mockResolvedValue({
    data: Buffer.from("video-bytes"),
    filename: "clip.mp4",
  });
  const bot = fakeBot({ rejectVideo: true });

  await send(bot);

  // Upload rejected -> still posts as a link-preview text.
  expect(bot.calls).toContain("sendVideo");
  expect(bot.calls).toContain("sendMessage");
});
