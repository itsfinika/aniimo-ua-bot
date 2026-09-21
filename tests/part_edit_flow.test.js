/**
 * The per-part edit flow, end to end through the real handlers.
 *
 * tests/footer_edit.test.js covers the helpers; this covers the path that
 * actually broke. Both callbacks are dispatched through the composer, so the
 * assertions cover what Telegram is really sent and what is really stored:
 *
 *   1. "Edit this part"  -> startPartDraft  -> an editable copy is sent
 *   2. the admin changes that message's text and taps Save
 *   3. Save              -> savePartDraft   -> the new text is stored
 *
 * The bug was in step 1: the editable copy was rendered WITH the community
 * footer, so step 3 stored the footer as body text and every later render
 * appended another one.
 */

import { expect, it } from "vitest";

import { buildAdminComposer } from "../handlers/admin.js";
import { ModerationPartCallback } from "../keyboards.js";
import { formatCommunityFooter } from "../services/post_footer.js";
import { dispatch, fakeBot } from "./helpers/telegram.js";

const BODY = "Патч 5.5 вже доступний. Баланс героїв змінено.";
const FOOTER = formatCommunityFooter();
const ADMIN_CHAT = -4242;
const ADMIN_ID = 7;

const countFooters = (text) => (String(text).match(/Запропонувати новину/g) || []).length;

function fakeDb(partText) {
  const part = {
    submission_id: 1,
    part_index: 1,
    message_type: "text",
    text: partText,
    file_id: null,
    media_url: null,
    media_type: "none",
    source_url: "",
    source_type: "",
    admin_message_id: 500,
  };
  return {
    part,
    stored: [],
    editState: null,
    async getSubmission() {
      return { id: 1, status: "pending", parts: [part], tags: [], draft_text: part.text };
    },
    async getSubmissionPart() {
      return part;
    },
    async setAdminEditState(_adminId, _submissionId, state) {
      this.editState = state;
    },
    async clearAdminEditState() {
      this.editState = null;
    },
    async updateSubmissionPartText(_submissionId, _partIndex, text) {
      this.stored.push(text);
      part.text = text;
    },
  };
}

function partCallback(action, bot, messageText = "pick") {
  return {
    update_id: 1,
    callback_query: {
      id: "1",
      from: { id: ADMIN_ID, is_bot: false, first_name: "A" },
      chat_instance: "1",
      data: ModerationPartCallback.pack({ action, submission_id: 1, part_index: 1 }),
      message: {
        message_id: 900,
        date: 0,
        chat: { id: ADMIN_CHAT, type: "supergroup" },
        text: messageText,
      },
    },
  };
}

function build(partText) {
  const db = fakeDb(partText);
  const bot = fakeBot();
  const config = {
    admin_chat_id: ADMIN_CHAT,
    admin_user_ids: new Set([ADMIN_ID]),
    enable_telegram_moderation: false,
    telegram_moderation_chat_ids: new Set(),
  };
  return { db, bot, composer: buildAdminComposer({ config, db, bot }) };
}

/** The text of the editable copy the handler sent to the admin chat. */
const draftSent = (bot) => {
  const call = bot.callsTo("sendMessage").at(-1);
  return { text: call.args[1], options: call.args[2] ?? {} };
};

it("offers the bare body for editing, without the footer", async () => {
  const { bot, composer } = build(BODY);

  await dispatch(composer, partCallback("select", bot), bot);

  const { text, options } = draftSent(bot);
  expect(text).toBe(BODY);
  expect(countFooters(text)).toBe(0);
  // Plain text: the body is not HTML, and parse_mode would hand back a
  // de-tagged string on save.
  expect(options.parse_mode).toBeUndefined();
});

it("stores exactly what the admin left in the message", async () => {
  const { db, bot, composer } = build(BODY);
  const edited = "Патч 5.5 вже доступний. Джефа знову зачепили.";

  await dispatch(composer, partCallback("save", bot, edited), bot);

  expect(db.stored).toEqual([edited]);
  expect(countFooters(db.part.text)).toBe(0);
});

it("keeps the published post at one footer after an edit", async () => {
  const { db, bot, composer } = build(BODY);

  await dispatch(composer, partCallback("select", bot), bot);
  const editable = draftSent(bot).text;
  await dispatch(composer, partCallback("save", bot, editable), bot);

  // The original part message is re-rendered on save - that is the post that
  // gets published, and it must carry exactly one footer.
  const rerendered = bot.callsTo("editMessageText").at(-1).args[2];
  expect(countFooters(rerendered)).toBe(1);
  expect(countFooters(db.part.text)).toBe(0);
});

it("survives three edit cycles without stacking footers", async () => {
  const { db, bot, composer } = build(BODY);

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await dispatch(composer, partCallback("select", bot), bot);
    const editable = draftSent(bot).text;
    await dispatch(composer, partCallback("save", bot, editable), bot);

    expect(countFooters(db.part.text)).toBe(0);
    expect(countFooters(bot.callsTo("editMessageText").at(-1).args[2])).toBe(1);
  }
  expect(db.part.text).toBe(BODY);
});

it("heals a draft already stored with a footer baked in", async () => {
  // What an edit before the fix left behind in the database.
  const { db, bot, composer } = build(`${BODY}\n\n${FOOTER}`);

  await dispatch(composer, partCallback("select", bot), bot);
  expect(draftSent(bot).text).toBe(BODY); // shown clean

  await dispatch(composer, partCallback("save", bot, draftSent(bot).text), bot);
  expect(db.part.text).toBe(BODY); // and stored clean
  expect(countFooters(bot.callsTo("editMessageText").at(-1).args[2])).toBe(1);
});
