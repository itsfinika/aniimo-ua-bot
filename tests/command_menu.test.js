/**
 * Tests for the admin-chat command menu: the content commands are advertised in
 * the admin chat only, never in a chat whose menu belongs to moderation.
 */

import { GrammyError } from "grammy";
import { expect, it } from "vitest";

import { applyAdminChatCommands } from "../main.js";
import { t } from "../services/i18n.js";

function fakeBot({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    api: {
      async setMyCommands(commands, other) {
        if (fail) {
          throw new GrammyError(
            "Call to 'setMyCommands' failed!",
            { ok: false, error_code: 403, description: "Forbidden" },
            "setMyCommands",
            {},
          );
        }
        calls.push([commands, other?.scope]);
      },
    },
  };
}

function config({ adminChatId = -100, moderated = [] } = {}) {
  return { admin_chat_id: adminChatId, telegram_moderation_chat_ids: new Set(moderated) };
}

it("scopes the admin commands to the admin chat", async () => {
  const bot = fakeBot();
  await applyAdminChatCommands(bot, config({ adminChatId: -4242 }));

  expect(bot.calls).toHaveLength(1);
  const [commands, scope] = bot.calls[0];
  expect(scope.type).toBe("chat");
  expect(scope.chat_id).toBe(-4242);
  expect(commands.map((command) => command.command)).toEqual([
    "fetch_news",
    "redraft",
    "fanartdigest",
    "guidesdigest",
    "aniimoweek",
    "stats",
    "cleanup",
    "cancel",
  ]);
  // Descriptions come from the locale, not a placeholder key.
  expect(commands.map((command) => command.description)).toEqual([
    t("commands.fetch_news"),
    t("commands.redraft"),
    t("commands.fanartdigest"),
    t("commands.guidesdigest"),
    t("commands.aniimoweek"),
    t("commands.stats"),
    t("commands.cleanup"),
    t("commands.cancel"),
  ]);
  expect(commands.every((command) => command.description && !command.description.startsWith("commands."))).toBe(true);
});

it("skips the admin commands when the admin chat is moderated", async () => {
  // That chat's chat-scope menu carries /report + /rules for ordinary members;
  // overwriting it would advertise admin commands to everyone in the chat.
  const bot = fakeBot();
  await applyAdminChatCommands(bot, config({ adminChatId: -7, moderated: [-7] }));

  expect(bot.calls).toEqual([]);
});

it("survives a Telegram error", async () => {
  const bot = fakeBot({ fail: true });
  // Must not throw: a failed menu update never blocks startup.
  await applyAdminChatCommands(bot, config());

  expect(bot.calls).toEqual([]);
});
