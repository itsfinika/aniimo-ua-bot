/**
 * One-off admin script: list every Telegram chat the bot has recently seen,
 * so ADMIN_CHAT_ID / PUBLISH_CHAT_ID / TELEGRAM_MODERATION_CHAT_IDS /
 * TELEGRAM_MOD_LOG_CHAT_ID can be copied into .env without digging through
 * the raw getUpdates JSON in a browser.
 *
 * Run manually, once BOT_TOKEN is in .env:
 *
 *     node scripts/telegram_chat_ids.js
 *
 * How to make a chat show up:
 *   - group / supergroup: add the bot to it (the my_chat_member update alone
 *     is enough, no message needed);
 *   - channel: add the bot as an administrator with "Post messages";
 *   - private chat: press Start on the bot, or send it any message.
 *
 * What it does (two plain Bot API calls, no long polling):
 *   1. getMe — confirms the token belongs to the bot you expect.
 *   2. getUpdates WITHOUT an offset — reads the last 100 pending updates
 *      (Telegram keeps them for 24 h) but does not confirm them, so the
 *      deployed bot still receives every one of them later.
 *   3. Prints one line per distinct chat: id, type, title / username.
 *
 * Do NOT run this while the bot is deployed and polling: two concurrent
 * getUpdates callers make Telegram answer 409 to both. Run it before the
 * first deploy, or stop the container first. The script never prints the token.
 */

import process from "node:process";

import dotenv from "dotenv";

const API = "https://api.telegram.org";

// Every update type that carries a chat, in the order Telegram documents them.
const CHAT_FIELDS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "my_chat_member",
  "chat_member",
  "chat_join_request",
];

/**
 * Reduce a getUpdates result to distinct chats.
 *
 * Returns { chats, users }: `chats` has one entry per chat id (last seen wins
 * for the title, so a rename shows the new name); `users` collects the people
 * who wrote to the bot in private, which is what ADMIN_USER_IDS needs.
 * Exported for tests.
 */
export function collectChats(updates) {
  const chats = new Map();
  const users = new Map();
  for (const update of updates ?? []) {
    for (const field of CHAT_FIELDS) {
      const chat = update?.[field]?.chat;
      if (!chat || typeof chat.id !== "number") continue;
      chats.set(chat.id, {
        id: chat.id,
        type: chat.type ?? "?",
        title: chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(" "),
        username: chat.username ?? "",
      });
    }
    const from = update?.message?.from ?? update?.callback_query?.from;
    if (from && typeof from.id === "number" && !from.is_bot) {
      users.set(from.id, {
        id: from.id,
        name: [from.first_name, from.last_name].filter(Boolean).join(" "),
        username: from.username ?? "",
      });
    }
  }
  return { chats: [...chats.values()], users: [...users.values()] };
}

/** Render the table printed to stdout. Exported for tests. */
export function formatReport({ chats, users }) {
  const lines = [];
  if (chats.length === 0) {
    lines.push("No chats seen yet. Add the bot to a chat (or write to it) and run again.");
  } else {
    lines.push("Chats the bot has seen (last 24 h):");
    for (const chat of chats.sort((a, b) => a.type.localeCompare(b.type) || a.id - b.id)) {
      const name = [chat.title, chat.username ? `@${chat.username}` : ""].filter(Boolean).join(" ");
      lines.push(`  ${String(chat.id).padStart(15)}  ${chat.type.padEnd(10)}  ${name}`);
    }
  }
  if (users.length > 0) {
    lines.push("", "Users who wrote to the bot (for ADMIN_USER_IDS):");
    for (const user of users) {
      const name = [user.name, user.username ? `@${user.username}` : ""].filter(Boolean).join(" ");
      lines.push(`  ${String(user.id).padStart(15)}  ${name}`);
    }
  }
  return lines.join("\n");
}

async function callApi(token, method) {
  const response = await fetch(`${API}/bot${token}/${method}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const description = body.description ?? `HTTP ${response.status}`;
    throw new Error(`${method}: ${description}`);
  }
  return body.result;
}

async function main() {
  dotenv.config();
  const token = (process.env.BOT_TOKEN ?? "").trim();
  if (!/^\d+:[\w-]+$/.test(token)) {
    console.error("BOT_TOKEN in .env is empty or still a placeholder — paste the token from BotFather first.");
    process.exit(1);
  }

  try {
    const me = await callApi(token, "getMe");
    console.log(`Token belongs to @${me.username} (${me.first_name})`);
    const updates = await callApi(token, "getUpdates?limit=100");
    console.log(formatReport(collectChats(updates)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("409")) {
      console.error("Telegram answered 409: another process is polling with this token (the deployed bot?). Stop it and retry.");
    } else if (message.toLowerCase().includes("webhook")) {
      console.error("A webhook is set for this bot, so getUpdates is unavailable. Delete it via /deleteWebhook and retry.");
    } else {
      console.error(message);
    }
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
