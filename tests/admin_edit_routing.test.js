/**
 * Run the admin and user composers together, in production order. An open
 * moderation draft must never turn a new private submission into an edit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Composer } from "grammy";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Database } from "../database.js";
import { buildAdminComposer } from "../handlers/admin.js";
import { __testing as userTesting, buildUserComposer } from "../handlers/user.js";
import { t } from "../services/i18n.js";
import * as moderationModule from "../services/moderation.js";
import { channelPostUpdate, dispatch, fakeBot, messageUpdate, sentTexts } from "./helpers/telegram.js";

const ADMIN_ID = 7;
const ADMIN_CHAT = -4242;
const ORIGINAL = "Початковий текст старої заявки";
const NEW_TEXT = "Окрема новина для нової заявки";
const MODES = ["draft_part", "add_part"];
const photo = (id) => [{ file_id: id, width: 1280, height: 720 }];
let tempDir;
let db;
let bot;
let composer;
let moderationSend;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "admin-edit-routing-"));
  db = new Database(path.join(tempDir, "bot.db"));
  await db.init();
  bot = fakeBot();
  const config = {
    admin_chat_id: ADMIN_CHAT,
    admin_user_ids: new Set([ADMIN_ID]),
    telegram_moderation_chat_ids: new Set(),
    submission_cooldown_seconds: 0,
    min_submission_text_words: 0,
    min_submission_text_chars: 0,
  };
  composer = new Composer();
  composer.use(buildAdminComposer({ config, db, bot }));
  composer.use(buildUserComposer({ config, db, bot }));
  moderationSend = vi.spyOn(moderationModule, "sendSubmissionToModeration").mockResolvedValue(undefined);
});

afterEach(() => {
  for (const album of userTesting.pendingAlbums.values()) clearTimeout(album.timer);
  userTesting.pendingAlbums.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function openEdit(mode) {
  const submissionId = await db.createSubmission({
    user_id: 99,
    username: "reader",
    message_type: "text",
    original_text: ORIGINAL,
    file_id: null,
  });
  await db.setAdminEditState(ADMIN_ID, submissionId, {
    mode,
    part_index: mode === "draft_part" ? 1 : null,
    draft_message_id: mode === "draft_part" ? 900 : null,
  });
  return submissionId;
}

async function sendPrivate(message) {
  return dispatch(composer, messageUpdate({ chatId: ADMIN_ID, userId: ADMIN_ID, ...message }), bot);
}

async function newSubmission() {
  expect(moderationSend).toHaveBeenCalledTimes(1);
  return db.getSubmission(moderationSend.mock.calls[0][3]);
}

const PRIVATE_MESSAGES = [
  ["text", { text: NEW_TEXT }],
  ["photo", { photo: photo("photo-1"), caption: NEW_TEXT }],
  ["video", { video: { file_id: "video-1", duration: 5, width: 1280, height: 720 }, caption: NEW_TEXT }],
  ["document", { document: { file_id: "document-1", file_name: "guide.txt" }, caption: NEW_TEXT }],
];

it.each(MODES.flatMap((mode) => PRIVATE_MESSAGES.map(([type, message]) => [mode, type, message])))(
  "keeps a private %s-state %s message as a new submission",
  async (mode, type, message) => {
    const oldId = await openEdit(mode);
    const state = await db.getAdminEditState(ADMIN_ID);
    await sendPrivate(message);

    const submitted = await newSubmission();
    expect(submitted.id).not.toBe(oldId);
    expect(submitted.message_type).toBe(type);
    expect(submitted.original_text).toBe(NEW_TEXT);
    expect((await db.getSubmission(oldId)).draft_text).toBe(ORIGINAL);
    expect(await db.getAdminEditState(ADMIN_ID)).toEqual(state);
    expect(bot.callsTo("editMessageText")).toEqual([]);
    expect(bot.callsTo("editMessageCaption")).toEqual([]);
    expect(bot.callsTo("deleteMessage")).toEqual([]);
    expect(sentTexts(bot)).toEqual([t("user.thank_you")]);
  },
);

it.each(MODES)("keeps a private album together while %s is active", async (mode) => {
  vi.useFakeTimers();
  const oldId = await openEdit(mode);
  const state = await db.getAdminEditState(ADMIN_ID);
  await sendPrivate({ photo: photo("album-photo"), caption: NEW_TEXT, mediaGroupId: "album-1" });
  await sendPrivate({
    video: { file_id: "album-video", duration: 5, width: 1280, height: 720 },
    mediaGroupId: "album-1",
  });
  expect(moderationSend).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(userTesting.ALBUM_GROUPING_WINDOW_MS + 10);

  const submitted = await newSubmission();
  expect(submitted.message_type).toBe("album");
  expect(submitted.parts.map((part) => part.file_id)).toEqual(["album-photo", "album-video"]);
  expect(submitted.original_text).toBe(NEW_TEXT);
  expect((await db.getSubmission(oldId)).draft_text).toBe(ORIGINAL);
  expect(await db.getAdminEditState(ADMIN_ID)).toEqual(state);
  expect(bot.callsTo("deleteMessage")).toEqual([]);
  expect(bot.callsTo("editMessageText")).toEqual([]);
  expect(sentTexts(bot)).toEqual([t("user.thank_you")]);
});

it.each(MODES)("shows the normal private /start welcome while %s is active", async (mode) => {
  const oldId = await openEdit(mode);
  const state = await db.getAdminEditState(ADMIN_ID);
  await sendPrivate({ text: "/start" });

  expect(sentTexts(bot)).toEqual([t("user.start")]);
  expect(moderationSend).not.toHaveBeenCalled();
  expect(bot.callsTo("editMessageText")).toEqual([]);
  expect(bot.callsTo("deleteMessage")).toEqual([]);
  expect((await db.getSubmission(oldId)).draft_text).toBe(ORIGINAL);
  expect(await db.getAdminEditState(ADMIN_ID)).toEqual(state);
});

it("still allows /cancel in private without deleting the command", async () => {
  await openEdit("draft_part");
  await sendPrivate({ text: "/cancel" });
  expect(await db.getAdminEditState(ADMIN_ID)).toBeNull();
  expect(sentTexts(bot)).toEqual([t("admin.edit.cancelled")]);
  expect(bot.callsTo("deleteMessage")).toEqual([]);
});

it("still edits an active draft in the admin group and cleans up only that source", async () => {
  const submissionId = await openEdit("draft_part");
  await dispatch(composer, messageUpdate({
    text: NEW_TEXT, chatId: ADMIN_CHAT, chatType: "supergroup", userId: ADMIN_ID, messageId: 123,
  }), bot);

  expect(bot.callsTo("editMessageText")).toHaveLength(1);
  expect(bot.callsTo("editMessageText")[0].args.slice(0, 2)).toEqual([ADMIN_CHAT, 900]);
  expect(bot.callsTo("editMessageText")[0].args[2]).toContain(NEW_TEXT);
  expect(bot.callsTo("deleteMessage").map((call) => call.args)).toEqual([[ADMIN_CHAT, 123]]);
  expect((await db.getSubmission(submissionId)).draft_text).toBe(ORIGINAL); // Save still required.
  expect((await db.getAdminEditState(ADMIN_ID)).mode).toBe("draft_part");
  expect(moderationSend).not.toHaveBeenCalled();
});

it.each(["supergroup", "channel"])("still adds a part in the admin %s", async (chatType) => {
  const submissionId = await openEdit("add_part");
  const update = chatType === "channel"
    ? channelPostUpdate({ text: NEW_TEXT, chatId: ADMIN_CHAT, messageId: 123 })
    : messageUpdate({ text: NEW_TEXT, chatId: ADMIN_CHAT, chatType, userId: ADMIN_ID, messageId: 123 });
  await dispatch(composer, update, bot);

  expect((await db.getSubmission(submissionId)).parts.map((part) => part.text)).toEqual([ORIGINAL, NEW_TEXT]);
  expect(await db.getAdminEditState(ADMIN_ID)).toBeNull();
  expect(bot.callsTo("deleteMessage").map((call) => call.args)).toContainEqual([ADMIN_CHAT, 123]);
  expect(moderationSend).not.toHaveBeenCalled();
});

it.each(MODES)("does not interpret admin-group /start as %s content", async (mode) => {
  const submissionId = await openEdit(mode);
  await dispatch(composer, messageUpdate({
    text: "/start", chatId: ADMIN_CHAT, chatType: "supergroup", userId: ADMIN_ID,
  }), bot);
  expect(sentTexts(bot)).toEqual([t("admin.edit.active_reminder", { submission_id: submissionId })]);
  expect(bot.callsTo("editMessageText")).toEqual([]);
  expect(bot.callsTo("deleteMessage")).toEqual([]);
  expect((await db.getSubmission(submissionId)).parts).toHaveLength(1);
});

it.each(MODES.flatMap((mode) => ["published", "rejected", "missing"].map((status) => [mode, status])))(
  "clears a leftover %s state for a %s target before admin-group capture",
  async (mode, status) => {
    const submissionId = await openEdit(mode);
    const raw = new DatabaseSync(db.path);
    try {
      if (status === "missing") raw.prepare("DELETE FROM submissions WHERE id = ?").run(submissionId);
      else raw.prepare("UPDATE submissions SET status = ? WHERE id = ?").run(status, submissionId);
    } finally {
      raw.close();
    }
    const { reachedEnd } = await dispatch(composer, messageUpdate({
      text: NEW_TEXT, chatId: ADMIN_CHAT, chatType: "supergroup", userId: ADMIN_ID,
    }), bot);
    expect(reachedEnd).toBe(true);
    expect(await db.getAdminEditState(ADMIN_ID)).toBeNull();
    expect(bot.calls).toEqual([]);
  },
);

it("does not copy or delete a channel post for a processed add-part target", async () => {
  const submissionId = await openEdit("add_part");
  await db.markPublished(submissionId);
  await db.setAdminEditState(ADMIN_ID, submissionId, { mode: "add_part" });
  const { reachedEnd } = await dispatch(composer, channelPostUpdate({ text: NEW_TEXT, chatId: ADMIN_CHAT }), bot);
  expect(reachedEnd).toBe(true);
  expect(await db.getAdminEditState(ADMIN_ID)).toBeNull();
  expect(bot.calls).toEqual([]);
});

it("clears a draft whose selected part no longer exists", async () => {
  const submissionId = await openEdit("draft_part");
  await db.setAdminEditState(ADMIN_ID, submissionId, { mode: "draft_part", part_index: 99, draft_message_id: 900 });
  const { reachedEnd } = await dispatch(composer, messageUpdate({
    text: NEW_TEXT, chatId: ADMIN_CHAT, chatType: "supergroup", userId: ADMIN_ID,
  }), bot);
  expect(reachedEnd).toBe(true);
  expect(await db.getAdminEditState(ADMIN_ID)).toBeNull();
  expect(bot.calls).toEqual([]);
});

it.each([["markPublished", "published"], ["markRejected", "rejected"]])(
  "%s clears every editor of that submission and leaves unrelated editors alone",
  async (method, status) => {
    const targetId = await openEdit("draft_part");
    await db.setAdminEditState(8, targetId, { mode: "add_part" });
    const otherId = await db.createSubmission({ user_id: 10, message_type: "text", original_text: "other" });
    await db.setAdminEditState(9, otherId, { mode: "add_part" });

    await db[method](targetId);

    expect((await db.getSubmission(targetId)).status).toBe(status);
    expect(await db.getAdminEditState(ADMIN_ID)).toBeNull();
    expect(await db.getAdminEditState(8)).toBeNull();
    expect((await db.getAdminEditState(9)).submission_id).toBe(otherId);
  },
);

it.each(["markPublished", "markRejected"])("%s rolls back status if edit-state cleanup fails", async (method) => {
  const submissionId = await openEdit("draft_part");
  const raw = new DatabaseSync(db.path);
  try {
    raw.exec(`CREATE TRIGGER fail_edit_cleanup BEFORE DELETE ON admin_edit_states
      BEGIN SELECT RAISE(ABORT, 'simulated cleanup failure'); END`);
  } finally {
    raw.close();
  }

  await expect(db[method](submissionId)).rejects.toThrow("simulated cleanup failure");
  expect((await db.getSubmission(submissionId)).status).toBe("pending");
  expect((await db.getAdminEditState(ADMIN_ID)).submission_id).toBe(submissionId);
});
