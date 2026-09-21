/**
 * What a reader's album looks like once stored, previewed and published: one row
 * with a part per media item, an admin card that says what the group holds, and a
 * publish that sends the files back to Telegram untouched.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it } from "vitest";

import { Database } from "../database.js";
import { formatAdminPreview } from "../services/formatter.js";
import { albumItems } from "../services/publisher.js";

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-album-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function store(items, caption = "підпис") {
  const db = new Database(path.join(tmpDir, "bot.db"));
  await db.init();
  const submissionId = await db.createUserAlbumSubmission({
    user_id: 999,
    username: "reader",
    original_text: caption,
    items,
  });
  return db.getSubmission(submissionId);
}

it("stores one part per media item", async () => {
  const submission = await store([
    { file_id: "p1", media_type: "photo" },
    { file_id: "v1", media_type: "video" },
    { file_id: "p2", media_type: "photo" },
  ]);

  expect(submission.message_type).toBe("album");
  expect(submission.user_id).toBe(999);
  expect(submission.draft_text).toBe("підпис");
  expect(submission.parts).toHaveLength(3);
  expect(submission.parts.map((part) => [part.file_id, part.media_type])).toEqual([
    ["p1", "photo"],
    ["v1", "video"],
    ["p2", "photo"],
  ]);
  // The caption belongs to the group, so it rides on the first part only.
  expect(submission.parts.map((part) => part.text)).toEqual(["підпис", "", ""]);
});

it("drops a repeated file and caps the group at ten", async () => {
  const submission = await store([
    { file_id: "p1", media_type: "photo" },
    { file_id: "p1", media_type: "photo" },
    ...Array.from({ length: 12 }, (_value, index) => ({ file_id: `x${index}`, media_type: "photo" })),
  ]);

  expect(submission.parts).toHaveLength(10); // Telegram's media-group maximum
  expect(submission.parts[0].file_id).toBe("p1");
  expect(submission.parts[1].file_id).toBe("x0");
});

it("refuses an album with no media", async () => {
  await expect(store([{ file_id: "  " }])).rejects.toThrow(/at least one media item/);
});

it("publishes the stored files without fetching them", async () => {
  const submission = await store([
    { file_id: "p1", media_type: "photo" },
    { file_id: "v1", media_type: "video" },
  ]);

  expect(albumItems(submission)).toEqual([
    { file_id: "p1", media_url: null, media_type: "photo" },
    { file_id: "v1", media_url: null, media_type: "video" },
  ]);
});

it("tells the moderator what the album holds", async () => {
  const submission = await store([
    { file_id: "p1", media_type: "photo" },
    { file_id: "p2", media_type: "photo" },
    { file_id: "v1", media_type: "video" },
  ]);

  const preview = formatAdminPreview(submission);

  expect(preview).toContain("Медіа в альбомі");
  expect(preview).toContain("3 (photo 2, video 1)");
});

it("says nothing about an album for an ordinary submission", async () => {
  const db = new Database(path.join(tmpDir, "bot.db"));
  await db.init();
  const id = await db.createSubmission({
    user_id: 1,
    username: "reader",
    message_type: "photo",
    original_text: "одне фото",
    file_id: "p1",
  });

  expect(formatAdminPreview(await db.getSubmission(id))).not.toContain("Медіа в альбомі");
});
