/**
 * Regression test for the read-only-volume outage.
 *
 * A container that can read but not write the data volume starts up perfectly
 * happily — every `CREATE TABLE IF NOT EXISTS` is a no-op on an existing schema
 * and needs no write — and then silently drops every submission, because only
 * the writes fail with "attempt to write a readonly database". That is exactly
 * what shipped when the image's user changed uid while the named volume kept the
 * old one.
 *
 * `init()` must therefore refuse to start rather than limp along read-only.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, expect, it } from "vitest";

import { Database } from "../database.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dbwrite-"));
});

afterEach(() => {
  try {
    for (const name of fs.readdirSync(tmpDir)) {
      fs.chmodSync(path.join(tmpDir, name), 0o666);
    }
  } catch {
    // Directory already gone; nothing to relax.
  }
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

it("initialises a writable database", async () => {
  const db = new Database(path.join(tmpDir, "bot.db"));
  await expect(db.init()).resolves.toBeUndefined();

  // And it really can write afterwards.
  const id = await db.createSubmission({
    user_id: 1,
    username: "u",
    message_type: "text",
    original_text: "a genuine news tip",
    file_id: null,
  });
  expect(id).toBeGreaterThan(0);
});

it("refuses to start on a read-only database instead of losing writes", async () => {
  const dbPath = path.join(tmpDir, "bot.db");

  // Seed a complete schema, then take write permission away.
  await new Database(dbPath).init();
  fs.chmodSync(dbPath, 0o444);

  // The schema statements still succeed on a read-only file, so only an explicit
  // write probe catches this - that is the whole point of the check.
  const readOnly = new DatabaseSync(dbPath, { readOnly: true });
  expect(() => readOnly.exec("CREATE TABLE IF NOT EXISTS submissions (id INTEGER)")).not.toThrow();
  readOnly.close();

  await expect(new Database(dbPath).init()).rejects.toThrow(/not writable by this process/);
});
