/**
 * Tests for cross-source semantic dedup: the BaseNewsCollector wiring that asks
 * Gemini whether a parsed candidate duplicates a recently-seen title, and the
 * getRecentSeenTitles query it relies on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it } from "vitest";

import { Database } from "../database.js";
import { collectionStats, collectorDefinition, draftCandidate, listingEntry } from "../services/collectors/base.js";
import { BaseNewsCollector, isNewerOrSameArticleDate } from "../services/collectors/runner.js";
import { OfficialAniimoCollector } from "../services/collectors/official_aniimo/collector.js";

const DEFINITION = collectorDefinition({
  collector_id: "test_source",
  source_type: "test_source",
  title_key: "collectors.bluesky.title",
  button_key: "buttons.collector_bluesky",
});

const CANDIDATE = draftCandidate({
  source_id: "s1",
  source_url: "https://example.com/1",
  title: "New shiny trailer",
  body_text: "body",
  source_name: "Test Source",
  username: "tester",
  original_text: "original",
  article_date: "2026-06-16",
});

const ENTRY = listingEntry("s1", null);

class FakeDb {
  constructor({ seen = [], titles = [] } = {}) {
    this.seen = new Set(seen.map(([type, id]) => `${type}:${id}`));
    this.titles = [...titles];
    this.marked = [];
    this.lastExclude = undefined;
  }

  async isSourceSeen(sourceType, sourceId) {
    return this.seen.has(`${sourceType}:${sourceId}`);
  }

  async getRecentSeenTitles({ limit, exclude_source_type = null }) {
    this.lastExclude = exclude_source_type;
    return this.titles.slice(0, limit);
  }

  async markSourceSeen(kwargs) {
    this.marked.push(kwargs);
  }
}

class FakeGenerator {
  constructor({ verdict = null, error = null } = {}) {
    this.verdict = verdict ?? { is_duplicate: false, matched_title: null };
    this.error = error;
    this.calls = [];
  }

  async findDuplicateTitle(newTitle, existingTitles) {
    this.calls.push([newTitle, [...existingTitles]]);
    if (this.error !== null) {
      throw this.error;
    }
    return this.verdict;
  }
}

class StubCollector extends BaseNewsCollector {
  static definition = DEFINITION;

  constructor({ config, db }) {
    super({ config, db, bot: null });
    this.parseCalls = 0;
  }

  async fetchListing() {
    return [ENTRY];
  }

  async parseEntry() {
    this.parseCalls += 1;
    return CANDIDATE;
  }

  missingGeminiWarning() {
    return "no gemini";
  }
}

function config({ enabled = true, limit = 200 } = {}) {
  return { enable_cross_source_dedup: enabled, cross_source_dedup_title_limit: limit };
}

function freshStats() {
  return collectionStats({ collector_id: "test_source", source_type: "test_source", source_title: "Test" });
}

function parse(collector, generator, stats) {
  return collector.parseCandidateIfNeeded(ENTRY, stats, null, generator);
}

it("skips a cross-source duplicate and marks it seen", async () => {
  const db = new FakeDb({ titles: ["New shiny trailer (official)"] });
  const generator = new FakeGenerator({
    verdict: { is_duplicate: true, matched_title: "New shiny trailer (official)" },
  });
  const collector = new StubCollector({ config: config(), db });
  const stats = freshStats();

  const result = await parse(collector, generator, stats);

  expect(result).toBeNull();
  expect(stats.duplicates).toBe(1);
  expect(stats.new).toBe(0);
  expect(generator.calls.length, "Gemini should have been consulted").toBeGreaterThan(0);
  // A source must never be compared against its own titles.
  expect(db.lastExclude).toBe("test_source");
  // Marked seen so the same item is not re-fetched and re-checked next run.
  expect(db.marked).toHaveLength(1);
  expect(db.marked[0].source_id).toBe("s1");
  expect(db.marked[0].title).toBe("New shiny trailer");
});

it("passes a unique candidate through", async () => {
  const db = new FakeDb({ titles: ["Something unrelated"] });
  const generator = new FakeGenerator({ verdict: { is_duplicate: false, matched_title: null } });
  const collector = new StubCollector({ config: config(), db });
  const stats = freshStats();

  const result = await parse(collector, generator, stats);

  expect(result).toBe(CANDIDATE);
  expect(stats.new).toBe(1);
  expect(stats.duplicates).toBe(0);
  expect(db.marked).toEqual([]);
});

it("does not consult Gemini when dedup is disabled", async () => {
  const db = new FakeDb({ titles: ["New shiny trailer"] });
  const generator = new FakeGenerator({ verdict: { is_duplicate: true } }); // would say dup if asked
  const collector = new StubCollector({ config: config({ enabled: false }), db });
  const stats = freshStats();

  const result = await parse(collector, generator, stats);

  expect(result).toBe(CANDIDATE);
  expect(stats.new).toBe(1);
  expect(generator.calls).toEqual([]);
});

it("does not consult Gemini with a zero limit", async () => {
  const db = new FakeDb({ titles: ["New shiny trailer"] });
  const generator = new FakeGenerator({ verdict: { is_duplicate: true } });
  const collector = new StubCollector({ config: config({ limit: 0 }), db });
  const stats = freshStats();

  const result = await parse(collector, generator, stats);

  expect(result).toBe(CANDIDATE);
  expect(stats.new).toBe(1);
  expect(generator.calls).toEqual([]);
});

it("does not consult Gemini with no existing titles", async () => {
  const db = new FakeDb({ titles: [] });
  const generator = new FakeGenerator({ verdict: { is_duplicate: true } });
  const collector = new StubCollector({ config: config(), db });
  const stats = freshStats();

  const result = await parse(collector, generator, stats);

  expect(result).toBe(CANDIDATE);
  expect(stats.new).toBe(1);
  expect(generator.calls).toEqual([]);
});

it("fails open when the dedup check throws", async () => {
  const db = new FakeDb({ titles: ["New shiny trailer"] });
  const generator = new FakeGenerator({ error: new Error("gemini exploded") });
  const collector = new StubCollector({ config: config(), db });
  const stats = freshStats();

  const result = await parse(collector, generator, stats);

  // Fail open: a check error must never drop real news.
  expect(result).toBe(CANDIDATE);
  expect(stats.new).toBe(1);
  expect(db.marked).toEqual([]);
});

it("short-circuits an exactly-seen entry before parsing or dedup", async () => {
  const db = new FakeDb({ seen: [["test_source", "s1"]], titles: ["New shiny trailer"] });
  const generator = new FakeGenerator({ verdict: { is_duplicate: true } });
  const collector = new StubCollector({ config: config(), db });
  const stats = freshStats();

  const result = await parse(collector, generator, stats);

  expect(result).toBeNull();
  expect(stats.duplicates).toBe(1);
  expect(collector.parseCalls).toBe(0); // never parsed
  expect(generator.calls).toEqual([]); // never asked Gemini
});

it("never suppresses an authoritative source", async () => {
  // A collector that opts out (the official, authoritative source) must never be
  // dropped as a cross-source duplicate of a shorter social post — and must not
  // even consult Gemini.
  const db = new FakeDb({ titles: ["New shiny trailer (Bluesky)"] });
  const generator = new FakeGenerator({
    verdict: { is_duplicate: true, matched_title: "New shiny trailer (Bluesky)" },
  });
  const collector = new StubCollector({ config: config(), db });
  collector.participatesInCrossSourceDedup = false;
  const stats = freshStats();

  const result = await parse(collector, generator, stats);

  expect(result).toBe(CANDIDATE);
  expect(stats.new).toBe(1);
  expect(stats.duplicates).toBe(0);
  expect(generator.calls).toEqual([]);
  expect(db.marked).toEqual([]);
});

it("has the official collector opt out while the base default participates", () => {
  expect(OfficialAniimoCollector.participates_in_cross_source_dedup).toBe(false);
  expect(BaseNewsCollector.participates_in_cross_source_dedup).toBe(true);
});

it("keeps a same-day article when the date granularity degrades", () => {
  // latestSeen carries a full afternoon timestamp; a genuinely-new same-day
  // article whose detail-page fetch failed degrades to a date-only card date.
  // Comparing date-only midnight against the afternoon timestamp must NOT drop it.
  expect(isNewerOrSameArticleDate("2026-06-16", "2026-06-16T18:00+03:00")).toBe(true);
  // ...and the symmetric case (seen value is the date-only one).
  expect(isNewerOrSameArticleDate("2026-06-16T09:00+03:00", "2026-06-16")).toBe(true);
});

it("drops a strictly older date-only article", () => {
  expect(isNewerOrSameArticleDate("2026-06-15", "2026-06-16T18:00+03:00")).toBe(false);
});

it("compares full timestamps precisely", () => {
  expect(isNewerOrSameArticleDate("2026-06-16T17:00+03:00", "2026-06-16T18:00+03:00")).toBe(false);
  expect(isNewerOrSameArticleDate("2026-06-16T19:00+03:00", "2026-06-16T18:00+03:00")).toBe(true);
});

it("always keeps a candidate with no article date", () => {
  expect(isNewerOrSameArticleDate(null, "2026-06-16T18:00+03:00")).toBe(true);
});

// --- the seen-titles query ------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function insertSeen(dbPath, rows) {
  const connection = new DatabaseSync(dbPath);
  try {
    const insert = connection.prepare(
      "INSERT INTO seen_sources (source_type, source_id, source_url, title, article_date, first_seen_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(...row);
    }
  } finally {
    connection.close();
  }
}

it("returns distinct titles, newest first, capped", async () => {
  const dbPath = path.join(tmpDir, "bot.db");
  const db = new Database(dbPath);
  await db.init();

  insertSeen(dbPath, [
    ["official", "u1", "url1", "Alpha", null, "2026-06-10T00:00:00+00:00"],
    ["official", "u2", "url2", "Beta", null, "2026-06-12T00:00:00+00:00"],
    ["youtube", "v1", "url3", "Beta", null, "2026-06-13T00:00:00+00:00"], // same title, newer sighting
    ["youtube", "v2", "url4", "", null, "2026-06-14T00:00:00+00:00"], // empty title -> excluded
    ["reddit", "r1", "url5", null, null, "2026-06-15T00:00:00+00:00"], // null title -> excluded
    ["reddit", "r2", "url6", "Gamma", null, "2026-06-11T00:00:00+00:00"],
  ]);

  // Distinct titles, ordered by most recent sighting: Beta(06-13), Gamma(06-11), Alpha(06-10).
  expect(await db.getRecentSeenTitles({ limit: 10 })).toEqual(["Beta", "Gamma", "Alpha"]);
  expect(await db.getRecentSeenTitles({ limit: 2 })).toEqual(["Beta", "Gamma"]);
  expect(await db.getRecentSeenTitles({ limit: 0 })).toEqual([]);
});

it("excludes the collector's own source type", async () => {
  const dbPath = path.join(tmpDir, "bot.db");
  const db = new Database(dbPath);
  await db.init();

  insertSeen(dbPath, [
    ["official", "u1", "url1", "Official only", null, "2026-06-10T00:00:00+00:00"],
    ["youtube", "v1", "url2", "From YouTube", null, "2026-06-12T00:00:00+00:00"],
  ]);

  // Excluding "official" leaves only the YouTube title — and with a single source
  // configured (only official rows) the comparison set would be empty.
  expect(await db.getRecentSeenTitles({ limit: 10, exclude_source_type: "official" })).toEqual(["From YouTube"]);
  expect(await db.getRecentSeenTitles({ limit: 10, exclude_source_type: "youtube" })).toEqual(["Official only"]);
  expect(await db.getRecentSeenTitles({ limit: 10, exclude_source_type: "official" })).not.toEqual(
    await db.getRecentSeenTitles({ limit: 10 }),
  );
});
