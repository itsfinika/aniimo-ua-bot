/**
 * Optional Discord moderation bot for the Aniimo UA community server.
 *
 * This module is completely independent from the Telegram news/submission/approval
 * flow. It is started from main.js as a cancellable background task that runs
 * alongside the grammY long-polling loop in the same process. Any failure here is
 * contained so the Telegram bot keeps running.
 *
 * It does NOT parse the official Aniimo Discord server. It only provides
 * moderation/utility features on our own community server:
 *
 *   * anti-spam (rate limit + short timeout)
 *   * Discord invite filtering
 *   * suspicious / scam link filtering
 *   * a small, conservative bad-word filter
 *   * moderation logging to a configured channel
 *   * persistent warning history with configurable auto-actions
 *   * a member /report flow and an optional welcome system for new members
 *   * slash commands: /help, /clear, /timeout, /warn, /report, /warnings,
 *     /clearwarnings, /lfthelp (LFT-forum guide for everyone)
 *
 * ---------------------------------------------------------------------------
 * DISCORD DEVELOPER PORTAL REMINDERS (one-time setup):
 *
 * 1. Privileged "MESSAGE CONTENT INTENT" must be enabled for the bot under
 *    Developer Portal -> Your App -> Bot -> Privileged Gateway Intents.
 *    Without it the bot logs in but cannot read message content, so the
 *    invite/scam/bad-word/anti-spam filters cannot work.
 *
 * 2. Slash commands require the bot to be invited with BOTH the `bot` and
 *    `applications.commands` OAuth2 scopes. If the slash commands do not show
 *    up, re-invite the bot using an OAuth2 URL that includes
 *    `scope=bot%20applications.commands`.
 *
 * 3. The bot does NOT need Administrator. Grant only:
 *    View Channels, Send Messages, Manage Messages, Read Message History,
 *    Moderate Members, Embed Links, Use Application Commands.
 *
 * 4. The optional welcome system (DISCORD_WELCOME_CHANNEL_ID) needs the privileged
 *    "SERVER MEMBERS INTENT" enabled in the Developer Portal. It is requested ONLY
 *    when a welcome channel is configured, so leaving welcome off keeps the bot's
 *    intents (and behaviour) exactly as they were before.
 * ---------------------------------------------------------------------------
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import { DateTime } from "luxon";

import { createTask } from "./services/background.js";
import { getLogger } from "./services/logger.js";
import {
  errorText,
  escapeRegExp,
  fromIsoFormat,
  hasIsoOffset,
  sliceChars,
  sortedNumbers,
  WORD,
} from "./services/pyutils.js";

const logger = getLogger("discord_moderation");

// --------------------------------------------------------------------------- //
// Tunable moderation settings (kept in code on purpose, as requested).
// --------------------------------------------------------------------------- //

// Anti-spam: more than SPAM_MAX_MESSAGES messages from the same user in the same
// channel within SPAM_WINDOW_SECONDS triggers an action.
export const SPAM_WINDOW_SECONDS = 7.0;
export const SPAM_MAX_MESSAGES = 5;
export const SPAM_TIMEOUT_SECONDS = 60;

// Discord's hard maximum timeout is 28 days.
export const MAX_TIMEOUT_MINUTES = 28 * 24 * 60; // 40320

// Auto-actions after repeated /warn warnings (configurable; kept in code on
// purpose, like the anti-spam thresholds above). Keys are the *active* warning
// count that triggers the action; values are the timeout length in seconds.
// The bot NEVER auto-bans or auto-kicks, and never auto-punishes staff (see
// isStaff). Each /warn adds exactly one warning, so an exact-count match fires
// every threshold once.
export const WARN_TIMEOUT_THRESHOLDS = new Map([
  [3, 10 * 60], // 3 warnings -> 10-minute timeout
  [5, 60 * 60], // 5 warnings -> 1-hour timeout
]);
// At this many warnings, post an urgent mod-log note asking moderators to review
// manually. No automatic ban/kick is ever performed.
export const WARN_ESCALATION_THRESHOLD = 7;

// Bad-word filter. The list itself lives in an external, easy-to-edit text file
// (discord_badwords.txt next to this module) so it can be curated without
// touching code. It is loaded once at startup; matching uses Unicode-aware word
// boundaries, so terms match only WHOLE words, never substrings of normal words.
const BAD_WORDS_FILE = path.resolve(import.meta.dirname, "discord_badwords.txt");

// Minimal fallback used only if discord_badwords.txt is missing/unreadable/empty.
const DEFAULT_BAD_WORDS = ["nigger", "faggot", "retard"];

function loadBadWords() {
  let raw;
  try {
    raw = fs.readFileSync(BAD_WORDS_FILE, "utf8");
  } catch {
    logger.warning(
      `Bad-word list ${path.basename(BAD_WORDS_FILE)} not found or unreadable; using built-in defaults.`,
    );
    return DEFAULT_BAD_WORDS;
  }
  const words = [];
  for (const line of raw.split(/\r?\n/)) {
    const token = line.trim();
    if (!token || token.startsWith("#")) {
      continue;
    }
    words.push(token.toLowerCase());
  }
  // De-duplicate while preserving order; fall back to defaults if file is empty.
  const unique = [...new Set(words)];
  return unique.length ? unique : DEFAULT_BAD_WORDS;
}

export const BAD_WORDS = loadBadWords();

// Welcome rules. Like the bad-word list, the text lives in an external,
// easy-to-edit file (discord_rules.txt) so the community rules shown in the
// welcome message can be curated without touching code. One rule per line;
// blank lines and lines starting with "#" are ignored. If the file is missing or
// empty, the welcome simply omits the rules section.
const WELCOME_RULES_FILE = path.resolve(import.meta.dirname, "discord_rules.txt");

function loadWelcomeRules() {
  let raw;
  try {
    raw = fs.readFileSync(WELCOME_RULES_FILE, "utf8");
  } catch {
    return [];
  }
  const rules = [];
  for (const line of raw.split(/\r?\n/)) {
    const token = line.trim();
    if (!token || token.startsWith("#")) {
      continue;
    }
    rules.push(token);
  }
  return rules;
}

export const WELCOME_RULES = loadWelcomeRules();

// Python's `\b` / `\w` are Unicode-aware for `str`; JavaScript's are ASCII-only.
const NOT_WORD_BEFORE = `(?<!${WORD})`;
const NOT_WORD_AFTER = `(?!${WORD})`;

// Detect Discord invite links: discord.gg/<code>, discord.com/invite/<code>,
// discordapp.com/invite/<code> (with or without scheme / www).
const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/gi;

// Always-suspicious scam phrases / phishing look-alike domains. Kept conservative.
const SCAM_PATTERNS = [
  /free\s+(?:discord\s+)?nitro/i,
  /nitro\s+(?:for\s+)?free/i,
  /(?:steam|cs:?go)\s+gift/i,
  new RegExp(`free\\s+(?:robux|v-?bucks|skins?)${NOT_WORD_AFTER}`, "iu"),
  /(?:double|2x)\s+your\s+(?:crypto|btc|eth|bitcoin)/i,
  new RegExp(`${NOT_WORD_BEFORE}crypto\\s+airdrop${NOT_WORD_AFTER}`, "iu"),
  // Common phishing look-alike domains / typosquats.
  new RegExp(
    `${NOT_WORD_BEFORE}(?:dlscord|discrod|dlsc0rd|discord-nitro|discordgift|discordapp\\.gift|` +
      `steamcommunlty|steamcommun[il]ty|steamcomunity)${NOT_WORD_AFTER}`,
    "iu",
  ),
  // IP-logger / grabber services are effectively always malicious.
  /https?:\/\/(?:grabify\.link|iplogger\.\w+|blasze\.\w+)\/\S+/i,
];

// Generic URL shorteners: only treated as suspicious when combined with a scam
// keyword, to avoid blocking legitimate shortened links.
const SHORTENER_RE = /https?:\/\/(?:bit\.ly|tinyurl\.com|cutt\.ly|is\.gd|shorturl\.at|t\.co|rb\.gy)\/\S+/i;
const SCAM_KEYWORD_RE = new RegExp(
  `${NOT_WORD_BEFORE}(?:nitro|free|gift|airdrop|giveaway|claim|reward|prize|crypto|wallet)${NOT_WORD_AFTER}`,
  "iu",
);

function buildBadWordRe() {
  if (!BAD_WORDS.length) {
    return null;
  }
  const joined = BAD_WORDS.map((word) => escapeRegExp(word)).join("|");
  return new RegExp(`${NOT_WORD_BEFORE}(?:${joined})${NOT_WORD_AFTER}`, "iu");
}

const BAD_WORD_RE = buildBadWordRe();

/** Return a short reason string if the content looks like a scam, else null. */
export function suspiciousReason(content) {
  for (const pattern of SCAM_PATTERNS) {
    if (pattern.test(content)) {
      return "Suspicious / scam link or phrase";
    }
  }
  if (SHORTENER_RE.test(content) && SCAM_KEYWORD_RE.test(content)) {
    return "Suspicious shortened link";
  }
  return null;
}

