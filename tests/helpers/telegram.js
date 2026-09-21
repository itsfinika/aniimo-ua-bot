/**
 * A miniature Telegram harness for handler tests.
 *
 * The Python tests called the aiogram handler functions directly with a fake
 * message object. The grammY port registers its handlers on a Composer, so the
 * equivalent — and stricter — approach is to build a REAL `Context` from a real
 * `Update` and run it through the composer: that exercises the command filters,
 * the chat scoping and the handler ordering, not just the handler body.
 *
 * The API object is a recording stub, so nothing leaves the process.
 */

import { Context } from "grammy";

export const BOT_INFO = Object.freeze({
  id: 1234567,
  is_bot: true,
  first_name: "Test",
  username: "TestBot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
});

/**
 * A stub `bot` whose `api` records every call as `{method, args}`.
 *
 * Individual methods can be overridden through `handlers` when a test needs a
 * specific return value (e.g. a message_id).
 */
export function fakeBot(handlers = {}) {
  const calls = [];
  const api = new Proxy(
    {},
    {
      get(_target, method) {
        if (method === "then") return undefined; // never look thenable
        return async (...args) => {
          calls.push({ method, args });
          if (typeof handlers[method] === "function") {
            return handlers[method](...args);
          }
          // A plausible sent-message shape covers most call sites.
          return { message_id: calls.length, chat: { id: args[0] }, date: 0, text: args[1] };
        };
      },
    },
  );
  return { api, botInfo: BOT_INFO, calls, callsTo: (method) => calls.filter((call) => call.method === method) };
}

let nextUpdateId = 1;
let nextMessageId = 1000;

/** Build a message update, with bot_command entities filled in automatically. */
export function messageUpdate({
  text = null,
  caption = null,
  chatId = 100,
  chatType = "private",
  chatTitle = undefined,
  userId = 7,
  username = "tester",
  firstName = "Test",
  entities = null,
  replyToMessage = undefined,
  senderChat = undefined,
  photo = undefined,
  video = undefined,
  document = undefined,
  newChatMembers = undefined,
  mediaGroupId = undefined,
  messageId = null,
} = {}) {
  const message = {
    message_id: messageId ?? nextMessageId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: chatType, ...(chatTitle === undefined ? {} : { title: chatTitle }) },
    from: { id: userId, is_bot: false, first_name: firstName, username },
  };
  if (text !== null) message.text = text;
  if (caption !== null) message.caption = caption;
  if (photo) message.photo = photo;
  if (video) message.video = video;
  if (document) message.document = document;
  if (mediaGroupId) message.media_group_id = mediaGroupId;
  if (newChatMembers) message.new_chat_members = newChatMembers;
  if (replyToMessage) message.reply_to_message = replyToMessage;
  if (senderChat) message.sender_chat = senderChat;
  message.entities = entities ?? commandEntities(text);

  return { update_id: nextUpdateId++, message };
}

/** A `channel_post` update — the admin channel path in handlers/admin.js. */
export function channelPostUpdate({ text = null, chatId = 100, messageId = null } = {}) {
  return {
    update_id: nextUpdateId++,
    channel_post: {
      message_id: messageId ?? nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "channel" },
      ...(text === null ? {} : { text }),
    },
  };
}

export function callbackQueryUpdate({ data, userId = 7, chatId = 100, messageId = 500, chatType = "private" } = {}) {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId),
      from: { id: userId, is_bot: false, first_name: "Test", username: "tester" },
      chat_instance: "1",
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: chatType },
        text: "preview",
      },
    },
  };
}

/** Telegram marks a leading `/command` with a bot_command entity; grammY needs it. */
function commandEntities(text) {
  if (!text || !text.startsWith("/")) return undefined;
  const length = text.split(/\s/)[0].length;
  return [{ type: "bot_command", offset: 0, length }];
}

/** Run one update through a composer and return the recorded API calls. */
export async function dispatch(composer, update, bot) {
  const ctx = new Context(update, bot.api, BOT_INFO);
  let reachedEnd = false;
  await composer.middleware()(ctx, async () => {
    reachedEnd = true;
  });
  return { ctx, reachedEnd };
}

/** The text of every `sendMessage` the handler produced, in order. */
export function sentTexts(bot) {
  return bot.callsTo("sendMessage").map((call) => call.args[1]);
}
