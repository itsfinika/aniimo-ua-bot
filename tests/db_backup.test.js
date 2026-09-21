/**
 * Unit tests for the nightly database backup: snapshot correctness, next-run
 * scheduling math, and the runBackupOnce seam (snapshot + retention pruning).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DateTime } from "luxon";
import { afterEach, beforeEach, expect, it } from "vitest";

import { backupsDirFor, nextRunAt, pruneOldBackups, runBackupOnce, vacuumInto } from "../services/db_backup.js";

const KYIV = "Europe/Kyiv";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbbackup-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function kyiv(year, month, day, hour, minute, second = 0) {
  return DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: KYIV });
}

it("schedules today when the hour is still ahead", () => {
  const now = kyiv(2026, 6, 11, 1, 30);
  expect(nextRunAt(now, 4).toISO()).toBe(kyiv(2026, 6, 11, 4, 0).toISO());
});

it("schedules tomorrow when the hour has passed", () => {
  const now = kyiv(2026, 6, 11, 4, 0, 1);
  expect(nextRunAt(now, 4).toISO()).toBe(kyiv(2026, 6, 12, 4, 0).toISO());
});

it("schedules tomorrow when it is exactly the hour", () => {
  const now = kyiv(2026, 6, 11, 4, 0, 0);
  expect(nextRunAt(now, 4).toISO()).toBe(kyiv(2026, 6, 12, 4, 0).toISO());
});

function createDb(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE seen_sources (source_type TEXT, source_id TEXT)");
    const insert = db.prepare("INSERT INTO seen_sources VALUES (?, ?)");
    for (let index = 0; index < 5; index += 1) {
      insert.run("official_aniimo", `https://example.com/${index}`);
    }
  } finally {
    db.close();
  }
}

function readCounts(file) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare("SELECT COUNT(*) AS total, MIN(source_id) AS smallest FROM seen_sources").get();
  } finally {
    db.close();
  }
}

it("produces a readable copy", () => {
  const source = path.join(tmpDir, "bot.db");
  const target = path.join(tmpDir, "bot-backup.db");
  createDb(source);

  vacuumInto(source, target);

  const row = readCounts(target);
  expect(Number(row.total)).toBe(5);
  expect(row.smallest).toBe("https://example.com/0");
});

it("overwrites a stale target", () => {
  const source = path.join(tmpDir, "bot.db");
  const target = path.join(tmpDir, "snapshot.db");
  createDb(source);
  fs.writeFileSync(target, "stale leftover from a crashed run");

  vacuumInto(source, target); // must not throw: VACUUM INTO needs a fresh target

  expect(Number(readCounts(target).total)).toBe(5);
});

it("writes a dated snapshot", async () => {
  const dbPath = path.join(tmpDir, "bot.db");
  createDb(dbPath);
  const config = { database_path: dbPath, database_backup_keep: 14 };

  await runBackupOnce(config);

  const backupsDir = path.join(tmpDir, "backups");
  const backups = fs.readdirSync(backupsDir).filter((name) => /^bot-backup-.*\.db$/.test(name));
  expect(backups).toHaveLength(1);
  expect(Number(readCounts(path.join(backupsDir, backups[0])).total)).toBe(5);
  // No temp leftovers next to the snapshot.
  expect(fs.readdirSync(backupsDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

it("prunes old snapshots and a stale tmp file", async () => {
  const dbPath = path.join(tmpDir, "bot.db");
  createDb(dbPath);
  const backupsDir = backupsDirFor(dbPath);
  fs.mkdirSync(backupsDir);
  for (const day of ["2026-01-01", "2026-01-02", "2026-01-03"]) {
    fs.writeFileSync(path.join(backupsDir, `bot-backup-${day}.db`), "old snapshot");
  }
  fs.writeFileSync(path.join(backupsDir, "bot-backup-2026-01-04.db.tmp"), "crashed run leftover");
  const config = { database_path: dbPath, database_backup_keep: 2 };

  await runBackupOnce(config);

  const names = fs.readdirSync(backupsDir).sort();
  // Newest two remain: the 2026-01-03 file and today's fresh snapshot;
  // older ones and the stale .tmp are gone.
  expect(names).toHaveLength(2);
  expect(names).toContain("bot-backup-2026-01-03.db");
  expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
});

it("skips when the database file is missing", async () => {
  const config = { database_path: path.join(tmpDir, "absent.db"), database_backup_keep: 14 };

  await runBackupOnce(config);

  expect(fs.existsSync(path.join(tmpDir, "backups"))).toBe(false);
});

it("keeps the newest files when pruning", () => {
  for (const day of ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"]) {
    fs.writeFileSync(path.join(tmpDir, `bot-backup-${day}.db`), "x");
  }

  const removed = pruneOldBackups(tmpDir, "bot", { keep: 3 });

  expect(removed).toBe(1);
  expect(fs.readdirSync(tmpDir).sort()).toEqual([
    "bot-backup-2026-01-02.db",
    "bot-backup-2026-01-03.db",
    "bot-backup-2026-01-04.db",
  ]);
});