export function hasBadWord(content) {
  return BAD_WORD_RE !== null && BAD_WORD_RE.test(content);
}

/**
 * Render a stored ISO-8601 timestamp as a Discord `<t:...>` markup string.
 *
 * Discord localises `<t:epoch:f>` to each viewer's timezone. Falls back to the
 * raw value if it cannot be parsed, so a bad row never breaks /warnings.
 */
export function formatWarnTimestamp(raw) {
  const parsed = hasIsoOffset(raw) ? fromIsoFormat(raw) : DateTime.fromISO(String(raw ?? "").trim(), { zone: "utc" });
  if (parsed === null || !parsed.isValid) {
    return raw || "—";
  }
  return `<t:${Math.floor(parsed.toSeconds())}:f>`;
}

/** Discord's `escape_markdown`. */
function escapeMarkdown(text) {
  return String(text ?? "").replace(/([\\`*_~|>[\]()#+\-=.!{}])/g, "\\$1");
}

/**
 * Persistent Discord warning history stored in the project's SQLite file.
 *
 * Kept inside this module so the Discord feature stays self-contained and the
 * Telegram database layer (database.js) is untouched. It opens its own
 * short-lived connections (with a generous busy timeout) against the SAME
 * database file, in a dedicated `discord_warnings` table the Telegram side never
 * reads. Warning volume is low, so brief write contention is handled by SQLite's
 * busy timeout without changing the shared file's journal mode.
 */
export class WarningStore {
  constructor(dbPath) {
    this._path = dbPath;
  }

  _connect(work) {
    const db = new DatabaseSync(this._path);
    try {
      db.exec("PRAGMA busy_timeout = 30000");
      return work(db);
    } finally {
      db.close();
    }
  }

  async init() {
    this._connect((db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS discord_warnings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            guild_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            moderator_id INTEGER NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_discord_warnings_guild_user ON discord_warnings (guild_id, user_id)",
      );
    });
  }

  /** Insert a warning and return the active warning count for that member. */
  async add({ guild_id, user_id, moderator_id, reason }) {
    const createdAt = DateTime.utc().toISO();
    return this._connect((db) => {
      db.prepare(
        "INSERT INTO discord_warnings (guild_id, user_id, moderator_id, reason, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(guild_id, user_id, moderator_id, reason, createdAt);
      const row = db
        .prepare("SELECT COUNT(*) AS total FROM discord_warnings WHERE guild_id = ? AND user_id = ?")
        .get(guild_id, user_id);
      return row ? Number(row.total) : 0;
    });
  }

  async list({ guild_id, user_id }) {
    return this._connect((db) => {
      const rows = db
        .prepare(
          "SELECT moderator_id, reason, created_at FROM discord_warnings " +
            "WHERE guild_id = ? AND user_id = ? ORDER BY id ASC",
        )
        .all(guild_id, user_id);
      return rows.map((row) => ({
        moderator_id: row.moderator_id,
        reason: row.reason,
        created_at: row.created_at,
      }));
    });
  }

  async clear({ guild_id, user_id }) {
    return this._connect((db) => {
      const cursor = db
        .prepare("DELETE FROM discord_warnings WHERE guild_id = ? AND user_id = ?")
        .run(guild_id, user_id);
      return Number(cursor.changes ?? 0);
    });
  }
}

// --------------------------------------------------------------------------- //
// Public entry point used by main.js
// --------------------------------------------------------------------------- //

/**
 * Start the Discord moderation bot as a background task, or return null.
 *
 * Returns null (and logs a safe reason) when the module is disabled, when
 * discord.js is unavailable, or when the bot token is missing. Never throws, so
 * the Telegram bot is never affected by Discord configuration problems.
 */
export function startDiscordModeration(config) {
  if (!config.enable_discord_moderation) {
    logger.info("Discord moderation is disabled (ENABLE_DISCORD_MODERATION is not true).");
    return null;
  }

  if (!config.discord_bot_token) {
    logger.error(
      "Discord moderation is enabled but DISCORD_BOT_TOKEN is empty. " +
        "Skipping Discord startup; Telegram bot continues normally.",
    );
    return null;
  }

  logger.info("Starting Discord moderation bot task.");
  return createTask("discord-moderation", (signal) => runBot(config, signal));
}

/**
 * Run the Discord client and swallow failures so Telegram is unaffected.
 *
 * Secrets are never logged: only error class names / safe guidance are emitted.
 */
async function runBot(config, signal) {
  let discord;
  try {
    discord = await import("discord.js");
  } catch (error) {
    logger.error(
      `Discord moderation is enabled but discord.js is not installed (${errorText(error)}). ` +
        "Run: npm install. Telegram bot continues without it.",
    );
    return;
  }

  const bot = new ModerationBot(config, discord);
  try {
    await bot.start(config.discord_bot_token, signal);
  } catch (error) {
    const name = error?.name ?? "";
    const text = errorText(error);
    if (name === "Error" && /TOKEN_INVALID|disallowed intents/i.test(text)) {
      if (/disallowed intents/i.test(text)) {
        logger.error(
          "Discord login failed: a required privileged intent is not enabled for this bot. " +
            "Enable MESSAGE CONTENT INTENT (and, if you set DISCORD_WELCOME_CHANNEL_ID, also " +
            "SERVER MEMBERS INTENT) in the Developer Portal (Bot -> Privileged Gateway Intents). " +
            "Telegram bot keeps running.",
        );
      } else {
        logger.error("Discord login failed: the DISCORD_BOT_TOKEN is invalid. Telegram bot keeps running.");
      }
    } else {
      // Log the traceback but not the token; discord.js does not echo it.
      logger.exception("Discord moderation crashed. Telegram bot keeps running.", error);
    }
  } finally {
    await bot.close();
  }
}

// --------------------------------------------------------------------------- //
// The bot
// --------------------------------------------------------------------------- //

/** Discord moderation client. Holds config + per-channel spam state. */
class ModerationBot {
  constructor(config, discord) {
    this.discord = discord;
    this.mod_config = config;
    const { Client, GatewayIntentBits, Partials } = discord;
    const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
    // Server Members Intent is privileged and only needed for the welcome
    // system. Request it ONLY when a welcome channel is configured, so the
    // existing bot keeps working unchanged when welcome is disabled.
    if (config.discord_welcome_channel_id) {
      intents.push(GatewayIntentBits.GuildMembers);
    }
    this.client = new Client({ intents, partials: [Partials.Channel] });
    // (channel_id, user_id) -> array of monotonic timestamps
    this._spamTracker = new Map();
    this._modLogWarned = false;
    // Persistent warning history (same SQLite file, dedicated table).
    this.warningStore = new WarningStore(config.database_path);
    this._reportCooldowns = new Map();
    this._closed = false;
  }

  async start(token, signal) {
    const { Events } = this.discord;

    this.client.once(Events.ClientReady, async (client) => {
      logger.info(
        `Discord moderation connected as ${client.user?.tag} (id ${client.user?.id ?? "?"}); ` +
          `serving ${client.guilds.cache.size} guild(s).`,
      );
    });

    this.client.on(Events.MessageCreate, async (message) => {
      try {
        await this.moderate(message);
      } catch (error) {
        logger.exception("Error while moderating a Discord message.", error);
      }
    });

    this.client.on(Events.GuildMemberAdd, async (member) => {
      try {
        await this.sendWelcome(member);
      } catch (error) {
        logger.exception("Error while sending the Discord welcome message.", error);
      }
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      try {
        await handleCommand(this, interaction);
      } catch (error) {
        await this.onAppCommandError(interaction, error);
      }
    });

    // Ensure the warnings table exists before any command can touch it.
    // A failure here only disables warning history; the rest keeps working.
    try {
      await this.warningStore.init();
    } catch (error) {
      logger.exception("Failed to initialise the Discord warnings table; warning history disabled.", error);
    }

    await this.client.login(token);
    await this.registerCommands();

    // Stay alive until the task is cancelled by main's shutdown path.
    await new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async registerCommands() {
    // Sync slash commands. A guild-scoped sync is instant; a global sync can take
    // up to ~1 hour to propagate. Set DISCORD_GUILD_ID for fast iteration on your
    // own server.
    try {
      const definitions = buildCommandDefinitions(this.discord).map((command) => command.toJSON());
      if (this.mod_config.discord_guild_id) {
        const guild = await this.client.guilds.fetch(String(this.mod_config.discord_guild_id));
        await guild.commands.set(definitions);
        logger.info(`Synced Discord slash commands to guild ${this.mod_config.discord_guild_id}.`);
      } else {
        await this.client.application.commands.set(definitions);
        logger.info("Synced Discord slash commands globally (may take up to ~1h to appear).");
      }
    } catch (error) {
      logger.exception("Failed to sync Discord slash commands.", error);
    }
  }

  async close() {
    if (this._closed) {
      return;
    }
    this._closed = true;
    try {
      await this.client.destroy();
    } catch (error) {
      logger.exception("Error while closing the Discord client.", error);
    }
  }

  // ----- welcome system ----- //

  async sendWelcome(member) {
    const channelId = this.mod_config.discord_welcome_channel_id;
    if (!channelId || member.user.bot) {
      return; // welcome disabled, or a bot joined
    }

    const channel = await this.resolveChannel(channelId);
    if (channel === null) {
      logger.warning(`Welcome channel ${channelId} is missing or inaccessible.`);
      return;
    }

    const { EmbedBuilder, PermissionFlagsBits } = this.discord;
    const perms = channel.permissionsFor(channel.guild.members.me);
    if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks)) {
      logger.warning(`Missing 'Send Messages' / 'Embed Links' in welcome channel ${channelId}.`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("Вітаємо в Aniimo UA 🇺🇦")
      .setDescription("Ознайомся з правилами, обери роль і приєднуйся до спілкування. Гарної гри!")
      .setColor(0x5865f2); // blurple
    if (WELCOME_RULES.length) {
      const rulesText = WELCOME_RULES.map((rule, index) => `${index + 1}. ${rule}`).join("\n");
      embed.addFields({ name: "📜 Правила", value: sliceChars(rulesText, 0, 1024), inline: false });
    }
    const links = this.welcomeChannelLinks();
    if (links) {
      embed.addFields({ name: "Корисні канали", value: links, inline: false });
    }

    try {
      // Ping only the joining member; never @everyone or roles.
      await channel.send({
        content: member.toString(),
        embeds: [embed],
        allowedMentions: { parse: [], users: [member.id] },
      });
    } catch (error) {
      logger.exception("Failed to send the Discord welcome message.", error);
    }
  }

  /**
   * Channel mentions for the welcome embed, only for IDs set in .env.
   *
   * Uses `<#id>` markup (renders as a channel link, never pings). Channels are
   * never hardcoded — unset values are simply omitted. Rules are shown inline
   * (see WELCOME_RULES / discord_rules.txt), not as a channel link.
   */
  welcomeChannelLinks() {
    const cfg = this.mod_config;
    const entries = [
      ["💬 Чат", cfg.discord_chat_channel_id],
      ["🤝 Пошук команди", cfg.discord_lft_channel_id],
    ];
    return entries
      .filter(([, channelId]) => channelId)
      .map(([label, channelId]) => `${label}: <#${channelId}>`)
      .join("\n");
  }

  // ----- message moderation ----- //

  async moderate(message) {
    const { PermissionFlagsBits } = this.discord;
    // Ignore bots, webhooks, DMs, and our own messages.
    if (message.author?.bot || message.webhookId || !message.guild) {
      return;
    }

    const author = message.member;
    // Trusted members (those who can manage messages) bypass content filters.
    const isTrusted = Boolean(author?.permissions?.has(PermissionFlagsBits.ManageMessages));
    if (isTrusted) {
      return;
    }

    const content = message.content || "";

    if (this.hasBlockedInvite(content)) {
      await this.punish(message, {
        action: "Invite link removed",
        reason: "Unauthorized Discord invite link",
        timeoutSeconds: 0,
      });
      return;
    }

    const scamReason = suspiciousReason(content);
    if (scamReason) {
      await this.punish(message, { action: "Suspicious link removed", reason: scamReason, timeoutSeconds: 0 });
      return;
    }

    if (hasBadWord(content)) {
      await this.punish(message, {
        action: "Message removed (blocked word)",
        reason: "Blocked word filter",
        timeoutSeconds: 0,
      });
      return;
    }

    if (this.registerAndCheckSpam(message)) {
      await this.punish(message, {
        action: "Anti-spam",
        reason: `More than ${SPAM_MAX_MESSAGES} messages within ${SPAM_WINDOW_SECONDS.toFixed(0)}s`,
        timeoutSeconds: SPAM_TIMEOUT_SECONDS,
      });
    }
  }

  hasBlockedInvite(content) {
    const allowed = this.mod_config.discord_allowed_invites;
    INVITE_RE.lastIndex = 0;
    for (const match of String(content).matchAll(INVITE_RE)) {
      const code = match[1].toLowerCase();
      if (!allowed.has(code)) {
        return true; // at least one non-allowlisted invite -> block
      }
    }
    // No invites, or every invite found was on the allowlist.
    return false;
  }

  registerAndCheckSpam(message) {
    const key = `${message.channel.id}:${message.author.id}`;
    const now = performance.now() / 1000;
    let bucket = this._spamTracker.get(key);
    if (bucket === undefined) {
      bucket = [];
      this._spamTracker.set(key, bucket);
    }
    bucket.push(now);
    while (bucket.length && now - bucket[0] > SPAM_WINDOW_SECONDS) {
      bucket.shift();
    }
    if (bucket.length > SPAM_MAX_MESSAGES) {
      bucket.length = 0; // reset so we act once, not on every later message
      return true;
    }
    return false;
  }

  // ----- enforcement helpers ----- //

  async punish(message, { action, reason, timeoutSeconds }) {
    const channel = message.channel;
    const deleted = await this.safeDelete(message);

    if (timeoutSeconds > 0 && message.member) {
      await this.safeTimeout(message.member, timeoutSeconds, reason);
    }

    await this.sendModLog({
      action: deleted ? action : `${action} (delete failed — missing permission?)`,
      member: message.author,
      channel,
      reason,
      preview: message.content,
    });
  }

  async safeDelete(message) {
    const { PermissionFlagsBits } = this.discord;
    const channel = message.channel;
    const me = message.guild.members.me;
    if (!channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages)) {
      logger.warning(`Missing 'Manage Messages' in #${channel.name}; cannot delete flagged message.`);
      return false;
    }
    try {
      await message.delete();
      return true;
    } catch (error) {
      if (error?.code === 10008) {
        return true; // already gone
      }
      if (error?.code === 50013) {
        logger.warning(`Forbidden to delete message in #${channel.name}.`);
        return false;
      }
      logger.exception(`Failed to delete message in #${channel.name}.`, error);
      return false;
    }
  }

  async safeTimeout(member, seconds, reason) {
    const { PermissionFlagsBits } = this.discord;
    const guild = member.guild;
    const me = guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      logger.warning(`Missing 'Moderate Members'; cannot timeout user ${member.id}.`);
      return false;
    }
    if (member.id === guild.ownerId || member.roles.highest.comparePositionTo(me.roles.highest) >= 0) {
      logger.warning(`Cannot timeout user ${member.id} due to role hierarchy / ownership.`);
      return false;
    }
    try {
      await member.timeout(seconds * 1000, reason);
      return true;
    } catch (error) {
      if (error?.code === 50013) {
        logger.warning(`Forbidden to timeout user ${member.id}.`);
        return false;
      }
      logger.exception(`Failed to timeout user ${member.id}.`, error);
      return false;
    }
  }

  // ----- mod log ----- //

  async resolveChannel(channelId) {
    let channel = this.client.channels.cache.get(String(channelId)) ?? null;
    if (channel === null) {
      try {
        channel = await this.client.channels.fetch(String(channelId));
      } catch {
        channel = null;
      }
    }
    return channel;
  }

  /**
   * Resolve the configured mod-log channel, or warn once and return null.
   *
   * Shared by every logging path (moderation actions, reports, auto-actions) so
   * channel resolution and permission checks live in one place.
   */
  async getLogChannel() {
    const { PermissionFlagsBits } = this.discord;
    const channelId = this.mod_config.discord_mod_log_channel_id;
    if (!channelId) {
      this.warnModLogOnce(
        "DISCORD_MOD_LOG_CHANNEL_ID is not set; Discord moderation actions are not logged to a channel.",
      );
      return null;
    }

    const logChannel = await this.resolveChannel(channelId);
    if (logChannel === null) {
      this.warnModLogOnce(`Mod-log channel ${channelId} is missing or inaccessible.`);
      return null;
    }

    const perms = logChannel.permissionsFor(logChannel.guild.members.me);
    if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks)) {
      this.warnModLogOnce(`Missing 'Send Messages' / 'Embed Links' in mod-log channel ${channelId}.`);
      return null;
    }
    return logChannel;
  }

  async sendLogEmbed(embed) {
    const logChannel = await this.getLogChannel();
    if (logChannel === null) {
      return;
    }
    try {
      // allowedMentions none so the log itself never pings anyone.
      await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      logger.exception("Failed to send Discord mod-log message.", error);
    }
  }

  async sendModLog({ action, member, channel, reason, preview = null }) {
    const { EmbedBuilder } = this.discord;
    const embed = new EmbedBuilder()
      .setTitle(`🛡️ ${action}`)
      .setColor(0xe67e22) // orange
      .setTimestamp(new Date());
    embed.addFields({ name: "User", value: `${member} (\`${member.id}\`)`, inline: false });
    embed.addFields({
      name: "Channel",
      value: channel ? (channel.toString?.() ?? String(channel)) : "—",
      inline: true,
    });
    embed.addFields({ name: "Reason", value: sliceChars(reason || "—", 0, 1024), inline: true });
    if (preview) {
      // Truncate before escaping, so a cut cannot strand the backslash of an
      // escape sequence at the end of the preview.
      const safe = escapeMarkdown(sliceChars(preview, 0, 200));
      if (safe) {
        embed.addFields({ name: "Message preview", value: safe, inline: false });
      }
    }
    await this.sendLogEmbed(embed);
  }

  async sendReportLog({ reporter, reported, channel, reason }) {
    const { EmbedBuilder } = this.discord;
    const embed = new EmbedBuilder()
      .setTitle("🚩 Report")
      .setColor(0xed4245) // red
      .setTimestamp(new Date());
    embed.addFields({ name: "Reporter", value: `${reporter} (\`${reporter.id}\`)`, inline: false });
    embed.addFields({ name: "Reported member", value: `${reported} (\`${reported.id}\`)`, inline: false });
    embed.addFields({
      name: "Channel",
      value: channel ? (channel.toString?.() ?? String(channel)) : "—",
      inline: true,
    });
    embed.addFields({ name: "Reason", value: sliceChars(reason || "—", 0, 1024), inline: false });
    await this.sendLogEmbed(embed);
  }

  /** Auto-act on the active warning count. Never bans/kicks; never hits staff. */
  async applyWarningAutoactions({ member, channel, count }) {
    if (isStaff(member, this.discord)) {
      return; // never auto-punish moderators / admins / the owner
    }

    const timeoutSeconds = WARN_TIMEOUT_THRESHOLDS.get(count);
    if (timeoutSeconds) {
      const minutes = Math.floor(timeoutSeconds / 60);
      const ok = await this.safeTimeout(member, timeoutSeconds, `Авто-дія: ${count} попереджень`);
      if (ok) {
        await this.sendModLog({
          action: `Auto-timeout (${count} warnings)`,
          member,
          channel,
          reason: `${minutes}-minute timeout after reaching ${count} warnings`,
        });
      } else {
        // Could not time out (missing permission / role hierarchy / owner).
        await this.sendModLog({
          action: "Auto-timeout skipped — please review manually",
          member,
          channel,
          reason:
            `Reached ${count} warnings (wanted a ${minutes}-minute timeout) but I could not apply it ` +
            "— check my 'Moderate Members' permission and role position.",
        });
      }
    }

    if (count === WARN_ESCALATION_THRESHOLD) {
      await this.sendModLog({
        action: "⚠️ Manual review needed",
        member,
        channel,
        reason:
          `${member.user?.tag ?? member} reached ${count} warnings. Please review manually — ` +
          "no automatic ban/kick is ever performed.",
      });
    }
  }

  warnModLogOnce(message) {
    if (!this._modLogWarned) {
      logger.warning(message);
      this._modLogWarned = true;
    }
  }

  /** Light anti-abuse for /report: 3 reports per minute per user. */
  reportAllowed(userId) {
    const now = performance.now() / 1000;
    let bucket = this._reportCooldowns.get(userId);
    if (bucket === undefined) {
      bucket = [];
      this._reportCooldowns.set(userId, bucket);
    }
    while (bucket.length && now - bucket[0] > 60.0) {
      bucket.shift();
    }
    if (bucket.length >= 3) {
      return false;
    }
    bucket.push(now);
    return true;
  }

  // ----- slash command error handler ----- //

  async onAppCommandError(interaction, error) {
    logger.warning(`Slash command error: ${error?.name ?? "Error"}`);
    const message = "Щось пішло не так під час виконання команди.";
    try {
      const { MessageFlags } = this.discord;
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    } catch {
      // The interaction token expired; nothing more to do.
    }
  }
}

