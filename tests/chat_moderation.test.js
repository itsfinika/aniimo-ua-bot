/**
 * Unit tests for the pure moderation logic in services/chat_moderation.js.
 *
 * Everything tested here is synchronous and side-effect free, so the tests need
 * no Telegram client, no timers, and no network. File-backed loaders are pointed
 * at temporary files; the word-list regex is rebuilt from a fixed list so the
 * tests never depend on the repo's editable telegram_badwords.txt.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as cm from "../services/chat_moderation.js";

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatmod-"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- //
// suspiciousReason
// --------------------------------------------------------------------------- //

describe("suspiciousReason", () => {
  const scams = [
    "FREE NITRO for everyone, hurry up",
    "get free discord nitro here",
    "nitro for free!!!",
    "free telegram premium на місяць",
    "telegram premium for free",
    "we will double your crypto in 24h",
    "2x your BTC guaranteed",
    "crypto airdrop just started",
    "join my pump group",
    "insider signals from the exchange",
    "earn $500 per day from home",
    "earn 100 a day easily",
    "login via dlscord.com to claim",
    "steamcommunlty.com/trade/123",
    "check https://grabify.link/abc123 now",
  ];

  it.each(scams)("flags %s as scam", (text) => {
    expect(cm.suspiciousReason(text)).toBe("scam");
  });

  it("requires a link for the gaming-adjacent phrases", () => {
    // Normal gaming chat: free skins / steam gift talk without a URL is fine…
    expect(cm.suspiciousReason("в івенті роздають free skins всім")).toBeNull();
    expect(cm.suspiciousReason("хто хоче steam gift card на день народження?")).toBeNull();
    // …but the same phrases plus any link smell like scam.
    expect(cm.suspiciousReason("free skins тут: https://example.com/skins")).toBe("scam");
    expect(cm.suspiciousReason("steam gift забирай www.totally-legit.com")).toBe("scam");
    expect(cm.suspiciousReason("free robux t.me/grab_it")).toBe("scam");
  });

  it("treats a shortener as suspicious only with a scam keyword", () => {
    expect(cm.suspiciousReason("https://bit.ly/3xYz claim your free gift")).toBe("shortener");
    expect(cm.suspiciousReason("ось патчноути https://bit.ly/3xYz")).toBeNull();
    // Keyword without a shortener is not enough either.
    expect(cm.suspiciousReason("хто виграв giveaway вчора?")).toBeNull();
  });

  const normal = [
    "хто грає ввечері? го стак",
    "новий патч поламав Emberpup, граємо?",
    "https://www.aniimo.com/newslist читайте патчноути",
    "купив нову відеокарту, fps виріс удвічі",
  ];

  it.each(normal)("passes normal chat: %s", (text) => {
    expect(cm.suspiciousReason(text)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// hasBlockedInvite
// --------------------------------------------------------------------------- //

const EMPTY = new Set();

describe("hasBlockedInvite", () => {
  it("blocks invites that are not allowlisted", () => {
    expect(cm.hasBlockedInvite("заходьте t.me/SpamChannel", EMPTY)).toBe(true);
    expect(cm.hasBlockedInvite("https://t.me/joinchat/AbCdEf", EMPTY)).toBe(true);
    expect(cm.hasBlockedInvite("telegram.me/another_group", EMPTY)).toBe(true);
    expect(cm.hasBlockedInvite("telegram.dog/SpamGroup", EMPTY)).toBe(true);
    expect(cm.hasBlockedInvite("https://t.me/+PrivateHash123", EMPTY)).toBe(true);
  });

  it("allows allowlisted invites", () => {
    const allow = new Set(["aniimouachat", "aniimouabot"]);
    expect(cm.hasBlockedInvite("наш чат https://t.me/AniimoUAChat", allow)).toBe(false);
    expect(cm.hasBlockedInvite("пишіть боту t.me/AniimoUABot", allow)).toBe(false);
    // Mixed message: one allowlisted + one foreign link must still block.
    expect(cm.hasBlockedInvite("t.me/AniimoUAChat і ще t.me/SpamChannel", allow)).toBe(true);
  });

  it("accepts a plus-prefixed hash from the allowlist parser", () => {
    // The config parser keeps the "+" from t.me/+hash URLs; the regex strips it.
    expect(cm.hasBlockedInvite("https://t.me/+AbCdEf123", new Set(["+abcdef123"]))).toBe(false);
  });

  it("ignores well-known non-invite t.me paths", () => {
    expect(cm.hasBlockedInvite("стікери: t.me/addstickers/CoolPack", EMPTY)).toBe(false);
    expect(cm.hasBlockedInvite("t.me/share/url?url=x", EMPTY)).toBe(false);
    expect(cm.hasBlockedInvite("цитата t.me/c/1234567/89", EMPTY)).toBe(false);
  });

  it("does not match other domains", () => {
    expect(cm.hasBlockedInvite("моє портфоліо about.me/john", EMPTY)).toBe(false);
    expect(cm.hasBlockedInvite("пишіть на support.me/help", EMPTY)).toBe(false);
    expect(cm.hasBlockedInvite("повідомлення без посилань", EMPTY)).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// Bad-word filter (regex rebuilt from a fixed list, independent of the repo file)
// --------------------------------------------------------------------------- //

describe("bad-word filter", () => {
  const matcher = cm.buildBadWordRe(["badword", "хейтслово"]);

  it("matches whole words only", () => {
    expect(cm.hasBadWord("this has badword inside", matcher)).toBe(true);
    expect(cm.hasBadWord("BADWORD!!!", matcher)).toBe(true);
    expect(cm.hasBadWord("embedbadwordx is fine", matcher)).toBe(false);
  });

  it("respects Unicode word boundaries", () => {
    expect(cm.hasBadWord("ну ти й хейтслово,", matcher)).toBe(true);
    // Substring inside a longer Ukrainian word must NOT match.
    expect(cm.hasBadWord("обмінхейтсловом не рахується", matcher)).toBe(false);
  });

  it("parses comments, duplicates and case from the list file", () => {
    const wordsFile = path.join(tmpDir, "badwords.txt");
    fs.writeFileSync(wordsFile, "# comment\nFoo\n\nbar\nfoo\n", "utf8");
    expect(cm.loadBadWordsFrom(wordsFile)).toEqual(["foo", "bar"]);
  });

  it("falls back to the built-in defaults when the file is missing", () => {
    expect(cm.loadBadWordsFrom(path.join(tmpDir, "absent.txt"))).toEqual(cm.DEFAULT_BAD_WORDS);
  });
});

it("loads welcome rules and tolerates a missing file", () => {
  const rulesFile = path.join(tmpDir, "rules.txt");
  fs.writeFileSync(rulesFile, "# заголовок\nПравило один\n\nПравило два\n", "utf8");
  expect(cm.loadWelcomeRulesFrom(rulesFile)).toEqual(["Правило один", "Правило два"]);

  expect(cm.loadWelcomeRulesFrom(path.join(tmpDir, "absent.txt"))).toEqual([]);
});

// --------------------------------------------------------------------------- //
// SpamTracker
// --------------------------------------------------------------------------- //

/** Injected via SpamTracker's clock parameter — no global time patching. */
function fakeClock() {
  const state = { now: 1000.0 };
  const clock = () => state.now;
  clock.state = state;
  return clock;
}

