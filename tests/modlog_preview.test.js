/**
 * The mod-log preview must never be cut inside an HTML entity.
 *
 * The preview used to be escaped and only then truncated to 200 characters, so
 * a cut could land in the middle of an entity: `A&amp;B` became `A&a`. Telegram
 * rejects the WHOLE message with "can't parse entities", which meant the
 * moderation action still happened while the record of it silently never
 * arrived — the worst possible failure for an audit log.
 *
 * Dispatched through the real /del handler, so this asserts what is actually
 * sent to the mod-log chat.
 */

import { expect, it } from "vitest";

import { buildModerationComposer } from "../handlers/moderation.js";
import { dispatch, fakeBot, messageUpdate } from "./helpers/telegram.js";

const CHAT = -100777;
const MOD_LOG = -100999;
const MODERATOR = 7;

function build() {
  const bot = fakeBot({
    getChatAdministrators: async () => [{ user: { id: MODERATOR, is_bot: false, first_name: "Mod" } }],
  });
  const config = {
    admin_chat_id: -4242,
    admin_user_ids: new Set([MODERATOR]),
    telegram_mod_log_chat_id: MOD_LOG,
    telegram_moderation_chat_ids: new Set([CHAT]),
    telegram_link_allowlist: new Set(),
    telegram_welcome_delete_seconds: 0,
  };
  return { bot, composer: buildModerationComposer({ config, db: stubDb(), bot }) };
}

function stubDb() {
  return {
    async addTelegramWarning() {
      return 1;
    },
    async listTelegramWarnings() {
      return [];
    },
    async clearTelegramWarnings() {
      return 0;
    },
  };
}

/** A /del in the moderated chat, replying to `victimText`. */
function delUpdate(victimText) {
  const update = messageUpdate({
    text: "/del",
    chatId: CHAT,
    chatType: "supergroup",
    userId: MODERATOR,
    replyToMessage: {
      message_id: 55,
      date: 0,
      chat: { id: CHAT, type: "supergroup" },
      from: { id: 99, is_bot: false, first_name: "Victim" },
      text: victimText,
    },
  });
  return update;
}

/** The text of the message sent to the mod-log chat. */
function modLogText(bot) {
  const call = bot.callsTo("sendMessage").find(({ args }) => args[0] === MOD_LOG);
  return call ? call.args[1] : null;
}

/** A dangling `&x` / `&am` with no closing semicolon is an unparseable entity. */
const hasCutEntity = (text) => /&[a-zA-Z#]{0,6}$/.test(text) || /&(?![a-zA-Z#][a-zA-Z0-9]*;)/.test(text);

it("never leaves a cut HTML entity in a long preview", async () => {
  const { bot, composer } = build();
  // Long enough that the 200-char cut lands right around the ampersand.
  const victimText = `${"а".repeat(196)} A&B і ще багато тексту після цього`;

  await dispatch(composer, delUpdate(victimText), bot);

  const logged = modLogText(bot);
  expect(logged).not.toBeNull();
  expect(hasCutEntity(logged)).toBe(false);
  expect(logged).toContain("&amp;");
});

it("escapes the angle brackets a user typed rather than rendering them", async () => {
  const { bot, composer } = build();

  await dispatch(composer, delUpdate("<b>жирний</b> та & символ"), bot);

  const logged = modLogText(bot);
  expect(logged).toContain("&lt;b&gt;");
  expect(logged).toContain("&amp;");
  expect(hasCutEntity(logged)).toBe(false);
});

it("counts the 200 in visible characters, not escaped ones", async () => {
  const { bot, composer } = build();
  // 120 ampersands escape to 600 characters; the old order would have shown
  // barely 33 of them.
  await dispatch(composer, delUpdate("&".repeat(120)), bot);

  const logged = modLogText(bot);
  expect((logged.match(/&amp;/g) || []).length).toBe(120);
  expect(hasCutEntity(logged)).toBe(false);
});

it("logs a short preview unchanged", async () => {
  const { bot, composer } = build();

  await dispatch(composer, delUpdate("звичайне повідомлення"), bot);

  expect(modLogText(bot)).toContain("звичайне повідомлення");
});
