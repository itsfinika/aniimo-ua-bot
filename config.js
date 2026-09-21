import process from "node:process";

import dotenv from "dotenv";

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

// Compared against gemini-2.5-flash and gemini-3.5-flash on real articles, social
// posts and wiki entries: 3.6 produced the most natural Ukrainian (2.5 tended to
// translate proper names that must stay English), fit noticeably more of a patch
// note into the same character budget, and was the fastest of the three.
export const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";
// How often every source is polled. A full tick over all sources costs about two
// seconds when nothing is new, so the interval is set by how stale a post may be,
// not by cost: at 30 minutes a big announcement reached the queue up to half an
// hour late, which loses the race to other channels.
export const DEFAULT_NEWS_CHECK_INTERVAL_MINUTES = 5;
// The official English channel (@Aniimo_EN). The Japanese channel is a separate
// upload stream and is deliberately not used.
export const DEFAULT_YOUTUBE_CHANNEL_ID = "UC2YdJw53sP73T-lffzrqTZA";
// Title keywords (lowercased) that mark a YouTube upload as noise to skip, matched
// as a case-insensitive substring. Empty by default: the official channel carries
// no esports-VOD stream to filter out, but the mechanism stays for when it does.
export const DEFAULT_YOUTUBE_EXCLUDE_KEYWORDS = Object.freeze([]);

// The rumour source wants a LEAKS community, not the general subreddit: r/Aniimo
// has no leak/datamine flair at all (probed 21 Sep 2026 — its flairs are News,
// Discussion, Question, Guide, Meme, Screenshot, Video, Media), and its "News"
// posts are reposts of official announcements, which this collector would wrongly
// frame as чутки. r/AniimoLeaks exists but was still empty at launch, so its flair
// names are a guess to be checked with REDDIT_FLAIRS once it has posts.
export const DEFAULT_REDDIT_SUBREDDIT = "AniimoLeaks";
// Flairs routed via search.rss (entries carry no flair text, so the query IS the
// filter); combined with OR in one request.
export const DEFAULT_REDDIT_FLAIRS = Object.freeze(["Leak", "Datamine", "Reliable", "Confirmed"]);
// Recurring discussion/sticky threads to skip — matched as a case-insensitive
// substring of the title.
export const DEFAULT_REDDIT_EXCLUDE_KEYWORDS = Object.freeze(["megathread"]);

// The site's JSON API behind www.aniimo.com/newslist; the human-facing page URL
// (OFFICIAL_NEWS_URL) is what a published post links to.
export const DEFAULT_OFFICIAL_NEWS_API_URL = "https://worldx-office-api.aniimo.com";
export const DEFAULT_OFFICIAL_NEWS_REGION = "en";

// Steam's own "Community Announcements" feed for the app: every item is an
// official post, so it counts as an official source alongside the site.
export const DEFAULT_STEAM_FEED_URL = "https://store.steampowered.com/feeds/news/app/4126040/";

export const DEFAULT_ANIIMOTOOLS_FEED_URL = "https://aniimotools.dev/articles/rss.xml";

export const DEFAULT_WIKI_ANIIMO_API_URL = "https://wiki-backend.aniimo.com";
export const DEFAULT_WIKI_ANIIMO_SITE_URL = "https://wiki.aniimo.com/en";
// Monday (Mon=0 .. Sun=6) at 12:00 local time (ARTICLE_TIMEZONE).
export const DEFAULT_WIKI_ANIIMO_WEEKDAY = 0;
export const DEFAULT_WIKI_ANIIMO_HOUR = 12;

// r/Aniimo has no fan-art flair (see the probe note above); "Media" is where the
// community posts its screenshots and catches, so the weekly album is a
// "best shots of the week" round-up rather than a fan-art one.
export const DEFAULT_FANART_SUBREDDIT = "Aniimo";
export const DEFAULT_FANART_FLAIR = "Media";
// Friday (Mon=0 .. Sun=6) at 18:00 local time (ARTICLE_TIMEZONE).
export const DEFAULT_FANART_DIGEST_WEEKDAY = 4;
// Monday morning: the report covers the week that just ended, and lands before
// anyone decides what to do with the week ahead.
export const DEFAULT_WEEKLY_REPORT_WEEKDAY = 0;
export const DEFAULT_WEEKLY_REPORT_HOUR = 11;
export const DEFAULT_FANART_DIGEST_HOUR = 18;
// Telegram media groups allow at most 10 items.
export const DEFAULT_FANART_DIGEST_COUNT = 10;

