/**
 * Tests for the user-submission anti-spam filter: too-short plain-text tips are
 * bounced before they reach the moderation queue, while links, media and admins
 * are exempt.
 */

import { afterEach, expect, it, vi } from "vitest";

import { __testing, buildUserComposer } from "../handlers/user.js";
import { t } from "../services/i18n.js";
import * as moderationModule from "../services/moderation.js";
import { dispatch, fakeBot, messageUpdate, sentTexts } from "./helpers/telegram.js";

const { isTooShortText } = __testing;

afterEach(() => {
  vi.restoreAllMocks();
});

function config({ words = 3, chars = 10, admins = [] } = {}) {
  return {
    min_submission_text_words: words,
    min_submission_text_chars: chars,
    admin_user_ids: new Set(admins),
    telegram_moderation_chat_ids: new Set(),
    submission_cooldown_seconds: 0,
    admin_chat_id: 100,
  };
}

function message(text, { userId = 999, entities = [] } = {}) {
  return { text, caption: null, from: { id: userId, username: "tester" }, entities };
}

// --- the pure predicate ---------------------------------------------------------

it("treats one word as too short", () => {
  expect(isTooShortText(message("ы"), config())).toBe(true);
});

it("treats two words as too short", () => {
  expect(isTooShortText(message("новий патч"), config())).toBe(true);
});

it("passes three real words", () => {
  expect(isTooShortText(message("Новий герой виходить завтра"), config())).toBe(false);
});

it("fails three tiny words on the char floor", () => {
  // 3 words but only 5 characters -> still junk, caught by the char floor.
  expect(isTooShortText(message("a a a"), config())).toBe(true);
});

it("exempts admins", () => {
  expect(isTooShortText(message("ы", { userId: 7 }), config({ admins: [7] }))).toBe(false);
});

it("is disabled when both thresholds are zero", () => {
  expect(isTooShortText(message("ы"), config({ words: 0, chars: 0 }))).toBe(false);
});

it("can run with only the word floor active", () => {
  const cfg = config({ words: 3, chars: 0 });
  expect(isTooShortText(message("a a a"), cfg)).toBe(false); // char floor off
  expect(isTooShortText(message("hi there"), cfg)).toBe(true); // 2 words
});

// --- the handler ----------------------------------------------------------------

async function submit(text, cfg, { userId = 999 } = {}) {
  const created = [];
  const db = {
    async getLatestUserSubmission() {
      return null;
    },
    async createSubmission(kwargs) {
      created.push(kwargs);
      return 1;
    },
    async getSubmission() {
      return { id: 1, status: "pending", parts: [] };
    },
  };
  vi.spyOn(moderationModule, "sendSubmissionToModeration").mockResolvedValue(undefined);

  const bot = fakeBot();
  const composer = buildUserComposer({ config: cfg, db, bot });
  await dispatch(composer, messageUpdate({ text, chatId: 123, chatType: "private", userId }), bot);
  return { created, answers: sentTexts(bot) };
}

it("rejects short text", async () => {
  const { created, answers } = await submit("ы", config());

  expect(created).toEqual([]); // never queued
  expect(answers).toEqual([t("user.too_short")]);
});

it("accepts long text", async () => {
  const { created } = await submit("Нове легендарне аніімо виходить наступного тижня", config());

  expect(created).toHaveLength(1);
  expect(created[0].message_type).toBe("text");
});

it("accepts a short link", async () => {
  // A bare link is short on words but carries content -> must pass through.
  const { created, answers } = await submit("https://www.aniimo.com/newslist/detail/100145", config());

  expect(created).toHaveLength(1);
  expect(created[0].message_type).toBe("link");
  expect(answers).toEqual([t("user.thank_you")]);
});

it("lets an admin post short text", async () => {
  const { created } = await submit("тест", config({ admins: [7] }), { userId: 7 });

  expect(created).toHaveLength(1);
});
