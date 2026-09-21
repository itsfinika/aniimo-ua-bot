/**
 * One-off admin script: configure the LFT (looking-for-team) forum channel.
 *
 * Run manually whenever the forum needs to be (re)configured:
 *
 *     node scripts/setup_lft_forum.js
 *
 * What it does (plain Discord REST calls, no gateway connection):
 *   1. Finds the forum channel in DISCORD_GUILD_ID whose name contains
 *      "пошук" or "lft" (there is exactly one on our server).
 *   2. Renames it to "lft-пошук-тіммейтів" and sets the post guidelines,
 *      tags (platform / mode / role), default 🤝 reaction, list layout,
 *      sorting by latest activity and a 7-day auto-archive default.
 *   3. Creates the pinned "📌 Як знайти тіммейтів" intro post with the
 *      post template — unless a pinned 📌 post already exists (idempotent).
 *   4. Prints the forum channel ID so it can be put into DISCORD_LFT_CHANNEL_ID.
 *
 * Required bot permissions: Manage Channels (step 2), Send Messages /
 * Create Posts (step 3), Manage Threads (pinning). The script only touches
 * this one forum channel and never prints the token.
 */

import process from "node:process";

import dotenv from "dotenv";

const API = "https://discord.com/api/v10";

const FORUM_NAME = "lft-пошук-тіммейтів";

// Forum "Post Guidelines" (shown by Discord above the post list, max 4096).
const FORUM_GUIDELINES = `🤝 Шукаєш, з ким пограти в Aniimo? Ти за адресою!

Як створити пост:
• Натисни «New Post» і коротко напиши в назві, кого шукаєш — напр.: «Рейд на PC, потрібна Підтримка».
• Обери теги: платформа, режим, роль.
• Заповни шаблон із закріпленого поста 📌

Правила форуму:
1. Один активний пост на людину. Знайшов команду — напиши про це в пості й закрий його.
2. Без токсичності, образ і булінгу — граємо в задоволення 💙💛
3. Без реклами, бустів і продажу акаунтів.
4. Бачиш порушення — кидай /report, модерація розбереться.

GLHF! 🎮`;

// Forum tags: max 20 per forum, names up to 20 characters.
const FORUM_TAGS = [
  { name: "PC", moderated: false, emoji_id: null, emoji_name: "💻" },
  { name: "PlayStation", moderated: false, emoji_id: null, emoji_name: "🎮" },
  { name: "Mobile", moderated: false, emoji_id: null, emoji_name: "📱" },
  { name: "Кооп", moderated: false, emoji_id: null, emoji_name: "🤝" },
  { name: "PvP", moderated: false, emoji_id: null, emoji_name: "⚔️" },
  { name: "Рейд", moderated: false, emoji_id: null, emoji_name: "🏆" },
  { name: "DPS", moderated: false, emoji_id: null, emoji_name: "🔥" },
  { name: "Break (пробиття)", moderated: false, emoji_id: null, emoji_name: "🛡️" },
  { name: "Підтримка", moderated: false, emoji_id: null, emoji_name: "💉" },
];

const INTRO_TITLE = "📌 Як знайти тіммейтів — почни звідси";

const INTRO_CONTENT = `## Привіт! Це форум пошуку тіммейтів Aniimo UA 🤝

**Як створити пост:**
1. Натисни **New Post / Новий пост**.
2. У назві коротко вкажи головне — режим, платформу, роль. Напр.: \`Рейд на PC, шукаю Підтримку\`.
3. Обери теги: платформу, режим і роль.
4. Скопіюй шаблон нижче у свій пост і заповни 👇

**Шаблон:**
\`\`\`
**Платформа:** PC / PlayStation / Mobile
**Режим:** Кооп / PvP / Рейд
**Рівень:**
**Роль:** DPS / Break (пробиття) / Підтримка
**Час гри:** напр., 19:00–23:00 за Києвом
**Коментар:** вік, войс, кілька слів про себе
\`\`\`

**Поради:**
• Один активний пост на людину. Знайшов команду — напиши про це в пості й закрий його 🔒
• Хочеш відгукнутися на чийсь пост? Просто напиши в ньому.
• Будь привітним — з токсиками грати ніхто не хоче 😉
• Бачиш порушення — скористайся командою \`/report\`.

GLHF! 🎮💙💛`;

const GUILD_FORUM_TYPE = 15; // Discord channel type for forum channels
const PINNED_THREAD_FLAG = 1 << 1; // forum-thread PINNED flag

const FAILURES = [];

function fail(message) {
  console.log(`ERROR: ${message}`);
  process.exit(1);
}

async function request(token, method, path, body = null) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      ...(body === null ? {} : { "Content-Type": "application/json" }),
    },
    body: body === null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  return { status: response.status, text };
}