const DEFAULT_OFFICIAL_NEWS_URL = "https://www.aniimo.com/newslist";
const DEFAULT_ARTICLE_TIMEZONE = "Europe/Kyiv";
// Aniimo has no official Bluesky account. With the actor empty the registry keeps
// the source off even when ENABLE_BLUESKY_SOURCE is on, so nothing can be polled
// until someone sets BLUESKY_ACTOR explicitly.
const DEFAULT_BLUESKY_ACTOR = "";
const DEFAULT_DATABASE_PATH = "bot.db";

/**
 * Read every runtime setting from the environment.
 *
 * Two parsing disciplines are deliberately mixed and must not be levelled out:
 * the four required values raise {@link ConfigError} (the bot cannot run without
 * them), while every optional block — Discord, Telegram moderation, backups,
 * dedup and each news source — is parsed LENIENTLY, so one typo in an optional
 * secret can never stop the whole bot from starting.
 */
export function loadConfig(env = process.env) {
  dotenv.config({ quiet: true });

  const botToken = required(env, "BOT_TOKEN");
  const adminChatId = requiredInt(env, "ADMIN_CHAT_ID");
  const publishChatId = requiredInt(env, "PUBLISH_CHAT_ID");
  const adminUserIds = parseAdminUserIds(required(env, "ADMIN_USER_IDS"));
  const databasePath = (env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH).trim() || DEFAULT_DATABASE_PATH;
  const submissionCooldownSeconds = optionalNonNegativeInt(env, "SUBMISSION_COOLDOWN_SECONDS", 120);
  const minSubmissionTextWords = optionalNonNegativeInt(env, "MIN_SUBMISSION_TEXT_WORDS", 3);
  const minSubmissionTextChars = optionalNonNegativeInt(env, "MIN_SUBMISSION_TEXT_CHARS", 10);
  const geminiApiKey = (env.GEMINI_API_KEY ?? "").trim() || null;
  const geminiModel = (env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL).trim() || DEFAULT_GEMINI_MODEL;
  const officialNewsUrl =
    (env.OFFICIAL_NEWS_URL ?? DEFAULT_OFFICIAL_NEWS_URL).trim() || DEFAULT_OFFICIAL_NEWS_URL;
  const officialNewsApiUrl =
    (env.OFFICIAL_NEWS_API_URL ?? DEFAULT_OFFICIAL_NEWS_API_URL).trim() || DEFAULT_OFFICIAL_NEWS_API_URL;
  const officialNewsRegion =
    (env.OFFICIAL_NEWS_REGION ?? DEFAULT_OFFICIAL_NEWS_REGION).trim() || DEFAULT_OFFICIAL_NEWS_REGION;
  const newsCheckIntervalMinutes = optionalPositiveIntOrNull(
    env,
    "NEWS_CHECK_INTERVAL_MINUTES",
    DEFAULT_NEWS_CHECK_INTERVAL_MINUTES,
  );
  const articleTimezone = (env.ARTICLE_TIMEZONE ?? DEFAULT_ARTICLE_TIMEZONE).trim() || DEFAULT_ARTICLE_TIMEZONE;

  // Discord values are parsed leniently: a misconfigured Discord setting must never
  // raise ConfigError, because that would also stop the Telegram bot from starting.
  const enableDiscordModeration = optionalBool(env, "ENABLE_DISCORD_MODERATION", false);
  const discordBotToken = (env.DISCORD_BOT_TOKEN ?? "").trim() || null;
  const discordModLogChannelId = optionalIntOrNull(env, "DISCORD_MOD_LOG_CHANNEL_ID");
  const discordAllowedInvites = parseInviteAllowlist(env, "DISCORD_ALLOWED_INVITES");
  const discordGuildId = optionalIntOrNull(env, "DISCORD_GUILD_ID");
  const discordWelcomeChannelId = optionalIntOrNull(env, "DISCORD_WELCOME_CHANNEL_ID");
  const discordChatChannelId = optionalIntOrNull(env, "DISCORD_CHAT_CHANNEL_ID");
  const discordLftChannelId = optionalIntOrNull(env, "DISCORD_LFT_CHANNEL_ID");

  // Telegram moderation values are parsed leniently for the same reason as Discord:
  // a misconfigured moderation setting must never stop the whole bot from starting.
  const enableTelegramModeration = optionalBool(env, "ENABLE_TELEGRAM_MODERATION", false);
  const telegramModerationChatIds = parseIntIdSet(env, "TELEGRAM_MODERATION_CHAT_IDS");
  const telegramModLogChatId = optionalIntOrNull(env, "TELEGRAM_MOD_LOG_CHAT_ID");
  // The link allowlist reuses the invite parser: it strips full URLs down to the
  // trailing code and lowercases it, so "https://t.me/AniimoUAChat" -> "aniimouachat".
  const telegramLinkAllowlist = parseInviteAllowlist(env, "TELEGRAM_LINK_ALLOWLIST");
  const telegramWelcomeDeleteSeconds = optionalLenientNonNegativeInt(env, "TELEGRAM_WELCOME_DELETE_SECONDS", 60);

  const enableDatabaseBackup = optionalBool(env, "ENABLE_DATABASE_BACKUP", true);
  const databaseBackupHour = optionalHour(env, "DATABASE_BACKUP_HOUR", 4);
  // `|| 14`: zero would mean "keep nothing", which can only be a mistake.
  const databaseBackupKeep = optionalLenientNonNegativeInt(env, "DATABASE_BACKUP_KEEP", 14) || 14;

  const enableCrossSourceDedup = optionalBool(env, "ENABLE_CROSS_SOURCE_DEDUP", true);
  const crossSourceDedupTitleLimit = optionalLenientNonNegativeInt(env, "CROSS_SOURCE_DEDUP_TITLE_LIMIT", 200);
  const moderationSendIntervalSeconds = optionalLenientNonNegativeInt(env, "MODERATION_SEND_INTERVAL_SECONDS", 5);

  const enableBlueskySource = optionalBool(env, "ENABLE_BLUESKY_SOURCE", false);
  const blueskyActor = (env.BLUESKY_ACTOR ?? DEFAULT_BLUESKY_ACTOR).trim() || DEFAULT_BLUESKY_ACTOR;
  const enableBlueskyVideoDownload = optionalBool(env, "ENABLE_BLUESKY_VIDEO_DOWNLOAD", true);
  const blueskyVideoMaxMb = optionalLenientNonNegativeInt(env, "BLUESKY_VIDEO_MAX_MB", 48) || 48;

  const enableYoutubeSource = optionalBool(env, "ENABLE_YOUTUBE_SOURCE", false);
  const youtubeChannelId = (env.YOUTUBE_CHANNEL_ID ?? DEFAULT_YOUTUBE_CHANNEL_ID).trim() || DEFAULT_YOUTUBE_CHANNEL_ID;
  const youtubeExcludeKeywords = parseKeywordSet(env, "YOUTUBE_EXCLUDE_KEYWORDS", DEFAULT_YOUTUBE_EXCLUDE_KEYWORDS);
  const enableYoutubeVideoDownload = optionalBool(env, "ENABLE_YOUTUBE_VIDEO_DOWNLOAD", true);
  const youtubeVideoMaxMb = optionalLenientNonNegativeInt(env, "YOUTUBE_VIDEO_MAX_MB", 48) || 48;
  // From a datacenter IP YouTube refuses a plain download ("Video is login
  // required") on every client; a Proof-of-Origin token is what reopens the
  // WEB/MWEB path. Minting one costs a BotGuard run per session, so it can be
  // turned off on a host that does not need it.
  const enableYoutubePoToken = optionalBool(env, "ENABLE_YOUTUBE_PO_TOKEN", true);
  // Last resort for an IP that YouTube blocks even with a token: the Cookie
  // header of a throwaway Google account. Empty means anonymous.
  const youtubeCookie = (env.YOUTUBE_COOKIE ?? "").trim();

  const enableRedditSource = optionalBool(env, "ENABLE_REDDIT_SOURCE", false);
  const redditSubreddit = (env.REDDIT_SUBREDDIT ?? DEFAULT_REDDIT_SUBREDDIT).trim() || DEFAULT_REDDIT_SUBREDDIT;
  const redditFlairs = parseFlairs(env, "REDDIT_FLAIRS", DEFAULT_REDDIT_FLAIRS);
  const redditExcludeKeywords = parseKeywordSet(env, "REDDIT_EXCLUDE_KEYWORDS", DEFAULT_REDDIT_EXCLUDE_KEYWORDS);

  const enableSteamSource = optionalBool(env, "ENABLE_STEAM_SOURCE", false);
  const steamFeedUrl = (env.STEAM_FEED_URL ?? DEFAULT_STEAM_FEED_URL).trim() || DEFAULT_STEAM_FEED_URL;

  const enableAniimotoolsSource = optionalBool(env, "ENABLE_ANIIMOTOOLS_SOURCE", false);
  const aniimotoolsFeedUrl =
    (env.ANIIMOTOOLS_FEED_URL ?? DEFAULT_ANIIMOTOOLS_FEED_URL).trim() || DEFAULT_ANIIMOTOOLS_FEED_URL;

  const enableWikiAniimo = optionalBool(env, "ENABLE_WIKI_ANIIMO", false);
  const wikiAniimoApiUrl =
    (env.WIKI_ANIIMO_API_URL ?? DEFAULT_WIKI_ANIIMO_API_URL).trim() || DEFAULT_WIKI_ANIIMO_API_URL;
  const wikiAniimoSiteUrl =
    (env.WIKI_ANIIMO_SITE_URL ?? DEFAULT_WIKI_ANIIMO_SITE_URL).trim() || DEFAULT_WIKI_ANIIMO_SITE_URL;
  const wikiAniimoWeekday = optionalWeekday(env, "WIKI_ANIIMO_WEEKDAY", DEFAULT_WIKI_ANIIMO_WEEKDAY);
  const wikiAniimoHour = optionalHour(env, "WIKI_ANIIMO_HOUR", DEFAULT_WIKI_ANIIMO_HOUR);

  const enableFanartDigest = optionalBool(env, "ENABLE_FANART_DIGEST", false);
  const fanartSubreddit = (env.FANART_SUBREDDIT ?? DEFAULT_FANART_SUBREDDIT).trim() || DEFAULT_FANART_SUBREDDIT;
  const fanartFlair = (env.FANART_FLAIR ?? DEFAULT_FANART_FLAIR).trim() || DEFAULT_FANART_FLAIR;
  const fanartDigestWeekday = optionalWeekday(env, "FANART_DIGEST_WEEKDAY", DEFAULT_FANART_DIGEST_WEEKDAY);
  const fanartDigestHour = optionalHour(env, "FANART_DIGEST_HOUR", DEFAULT_FANART_DIGEST_HOUR);
  // The weekly activity report goes to the admin chat only, costs one message a
  // week and no network calls beyond it, so it is on unless switched off.
  const enableWeeklyReport = optionalBool(env, "ENABLE_WEEKLY_REPORT", true);
  const weeklyReportWeekday = optionalWeekday(env, "WEEKLY_REPORT_WEEKDAY", DEFAULT_WEEKLY_REPORT_WEEKDAY);
  const weeklyReportHour = optionalHour(env, "WEEKLY_REPORT_HOUR", DEFAULT_WEEKLY_REPORT_HOUR);

  // Clamp the count to Telegram's media-group max of 10; 0/invalid keeps the default.
  const fanartDigestCount = Math.min(
    optionalLenientNonNegativeInt(env, "FANART_DIGEST_COUNT", DEFAULT_FANART_DIGEST_COUNT) ||
      DEFAULT_FANART_DIGEST_COUNT,
    10,
  );

  return Object.freeze({
    bot_token: botToken,
    admin_chat_id: adminChatId,
    publish_chat_id: publishChatId,
    admin_user_ids: adminUserIds,
    database_path: databasePath,
    submission_cooldown_seconds: submissionCooldownSeconds,
    min_submission_text_words: minSubmissionTextWords,
    min_submission_text_chars: minSubmissionTextChars,
    gemini_api_key: geminiApiKey,
    gemini_model: geminiModel,
    official_news_url: officialNewsUrl,
    official_news_api_url: officialNewsApiUrl,
    official_news_region: officialNewsRegion,
    news_check_interval_minutes: newsCheckIntervalMinutes,
    article_timezone: articleTimezone,
    enable_discord_moderation: enableDiscordModeration,
    discord_bot_token: discordBotToken,
    discord_mod_log_channel_id: discordModLogChannelId,
    discord_allowed_invites: discordAllowedInvites,
    discord_guild_id: discordGuildId,
    discord_welcome_channel_id: discordWelcomeChannelId,
    discord_chat_channel_id: discordChatChannelId,
    discord_lft_channel_id: discordLftChannelId,
    enable_telegram_moderation: enableTelegramModeration,
    telegram_moderation_chat_ids: telegramModerationChatIds,
    telegram_mod_log_chat_id: telegramModLogChatId,
    telegram_link_allowlist: telegramLinkAllowlist,
    telegram_welcome_delete_seconds: telegramWelcomeDeleteSeconds,
    enable_database_backup: enableDatabaseBackup,
    database_backup_hour: databaseBackupHour,
    database_backup_keep: databaseBackupKeep,
    enable_cross_source_dedup: enableCrossSourceDedup,
    cross_source_dedup_title_limit: crossSourceDedupTitleLimit,
    moderation_send_interval_seconds: moderationSendIntervalSeconds,
    enable_bluesky_source: enableBlueskySource,
    bluesky_actor: blueskyActor,
    enable_bluesky_video_download: enableBlueskyVideoDownload,
    bluesky_video_max_mb: blueskyVideoMaxMb,
    enable_youtube_source: enableYoutubeSource,
    youtube_channel_id: youtubeChannelId,
    youtube_exclude_keywords: youtubeExcludeKeywords,
    enable_youtube_video_download: enableYoutubeVideoDownload,
    youtube_video_max_mb: youtubeVideoMaxMb,
    enable_youtube_po_token: enableYoutubePoToken,
    youtube_cookie: youtubeCookie,
    enable_reddit_source: enableRedditSource,
    reddit_subreddit: redditSubreddit,
    reddit_flairs: redditFlairs,
    reddit_exclude_keywords: redditExcludeKeywords,
    enable_steam_source: enableSteamSource,
    steam_feed_url: steamFeedUrl,
    enable_aniimotools_source: enableAniimotoolsSource,
    aniimotools_feed_url: aniimotoolsFeedUrl,
    enable_wiki_aniimo: enableWikiAniimo,
    wiki_aniimo_api_url: wikiAniimoApiUrl,
    wiki_aniimo_site_url: wikiAniimoSiteUrl,
    wiki_aniimo_weekday: wikiAniimoWeekday,
    wiki_aniimo_hour: wikiAniimoHour,
    enable_fanart_digest: enableFanartDigest,
    fanart_subreddit: fanartSubreddit,
    fanart_flair: fanartFlair,
    enable_weekly_report: enableWeeklyReport,
    weekly_report_weekday: weeklyReportWeekday,
    weekly_report_hour: weeklyReportHour,
    fanart_digest_weekday: fanartDigestWeekday,
    fanart_digest_hour: fanartDigestHour,
    fanart_digest_count: fanartDigestCount,
  });
}

