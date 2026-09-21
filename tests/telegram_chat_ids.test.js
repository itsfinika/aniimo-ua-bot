/**
 * Tests for the chat-id helper script: the getUpdates payload is reduced to one
 * line per chat, whatever update type carried it, and private senders are
 * listed separately for ADMIN_USER_IDS.
 */

import { expect, it } from "vitest";

import { collectChats, formatReport } from "../scripts/telegram_chat_ids.js";

const supergroup = { id: -1001111111111, type: "supergroup", title: "Тестова група" };
const channel = { id: -1002222222222, type: "channel", title: "Aniimo|UA", username: "AniimoUA" };
const person = { id: 123456789, is_bot: false, first_name: "Тест", username: "tester" };

it("collects one entry per chat across update types", () => {
  const updates = [
    { update_id: 1, my_chat_member: { chat: supergroup, from: person } },
    { update_id: 2, message: { chat: supergroup, from: person, text: "hi" } },
    { update_id: 3, channel_post: { chat: channel, text: "post" } },
    { update_id: 4, message: { chat: { id: person.id, type: "private", first_name: "Тест", username: "tester" }, from: person, text: "/start" } },
  ];
  const { chats, users } = collectChats(updates);
  expect(chats.map((c) => c.id)).toEqual([supergroup.id, channel.id, person.id]);
  expect(chats[1]).toEqual({ id: channel.id, type: "channel", title: "Aniimo|UA", username: "AniimoUA" });
  expect(chats[2].title).toBe("Тест");
  expect(users).toEqual([{ id: person.id, name: "Тест", username: "tester" }]);
});

it("keeps the latest title after a rename and ignores bots and malformed updates", () => {
  const updates = [
    { update_id: 1, message: { chat: { ...supergroup, title: "Old name" }, from: { id: 42, is_bot: true, first_name: "Bot" } } },
    { update_id: 2, message: { chat: supergroup, from: person } },
    { update_id: 3, message: { chat: { type: "group" } } },
    { update_id: 4 },
    null,
  ];
  const { chats, users } = collectChats(updates);
  expect(chats).toHaveLength(1);
  expect(chats[0].title).toBe("Тестова група");
  expect(users.map((u) => u.id)).toEqual([person.id]);
});

it("formats an empty result as a hint and a full one as a table", () => {
  expect(formatReport(collectChats([]))).toMatch(/No chats seen yet/);
  const report = formatReport(collectChats([
    { update_id: 1, channel_post: { chat: channel } },
    { update_id: 2, my_chat_member: { chat: supergroup } },
  ]));
  const lines = report.split("\n");
  expect(lines[0]).toBe("Chats the bot has seen (last 24 h):");
  // Sorted by type, so the channel comes before the supergroup.
  expect(lines[1]).toContain("-1002222222222");
  expect(lines[1]).toContain("channel");
  expect(lines[1]).toContain("Aniimo|UA @AniimoUA");
  expect(lines[2]).toContain("Тестова група");
  expect(report).not.toMatch(/ADMIN_USER_IDS/);
});
