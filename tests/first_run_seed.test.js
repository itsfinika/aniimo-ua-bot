/**
 * Tests for the first-run seed: a source with no history records what its feed
 * currently holds and drafts none of it, so a fresh database never replays an
 * archive into moderation (nor spends the Gemini quota on it).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { Database } from "../database.js";
import { CollectionMode, collectorDefinition, draftCandidate, listingEntry } from "../services/collectors/base.js";
import { BaseNewsCollector } from "../services/collectors/runner.js";

const DEFINITION = collectorDefinition({
  collector_id: "test_source",
  source_type: "test_source",
  title_key: "collectors.bluesky.title",
  button_key: "buttons.collector_bluesky",
});

const ENTRIES = [listingEntry("s3", null), listingEntry("s2", null), listingEntry("s1", null)];

class StubCollector extends BaseNewsCollector {
  static definition = DEFINITION;

  constructor({ config, db }) {
    super({ config, db, bot: null });
    this.parseCalls = 0;
  }

  async fetchListing() {
    return ENTRIES;
  }

  async parseEntry(entry) {
    this.parseCalls += 1;
    return draftCandidate({
      source_id: entry.dedup_key,
      source_url: `https://example.com/${entry.dedup_key}`,
      title: `Item ${entry.dedup_key}`,
      body_text: "body",
      source_name: "Test Source",
      username: "tester",
      original_text: "original",
      article_date: "2026-06-16",
    });
  }

  missingGeminiWarning() {
    return "no gemini";
  }
}

let dir;
let db;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aniimo-seed-"));
  db = new Database(path.join(dir, "bot.db"));
  await db.init();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function collector() {
  // A key is configured on purpose: the seed must win BEFORE any Gemini work,
  // not merely because drafting was unavailable.
  return new StubCollector({ config: { gemini_api_key: "key", enable_cross_source_dedup: true }, db });
}

it("records the whole feed as seen on the first scheduled run and drafts nothing", async () => {
  const subject = collector();

  const stats = await subject.runOnce(CollectionMode.SCHEDULED_SINCE_LAST);

  expect(stats.found).toBe(3);
  expect(stats.sent_to_moderation).toBe(0);
  expect(stats.new).toBe(0);
  expect(stats.failed).toBe(0);
  expect(stats.duplicates).toBe(3);
  // Nothing was fetched or parsed, so no article body and no Gemini call.
  expect(subject.parseCalls).toBe(0);
  for (const entry of ENTRIES) {
    expect(await db.isSourceSeen("test_source", entry.dedup_key)).toBe(true);
  }
  expect(await db.hasSeenSource("test_source")).toBe(true);
  // Seeded rows are not reported as collected work.
  const activity = await db.collectActivity({ since: "1970-01-01T00:00:00+00:00" });
  expect(activity.seen).toEqual([{ source_type: "test_source", outcome: "seeded", total: 3 }]);
  expect(activity.submissions).toEqual([]);
});

it("seeds only once, then treats the next tick normally", async () => {
  const first = collector();
  await first.runOnce(CollectionMode.SCHEDULED_SINCE_LAST);

  const second = collector();
  const stats = await second.runOnce(CollectionMode.SCHEDULED_SINCE_LAST);

  // Same three entries, now all known: counted as duplicates by the ordinary
  // path, and still never parsed.
  expect(stats.duplicates).toBe(3);
  expect(stats.sent_to_moderation).toBe(0);
  expect(second.parseCalls).toBe(0);
});

it("does not seed a source that already recorded something", async () => {
  await db.markSourceSeen({
    source_type: "test_source",
    source_id: "s3",
    source_url: "https://example.com/s3",
    title: "Item s3",
    article_date: "2026-06-16",
    outcome: "queued",
  });

  const subject = collector();
  const seeded = await subject.seedIfFirstRun(ENTRIES, { duplicates: 0 });

  expect(seeded).toBe(false);
  expect(await db.isSourceSeen("test_source", "s1")).toBe(false);
});

it("leaves a manual run alone so a fresh source can still be tested", async () => {
  const subject = collector();

  // MANUAL_LATEST parses the newest unseen entry; with no Gemini stub in place
  // the draft step is what fails, which proves the seed did not short-circuit it.
  await subject.runOnce(CollectionMode.MANUAL_LATEST).catch(() => {});

  expect(subject.parseCalls).toBeGreaterThan(0);
  expect(await db.hasSeenSource("test_source")).toBe(false);
});