/** True for members the bot must never auto-punish (mods / admins / owner). */
function isStaff(member, discord) {
  const { PermissionFlagsBits } = discord;
  const perms = member?.permissions;
  if (!perms) {
    return false;
  }
  return (
    perms.has(PermissionFlagsBits.Administrator) ||
    perms.has(PermissionFlagsBits.ManageMessages) ||
    perms.has(PermissionFlagsBits.ModerateMembers)
  );
}

// --------------------------------------------------------------------------- //
// Slash commands
// --------------------------------------------------------------------------- //
// NOTE: slash commands require the bot to be invited with the
// `applications.commands` OAuth2 scope (in addition to `bot`). See module
// docstring. `setDefaultMemberPermissions(...)` hides each command from members
// who lack the relevant permission, and we re-check at runtime for safety.

function buildCommandDefinitions(discord) {
  const { SlashCommandBuilder, PermissionFlagsBits } = discord;
  return [
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("Показати список доступних команд модерації.")
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder()
      .setName("clear")
      .setDescription("Видалити кілька останніх повідомлень у цьому каналі.")
      .addIntegerOption((option) =>
        option
          .setName("amount")
          .setDescription("Скільки повідомлень видалити (1–100).")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(100),
      )
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder()
      .setName("timeout")
      .setDescription("Видати учаснику тайм-аут на задану кількість хвилин.")
      .addUserOption((option) =>
        option.setName("user").setDescription("Учасник, якому видати тайм-аут.").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("minutes")
          .setDescription("Тривалість у хвилинах (1–40320 = 28 днів).")
          .setRequired(true)
          .setMinValue(1)
          .setMaxValue(MAX_TIMEOUT_MINUTES),
      )
      .addStringOption((option) => option.setName("reason").setDescription("Причина тайм-ауту."))
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder()
      .setName("warn")
      .setDescription("Попередити учасника (з логом у мод-канал і повідомленням в особисті, якщо можливо).")
      .addUserOption((option) => option.setName("user").setDescription("Учасник, якого попередити.").setRequired(true))
      .addStringOption((option) =>
        option.setName("reason").setDescription("Причина попередження.").setRequired(true),
      )
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder()
      .setName("report")
      .setDescription("Поскаржитися модерації на учасника.")
      .addUserOption((option) =>
        option.setName("member").setDescription("Учасник, на якого скаржишся.").setRequired(true),
      )
      .addStringOption((option) =>
        option.setName("reason").setDescription("Що сталося / причина скарги.").setRequired(true),
      )
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName("lfthelp")
      .setDescription("Як знайти тіммейтів в Aniimo: інструкція та шаблон поста.")
      .setDMPermission(false),
    new SlashCommandBuilder()
      .setName("warnings")
      .setDescription("Показати історію попереджень учасника.")
      .addUserOption((option) =>
        option.setName("member").setDescription("Учасник, чиї попередження показати.").setRequired(true),
      )
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
    new SlashCommandBuilder()
      .setName("clearwarnings")
      .setDescription("Очистити всі попередження учасника.")
      .addUserOption((option) =>
        option.setName("member").setDescription("Учасник, чиї попередження очистити.").setRequired(true),
      )
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  ];
}

