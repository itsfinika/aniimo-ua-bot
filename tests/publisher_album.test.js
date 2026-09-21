/**
 * Tests for the album publish helpers: the index Telegram blames in a media-group
 * error (used to drop one rejected image and retry the otherwise-atomic album),
 * and the SSRF/size guards on the bot-side album image downloader.
 */

import { afterEach, expect, it, vi } from "vitest";

import {
  albumCaptionHtml,
  albumItems,
  downloadAlbumPhoto,
  downloadExternalVideo,
  failingMediaIndex,
  isFetchableMediaUrl,
  linkPreviewOptionsFor,
  needsExternalVideoDownload,
  previewLinkUrl,
  sendAlbumMessage,
  youtubeVideoUrl,
} from "../services/publisher.js";
import { fakeBot } from "./helpers/telegram.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch stub that answers every request with the given response spec. */
function stubFetch({ contentType, body = "", contentLength = undefined, chunks = null, calls = [] }) {
  vi.stubGlobal("fetch", async (url) => {
    calls.push(String(url));
    const headers = new Map([["content-type", contentType]]);
    if (contentLength !== undefined) {
      headers.set("content-length", String(contentLength));
    }
    const source =
      chunks ?? [typeof body === "string" ? Buffer.from(body, "binary") : Buffer.from(body)];
    return {
      status: 200,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      body: (async function* iterate() {
        for (const chunk of source) {
          yield chunk;
        }
      })(),
    };
  });
  return calls;
}

it("enables the link preview for YouTube only", () => {
  const yt = linkPreviewOptionsFor({ source_type: "youtube", source_url: "https://www.youtube.com/watch?v=x" });
  expect(yt.is_disabled).toBe(false);
  expect(yt.url).toBe("https://www.youtube.com/watch?v=x");
  expect(yt.prefer_large_media).toBe(true);

  // Other sources keep previews disabled, and youtube without a URL stays disabled.
  expect(linkPreviewOptionsFor({ source_type: "bluesky", source_url: "https://x" }).is_disabled).toBe(true);
  expect(linkPreviewOptionsFor({ source_type: "youtube", source_url: "" }).is_disabled).toBe(true);
});

// --- a reader's own link ---------------------------------------------------------

it("previews the link a reader sent, which has no source URL", () => {
  // Published with previews off, a submitted link was naked blue text: no title,
  // no thumbnail, nothing saying what is behind it.
  const preview = linkPreviewOptionsFor({
    message_type: "link",
    text: "гляньте що знайшов https://www.aniimo.com/newslist/detail/100145 крутяк",
  });

  expect(preview.is_disabled).toBe(false);
  expect(preview.url).toBe("https://www.aniimo.com/newslist/detail/100145");
  expect(preview.show_above_text).toBe(true);
});

it("reads the link out of a stored draft too", () => {
  expect(previewLinkUrl({ draft_text: "https://youtu.be/dQw4w9WgXcQ" })).toBe("https://youtu.be/dQw4w9WgXcQ");
});

it("trims sentence punctuation off a submitted link", () => {
  expect(previewLinkUrl({ text: "дивіться (https://www.aniimo.com/newslist/detail/1), новий скін!" })).toBe(
    "https://www.aniimo.com/newslist/detail/1",
  );
});

it("shows no preview for a reader's plain text", () => {
  expect(linkPreviewOptionsFor({ text: "коли вже нерфнуть Хелу" }).is_disabled).toBe(true);
  expect(previewLinkUrl({ text: "" })).toBeNull();
});

it("never previews an internal or non-http link a reader sent", () => {
  // The same SSRF guard the media downloader uses: previewing it would have
  // Telegram fetch an internal address on our behalf.
  expect(previewLinkUrl({ text: "http://169.254.169.254/latest/meta-data/" })).toBeNull();
  expect(previewLinkUrl({ text: "ftp://example.com/x" })).toBeNull();
});

it("keeps a collector post previewing its own source, never the body", () => {
  // A Bluesky post may quote any URL; that must not become the preview.
  expect(previewLinkUrl({ source_type: "bluesky", source_url: "https://x", text: "https://evil.example/x" })).toBeNull();
});