function check(response, what) {
  if (response.status === 403) {
    fail(`${what}: 403 Forbidden — the bot is missing a permission. Body: ${response.text}`);
  }
  if (response.status >= 400) {
    fail(`${what}: HTTP ${response.status}. Body: ${response.text}`);
  }
  return response.text ? JSON.parse(response.text) : {};
}

/** Like check(), but a failure is recorded and the script keeps going. */
function tryStep(response, what, needs) {
  if (response.status === 403) {
    FAILURES.push(`${what} — bot is missing the '${needs}' permission on the forum channel.`);
    return null;
  }
  if (response.status >= 400) {
    FAILURES.push(`${what} — HTTP ${response.status}: ${response.text}`);
    return null;
  }
  return response.text ? JSON.parse(response.text) : {};
}

async function main() {
  dotenv.config({ quiet: true });
  const token = (process.env.DISCORD_BOT_TOKEN || "").trim();
  const guildId = (process.env.DISCORD_GUILD_ID || "").trim();
  if (!token || !guildId) {
    fail("DISCORD_BOT_TOKEN and DISCORD_GUILD_ID must be set in .env");
  }

  // 1. Find the forum channel.
  const channels = check(await request(token, "GET", `/guilds/${guildId}/channels`), "List guild channels");
  const forums = channels.filter((channel) => channel.type === GUILD_FORUM_TYPE);
  const candidates = forums.filter((channel) => {
    const name = (channel.name || "").toLowerCase();
    return name.includes("пошук") || name.includes("lft");
  });
  if (!candidates.length) {
    fail(
      `No forum channel matching 'пошук'/'lft' found. Forums present: ` +
        `${JSON.stringify(forums.map((channel) => channel.name))}`,
    );
  }
  if (candidates.length > 1) {
    fail(`Several matching forums found, refusing to guess: ${JSON.stringify(candidates.map((c) => c.name))}`);
  }
  const forum = candidates[0];
  const forumId = forum.id;
  console.log(`Found forum: #${forum.name} (id ${forumId})`);

  // 2. Configure the channel itself.
  const payload = {
    name: FORUM_NAME,
    topic: FORUM_GUIDELINES,
    available_tags: FORUM_TAGS,
    default_reaction_emoji: { emoji_id: null, emoji_name: "🤝" },
    default_sort_order: 0, // latest activity
    default_forum_layout: 1, // list view
    default_auto_archive_duration: 10080, // new posts auto-archive after 7 days
  };
  const configured = tryStep(
    await request(token, "PATCH", `/channels/${forumId}`, payload),
    "Configure forum channel (name/guidelines/tags/defaults)",
    "Manage Channels",
  );
  if (configured !== null) {
    console.log(
      `Configured forum: name=${FORUM_NAME}, ${FORUM_TAGS.length} tags, guidelines, 🤝 default reaction`,
    );
  }

  // 3. Create + pin the intro post, unless a 📌 post already exists.
  const active = check(await request(token, "GET", `/guilds/${guildId}/threads/active`), "List active threads");
  const existing = (active.threads ?? []).filter(
    (thread) => thread.parent_id === forumId && (thread.name || "").startsWith("📌"),
  );
  let thread;
  if (existing.length) {
    thread = existing[0];
    console.log(`Intro post already exists (id ${thread.id}); skipping creation.`);
  } else {
    thread = tryStep(
      await request(token, "POST", `/channels/${forumId}/threads`, {
        name: INTRO_TITLE,
        auto_archive_duration: 10080,
        message: { content: INTRO_CONTENT },
      }),
      "Create intro post",
      "Send Messages / Create Posts",
    );
    if (thread !== null) {
      console.log(`Created intro post (id ${thread.id})`);
    }
  }

  if (thread !== null) {
    if ((thread.flags ?? 0) & PINNED_THREAD_FLAG) {
      console.log("Intro post is already pinned.");
    } else {
      const pinned = tryStep(
        await request(token, "PATCH", `/channels/${thread.id}`, { flags: PINNED_THREAD_FLAG }),
        "Pin intro post",
        "Manage Threads",
      );
      if (pinned !== null) {
        console.log("Pinned intro post.");
      }
    }
  }

  console.log();
  if (FAILURES.length) {
    console.log("Some steps FAILED — grant the bot these permissions on the forum channel");
    console.log("(channel Edit -> Permissions -> add the bot/its role), then re-run this script:");
    for (const failure of FAILURES) {
      console.log(`  - ${failure}`);
    }
    console.log();
  }
  console.log("Add this to .env (and the production environment) so the bot");
  console.log("can link the forum in /lfthelp and welcome messages:");
  console.log(`DISCORD_LFT_CHANNEL_ID=${forumId}`);
}

await main();