async function handleCommand(bot, interaction) {
  switch (interaction.commandName) {
    case "help":
      return helpCommand(bot, interaction);
    case "clear":
      return clearCommand(bot, interaction);
    case "timeout":
      return timeoutCommand(bot, interaction);
    case "warn":
      return warnCommand(bot, interaction);
    case "report":
      return reportCommand(bot, interaction);
    case "lfthelp":
      return lftHelpCommand(bot, interaction);
    case "warnings":
      return warningsCommand(bot, interaction);
    case "clearwarnings":
      return clearWarningsCommand(bot, interaction);
    default:
      return undefined;
  }
}

function ephemeral(discord) {
  return { flags: discord.MessageFlags.Ephemeral };
}

async function helpCommand(bot, interaction) {
  const { EmbedBuilder, PermissionFlagsBits } = bot.discord;
  // "Server administration only": anyone who can run a moderation command.
  // Administrator / owner implicitly hold both of these permissions.
  const perms = interaction.member?.permissions;
  if (
    !perms?.has(PermissionFlagsBits.ManageMessages) &&
    !perms?.has(PermissionFlagsBits.ModerateMembers)
  ) {
    await interaction.reply({ content: "Ця команда доступна лише модерації сервера.", ...ephemeral(bot.discord) });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("🛡️ Команди модерації — Aniimo UA")
    .setDescription("Доступно лише модерації сервера. Цей список бачиш лише ти.")
    .setColor(0x5865f2);
  embed.addFields(
    { name: "/help", value: "Показати цей список команд модерації.", inline: false },
    {
      name: "/clear <кількість>",
      value:
        "Видалити від 1 до 100 останніх повідомлень у поточному каналі.\n" +
        "Потрібен дозвіл: **Manage Messages** (Керування повідомленнями).",
      inline: false,
    },
    {
      name: "/timeout <учасник> <хвилини> [причина]",
      value:
        "Тимчасово обмежити учаснику можливість писати (тайм-аут) на 1–40320 хв (до 28 днів).\n" +
        "Потрібен дозвіл: **Moderate Members** (Тайм-аут учасників).",
      inline: false,
    },
    {
      name: "/warn <учасник> <причина>",
      value:
        "Винести попередження учаснику (зберігається в історію). Дію записано в канал " +
        "мод-логів і надіслано учаснику в особисті повідомлення, якщо це можливо.\n" +
        "Потрібен дозвіл: **Moderate Members** (Тайм-аут учасників).",
      inline: false,
    },
    {
      name: "/warnings <учасник>",
      value: "Показати історію попереджень учасника.\nПотрібен дозвіл: **Moderate Members** (Тайм-аут учасників).",
      inline: false,
    },
    {
      name: "/clearwarnings <учасник>",
      value: "Очистити всі попередження учасника.\nПотрібен дозвіл: **Moderate Members** (Тайм-аут учасників).",
      inline: false,
    },
    {
      name: "/report <учасник> <причина> — для всіх",
      value:
        "Будь-який учасник може поскаржитися на іншого; скарга надходить у канал " +
        "мод-логів. Відповідь бачить лише той, хто скаржиться.",
      inline: false,
    },
    {
      name: "/lfthelp — для всіх",
      value:
        "Показати інструкцію та шаблон поста для форуму пошуку тіммейтів. " +
        "Відповідь бачить лише той, хто викликав команду.",
      inline: false,
    },
  );

  const warnRules = sortedNumbers([...WARN_TIMEOUT_THRESHOLDS.keys()])
    .map((count) => `${count} → тайм-аут ${Math.floor(WARN_TIMEOUT_THRESHOLDS.get(count) / 60)} хв`)
    .join(", ");
  embed.addFields({
    name: "ℹ️ Автоматична модерація (працює без команд)",
    value:
      `• Антиспам: понад ${SPAM_MAX_MESSAGES} повідомлень за ~${SPAM_WINDOW_SECONDS.toFixed(0)} с ` +
      `→ видалення + тайм-аут ${SPAM_TIMEOUT_SECONDS} с.\n` +
      "• Фільтр запрошень Discord (окрім дозволених у білому списку).\n" +
      "• Фільтр підозрілих / шахрайських посилань.\n" +
      "• Фільтр заборонених слів.\n" +
      `• Авто-дії за попередженнями: ${warnRules}, ` +
      `${WARN_ESCALATION_THRESHOLD} → сигнал модерації для ручного розгляду. ` +
      "Бот ніколи не банить і не кікає автоматично; модераторів авто-дії не торкаються.\n" +
      "Учасники з дозволом **Manage Messages** не підпадають під фільтри контенту.",
    inline: false,
  });
  if (bot.mod_config.discord_welcome_channel_id) {
    embed.addFields({
      name: "👋 Привітання нових учасників",
      value: "Увімкнено: нові учасники отримують вітальне повідомлення у вітальному каналі.",
      inline: false,
    });
  }
  await interaction.reply({ embeds: [embed], ...ephemeral(bot.discord) });
}

async function clearCommand(bot, interaction) {
  const { PermissionFlagsBits } = bot.discord;
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({
      content: "Тобі потрібен дозвіл **Manage Messages** (Керування повідомленнями).",
      ...ephemeral(bot.discord),
    });
    return;
  }
  const me = interaction.guild.members.me;
  const perms = interaction.channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ManageMessages) || !perms?.has(PermissionFlagsBits.ReadMessageHistory)) {
    await interaction.reply({
      content: "Мені потрібні дозволи **Manage Messages** і **Read Message History** у цьому каналі.",
      ...ephemeral(bot.discord),
    });
    return;
  }

  const amount = interaction.options.getInteger("amount");
  await interaction.deferReply(ephemeral(bot.discord));
  let deleted;
  try {
    deleted = await interaction.channel.bulkDelete(amount, true);
  } catch (error) {
    if (error?.code === 50013) {
      await interaction.followUp({ content: "Мені не дозволено видаляти повідомлення тут.", ...ephemeral(bot.discord) });
      return;
    }
    logger.exception(`/clear failed in #${interaction.channel?.name}`, error);
    await interaction.followUp({
      content: "Не вдалося видалити повідомлення (помилка Discord).",
      ...ephemeral(bot.discord),
    });
    return;
  }

  await interaction.followUp({ content: `Видалено повідомлень: ${deleted.size}.`, ...ephemeral(bot.discord) });
  await bot.sendModLog({
    action: "/clear",
    member: interaction.user,
    channel: interaction.channel,
    reason: `Cleared ${deleted.size} message(s)`,
  });
}

