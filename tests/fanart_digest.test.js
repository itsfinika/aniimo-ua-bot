/**
 * Tests for the weekly fan-art digest: album submission storage, the run-once
 * build/dedup logic, the weekly schedule helper, and album image extraction.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DateTime } from "luxon";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Database } from "../database.js";
import { buildAdminComposer } from "../handlers/admin.js";
import * as redditFeedFetcher from "../services/collectors/reddit/feed_fetcher.js";
import * as fanart from "../services/digests/fanart.js";
import {
  MAX_ARTS_PER_AUTHOR,
  __testing,
  nextWeeklyRunAt,
  pickDigestArts,
  runFanartDigestOnce,
} from "../services/digests/fanart.js";
import { t } from "../services/i18n.js";
import * as moderationModule from "../services/moderation.js";
import { albumItems } from "../services/publisher.js";
import { dispatch, fakeBot, messageUpdate, sentTexts } from "./helpers/telegram.js";

const { authorHandle, isDirectImage, isoWeekKey } = __testing;
const TZ = "Europe/Kyiv";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanart-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function redditPost(postId, title, image, author = "/u/artist") {
  return {
    post_id: postId,
    web_url: `https://www.reddit.com/r/Aniimo/comments/${postId.slice(3)}/x/`,
    title,
    body_text: "",
    created_at: "2026-06-12T10:00:00+00:00",
    image_url: image,
    author,
  };
}

function config() {
  return {
    article_timezone: TZ,
    fanart_subreddit: "Aniimo",
    fanart_flair: "Media",
    fanart_digest_count: 10,
  };
}

// --- DB album submission ----------------------------------------------------------

it("stores one part per image", async () => {
  const db = new Database(path.join(tmpDir, "bot.db"));
  await db.init();

  const submissionId = await db.createAlbumSubmission({
    username: "fanart_digest",
    original_text: "orig",
    caption: "CAPTION TEXT",
    image_urls: ["https://i.redd.it/a.jpg", "https://i.redd.it/b.jpg", "https://i.redd.it/a.jpg"],
    source_type: "reddit_fanart",
    source_id: "2026-W24",
    source_url: "https://www.reddit.com/r/Aniimo/",
  });
  const submission = await db.getSubmission(submissionId);

  expect(submission.message_type).toBe("album");
  expect(submission.media_url).toBe("https://i.redd.it/a.jpg");
  const parts = submission.parts;
  expect(parts.map((part) => part.media_url)).toEqual(["https://i.redd.it/a.jpg", "https://i.redd.it/b.jpg"]); // dedup
  expect(parts.every((part) => String(part.message_type) === "album")).toBe(true);
  expect(parts[0].text).toBe("CAPTION TEXT");
  expect(parts[1].text).toBeFalsy();
});

it("caps the album at ten images", async () => {
  const db = new Database(path.join(tmpDir, "bot.db"));
  await db.init();

  const submissionId = await db.createAlbumSubmission({
    username: "fanart_digest",
    original_text: "orig",
    caption: "c",
    image_urls: Array.from({ length: 15 }, (_value, index) => `https://i.redd.it/${index}.jpg`),
    source_type: "reddit_fanart",
    source_id: "2026-W25",
    source_url: "https://www.reddit.com/r/Aniimo/",
  });
  const submission = await db.getSubmission(submissionId);
  expect(submission.parts).toHaveLength(10);
});

// --- run-once build / dedup -------------------------------------------------------

class FakeDb {
  constructor({ seen = false } = {}) {
    this._seen = seen;
    this.created = null;
    this.marked = [];
  }

  async isSourceSeen() {
    return this._seen;
  }

  async createAlbumSubmission(kwargs) {
    this.created = kwargs;
    return 42;
  }

  async markSourceSeen(kwargs) {
    this.marked.push(kwargs);
  }
}

function stubFetcher(posts) {
  vi.spyOn(redditFeedFetcher, "RedditSearchFetcher").mockImplementation(function stub() {
    return {
      async fetchRecentPosts() {
        return posts;
      },
    };
  });
}

function stubSend(sent) {
  vi.spyOn(moderationModule, "sendSubmissionToModeration").mockImplementation(async (_bot, _config, _db, id) => {
    sent.push(id);
  });
}

function kyivNow() {
  return DateTime.fromObject({ year: 2026, month: 6, day: 12, hour: 18, minute: 0 }, { zone: TZ });
}

it("builds the album from image posts and marks the week", async () => {
  const posts = [
    redditPost("t3_1", "Art One", "https://i.redd.it/1.jpg", "/u/alice"),
    redditPost("t3_2", "Art Two", "https://i.redd.it/2.jpg", "u/bob"),
    redditPost("t3_3", "No image", null, "/u/carol"), // excluded: no image
  ];
  stubFetcher(posts);
  const sent = [];
  stubSend(sent);
  const db = new FakeDb();
  const now = kyivNow();

  const created = await runFanartDigestOnce(null, config(), db, { now });

  expect(created).toBe(true);
  expect(sent).toEqual([42]);
  expect(db.created.image_urls).toEqual(["https://i.redd.it/1.jpg", "https://i.redd.it/2.jpg"]);
  const caption = db.created.caption;
  // Author nicks are hyperlinked to their posts; post titles are NOT shown.
  expect(caption).toContain('<a href="https://www.reddit.com/r/Aniimo/comments/1/x/">u/alice</a>');
  expect(caption).toContain("u/bob");
  expect(caption).not.toContain("Art One");
  expect(caption).not.toContain("Art Two");
  expect(caption).toContain("сподобався"); // engagement prompt
  expect(caption).toContain("#КадриТижня"); // tags
  expect(db.marked.length).toBeGreaterThan(0);
  expect(db.marked[0].source_id).toBe(isoWeekKey(now));
});

it("skips when the week is already seen", async () => {
  stubFetcher([redditPost("t3_1", "Art", "https://i.redd.it/1.jpg")]);
  const db = new FakeDb({ seen: true });

  const created = await runFanartDigestOnce(null, config(), db, { now: kyivNow() });

  expect(created).toBe(false);
  expect(db.created).toBeNull();
  expect(db.marked).toEqual([]);
});

it("bypasses the week guard with force", async () => {
  // /fanartdigest force must build the digest even when the week is already seen.
  stubFetcher([redditPost("t3_1", "Art", "https://i.redd.it/1.jpg", "u/alice")]);
  const sent = [];
  stubSend(sent);
  const db = new FakeDb({ seen: true });

  const created = await runFanartDigestOnce(null, config(), db, { now: kyivNow(), force: true });

  expect(created).toBe(true);
  expect(sent).toEqual([42]);
  expect(db.created).not.toBeNull();
});

it("skips non-direct-image posts", async () => {
  // Gallery/video/external posts expose only a signed preview URL Telegram can't
  // fetch in an album, so they must be dropped (not break the whole digest).
  stubFetcher([
    redditPost("t3_1", "Gallery", "https://preview.redd.it/x.jpg?s=sig"),
    redditPost("t3_2", "Direct", "https://i.redd.it/2.jpg"),
  ]);
  stubSend([]);
  const db = new FakeDb();

  const created = await runFanartDigestOnce(null, config(), db, { now: kyivNow() });

  expect(created).toBe(true);
  expect(db.created.image_urls).toEqual(["https://i.redd.it/2.jpg"]);
});

it("does not mark the week when there are no arts", async () => {
  stubFetcher([redditPost("t3_3", "No image", null)]);
  const db = new FakeDb();

  const created = await runFanartDigestOnce(null, config(), db, { now: kyivNow() });

  // Empty week: don't mark seen, so a later manual run can still post.
  expect(created).toBe(false);
  expect(db.created).toBeNull();
  expect(db.marked).toEqual([]);
});

// --- the /fanartdigest command ---------------------------------------------------

function commandConfig({ enabled }) {
  return {
    enable_fanart_digest: enabled,
    admin_user_ids: new Set([7]),
    admin_chat_id: 100,
    telegram_moderation_chat_ids: new Set(),
  };
}

async function runCommand(config, created) {
  vi.spyOn(fanart, "runFanartDigestOnce").mockResolvedValue(created);
  const bot = fakeBot();
  const composer = buildAdminComposer({ config, db: {}, bot });
  await dispatch(composer, messageUpdate({ text: "/fanartdigest", userId: 7, chatId: 100 }), bot);
  return sentTexts(bot);
}

it("warns when the weekly scheduler is off", async () => {
  // The digest is still built — an admin who typed the command wants it — but a
  // disabled scheduler means nothing will appear on Friday, so say so.
  const answers = await runCommand(commandConfig({ enabled: false }), true);

  expect(answers[0]).toContain("ENABLE_FANART_DIGEST");
  expect(answers[answers.length - 1]).toBe(t("admin.fanart_digest.queued"));
});

it("stays quiet when the scheduler is on", async () => {
  const answers = await runCommand(commandConfig({ enabled: true }), true);
  expect(answers).toEqual([t("admin.fanart_digest.started"), t("admin.fanart_digest.queued")]);
});

// --- helpers ----------------------------------------------------------------------

it("accepts only i.redd.it still images", () => {
  expect(isDirectImage("https://i.redd.it/a.jpg")).toBe(true);
  expect(isDirectImage("https://i.redd.it/a.PNG")).toBe(true);
  expect(isDirectImage("https://preview.redd.it/a.jpg?s=x")).toBe(false);
  expect(isDirectImage("https://external-preview.redd.it/a.jpg")).toBe(false);
  expect(isDirectImage("https://i.redd.it.attacker.com/a.jpg")).toBe(false);
  expect(isDirectImage("https://i.redd.it/a.gif")).toBe(false); // animated -> album would skip it
  expect(isDirectImage("https://i.redd.it/a")).toBe(false); // no still-image extension
  expect(isDirectImage(null)).toBe(false);
});

it("lands the weekly run on the target weekday", () => {
  const now = DateTime.fromObject({ year: 2026, month: 6, day: 10, hour: 10 }, { zone: TZ }); // a Wednesday
  const nextRun = nextWeeklyRunAt(now, 4, 18); // Friday 18:00
  expect(nextRun.weekday).toBe(5); // luxon: 1=Mon, so Friday is 5
  expect(nextRun.hour).toBe(18);
  expect(nextRun > now).toBe(true);
  expect(nextRun <= now.plus({ days: 7 })).toBe(true);
});

it("handles the target weekday before and after the hour", () => {
  const base = DateTime.fromObject({ year: 2026, month: 6, day: 10, hour: 0 }, { zone: TZ });
  const friday = base.plus({ days: (4 - (base.weekday - 1) + 7) % 7 }).set({ hour: 10 });
  expect(nextWeeklyRunAt(friday, 4, 18).toISODate()).toBe(friday.toISODate()); // before 18:00 -> today
  const after = friday.set({ hour: 19 });
  expect(nextWeeklyRunAt(after, 4, 18).toISODate()).toBe(friday.plus({ days: 7 }).toISODate());
});

it("normalises the author handle", () => {
  expect(authorHandle("/u/Alice")).toBe("u/Alice");
  expect(authorHandle("u/Bob")).toBe("u/Bob");
  expect(authorHandle("Carol")).toBe("u/Carol");
  expect(authorHandle("")).toBe("");
});

it("dedups and caps the album items", () => {
  const submission = {
    parts: [{ media_url: "a" }, { media_url: "b" }, { media_url: "a" }, { media_url: "" }],
    media_url: "x",
  };
  expect(albumItems(submission).map((item) => item.media_url)).toEqual(["a", "b"]);
  expect(albumItems({ parts: [], media_url: "only" }).map((item) => item.media_url)).toEqual(["only"]);
  const many = { parts: Array.from({ length: 12 }, (_value, index) => ({ media_url: `u${index}` })) };
  expect(albumItems(many).map((item) => item.media_url)).toEqual(
    Array.from({ length: 10 }, (_value, index) => `u${index}`),
  );
  // A digest album is photos by URL, which is what the collector path has always sent.
  expect(albumItems(submission).every((item) => item.media_type === "photo" && item.file_id === null)).toBe(true);
});


// --- per-artist cap ---------------------------------------------------------
//
// Reddit ranks the weekly top per post, so one prolific artist could take four
// of the ten slots and the digest stopped reading as a community round-up.

const art = (author, id) => ({ author, image_url: `https://i.redd.it/${id}.jpg`, web_url: `https://r/${id}` });

it("takes at most three works from one artist", () => {
  const posts = [
    art("u/Popo", 1), art("u/Popo", 2), art("u/Popo", 3), art("u/Popo", 4),
    art("u/Other", 5), art("u/Third", 6),
  ];

  const picked = pickDigestArts(posts, 5);

  expect(picked.filter((post) => post.author === "u/Popo")).toHaveLength(MAX_ARTS_PER_AUTHOR);
  expect(picked.map((post) => post.web_url)).toEqual(["https://r/1", "https://r/2", "https://r/3", "https://r/5", "https://r/6"]);
});

it("keeps the album full rather than short when capping runs out of artists", () => {
  // Only two artists posted this week; a strict cap would leave 4 of 6 slots
  // empty, and a short album is worse than a lopsided one.
  const posts = [
    art("u/Popo", 1), art("u/Popo", 2), art("u/Popo", 3), art("u/Popo", 4), art("u/Popo", 5),
    art("u/Other", 6),
  ];

  const picked = pickDigestArts(posts, 6);

  expect(picked).toHaveLength(6);
  // Capped picks keep their ranking; the held-back works refill the tail in order.
  expect(picked.map((post) => post.web_url)).toEqual([
    "https://r/1",
    "https://r/2",
    "https://r/3",
    "https://r/6",
    "https://r/4",
    "https://r/5",
  ]);
});

it("never caps unknown authors together", () => {
  const posts = [art("", 1), art("", 2), art("", 3), art("", 4), art("u/Popo", 5)];

  expect(pickDigestArts(posts, 5)).toHaveLength(5);
});

it("normalises the handle before counting, so u/X and X are one artist", () => {
  const posts = [art("u/Popo", 1), art("Popo", 2), art("/u/POPO", 3), art("popo", 4), art("u/Other", 5)];

  const picked = pickDigestArts(posts, 5);

  expect(picked.map((post) => post.web_url)).toEqual(["https://r/1", "https://r/2", "https://r/3", "https://r/5", "https://r/4"]);
});

it("leaves a already-varied week untouched", () => {
  const posts = [art("u/A", 1), art("u/B", 2), art("u/C", 3)];
  expect(pickDigestArts(posts, 10).map((post) => post.web_url)).toEqual(["https://r/1", "https://r/2", "https://r/3"]);
});
