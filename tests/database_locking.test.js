/**
 * Regression test for the busy timeout.
 *
 * `node:sqlite` defaults to no timeout at all: a write that finds the database
 * locked by another connection fails instantly with "database is locked". Python's
 * `sqlite3` — which this layer was ported from — waits five seconds by default,
 * so the port silently dropped that safety net.
 *
 * The lock is taken in a CHILD PROCESS on purpose. `node:sqlite` is synchronous,
 * so a lock held by this process could never be released while the main thread
 * sits blocked waiting for it — only a separate process reproduces the real case
 * (a rollout where the old container still holds the file, or an operator poking
 * at the database with the `sqlite3` CLI).
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it } from "vitest";

import { BUSY_TIMEOUT_MS, Database } from "../database.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dblock-"));
});

afterEach(() => {
  // Windows keeps the file handle briefly after the lock holder exits, so retry.
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("waits long enough to be worth having", () => {
  // Matches Python's sqlite3 default; zero is what broke /cleanup in production.
  expect(BUSY_TIMEOUT_MS).toBeGreaterThanOrEqual(5000);
});

/**
 * Hold a write lock on `dbPath` for `holdMs`, then commit and exit.
 * Resolves once the lock is actually held, so the caller cannot race it.
 */
function holdLockInChildProcess(dbPath, holdMs) {
  const source = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO seen_sources (source_type, source_id, source_url, first_seen_at) VALUES (?, ?, ?, ?)")
      .run("lock", "holder", "https://example.com", "2026-01-01T00:00:00+00:00");
    process.send("locked");
    setTimeout(() => { db.exec("COMMIT"); db.close(); process.exit(0); }, ${holdMs});
  `;
  const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  child.stopped = new Promise((resolve) => child.once("exit", resolve));
  return new Promise((resolve, reject) => {
    child.once("message", () => resolve(child));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock holder exited early with ${code}`)));
  });
}

it("waits out a lock held by another process instead of failing the write", async () => {
  const dbPath = path.join(tmpDir, "bot.db");
  const db = new Database(dbPath);
  await db.init();

  const holdMs = 600;
  const child = await holdLockInChildProcess(dbPath, holdMs);

  const startedAt = Date.now();
  let submissionId;
  try {
    // Without the busy timeout this throws "database is locked" immediately.
    submissionId = await db.createSubmission({
      user_id: 7,
      username: "tester",
      message_type: "text",
      original_text: "a real news tip",
      file_id: null,
    });
  } finally {
    child.kill();
    await child.stopped;
  }
  const elapsed = Date.now() - startedAt;

  expect(submissionId).toBeGreaterThan(0);
  // It genuinely blocked on the other process rather than erroring out.
  expect(elapsed).toBeGreaterThanOrEqual(holdMs - 150);
  expect(elapsed).toBeLessThan(BUSY_TIMEOUT_MS);
});

it("shows the failure the timeout prevents", async () => {
  // The same write on a bare connection with no timeout - i.e. what the ported
  // code did before this fix - fails on the spot.
  const dbPath = path.join(tmpDir, "bot.db");
  const db = new Database(dbPath);
  await db.init();

  const child = await holdLockInChildProcess(dbPath, 3000);
  try {
    const bare = new DatabaseSync(dbPath);
    try {
      expect(() => bare.exec("DELETE FROM submissions")).toThrow(/database is locked/);
    } finally {
      bare.close();
    }
  } finally {
    child.kill();
    await child.stopped;
  }
});