async function timeoutCommand(bot, interaction) {
  const { PermissionFlagsBits } = bot.discord;
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: "Тобі потрібен дозвіл **Moderate Members** (Тайм-аут учасників).",
      ...ephemeral(bot.discord),
    });
    return;
  }

  const user = interaction.options.getMember("user");
  const minutes = interaction.options.getInteger("minutes");
  const reason = interaction.options.getString("reason") ?? "Причину не вказано";

  await interaction.deferReply(ephemeral(bot.discord));
  const ok = user ? await bot.safeTimeout(user, minutes * 60, reason) : false;
  if (!ok) {
    await interaction.followUp({
      content:
        "Не вдалося видати тайм-аут цьому учаснику. Перевір мій дозвіл **Moderate Members** і що моя " +
        "роль вища за роль учасника (власника сервера заглушити не можна).",
      ...ephemeral(bot.discord),
    });
    return;
  }

  await interaction.followUp({ content: `Видано тайм-аут ${user} на ${minutes} хв.`, ...ephemeral(bot.discord) });
  await bot.sendModLog({
    action: "/timeout",
    member: user,
    channel: interaction.channel,
    reason: `${minutes} min — ${reason}`,
  });
}

async function warnCommand(bot, interaction) {
  const { PermissionFlagsBits } = bot.discord;
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: "Тобі потрібен дозвіл **Moderate Members** (Тайм-аут учасників).",
      ...ephemeral(bot.discord),
    });
    return;
  }

  const user = interaction.options.getMember("user");
  const reason = interaction.options.getString("reason");

  // Persist first so /warnings reflects it and auto-actions can count it.
  let activeCount = null;
  try {
    activeCount = await bot.warningStore.add({
      guild_id: interaction.guild.id,
      user_id: user.id,
      moderator_id: interaction.user.id,
      reason,
    });
  } catch (error) {
    logger.exception("Failed to persist a Discord warning; continuing without history.", error);
  }

  let dmSent = false;
  try {
    await user.send(`⚠️ Тобі винесли попередження на сервері **${interaction.guild.name}**: ${reason}`);
    dmSent = true;
  } catch {
    dmSent = false; // DMs closed or blocked; not an error.
  }

  const totalNote = activeCount !== null ? ` Усього активних попереджень: ${activeCount}.` : "";
  await interaction.reply({
    content:
      `Винесено попередження ${user}.` +
      (dmSent ? " (повідомлення в особисті надіслано)" : " (не вдалося написати в особисті)") +
      totalNote,
    ...ephemeral(bot.discord),
  });
  await bot.sendModLog({ action: "/warn", member: user, channel: interaction.channel, reason });
  if (activeCount !== null) {
    await bot.applyWarningAutoactions({ member: user, channel: interaction.channel, count: activeCount });
  }
}