it("routes a reader's YouTube link to native video, and nothing else", () => {
  expect(youtubeVideoUrl({ message_type: "link", text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })).toBe(
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  );
  expect(youtubeVideoUrl({ message_type: "link", text: "https://youtu.be/dQw4w9WgXcQ" })).toBe(
    "https://youtu.be/dQw4w9WgXcQ",
  );
  // A non-YouTube link is previewed, not downloaded.
  expect(youtubeVideoUrl({ message_type: "link", text: "https://www.aniimo.com/newslist/detail/1" })).toBeNull();
  // A look-alike host must not reach the downloader.
  expect(youtubeVideoUrl({ message_type: "link", text: "https://youtube.com.attacker.example/watch?v=x" })).toBeNull();
  // The collector path is unchanged.
  expect(youtubeVideoUrl({ source_type: "youtube", source_url: "https://www.youtube.com/watch?v=x" })).toBe(
    "https://www.youtube.com/watch?v=x",
  );
  expect(youtubeVideoUrl({ source_type: "bluesky", source_url: "https://bsky.app/x" })).toBeNull();
});

it("passes a pre-rendered album caption through and formats the rest", () => {
  // Digest captions are already HTML and pass through untouched.
  const raw = albumCaptionHtml({ source_type: "reddit_fanart", draft_text: '<a href="u">x</a>' });
  expect(raw).toBe('<a href="u">x</a>');

  // Collector-album captions are plain text formatted through the post formatter,
  // which escapes the body and drops the admin-only "Джерело:" line.
  const formatted = albumCaptionHtml({
    source_type: "bluesky",
    draft_text: "Текст.\n\nДжерело: MR",
    source_url: "https://x",
  });
  expect(formatted).toContain("Текст.");
  expect(formatted).not.toContain("Джерело");
});

it("parses the message number Telegram blames", () => {
  expect(failingMediaIndex("Bad Request: failed to send message #2 with the error ...", 5)).toBe(1);
  expect(failingMediaIndex("Bad Request: failed to send message #1 ...", 5)).toBe(0);
});

it("falls back to index zero", () => {
  expect(failingMediaIndex("Bad Request: PHOTO_INVALID_DIMENSIONS", 5)).toBe(0); // no "message #N"
  expect(failingMediaIndex("failed to send message #99", 3)).toBe(0); // out of range
  expect(failingMediaIndex("", 1)).toBe(0);
});

// --- SSRF / size guards on the bot-side album downloader -----------------------

it("allows public https URLs only", () => {
  expect(isFetchableMediaUrl("https://cdn.bsky.app/img/a.jpg")).toBe(true);
  expect(isFetchableMediaUrl("https://i.redd.it/a.jpg")).toBe(true);
  expect(isFetchableMediaUrl("https://8.8.8.8/a.jpg")).toBe(true); // public IP literal is fine
});

it("blocks SSRF targets and non-https URLs", () => {
  expect(isFetchableMediaUrl("http://cdn.bsky.app/a.jpg")).toBe(false); // not https
  expect(isFetchableMediaUrl("ftp://cdn.bsky.app/a.jpg")).toBe(false);
  expect(isFetchableMediaUrl("https:///a.jpg")).toBe(false); // no host
  // Internal / metadata IP literals must be rejected.
  expect(isFetchableMediaUrl("https://169.254.169.254/latest/meta-data/")).toBe(false);
  expect(isFetchableMediaUrl("https://127.0.0.1/a.jpg")).toBe(false);
  expect(isFetchableMediaUrl("https://10.0.0.5/a.jpg")).toBe(false);
  expect(isFetchableMediaUrl("https://192.168.1.1/a.jpg")).toBe(false);
});

it("rejects an internal album URL without fetching", async () => {
  const calls = stubFetch({ contentType: "image/jpeg", body: "x" });

  expect(await downloadAlbumPhoto("https://169.254.169.254/x.jpg", 0)).toBeNull();
  expect(calls).toEqual([]); // the guard short-circuits before any request is sent
});

it("rejects an oversized declared length", async () => {
  stubFetch({ contentType: "image/jpeg", body: "x", contentLength: 10 * 1024 * 1024 + 1 });

  expect(await downloadAlbumPhoto("https://cdn.bsky.app/big.jpg", 0)).toBeNull();
});

it("aborts an oversized stream with no content-length", async () => {
  // Many small chunks, no Content-Length -> the precheck passes and the streaming
  // loop must abort once the running total exceeds the cap.
  stubFetch({
    contentType: "image/jpeg",
    chunks: Array.from({ length: 100 }, () => Buffer.from("xxxxx")),
  });

  expect(await downloadAlbumPhoto("https://cdn.bsky.app/drip.jpg", 0, { maxBytes: 8 })).toBeNull();
});

it("rejects a non-image content type", async () => {
  stubFetch({ contentType: "text/html", body: "<html>internal</html>" });

  expect(await downloadAlbumPhoto("https://cdn.bsky.app/x", 0)).toBeNull();
});

