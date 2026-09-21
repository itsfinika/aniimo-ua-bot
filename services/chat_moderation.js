/**
 * Pure moderation logic for the Telegram group-chat moderation feature.
 *
 * This module holds NO Telegram I/O. It mirrors the pure parts of
 * discord_moderation.js (anti-spam tracker, invite/scam/bad-word filters,
 * external editable word/rule lists) so the rules stay consistent across both
 * platforms while handlers/moderation.js keeps all the Telegram API calls.
 *
 * Everything here is synchronous and side-effect free except for reading the two
 * optional, editable text files at import time. Those loaders never throw: a
 * missing/unreadable file falls back to safe defaults, exactly like the Discord
 * module, so a deployment without the files still starts and moderates.
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { escapeRegExp, WORD } from "./pyutils.js";

// --------------------------------------------------------------------------- //
// Tunable moderation settings (kept in code on purpose, like discord_moderation).
// --------------------------------------------------------------------------- //

// Anti-flood: more than SPAM_MAX_MESSAGES messages from the same user in the same
// chat within SPAM_WINDOW_SECONDS triggers a delete + temporary mute.
export const SPAM_WINDOW_SECONDS = 7.0;
export const SPAM_MAX_MESSAGES = 5;
export const SPAM_MUTE_SECONDS = 60;

// Auto-actions after repeated /warn warnings. Keys are the *active* warning count
// that triggers the action; values are the mute length in seconds. The bot NEVER
// auto-bans or auto-kicks, and never auto-punishes chat admins (see handlers).
export const WARN_MUTE_THRESHOLDS = new Map([
  [3, 10 * 60], // 3 warnings -> 10-minute mute
  [5, 60 * 60], // 5 warnings -> 1-hour mute
]);
// At this many warnings, post an urgent mod-log note asking for manual review.
export const WARN_ESCALATION_THRESHOLD = 7;

// Telegram clamps restriction durations: an until_date less than 30 seconds or
// more than 366 days from now is treated as "forever". Keep temporary mutes
// safely inside that window so a short anti-flood mute never becomes permanent.
export const MIN_MUTE_SECONDS = 35;
export const MAX_MUTE_SECONDS = 366 * 24 * 60 * 60 - 60;

// --------------------------------------------------------------------------- //
// External, editable word / rule lists (repo root, one level up from services/).
// --------------------------------------------------------------------------- //

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BAD_WORDS_FILE = path.join(REPO_ROOT, "telegram_badwords.txt");
const RULES_FILE = path.join(REPO_ROOT, "telegram_rules.txt");

// Minimal fallback used only if telegram_badwords.txt is missing/unreadable/empty.
export const DEFAULT_BAD_WORDS = ["nigger", "faggot", "retard"];

/**
 * Read a one-item-per-line list file, dropping blanks and `#` comments.
 *
 * The path is a parameter rather than a module constant so the tests can point
 * it at a temporary file; production always passes the repo-root path below.
 */
function readListFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    const token = line.trim();
    if (!token || token.startsWith("#")) {
      continue;
    }
    lines.push(token);
  }
  return lines;
}

export function loadBadWordsFrom(file) {
  const lines = readListFile(file);
  if (lines === null) {
    return DEFAULT_BAD_WORDS;
  }
  // De-duplicate while preserving order; fall back to defaults if file is empty.
  const unique = [...new Set(lines.map((word) => word.toLowerCase()))];
  return unique.length ? unique : DEFAULT_BAD_WORDS;
}

export function loadWelcomeRulesFrom(file) {
  return readListFile(file) ?? [];
}

/**
 * Return the editable welcome rules, or [] when the file is missing/empty.
 *
 * Read on demand (not cached) so editing telegram_rules.txt is picked up on the
 * next join without restarting; the file is tiny and joins are infrequent.
 */
export function loadWelcomeRules() {
  return loadWelcomeRulesFrom(RULES_FILE);
}

export const BAD_WORDS = loadBadWordsFrom(BAD_WORDS_FILE);

// --------------------------------------------------------------------------- //
// Regexes (adapted from discord_moderation.js, kept conservative).
// --------------------------------------------------------------------------- //

// Python's `\b` and `\w` are Unicode-aware for `str`; JavaScript's are ASCII-only.
// Restoring the Unicode meaning matters here more than anywhere else: with the
// ASCII versions, a bad word would match inside an ordinary Ukrainian word.
const NOT_WORD_BEFORE = `(?<!${WORD})`;
const NOT_WORD_AFTER = `(?!${WORD})`;