async function reportCommand(bot, interaction) {
  const member = interaction.options.getMember("member") ?? interaction.options.getUser("member");
  const reason = interaction.options.getString("reason");
  if (member.id === interaction.user.id) {
    await interaction.reply({ content: "Не можна поскаржитися на самого себе.", ...ephemeral(bot.discord) });
    return;
  }
  if (member.user?.bot ?? member.bot) {
    await interaction.reply({ content: "Не можна поскаржитися на бота.", ...ephemeral(bot.discord) });
    return;
  }
  if (!bot.reportAllowed(interaction.user.id)) {
    await interaction.reply({ content: "Команда на перезарядці, спробуй за мить.", ...ephemeral(bot.discord) });
    return;
  }

  await bot.sendReportLog({
    reporter: interaction.user,
    reported: member,
    channel: interaction.channel,
    reason,
  });
  await interaction.reply({ content: "Дякуємо, репорт надіслано модерації.", ...ephemeral(bot.discord) });
}

async function lftHelpCommand(bot, interaction) {
  const { EmbedBuilder } = bot.discord;
  // Available to everyone; the reply is ephemeral so it never spams a channel.
  const lftChannelId = bot.mod_config.discord_lft_channel_id;
  const forumRef = lftChannelId ? `<#${lftChannelId}>` : "форумі пошуку тіммейтів";
  const embed = new EmbedBuilder()
    .setTitle("🤝 Пошук тіммейтів — як це працює")
    .setDescription(
      `Шукай команду у ${forumRef} — один пост = один пошук.\n` +
        "1. Натисни **New Post / Новий пост**.\n" +
        "2. У назві коротко вкажи головне — режим, платформу, роль. " +
        "Напр.: `Рейд на PC, шукаю Підтримку`.\n" +
        "3. Обери теги: платформу, режим і роль.\n" +
        "4. Скопіюй шаблон нижче у свій пост і заповни 👇",
    )
    .setColor(0x57f287); // green
  embed.addFields({
    name: "Шаблон поста",
    value:
      "```\n" +
      "**Платформа:** PC / PlayStation / Mobile\n" +
      "**Режим:** Кооп / PvP / Рейд\n" +
      "**Рівень:**\n" +
      "**Роль:** DPS / Break (пробиття) / Підтримка\n" +
      "**Час гри:** напр., 19:00–23:00 за Києвом\n" +
      "**Коментар:** вік, войс, кілька слів про себе\n" +
      "```",
    inline: false,
  });
  embed.addFields({
    name: "Поради",
    value:
      "• Один активний пост на людину. Знайшов команду — напиши про це в пості й закрий його 🔒\n" +
      "• Хочеш відгукнутися на чийсь пост? Просто напиши в ньому.\n" +
      "• Будь привітним — з токсиками грати ніхто не хоче 😉\n" +
      "• Бачиш порушення — скористайся командою `/report`.",
    inline: false,
  });
  await interaction.reply({ embeds: [embed], ...ephemeral(bot.discord) });
}

