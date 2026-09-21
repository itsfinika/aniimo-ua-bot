/**
 * The activity report: which source fed the channel, what was dropped as a
 * duplicate, and how long the queue has been waiting.
 *
 * The formatter is driven with fixtures, and the aggregation with a real
 * throwaway database, so a broken query cannot pass by agreeing with a stub.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DateTime } from "luxon";
import { afterEach, beforeEach, expect, it } from "vitest";

import { Database, STATUS_PUBLISHED, STATUS_REJECTED } from "../database.js";
import { buildActivityReport, formatActivityReport, startWeeklyReportScheduler } from "../services/reports.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reports-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const UNTIL = DateTime.fromISO("2026-08-19T11:00:00", { zone: "utc" });
const SOURCES = [
  { source_type: "official_aniimo", title: "Офіційний сайт", enabled: true },
  { source_type: "steam", title: "Steam", enabled: true },
  { source_type: "bluesky", title: "Bluesky", enabled: true },
  { source_type: "reddit", title: "Reddit", enabled: false },
  { source_type: "wiki_aniimo", title: "Аніімо тижня", enabled: false },
  { source_type: "", title: "Предложка", enabled: true },
];

function report(activity) {
  return formatActivityReport(
    { seen: [], submissions: [], pending_total: 0, pending_oldest: null, ...activity },
    { since: UNTIL.minus({ days: 7 }), until: UNTIL, days: 7, sources: SOURCES },
  );
}

it("says what each source found and what came of it", () => {
  const text = report({
    seen: [
      { source_type: "official_aniimo", outcome: "queued", total: 5 },
      { source_type: "official_aniimo", outcome: "duplicate", total: 2 },
      { source_type: "steam", outcome: "queued", total: 1 },
      { source_type: "bluesky", outcome: "queued", total: 3 },
    ],
    submissions: [
      { source_type: "official_aniimo", status: STATUS_PUBLISHED, total: 4 },
      { source_type: "official_aniimo", status: STATUS_REJECTED, total: 1 },
      { source_type: "steam", status: STATUS_PUBLISHED, total: 1 },
      { source_type: "bluesky", status: STATUS_PUBLISHED, total: 3 },
    ],
  });

  // "Found" counts the duplicates too: they were found, then dropped.
  expect(text).toContain("Офіційний сайт</b> — знайдено 7, дублікатів 2, опубліковано 4, відхилено 1");
  expect(text).toContain("Steam</b> — знайдено 1, опубліковано 1");
  expect(text).toContain("Bluesky</b> — знайдено 3, опубліковано 3");
  expect(text).toContain("опубліковано 8");
  expect(text).toContain("відсіяно дублікатів 2");
});

it("names a source that brought nothing, instead of hiding it", () => {
  // A silent source is the whole point of the report: it either has nothing to
  // give or is quietly broken, and either way it should be visible.
  const text = report({ seen: [{ source_type: "bluesky", outcome: "queued", total: 1 }] });

  expect(text).toContain("Офіційний сайт</b> — нічого нового");
});

it("marks a switched-off source as off, not as silent", () => {
  const text = report({});

  expect(text).toContain("Reddit</b> — вимкнене");
  expect(text).toContain("Аніімо тижня</b> — вимкнене");
});

it("counts a switched-off source that still has history", () => {
  // Turned off yesterday, but its posts from earlier in the window still count.
  const text = report({ submissions: [{ source_type: "reddit", status: STATUS_PUBLISHED, total: 2 }] });

  expect(text).toContain("Reddit</b> — знайдено 0, опубліковано 2");
});

it("counts readers' submissions without pretending they were 'found'", () => {
  const text = report({
    submissions: [
      { source_type: "", status: STATUS_PUBLISHED, total: 2 },
      { source_type: "", status: "pending", total: 1 },
    ],
  });

  expect(text).toContain("Предложка</b> — заявок 3, опубліковано 2, у черзі 1");
  expect(text).not.toContain("Предложка</b> — знайдено");
});

it("reports the backlog and how long it has waited", () => {
  const text = report({ pending_total: 3, pending_oldest: "2026-08-16T11:00:00+00:00" });

  expect(text).toContain("У черзі зараз: 3, найстаріша заявка чекає 3 дн.");
});

it("says so when the queue is empty", () => {
  expect(report({})).toContain("Черга порожня");
});

it("counts legacy rows with no recorded outcome as found", () => {
  // seen_sources predates the outcome column; those rows must not vanish.
  const text = report({ seen: [{ source_type: "bluesky", outcome: "unknown", total: 4 }] });

  expect(text).toContain("Bluesky</b> — знайдено 4");
});

// --- the aggregation, against a real database ------------------------------------

async function seed() {
  const db = new Database(path.join(tmpDir, "bot.db"));
  await db.init();

  await db.markSourceSeen({
    source_type: "bluesky",
    source_id: "a",
    source_url: "https://x/a",
    title: "a",
    article_date: null,
    outcome: "queued",
  });
  await db.markSourceSeen({
    source_type: "bluesky",
    source_id: "b",
    source_url: "https://x/b",
    title: "b",
    article_date: null,
    outcome: "duplicate",
  });
  const submissionId = await db.createAiNewsSubmission({
    username: "collector",
    original_text: "o",
    draft_text: "d",
    message_type: "text",
    media_url: null,
    media_type: "none",
    source_type: "bluesky",
    source_id: "a",
    source_url: "https://x/a",
    article_date: null,
    article_date_display: null,
  });
  await db.createSubmission({
    user_id: 5,
    username: "reader",
    message_type: "text",
    original_text: "щось цікаве від читача",
    file_id: null,
  });
  return { db, submissionId };
}

it("aggregates what the database really holds", async () => {
  const { db, submissionId } = await seed();
  await db.markPublished(submissionId);

  const config = {
    article_timezone: "Europe/Kyiv",
    enable_bluesky_source: true,
    bluesky_actor: "aniimo.bsky.social",
    enable_fanart_digest: false,
  };
  const text = await buildActivityReport(db, config, { days: 7 });

  expect(text).toContain("знайдено 2, дублікатів 1, опубліковано 1");
  expect(text).toContain("заявок 1"); // the reader's submission
  expect(text).toContain("У черзі зараз: 1"); // the reader's submission is still pending
});

it("ignores anything older than the window", async () => {
  const { db } = await seed();

  const config = {
    article_timezone: "Europe/Kyiv",
    enable_bluesky_source: true,
    bluesky_actor: "aniimo.bsky.social",
    enable_fanart_digest: false,
  };
  const future = DateTime.now().plus({ days: 30 });
  const text = await buildActivityReport(db, config, { days: 7, now: future });

  expect(text).toContain("нічого нового");
});

it("reads each source's own switch, and Bluesky's actor too", async () => {
  const { db } = await seed();

  // Every optional source is off except Steam; Bluesky has its flag but no
  // account behind it, which the registry treats as off — so must the report.
  const config = {
    article_timezone: "Europe/Kyiv",
    enable_steam_source: true,
    enable_bluesky_source: true,
    bluesky_actor: "",
    enable_youtube_source: false,
    enable_reddit_source: false,
    enable_aniimotools_source: false,
    enable_wiki_aniimo: false,
    enable_fanart_digest: false,
  };
  const text = await buildActivityReport(db, config, { days: 7 });

  expect(text).toContain("Офіційний сайт Aniimo</b> — нічого нового"); // always on
  expect(text).toContain("Steam (офіційні анонси)</b> — нічого нового");
  expect(text).toContain("Aniimo Tools (фан-новини)</b> — вимкнене");
  expect(text).toContain("Аніімо тижня (офіційна вікі)</b> — вимкнене");
  // Bluesky still has history in the window, so its counts show even though the
  // missing actor means the source is not actually running.
  expect(text).toContain("Bluesky (офіційний акаунт)</b> — знайдено 2, дублікатів 1");
});

it("does not start the scheduler when the report is switched off", () => {
  expect(startWeeklyReportScheduler({}, { enable_weekly_report: false }, {})).toBeNull();
});
