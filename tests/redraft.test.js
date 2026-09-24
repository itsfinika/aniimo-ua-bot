/**
 * /redraft — re-draft the newest item of a source that has nothing new left.
 *
 * A source that has been collecting for months reports "found 9, duplicates 9,
 * new 0" and produces nothing, so there is no way to check the pipeline after a
 * change. /cleanup cannot help: it deliberately leaves `seen_sources` alone,
 * because clearing it would re-queue every old article at once.
 *
 * The two properties that make this safe to run against production are asserted
 * here: exactly ONE draft, and `seen_sources` untouched.
 */

import { expect, it } from "vitest";

import { buildAdminComposer } from "../handlers/admin.js";
import { CollectionMode, listingEntry } from "../services/collectors/base.js";
import { BaseNewsCollector, entryMatchesUrl } from "../services/collectors/runner.js";
import { RedraftCallback, redraftSourceKeyboard, unpackRedraftCallback } from "../keyboards.js";
import { dispatch, fakeBot, messageUpdate, sentTexts } from "./helpers/telegram.js";

const ARTICLES = [
  { id: "a3", title: "Newest article" },
  { id: "a2", title: "Older article" },
  { id: "a1", title: "Oldest article" },
];

class FakeDb {
  constructor() {
    // Everything this source can offer has already been posted.
    this.seen = new Set(ARTICLES.map((article) => article.id));
    this.marked = [];
  }

  async isSourceSeen(_sourceType, sourceId) {
    return this.seen.has(sourceId);
  }

  async markSourceSeen(row) {
    this.marked.push(row);
    this.seen.add(row.source_id);
  }

  async getLatestSeenArticleDate() {
    return null;
  }

  async getRecentSeenTitles() {
    return [];
  }
}

class FakeCollector extends BaseNewsCollector {
  static definition = {
    collector_id: "official_aniimo",
    source_type: "official_aniimo",
    title: "Офіційний сайт",
    button_text: "Офіційний сайт",
  };

  missingGeminiWarning() {
    return "no key";
  }

  async fetchListing() {
    return ARTICLES.map((article) => listingEntry(article.id, article));
  }

  async parseEntry(entry) {
    return {
      source_id: entry.dedup_key,
      source_url: `https://x/${entry.dedup_key}`,
      title: entry.payload.title,
      body_text: "body",
      source_name: "Офіційний сайт",
      username: "collector",
      original_text: "original",
      article_date: null,
      article_date_display: null,
      has_media: false,
      media_url: null,
      media_type: "none",
      additional_media_urls: null,
    };
  }
}

function buildCollector() {
  const db = new FakeDb();
  const collector = new FakeCollector({
    config: { gemini_api_key: "k", article_timezone: "Europe/Kyiv" },
    db,
    bot: null,
  });
  const drafted = [];
  collector.createModerationSubmissions = async (candidate, _generator, stats) => {
    drafted.push(candidate);
    stats.sent_to_moderation += 1;
  };
  return { collector, db, drafted };
}

it("normally produces nothing once every item has been seen", async () => {
  const { collector, drafted } = buildCollector();

  const stats = await collector.runOnce(CollectionMode.MANUAL_LATEST);

  expect(drafted).toEqual([]);
  expect(stats.duplicates).toBe(3);
  expect(stats.new).toBe(0);
});

it("re-drafts the newest item even though it is already seen", async () => {
  const { collector, drafted } = buildCollector();

  const stats = await collector.runOnce(CollectionMode.FORCE_LATEST);

  expect(drafted.map((candidate) => candidate.title)).toEqual(["Newest article"]);
  expect(stats.new).toBe(1);
  expect(stats.sent_to_moderation).toBe(1);
});

it("drafts exactly one item, never the whole backlog", async () => {
  const { collector, drafted } = buildCollector();

  await collector.runOnce(CollectionMode.FORCE_LATEST);

  // The point of the mode is a single test post, not a flood of nine.
  expect(drafted).toHaveLength(1);
});

it("writes nothing to seen_sources, so a rejected test draft leaves no trace", async () => {
  const { collector, db } = buildCollector();
  const before = new Set(db.seen);

  await collector.runOnce(CollectionMode.FORCE_LATEST);

  expect(db.marked).toEqual([]);
  expect([...db.seen].sort()).toEqual([...before].sort());
});