function required(env, name) {
  const value = env[name];
  if (value === undefined || value === null || !value.trim()) {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function requiredInt(env, name) {
  const value = required(env, name);
  const parsed = parseIntegerStrict(value);
  if (parsed === null) {
    throw new ConfigError(`${name} must be an integer`);
  }
  return parsed;
}

function optionalNonNegativeInt(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || !value.trim()) {
    return fallback;
  }

  const parsed = parseIntegerStrict(value.trim());
  if (parsed === null) {
    throw new ConfigError(`${name} must be an integer`);
  }

  if (parsed < 0) {
    throw new ConfigError(`${name} must be 0 or greater`);
  }

  return parsed;
}

function optionalPositiveIntOrNull(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null) {
    return fallback;
  }

  if (!value.trim()) {
    return null;
  }

  const parsed = parseIntegerStrict(value.trim());
  if (parsed === null || parsed <= 0) {
    return null;
  }

  return parsed;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * Parse an optional boolean, falling back to the default on typos.
 *
 * Unrecognized values keep the default (like the other lenient parsers) so a
 * misspelt value can never silently flip a default-on feature like the nightly
 * backup off — explicit "false"/"0"/"no"/"off" is required for that.
 */
function optionalBool(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || !value.trim()) {
    return fallback;
  }
  const token = value.trim().toLowerCase();
  if (TRUE_VALUES.has(token)) return true;
  if (FALSE_VALUES.has(token)) return false;
  return fallback;
}

