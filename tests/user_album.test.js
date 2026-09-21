/**
 * Tests for reader-submitted albums: Telegram delivers a media group as separate
 * messages sharing a `media_group_id`, and the bot regroups them into ONE
 * submission — otherwise five photos became five queue entries and five
 * single-photo posts.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { __testing, buildUserComposer } from "../handlers/user.js";
import { t } from "../services/i18n.js";
import * as moderationModule from "../services/moderation.js";
import { dispatch, fakeBot, messageUpdate, sentTexts } from "./helpers/telegram.js";

const { ALBUM_GROUPING_WINDOW_MS, pendingAlbums } = __testing;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  pendingAlbums.clear();
});

function config() {
  return {
    min_submission_text_words: 3,
    min_submission_text_chars: 10,
    admin_user_ids: new Set(),
    telegram_moderation_chat_ids: new Set(),
    submission_cooldown_seconds: 0,
    admin_chat_id: 100,
  };
}

/**
 * Send the given media messages through the composer, then let the grouping
 * window expire so a finished album is queued.
 */
async function submitAlbum(messages, { advance = true } = {}) {
  const albums = [];
  const singles = [];
  const db = {
    async getLatestUserSubmission() {
      return null;
    },
    async createUserAlbumSubmission(kwargs) {
      albums.push(kwargs);
      return 5;
    },
    async createSubmission(kwargs) {
      singles.push(kwargs);
      return 6;
    },
    async getSubmission(id) {
      return { id, status: "pending", parts: [] };
    },
  };
  vi.spyOn(moderationModule, "sendSubmissionToModeration").mockResolvedValue(undefined);

  const bot = fakeBot();
  const composer = buildUserComposer({ config: config(), db, bot });
  for (const message of messages) {
    await dispatch(composer, messageUpdate({ chatId: 123, chatType: "private", userId: 999, ...message }), bot);
  }
  if (advance) {
    await vi.advanceTimersByTimeAsync(ALBUM_GROUPING_WINDOW_MS + 10);
  }
  return { albums, singles, answers: sentTexts(bot) };
}

const photo = (id) => [{ file_id: `${id}-small`, width: 90, height: 90 }, { file_id: id, width: 1280, height: 720 }];

it("queues one submission for a photo album", async () => {
  const { albums, singles, answers } = await submitAlbum([
    { photo: photo("p1"), caption: "Дивіться, що знайшов", mediaGroupId: "g1" },
    { photo: photo("p2"), mediaGroupId: "g1" },
    { photo: photo("p3"), mediaGroupId: "g1" },
  ]);

  expect(singles).toEqual([]);
  expect(albums).toHaveLength(1);
  expect(albums[0].items.map((item) => item.file_id)).toEqual(["p1", "p2", "p3"]);
  expect(albums[0].original_text).toBe("Дивіться, що знайшов");
  expect(albums[0].user_id).toBe(999);
  // One album, one reply — not one per photo.
  expect(answers).toEqual([t("user.thank_you")]);
});

it("keeps a photo-and-video album together", async () => {
  // Telegram allows the mix in one media group, so the video must not be split
  // off into a post of its own.
  const { albums } = await submitAlbum([
    { photo: photo("p1"), mediaGroupId: "g2" },
    { video: { file_id: "v1", width: 1280, height: 720, duration: 5 }, mediaGroupId: "g2" },
  ]);

  expect(albums).toHaveLength(1);
  expect(albums[0].items).toEqual([
    { file_id: "p1", media_type: "photo" },
    { file_id: "v1", media_type: "video" },
  ]);
});

it("takes the caption from whichever item carries it", async () => {
  const { albums } = await submitAlbum([
    { photo: photo("p1"), mediaGroupId: "g3" },
    { photo: photo("p2"), caption: "підпис", mediaGroupId: "g3" },
  ]);

  expect(albums[0].original_text).toBe("підпис");
});

it("stores a one-item group as an ordinary submission", async () => {
  // Nothing is published as a one-item "album": a media group needs 2-10 items.
  const { albums, singles } = await submitAlbum([{ photo: photo("p1"), caption: "самотнє фото", mediaGroupId: "g4" }]);

  expect(albums).toEqual([]);
  expect(singles).toHaveLength(1);
  expect(singles[0].message_type).toBe("photo");
  expect(singles[0].file_id).toBe("p1");
});

it("leaves a lone photo with no media group alone", async () => {
  const { albums, singles } = await submitAlbum([{ photo: photo("p1"), caption: "фото" }]);

  expect(albums).toEqual([]);
  expect(singles).toHaveLength(1);
});

it("does not queue anything until the group has settled", async () => {
  // The window restarts with each item, so a slow upload still lands in the same
  // submission instead of being cut into two posts.
  const { albums, singles } = await submitAlbum(
    [
      { photo: photo("p1"), mediaGroupId: "g5" },
      { photo: photo("p2"), mediaGroupId: "g5" },
    ],
    { advance: false },
  );

  expect(albums).toEqual([]);
  expect(singles).toEqual([]);
  await vi.advanceTimersByTimeAsync(ALBUM_GROUPING_WINDOW_MS + 10);
  expect(albums).toHaveLength(1);
});

it("keeps two different albums apart", async () => {
  const { albums } = await submitAlbum([
    { photo: photo("a1"), mediaGroupId: "g6" },
    { photo: photo("b1"), mediaGroupId: "g7" },
    { photo: photo("a2"), mediaGroupId: "g6" },
    { photo: photo("b2"), mediaGroupId: "g7" },
  ]);

  expect(albums).toHaveLength(2);
  expect(albums.map((album) => album.items.map((item) => item.file_id))).toEqual([
    ["a1", "a2"],
    ["b1", "b2"],
  ]);
});