it("does nothing when the source lists no items at all", async () => {
  const { collector, drafted } = buildCollector();
  collector.fetchListing = async () => [];

  const stats = await collector.runOnce(CollectionMode.FORCE_LATEST);

  expect(drafted).toEqual([]);
  expect(stats.sent_to_moderation).toBe(0);
});

// --- the callback wiring ----------------------------------------------------

it("keeps the /fetch_news buttons already sitting in the admin chat working", () => {
  // The redraft picker got its own prefix precisely so widening the collector
  // callback could not invalidate keyboards sent before the deploy.
  const old = "collector:official_aniimo";
  expect(unpackRedraftCallback(old)).toBeNull();
  expect(unpackRedraftCallback(RedraftCallback.pack({ collector_id: "official_aniimo" }))).toEqual({
    collector_id: "official_aniimo",
  });
});

it("builds one button per source with the redraft prefix", () => {
  const keyboard = redraftSourceKeyboard([
    { collector_id: "official_aniimo", button_text: "Офіційний" },
    { collector_id: "reddit", button_text: "Reddit" },
  ]);

  expect(keyboard.inline_keyboard.map((row) => row[0].callback_data)).toEqual([
    "recollect:official_aniimo",
    "recollect:reddit",
  ]);
});

it("offers the source picker to an admin and refuses everyone else", async () => {
  const bot = fakeBot();
  const composer = buildAdminComposer({ config: adminConfig(), db: {}, bot });
  const update = (userId) =>
    messageUpdate({ text: "/redraft", userId, chatId: -4242, chatType: "supergroup" });

  await dispatch(composer, update(7), bot);
  expect(sentTexts(bot).some((text) => text.includes("повторної чернетки"))).toBe(true);

  bot.calls.length = 0;
  await dispatch(composer, update(999), bot);
  expect(sentTexts(bot).some((text) => text.includes("немає прав"))).toBe(true);
});

it("runs the collector in FORCE_LATEST when the redraft button is tapped", async () => {
  const { modes, drafted, composer, bot } = wiredComposer();

  await dispatch(composer, callbackUpdate(RedraftCallback.pack({ collector_id: "official_aniimo" })), bot);

  expect(modes).toEqual([CollectionMode.FORCE_LATEST]);
  expect(drafted).toHaveLength(1);
});

it("still runs MANUAL_LATEST for the plain /fetch_news button", async () => {
  const { modes, drafted, composer, bot } = wiredComposer();

  await dispatch(composer, callbackUpdate("collector:official_aniimo"), bot);

  expect(modes).toEqual([CollectionMode.MANUAL_LATEST]);
  // Everything is already seen, so the ordinary button still yields nothing.
  expect(drafted).toEqual([]);
});

function adminConfig() {
  return {
    admin_chat_id: -4242,
    admin_user_ids: new Set([7]),
    enable_telegram_moderation: false,
    telegram_moderation_chat_ids: new Set(),
  };
}

/** An admin composer whose registry hands back the fake collector. */
function wiredComposer() {
  const { collector, drafted } = buildCollector();
  const modes = [];
  const runOnce = collector.runOnce.bind(collector);
  collector.runOnce = async (mode) => {
    modes.push(mode);
    return runOnce(mode);
  };

  const bot = fakeBot();
  const composer = buildAdminComposer({
    config: adminConfig(),
    db: {},
    bot,
    registry: {
      create: () => collector,
      definition: () => FakeCollector.definition,
      list: () => [FakeCollector.definition],
    },
  });
  return { modes, drafted, composer, bot };
}

function callbackUpdate(data) {
  return {
    update_id: 1,
    callback_query: {
      id: "1",
      from: { id: 7, is_bot: false, first_name: "A" },
      chat_instance: "1",
      data,
      message: { message_id: 5, date: 0, chat: { id: -4242, type: "supergroup" }, text: "pick" },
    },
  };
}

// --- /redraft <link>: re-draft ONE named article, not just the newest ------------
//
// The buttons can only reach a source's newest item, which is no help when a fix
// has to be re-applied to something published weeks ago.