/**
 * Parse an optional integer, returning null when missing, empty, or invalid.
 *
 * Used for Discord settings so a typo cannot crash the Telegram bot at startup.
 */
function optionalIntOrNull(env, name) {
  const value = env[name];
  if (value === undefined || value === null || !value.trim()) {
    return null;
  }
  return parseIntegerStrict(value.trim());
}

/**
 * Parse an optional non-negative int, returning the default on missing/invalid.
 *
 * Unlike optionalNonNegativeInt, this never throws ConfigError — used for the
 * Telegram moderation settings so a typo cannot stop the whole bot from starting.
 */
function optionalLenientNonNegativeInt(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || !value.trim()) {
    return fallback;
  }
  const parsed = parseIntegerStrict(value.trim());
  if (parsed === null) {
    return fallback;
  }
  return parsed >= 0 ? parsed : fallback;
}

/**
 * Parse an hour of day (0-23), returning the default on missing/invalid.
 *
 * Lenient for the same reason as the other backup/moderation settings: a typo
 * must never stop the whole bot from starting.
 */
function optionalHour(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || !value.trim()) {
    return fallback;
  }
  const parsed = parseIntegerStrict(value.trim());
  if (parsed === null) {
    return fallback;
  }
  return parsed >= 0 && parsed <= 23 ? parsed : fallback;
}