it("accepts a valid image", async () => {
  stubFetch({ contentType: "image/png", body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });

  const result = await downloadAlbumPhoto("https://cdn.bsky.app/a.png", 2);
  expect(result).not.toBeNull();
  const [data, filename] = result;
  expect([...data]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(filename).toBe("art_3.png");
});

// --- external (Bluesky) video download routing + guards ------------------------

it("routes only external-source videos to the downloader", () => {
  expect(
    needsExternalVideoDownload({
      message_type: "video",
      source_type: "bluesky",
      media_url: "https://pds.host.bsky.network/x",
    }),
  ).toBe(true);
  // A user video carries a Telegram file_id (sent directly) -> not downloaded.
  expect(
    needsExternalVideoDownload({
      message_type: "video",
      source_type: "bluesky",
      file_id: "abc",
      media_url: "https://x",
    }),
  ).toBe(false);
  // Non-download source / non-video / non-http URL -> not downloaded.
  expect(needsExternalVideoDownload({ message_type: "video", source_type: "reddit", media_url: "https://x" })).toBe(
    false,
  );
  expect(needsExternalVideoDownload({ message_type: "photo", source_type: "bluesky", media_url: "https://x" })).toBe(
    false,
  );
  expect(needsExternalVideoDownload({ message_type: "video", source_type: "bluesky", media_url: "ftp://x" })).toBe(
    false,
  );
  // http is rejected too — only https is fetchable, so routing must match.
  expect(
    needsExternalVideoDownload({
      message_type: "video",
      source_type: "bluesky",
      media_url: "http://pds.host.bsky.network/x",
    }),
  ).toBe(false);
});

it("accepts an MP4 within the cap", async () => {
  stubFetch({ contentType: "video/mp4", body: Buffer.from([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]) });

  const result = await downloadExternalVideo("https://pds.host.bsky.network/x", { maxBytes: 10_000_000 });

  expect(result).not.toBeNull();
  expect([...result.data.subarray(4, 8)]).toEqual([0x66, 0x74, 0x79, 0x70]); // "ftyp"
  expect(result.filename).toBe("video.mp4");
});

it("rejects an internal video URL without fetching", async () => {
  const calls = stubFetch({ contentType: "video/mp4", body: "x" });

  const result = await downloadExternalVideo("https://169.254.169.254/x.mp4", { maxBytes: 10_000_000 });

  expect(result).toBeNull();
  expect(calls).toEqual([]); // SSRF guard short-circuits before any request
});

it("rejects a non-video content type", async () => {
  stubFetch({ contentType: "text/html", body: "<html>" });

  expect(await downloadExternalVideo("https://pds.host.bsky.network/x", { maxBytes: 10_000_000 })).toBeNull();
});


// --- albums of Telegram files (a reader's own media group) ------------------------

it("reads file ids and media types off the parts", () => {
  const items = albumItems({
    message_type: "album",
    parts: [
      { file_id: "p1", media_type: "photo" },
      { file_id: "v1", media_type: "video" },
      { file_id: "p1", media_type: "photo" }, // the same file twice
    ],
  });

  expect(items).toEqual([
    { file_id: "p1", media_url: null, media_type: "photo" },
    { file_id: "v1", media_url: null, media_type: "video" },
  ]);
});

it("sends a photo-and-video album as one media group without fetching anything", async () => {
  // Telegram already holds these files, so a file_id is passed straight through:
  // no download, no size limit, and the video keeps its type instead of being
  // sent as a photo (which Telegram rejects for an MP4).
  const fetchCalls = stubFetch({ contentType: "image/jpeg" });
  const bot = fakeBot();

  await sendAlbumMessage(
    bot,
    42,
    [
      { file_id: "p1", media_type: "photo" },
      { file_id: "v1", media_type: "video" },
    ],
    "підпис",
  );

  expect(fetchCalls).toEqual([]);
  const [group] = bot.callsTo("sendMediaGroup");
  expect(group.args[1]).toEqual([
    { type: "photo", media: "p1", caption: "підпис", parse_mode: "HTML" },
    { type: "video", media: "v1" },
  ]);
});

it("sends a single surviving item as a plain message of its own type", async () => {
  const bot = fakeBot();

  await sendAlbumMessage(bot, 42, [{ file_id: "v1", media_type: "video" }], "підпис");

  expect(bot.callsTo("sendMediaGroup")).toEqual([]);
  const [video] = bot.callsTo("sendVideo");
  expect(video.args[1]).toBe("v1");
  expect(video.args[2]).toMatchObject({ caption: "підпис", supports_streaming: true });
});
