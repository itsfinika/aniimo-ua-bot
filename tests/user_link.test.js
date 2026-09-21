/**
 * What actually goes out when a reader drops a link into the bot.
 *
 * Published with previews disabled, a submitted link was naked blue text — no
 * title, no thumbnail, and for a YouTube link no video either. These drive the
 * real publish path end to end.
 */

import { afterEach, expect, it, vi } from "vitest";

import { publishSubmission } from "../services/publisher.js";
import * as youtubeVideo from "../services/youtube_video.js";
import { fakeBot } from "./helpers/telegram.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const CONFIG = {
  publish_chat_id: -100500,
  enable_youtube_video_download: true,
  youtube_video_max_mb: 48,
  youtube_cookie: "",
  enable_youtube_po_token: true,
  bluesky_video_max_mb: 48,
};

/** A submission exactly as the user handler stores one: text only, no source. */
function readerSubmission(text, messageType = "link") {
  return {
    id: 122,
    message_type: messageType,
    draft_text: text,
    original_text: text,
    source_type: null,
    source_url: null,
    file_id: null,
    media_url: null,
    parts: [{ part_index: 1, message_type: messageType, text, file_id: null, media_url: null, media_type: "none" }],
  };
}

it("publishes a reader's YouTube link as native video", async () => {
  vi.spyOn(youtubeVideo, "downloadYoutubeVideo").mockResolvedValue({
    data: Buffer.from("mp4-bytes"),
    filename: "clip.mp4",
  });
  const bot = fakeBot();

  await publishSubmission(bot, CONFIG, readerSubmission("https://www.youtube.com/watch?v=YMweqIzyB7s"));

  expect(bot.callsTo("sendVideo")).toHaveLength(1);
  expect(youtubeVideo.downloadYoutubeVideo).toHaveBeenCalledWith(
    "https://www.youtube.com/watch?v=YMweqIzyB7s",
    expect.objectContaining({ usePoToken: true }),
  );
});

it("falls back to a playable preview when the video cannot be downloaded", async () => {
  vi.spyOn(youtubeVideo, "downloadYoutubeVideo").mockResolvedValue(null);
  const bot = fakeBot();

  await publishSubmission(bot, CONFIG, readerSubmission("https://youtu.be/YMweqIzyB7s"));

  const [message] = bot.callsTo("sendMessage");
  expect(message.args[2].link_preview_options).toMatchObject({
    is_disabled: false,
    url: "https://youtu.be/YMweqIzyB7s",
  });
});

it("previews an ordinary link instead of publishing bare blue text", async () => {
  const bot = fakeBot();

  await publishSubmission(bot, CONFIG, readerSubmission("новий патч https://www.aniimo.com/newslist/detail/100145"));

  expect(bot.callsTo("sendVideo")).toEqual([]); // nothing to download
  const [message] = bot.callsTo("sendMessage");
  expect(message.args[2].link_preview_options).toMatchObject({
    is_disabled: false,
    url: "https://www.aniimo.com/newslist/detail/100145",
  });
});

it("leaves a reader's plain text without a preview", async () => {
  const bot = fakeBot();

  await publishSubmission(bot, CONFIG, readerSubmission("коли вже нерфнуть Irisalis", "text"));

  const [message] = bot.callsTo("sendMessage");
  expect(message.args[2].link_preview_options).toEqual({ is_disabled: true });
});

it("keeps a collector post's own preview rules", async () => {
  // A Bluesky post quoting a URL must still publish with previews off: its media
  // is attached, and a preview card would fight with it.
  const bot = fakeBot();
  const submission = {
    ...readerSubmission("Дивіться трейлер https://youtu.be/dQw4w9WgXcQ", "text"),
    source_type: "bluesky",
    source_url: "https://bsky.app/profile/x/post/1",
  };
  submission.parts[0].source_type = "bluesky";
  submission.parts[0].source_url = "https://bsky.app/profile/x/post/1";

  await publishSubmission(bot, CONFIG, submission);

  expect(bot.callsTo("sendVideo")).toEqual([]);
  const [message] = bot.callsTo("sendMessage");
  expect(message.args[2].link_preview_options).toEqual({ is_disabled: true });
});