/**
 * Parse a weekday (0=Mon .. 6=Sun), returning the default on missing/invalid.
 * Lenient like the other scheduler settings so a typo never stops the bot.
 */
function optionalWeekday(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || !value.trim()) {
    return fallback;
  }
  const parsed = parseIntegerStrict(value.trim());
  if (parsed === null) {
    return fallback;
  }
  return parsed >= 0 && parsed <= 6 ? parsed : fallback;
}

/**
 * Parse a comma-separated Reddit flair list (case preserved) into an array.
 *
 * Missing or empty keeps the `fallback`; an explicit value REPLACES it. Used to
 * build the combined `flair:"A" OR flair:"B"` search query.
 */
function parseFlairs(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || !value.trim()) {
    return fallback;
  }
  const flairs = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return flairs.length ? Object.freeze(flairs) : fallback;
}

/**
 * Parse a comma-separated, case-insensitive keyword list for title filtering.
 *
 * Missing or empty keeps the `fallback`; an explicit value REPLACES it. A lone
 * `-` or `none` yields an empty set — i.e. "disable filtering" without a code
 * change. Keywords are lowercased so matching is case-insensitive.
 */
function parseKeywordSet(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || !value.trim()) {
    return new Set(fallback);
  }
  if (["-", "none"].includes(value.trim().toLowerCase())) {
    return new Set();
  }
  const keywords = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  return keywords.length ? new Set(keywords) : new Set(fallback);
}

