/**
 * Tests for /cleanup: only finished submissions go, pending and the seen-sources
 * memory always stay, and nothing is deleted without an explicit confirm.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it } from "vitest";

import { Database, STATUS_PUBLISHED, STATUS_REJECTED } from "../database.js";
import { buildAdminComposer } from "../handlers/admin.js";
import { t } from "../services/i18n.js";
import { utcIsoSeconds } from "../services/pyutils.js";
import { dispatch, fakeBot, messageUpdate, sentTexts } from "./helpers/telegram.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function daysAgo(days) {
  return utcIsoSeconds(Date.now() - days * 24 * 60 * 60 * 1000);
}

function withConnection(dbPath, work) {
  const connection = new DatabaseSync(dbPath);
  try {
    return work(connection);
  } finally {
    connection.close();
  }
}

async function seed(dbPath) {
  const db = new Database(dbPath);
  await db.init();

  // Backdate a row so the age filter has something to work with.
  const age = (submissionId, ageDays) =>
    withConnection(dbPath, (connection) => {
      connection.prepare("UPDATE submissions SET updated_at = ? WHERE id = ?").run(daysAgo(ageDays), submissionId);
    });

  const add = async (status, ageDays) => {
    const submissionId = await db.createAiNewsSubmission({
      username: "collector",
      original_text: "o",
      draft_text: "d",
      message_type: "text",
      media_url: null,
      media_type: "none",
      source_type: "bluesky",
      source_id: `at://${status}${ageDays}`,
      source_url: "https://bsky.app/x",
      article_date: null,
      article_date_display: null,
      tags: ["патч"],
    });
    if (status === STATUS_PUBLISHED) {
      await db.markPublished(submissionId);
    } else {
      await db.markRejected(submissionId);
    }
    age(submissionId, ageDays);
    return submissionId;
  };

  await add(STATUS_PUBLISHED, 90);
  await add(STATUS_REJECTED, 60);
  await add(STATUS_PUBLISHED, 1);
  const pendingId = await db.createSubmission({
    user_id: 1,
    username: "u",
    message_type: "text",
    original_text: "o",
    file_id: null,
  });
  age(pendingId, 365);

  await db.markSourceSeen({
    source_type: "bluesky",
    source_id: "at://x",
    source_url: "https://bsky.app/x",
    title: "Old news",
    article_date: "2026-01-01",
  });
  return db;
}

it("counts only finished submissions past the cutoff", async () => {
  const dbPath = path.join(tmpDir, "bot.db");
  const db = await seed(dbPath);

  expect(await db.countProcessedSubmissions({ older_than_days: 30 })).toBe(2);
  expect(await db.countProcessedSubmissions({ older_than_days: 365 })).toBe(0);
  // 0 days means "everything already processed", including today's.
  expect(await db.countProcessedSubmissions({ older_than_days: 0 })).toBe(3);
});

it("keeps pending and recent rows", async () => {
  const dbPath = path.join(tmpDir, "bot.db");
  const db = await seed(dbPath);

  expect(await db.deleteProcessedSubmissions({ older_than_days: 30 })).toBe(2);

  const statuses = withConnection(dbPath, (connection) =>
    connection
      .prepare("SELECT status FROM submissions ORDER BY id")
      .all()
      .map((row) => String(row.status)),
  );

  // The one-day-old published row and the year-old PENDING row both survive.
  expect(statuses).toEqual([STATUS_PUBLISHED, "pending"]);
});

it("never touches the seen-sources memory", async () => {
  // Dropping this is what would make the bot re-queue old news.
  const dbPath = path.join(tmpDir, "bot.db");
  const db = await seed(dbPath);

  await db.deleteProcessedSubmissions({ older_than_days: 0 });

  expect(await db.isSourceSeen("bluesky", "at://x")).toBe(true);
});

it("removes the parts and tag links", async () => {
  const dbPath = path.join(tmpDir, "bot.db");
  const db = await seed(dbPath);
  await db.deleteProcessedSubmissions({ older_than_days: 30 });

  const orphans = withConnection(dbPath, (connection) => [
    Number(
      connection
        .prepare(
          "SELECT COUNT(*) c FROM submission_parts WHERE submission_id NOT IN (SELECT id FROM submissions)",
        )
        .get().c,
    ),
    Number(
      connection
        .prepare("SELECT COUNT(*) c FROM submission_tags WHERE submission_id NOT IN (SELECT id FROM submissions)")
        .get().c,
    ),
  ]);

  expect(orphans).toEqual([0, 0]);
});

it("is a no-op when nothing matches", async () => {
  const db = await seed(path.join(tmpDir, "bot.db"));
  expect(await db.deleteProcessedSubmissions({ older_than_days: 1000 })).toBe(0);
});

it("wipes every status when pending is included", async () => {
  const db = await seed(path.join(tmpDir, "bot.db"));

  const deleted = await db.deleteProcessedSubmissions({ older_than_days: 0, include_pending: true });

  expect(deleted).toBe(4); // 2 published + 1 rejected + 1 pending
  expect(await db.countSubmissionsByStatus()).toEqual({});
  // Even a full wipe keeps the dedup memory, so old news does not come back.
  expect(await db.isSourceSeen("bluesky", "at://x")).toBe(true);
});

it("counts every state in the status breakdown", async () => {
  const db = await seed(path.join(tmpDir, "bot.db"));

  expect(await db.countSubmissionsByStatus()).toEqual({ published: 2, rejected: 1, pending: 1 });
});

// --- the command ---------------------------------------------------------------

class FakeDb {
  constructor(total = 5, breakdown = { pending: 3 }) {
    this.total = total;
    this.breakdown = breakdown;
    this.deletedWith = [];
    this.vacuumed = false;
  }

  async countProcessedSubmissions() {
    return this.total;
  }

  async countSubmissionsByStatus() {
    return this.breakdown;
  }

  async deleteProcessedSubmissions({ older_than_days, include_pending = false }) {
    this.deletedWith.push([older_than_days, include_pending]);
    return this.total;
  }

  async vacuum() {
    this.vacuumed = true;
  }

  sizeBytes() {
    return 0;
  }
}

function commandConfig() {
  return {
    admin_user_ids: new Set([7]),
    admin_chat_id: 100,
    telegram_moderation_chat_ids: new Set(),
  };
}

async function runCleanup(db, args, { userId = 7, chatId = 100, chatType = "private" } = {}) {
  const bot = fakeBot();
  const composer = buildAdminComposer({ config: commandConfig(), db, bot });
  const text = args ? `/cleanup ${args}` : "/cleanup";
  await dispatch(composer, messageUpdate({ text, userId, chatId, chatType }), bot);
  return sentTexts(bot);
}

it("deletes nothing without confirm", async () => {
  const db = new FakeDb(5);
  const answers = await runCleanup(db, null);

  expect(db.deletedWith).toEqual([]);
  expect(answers[0]).toContain("5");
  expect(answers[0]).toContain("confirm");
});

it("deletes and vacuums on confirm", async () => {
  const db = new FakeDb(5);
  await runCleanup(db, "confirm");

  expect(db.deletedWith).toEqual([[30, false]]); // default window, finished rows only
  expect(db.vacuumed).toBe(true);
});

it("honours a custom window", async () => {
  const db = new FakeDb(2);
  await runCleanup(db, "7 confirm");

  expect(db.deletedWith).toEqual([[7, false]]);
});

it("accepts arguments in any order", async () => {
  const db = new FakeDb(2);
  await runCleanup(db, "confirm 7");

  expect(db.deletedWith).toEqual([[7, false]]);
});

it("includes pending and drops the age window for `all`", async () => {
  // "/cleanup all" is the wipe-the-queue case: every status, any age.
  const db = new FakeDb(9);
  await runCleanup(db, "all confirm");

  expect(db.deletedWith).toEqual([[0, true]]);
});

it("combines `all` with an age window", async () => {
  const db = new FakeDb(4);
  await runCleanup(db, "all 7 confirm");

  expect(db.deletedWith).toEqual([[7, true]]);
});

it("warns about pending for `all` without confirm", async () => {
  const db = new FakeDb(9);
  const answers = await runCleanup(db, "all");

  expect(db.deletedWith).toEqual([]);
  expect(answers[0]).toBe(t("admin.cleanup.preview_all", { count: 9, days: 0 }));
});

it("rejects an unknown argument without deleting", async () => {
  const db = new FakeDb(5);
  const answers = await runCleanup(db, "wipe-everything");

  expect(db.deletedWith).toEqual([]);
  expect(answers[0]).toContain("wipe-everything");
});

it("shows what is actually in the database when nothing matches", async () => {
  // The confusing case from real use: the moderation chat is full, but every
  // draft is still pending, so the default filter matches none of them.
  const db = new FakeDb(0, { pending: 12 });
  const answers = await runCleanup(db, "confirm");

  expect(db.deletedWith).toEqual([]);
  expect(answers[0]).toContain("12"); // the pending count is spelled out
  expect(answers[0]).toContain("/cleanup all"); // and the way to remove them is offered
});

it("refuses non-admins", async () => {
  const db = new FakeDb();
  const answers = await runCleanup(db, "confirm", { userId: 999 });

  expect(db.deletedWith).toEqual([]);
  expect(answers).toEqual([t("admin.cleanup.no_permission")]);
});

it("does not answer in a public group", async () => {
  const db = new FakeDb();
  const answers = await runCleanup(db, "confirm", { chatId: 555, chatType: "supergroup" });

  expect(db.deletedWith).toEqual([]);
  expect(answers).toEqual([]);
});