it("re-drafts the article named by its URL, not the newest one", async () => {
  const { collector, drafted } = buildCollector();

  const stats = await collector.redraftUrl("https://x/a2");

  expect(drafted.map((candidate) => candidate.title)).toEqual(["Older article"]);
  expect(stats.new).toBe(1);
  expect(stats.sent_to_moderation).toBe(1);
});

it("returns null for a URL this source does not list, so the next one is tried", async () => {
  const { collector, drafted } = buildCollector();

  expect(await collector.redraftUrl("https://x/nope")).toBeNull();
  expect(drafted).toEqual([]);
});

it("re-drafts exactly one article, never the rest of the listing", async () => {
  const { collector, drafted } = buildCollector();

  await collector.redraftUrl("https://x/a1");

  expect(drafted).toHaveLength(1);
});

it("reports the missing Gemini key instead of drafting", async () => {
  const { collector, drafted } = buildCollector();
  collector.config = { ...collector.config, gemini_api_key: "" };

  const stats = await collector.redraftUrl("https://x/a2");

  expect(drafted).toEqual([]);
  expect(stats.errors).toEqual(["no key"]);
});

it("matches a listing entry keyed by URL and one keyed by an opaque id", () => {
  // The official site keys entries by the canonical URL itself.
  const byUrl = listingEntry("https://www.aniimo.com/newslist/detail/100111");
  expect(entryMatchesUrl(byUrl, "https://www.aniimo.com/newslist/detail/100111")).toBe(true);
  // Scheme, "www." and a trailing slash are noise, not a different article.
  expect(entryMatchesUrl(byUrl, "http://aniimo.com/newslist/detail/100111/")).toBe(true);
  expect(entryMatchesUrl(byUrl, "https://www.aniimo.com/newslist/detail/100147")).toBe(false);

  // Steam/YouTube/Reddit key by an id that appears inside the article's link.
  const byId = listingEntry("dQw4w9WgXcQ");
  expect(entryMatchesUrl(byId, "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
  expect(entryMatchesUrl(byId, "https://youtu.be/dQw4w9WgXcQ")).toBe(true);
  expect(entryMatchesUrl(byId, "https://youtu.be/somethingelse")).toBe(false);

  // A short id must not match as a substring of a longer one.
  expect(entryMatchesUrl(listingEntry("1"), "https://www.aniimo.com/newslist/detail/100111")).toBe(false);
  expect(entryMatchesUrl(listingEntry(""), "https://x/a")).toBe(false);
});

it("passes a /redraft link to the registry instead of showing the source picker", async () => {
  const bot = fakeBot();
  const seen = [];
  const composer = buildAdminComposer({
    config: adminConfig(),
    db: {},
    bot,
    registry: {
      list: () => [],
      redraftUrl: async ({ url }) => {
        seen.push(url);
        return { source_title: "Офіційний сайт", found: 20, duplicates: 19, new: 1, drafts_created: 1, sent_to_moderation: 1, failed: 0, errors: [] };
      },
    },
  });

  await dispatch(
    composer,
    messageUpdate({
      text: "/redraft https://www.aniimo.com/newslist/detail/100111",
      userId: 7,
      chatId: -4242,
      chatType: "supergroup",
    }),
    bot,
  );

  expect(seen).toEqual(["https://www.aniimo.com/newslist/detail/100111"]);
  expect(sentTexts(bot).some((text) => text.includes("повторної чернетки"))).toBe(false);
});

it("says so when no source lists that link, and rejects a non-link argument", async () => {
  const bot = fakeBot();
  const composer = buildAdminComposer({
    config: adminConfig(),
    db: {},
    bot,
    registry: { list: () => [], redraftUrl: async () => null },
  });
  const send = (text) =>
    dispatch(composer, messageUpdate({ text, userId: 7, chatId: -4242, chatType: "supergroup" }), bot);

  await send("/redraft https://www.aniimo.com/newslist/detail/999999");
  expect(sentTexts(bot).some((text) => text.includes("Не знайшла цю статтю"))).toBe(true);

  bot.calls.length = 0;
  await send("/redraft останню");
  expect(sentTexts(bot).some((text) => text.includes("треба дати посилання"))).toBe(true);
});