/**
 * Parse a comma-separated list of chat IDs leniently into a Set of numbers.
 *
 * Blank or non-integer entries are skipped rather than raising, so one bad value
 * in TELEGRAM_MODERATION_CHAT_IDS cannot stop the bot from starting.
 */
function parseIntIdSet(env, name) {
  const raw = env[name] ?? "";
  const ids = new Set();
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const parsed = parseIntegerStrict(token);
    if (parsed === null) continue;
    ids.add(parsed);
  }
  return ids;
}

/**
 * Normalise DISCORD_ALLOWED_INVITES into a set of lowercase invite codes.
 *
 * Accepts bare codes (`abc123`) or full URLs (`https://discord.gg/abc123`) and
 * keeps only the trailing code. An empty value means "block every invite".
 */
function parseInviteAllowlist(env, name) {
  const raw = env[name] ?? "";
  const codes = new Set();
  for (const part of raw.split(",")) {
    let token = part.trim().replace(/\/+$/, "");
    if (!token) continue;
    if (token.includes("/")) {
      token = token.slice(token.lastIndexOf("/") + 1);
    }
    if (token) {
      codes.add(token.toLowerCase());
    }
  }
  return codes;
}

function parseAdminUserIds(value) {
  const rawIds = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!rawIds.length) {
    throw new ConfigError("ADMIN_USER_IDS must contain at least one Telegram user ID");
  }

  const adminIds = new Set();
  for (const rawId of rawIds) {
    const parsed = parseIntegerStrict(rawId);
    if (parsed === null) {
      throw new ConfigError("ADMIN_USER_IDS must be comma-separated integers");
    }
    adminIds.add(parsed);
  }

  return adminIds;
}

/**
 * Python `int(value)`: an optionally-signed run of digits and nothing else.
 *
 * `Number()` would happily accept "1e3", "0x10", " 12 " and "", and
 * `parseInt()` would accept the "12abc" that Python rejects — both would turn a
 * malformed chat id into a plausible-looking wrong number.
 */
function parseIntegerStrict(value) {
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) {
    return null;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