// Telegram invite / link to a group, channel, or bot: t.me/<code>, t.me/+<hash>,
// t.me/joinchat/<hash>, t.me/s/<channel>, telegram.me/..., telegram.dog/...
// The leading lookbehind keeps the host from matching inside OTHER domains that
// merely end in "t" (about.me/john, support.me/...).
const INVITE_RE = new RegExp(
  "(?<![\\p{L}\\p{N}_.\\-])(?:https?://)?(?:www\\.)?(?:t\\.me|telegram\\.me|telegram\\.dog)" +
    "/(?:joinchat/|s/|\\+)?([A-Za-z0-9_\\-]+)",
  "giu",
);

// Well-known t.me paths that are NOT group/channel invites; ignore to avoid
// over-blocking (e.g. sticker packs, share links, proxies, instant view).
// "c" covers t.me/c/<internal_id>/<msg_id> message deep links: they cannot be
// used to join anything and members paste them when quoting chat messages.
const NON_INVITE_TME_PATHS = new Set([
  "share",
  "addstickers",
  "addemoji",
  "addtheme",
  "proxy",
  "socks",
  "iv",
  "bg",
  "setlanguage",
  "confirmphone",
  "c",
  "s",
]);

// Always-suspicious scam phrases / phishing look-alikes. Kept conservative.
const SCAM_PATTERNS = [
  /free\s+(?:discord\s+)?nitro/i,
  /nitro\s+(?:for\s+)?free/i,
  /free\s+telegram\s+premium/i,
  /telegram\s+premium\s+(?:for\s+)?free/i,
  /(?:double|2x)\s+your\s+(?:crypto|btc|eth|usdt|bitcoin)/i,
  new RegExp(`${NOT_WORD_BEFORE}crypto\\s+(?:airdrop|giveaway)${NOT_WORD_AFTER}`, "iu"),
  new RegExp(
    `${NOT_WORD_BEFORE}(?:pump\\s+(?:and\\s+)?dump|pump\\s+group|insider\\s+signals?)${NOT_WORD_AFTER}`,
    "iu",
  ),
  new RegExp(`${NOT_WORD_BEFORE}earn\\s+\\$?\\d+\\s+(?:per|a)\\s+day${NOT_WORD_AFTER}`, "iu"),
  // Common phishing look-alike domains / typosquats.
  new RegExp(
    `${NOT_WORD_BEFORE}(?:dlscord|discrod|dlsc0rd|discord-nitro|discordgift|discordapp\\.gift|` +
      `steamcommunlty|steamcommun[il]ty|steamcomunity|telegrann|telergam)${NOT_WORD_AFTER}`,
    "iu",
  ),
  // IP-logger / grabber services are effectively always malicious.
  /https?:\/\/(?:grabify\.link|iplogger\.\w+|blasze\.\w+)\/\S+/i,
];

// Phrases that are common in NORMAL gaming chat ("куплю steam gift card", "free
// skins в івенті") — Aniimo is a Steam game with free-cosmetic events, so
// these count as scam only when the message also carries a link.
const LINKED_SCAM_PATTERNS = [
  /(?:steam|cs:?go)\s+gift/i,
  new RegExp(`free\\s+(?:robux|v-?bucks|skins?)${NOT_WORD_AFTER}`, "iu"),
];
const URL_HINT_RE = /https?:\/\/|www\.|t\.me\//i;

// Generic URL shorteners: only treated as suspicious when combined with a scam
// keyword, to avoid blocking legitimate shortened links.
const SHORTENER_RE = /https?:\/\/(?:bit\.ly|tinyurl\.com|cutt\.ly|is\.gd|shorturl\.at|t\.co|rb\.gy)\/\S+/i;
const SCAM_KEYWORD_RE = new RegExp(
  `${NOT_WORD_BEFORE}(?:nitro|free|gift|airdrop|giveaway|claim|reward|prize|crypto|wallet|premium)${NOT_WORD_AFTER}`,
  "iu",
);

/**
 * Build the whole-word matcher for a bad-word list.
 *
 * Exported so tests can build one from a fixed list instead of depending on the
 * repo's editable telegram_badwords.txt.
 */
export function buildBadWordRe(words = BAD_WORDS) {
  if (!words.length) {
    return null;
  }
  const joined = words.map((word) => escapeRegExp(word)).join("|");
  // The Unicode-aware word boundaries make terms match only WHOLE words, never
  // substrings of normal Ukrainian words.
  return new RegExp(`${NOT_WORD_BEFORE}(?:${joined})${NOT_WORD_AFTER}`, "iu");
}

const BAD_WORD_RE = buildBadWordRe();

// --------------------------------------------------------------------------- //
// Pure predicates used by the handlers.
// --------------------------------------------------------------------------- //