describe("SpamTracker", () => {
  it("triggers once per burst", () => {
    const tracker = new cm.SpamTracker({ windowSeconds: 7.0, maxMessages: 3, clock: fakeClock() });
    expect([0, 1, 2].map(() => tracker.registerAndCheck(1, 42))).toEqual([false, false, false]);
    expect(tracker.registerAndCheck(1, 42)).toBe(true);
    // The bucket was reset: the very next message does not re-trigger.
    expect(tracker.registerAndCheck(1, 42)).toBe(false);
  });

  it("isolates chats and users", () => {
    const tracker = new cm.SpamTracker({ windowSeconds: 7.0, maxMessages: 2, clock: fakeClock() });
    expect(tracker.registerAndCheck(1, 42)).toBe(false);
    expect(tracker.registerAndCheck(2, 42)).toBe(false); // same user, other chat
    expect(tracker.registerAndCheck(1, 43)).toBe(false); // other user, same chat
    expect(tracker.registerAndCheck(1, 42)).toBe(false);
    expect(tracker.registerAndCheck(1, 42)).toBe(true);
  });

  it("expires the window", () => {
    const clock = fakeClock();
    const tracker = new cm.SpamTracker({ windowSeconds: 7.0, maxMessages: 2, clock });
    expect(tracker.registerAndCheck(1, 42)).toBe(false);
    expect(tracker.registerAndCheck(1, 42)).toBe(false);
    clock.state.now += 8.0; // the earlier messages fall out of the window
    expect(tracker.registerAndCheck(1, 42)).toBe(false);
  });

  it("sweeps stale buckets", () => {
    const clock = fakeClock();
    const tracker = new cm.SpamTracker({ windowSeconds: 7.0, maxMessages: 5, clock });
    tracker.registerAndCheck(1, 42);
    tracker.registerAndCheck(2, 43);
    clock.state.now += 100.0;
    tracker.registerAndCheck(3, 44);
    tracker.sweep();
    expect([...tracker._buckets.keys()]).toEqual(["3:44"]);
  });
});

// --------------------------------------------------------------------------- //
// Duration parsing and clamping
// --------------------------------------------------------------------------- //

describe("parseDuration", () => {
  const cases = [
    ["30", 30 * 60], // bare number = minutes
    ["45s", 45],
    ["2h", 2 * 60 * 60],
    ["1d", 24 * 60 * 60],
    ["1w", 7 * 24 * 60 * 60],
    ["10 m", 10 * 60], // space before the unit is fine
    ["2H", 2 * 60 * 60], // unit is case-insensitive
    ["0", 0], // explicit permanent
    ["0s", 0],
    ["perm", 0],
    ["forever", 0],
    ["назавжди", 0],
    ["", null],
    ["   ", null],
    ["abc", null],
    ["-5", null],
    ["5x", null],
    ["1.5h", null],
  ];

  it.each(cases)("parses %s as %s", (text, expected) => {
    expect(cm.parseDuration(text)).toBe(expected);
  });

  it("returns null for a missing value", () => {
    expect(cm.parseDuration(null)).toBeNull();
    expect(cm.parseDuration(undefined)).toBeNull();
  });
});

it("clamps mute durations into Telegram's window", () => {
  expect(cm.clampMuteSeconds(1)).toBe(cm.MIN_MUTE_SECONDS);
  expect(cm.clampMuteSeconds(cm.MIN_MUTE_SECONDS)).toBe(cm.MIN_MUTE_SECONDS);
  expect(cm.clampMuteSeconds(3600)).toBe(3600);
  expect(cm.clampMuteSeconds(cm.MAX_MUTE_SECONDS + 1)).toBe(cm.MAX_MUTE_SECONDS);
});