async function warningsCommand(bot, interaction) {
  const { EmbedBuilder, PermissionFlagsBits } = bot.discord;
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: "Тобі потрібен дозвіл **Moderate Members** (Тайм-аут учасників).",
      ...ephemeral(bot.discord),
    });
    return;
  }

  const member = interaction.options.getMember("member") ?? interaction.options.getUser("member");
  let records;
  try {
    records = await bot.warningStore.list({ guild_id: interaction.guild.id, user_id: member.id });
  } catch (error) {
    logger.exception("Failed to read Discord warnings.", error);
    await interaction.reply({ content: "Не вдалося прочитати історію попереджень.", ...ephemeral(bot.discord) });
    return;
  }

  if (!records.length) {
    await interaction.reply({
      content: `У ${member} немає активних попереджень.`,
      allowedMentions: { parse: [] },
      ...ephemeral(bot.discord),
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(`Попередження — ${member.displayName ?? member.username}`)
    .setDescription(`${member} • усього активних: ${records.length}`)
    .setColor(0xe67e22);
  // Embeds allow 25 fields; show the 20 most recent and note if truncated.
  const recent = records.slice(-20);
  recent.forEach((record, offset) => {
    const position = records.length - recent.length + 1 + offset;
    const when = formatWarnTimestamp(record.created_at);
    const moderator = `<@${record.moderator_id}>`;
    const reasonText = sliceChars(record.reason || "—", 0, 300);
    embed.addFields({
      name: `#${position} • ${when}`,
      value: `Модератор: ${moderator}\nПричина: ${reasonText}`,
      inline: false,
    });
  });
  if (records.length > recent.length) {
    embed.setFooter({ text: `Показано останні ${recent.length} із ${records.length}.` });
  }

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] }, ...ephemeral(bot.discord) });
}

async function clearWarningsCommand(bot, interaction) {
  const { PermissionFlagsBits } = bot.discord;
  if (!interaction.member?.permissions?.has(PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply({
      content: "Тобі потрібен дозвіл **Moderate Members** (Тайм-аут учасників).",
      ...ephemeral(bot.discord),
    });
    return;
  }

  const member = interaction.options.getMember("member") ?? interaction.options.getUser("member");
  let removed;
  try {
    removed = await bot.warningStore.clear({ guild_id: interaction.guild.id, user_id: member.id });
  } catch (error) {
    logger.exception("Failed to clear Discord warnings.", error);
    await interaction.reply({ content: "Не вдалося очистити попередження.", ...ephemeral(bot.discord) });
    return;
  }

  await interaction.reply({
    content: `Очищено попереджень для ${member}: ${removed}.`,
    allowedMentions: { parse: [] },
    ...ephemeral(bot.discord),
  });
  await bot.sendModLog({
    action: "/clearwarnings",
    member,
    channel: interaction.channel,
    reason: `Cleared ${removed} warning(s) by ${interaction.user.tag} (${interaction.user.id})`,
  });
}