/** Return a short reason string if the content looks like a scam, else null. */
export function suspiciousReason(content) {
  for (const pattern of SCAM_PATTERNS) {
    if (pattern.test(content)) {
      return "scam";
    }
  }
  if (URL_HINT_RE.test(content)) {
    for (const pattern of LINKED_SCAM_PATTERNS) {
      if (pattern.test(content)) {
        return "scam";
      }
    }
  }
  if (SHORTENER_RE.test(content) && SCAM_KEYWORD_RE.test(content)) {
    return "shortener";
  }
  return null;
}

export function hasBadWord(content, matcher = BAD_WORD_RE) {
  return matcher !== null && matcher.test(content);
}

/**
 * True if the text contains a t.me invite/link whose code is not allowlisted.
 *
 * Well-known non-invite t.me paths (sticker packs, share links, proxies, ...)
 * are ignored. A message with no t.me links, or only allowlisted ones, returns
 * false.
 */
export function hasBlockedInvite(content, allowlist) {
  INVITE_RE.lastIndex = 0;
  for (const match of String(content).matchAll(INVITE_RE)) {
    const code = match[1].toLowerCase();
    if (NON_INVITE_TME_PATHS.has(code)) {
      continue;
    }
    // The allowlist parser keeps a leading "+" from full t.me/+hash URLs while
    // the regex strips it, so accept the code in both spellings.
    if (!allowlist.has(code) && !allowlist.has(`+${code}`)) {
      return true; // at least one non-allowlisted invite -> block
    }
  }
  return false;
}

// --------------------------------------------------------------------------- //
// Anti-flood tracker.
// --------------------------------------------------------------------------- //

/**
 * Per-(chat, user) sliding-window message-rate tracker.
 *
 * Mirrors discord_moderation's approach. Stale buckets are swept
 * opportunistically every SWEEP_EVERY registrations, so the key space does not
 * grow unbounded in a busy public group.
 */
export class SpamTracker {
  static SWEEP_EVERY = 512;

  constructor({
    windowSeconds = SPAM_WINDOW_SECONDS,
    maxMessages = SPAM_MAX_MESSAGES,
    clock = () => performance.now() / 1000,
  } = {}) {
    this._window = windowSeconds;
    this._max = maxMessages;
    this._clock = clock;
    this._buckets = new Map();
    this._calls = 0;
  }

  /** Record one message; return true exactly once when the user is flooding. */
  registerAndCheck(chatId, userId) {
    this._calls += 1;
    if (this._calls % SpamTracker.SWEEP_EVERY === 0) {
      this.sweep();
    }

    const key = `${chatId}:${userId}`;
    const now = this._clock();
    let bucket = this._buckets.get(key);
    if (bucket === undefined) {
      bucket = [];
      this._buckets.set(key, bucket);
    }
    bucket.push(now);
    while (bucket.length && now - bucket[0] > this._window) {
      bucket.shift();
    }
    if (bucket.length > this._max) {
      // Reset so we act once, not on every later message in the burst.
      this._buckets.delete(key);
      return true;
    }
    return false;
  }

  /** Drop buckets whose newest entry is older than the window. Optional upkeep. */
  sweep() {
    const now = this._clock();
    for (const [key, bucket] of [...this._buckets]) {
      if (!bucket.length || now - bucket[bucket.length - 1] > this._window) {
        this._buckets.delete(key);
      }
    }
  }
}

// --------------------------------------------------------------------------- //
// Duration parsing for /mute, /ban.
// --------------------------------------------------------------------------- //

const DURATION_RE = /^(\d+)\s*([smhdw]?)$/i;
const DURATION_UNIT_SECONDS = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
  w: 7 * 24 * 60 * 60,
  "": 60, // a bare number means minutes (common moderation-bot convention)
};
const PERMANENT_TOKENS = new Set(["0", "perm", "permanent", "forever", "назавжди", "назавжди."]);

/**
 * Parse a human duration into seconds.
 *
 * Returns:
 *   * a positive number — duration in seconds (e.g. "30" -> 1800, "2h" -> 7200);
 *   * `0` — explicit permanent ("0", "perm", "forever", "назавжди");
 *   * `null` — empty or unparseable input (caller decides the default).
 */
export function parseDuration(text) {
  if (text === null || text === undefined) {
    return null;
  }
  const token = String(text).trim().toLowerCase();
  if (!token) {
    return null;
  }
  if (PERMANENT_TOKENS.has(token)) {
    return 0;
  }
  const match = DURATION_RE.exec(token);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const seconds = amount * DURATION_UNIT_SECONDS[unit];
  return seconds > 0 ? seconds : 0;
}

/** Clamp a positive temporary-mute duration into Telegram's valid window. */
export function clampMuteSeconds(seconds) {
  if (seconds < MIN_MUTE_SECONDS) {
    return MIN_MUTE_SECONDS;
  }
  if (seconds > MAX_MUTE_SECONDS) {
    return MAX_MUTE_SECONDS;
  }
  return seconds;
}
