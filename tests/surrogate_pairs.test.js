/**
 * Regression test for the surrogate-pair split introduced by the Python port.
 *
 * Python's `str` is a sequence of code POINTS, so `text[:limit]` can never cut a
 * character in half. JavaScript strings are UTF-16, so the same slice at the same
 * numeric index lands *inside* an emoji and emits a lone surrogate — which is not
 * a character at all and reaches Telegram as a broken glyph. Every limit that the
 * Python original expressed in characters must therefore go through the
 * code-point helpers in services/pyutils.js.
 *
 * The bot posts emoji constantly (the "Чи знали ви?" rubric opens with 🤔, and
 * Bluesky/Reddit/YouTube titles are full of them), so this is not theoretical.
 */

import { describe, expect, it } from "vitest";

import { formatAdminPreview } from "../services/formatter.js";
import { splitText, telegramVisibleLength } from "../services/publisher.js";
import { charLength, rfindChars, sliceChars } from "../services/pyutils.js";

const THINKING = "\u{1F914}"; // 🤔 — one code point, two UTF-16 code units.

/** Any unpaired surrogate means a character was cut in half. */
const hasLoneSurrogate = (value) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

describe("code-point helpers", () => {
  it("counts code points, not UTF-16 code units", () => {
    expect(charLength(`${THINKING}ab`)).toBe(3);
    expect(`${THINKING}ab`.length).toBe(4); // what the naive port counted
  });

  it("slices without splitting a surrogate pair", () => {
    // Index 1 falls between the two code units of the emoji.
    expect(sliceChars(`${THINKING}ab`, 0, 1)).toBe(THINKING);
    expect(hasLoneSurrogate(sliceChars(`${THINKING}ab`, 0, 1))).toBe(false);
  });

  it("reports rfind positions in code points", () => {
    // Python: "🤔a b".rfind(" ", 0, 4) == 2
    expect(rfindChars(`${THINKING}a b`, " ", 4)).toBe(2);
    expect(rfindChars(`${THINKING}a b`, " ", 2)).toBe(-1);
    expect(rfindChars("no needle here", "\n")).toBe(-1);
  });
});

describe("splitText", () => {
  it("never emits a lone surrogate at a chunk boundary", () => {
    // The limit lands exactly inside the emoji, and there is no newline to
    // split on, so the code takes the raw `splitAt = limit` fallback.
    const text = `abcdefghi${THINKING}jkl mno pqr`;
    const chunks = splitText(text, 10);

    expect(chunks.some(hasLoneSurrogate)).toBe(false);
    expect(chunks[0]).toBe(`abcdefghi${THINKING}`);
    // Nothing is lost or duplicated by the split.
    expect(chunks.join("").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
  });

  it("measures the limit in characters, as Python did", () => {
    const text = THINKING.repeat(12);
    // 12 code points > 10, so it must split; a UTF-16 count would see 24.
    for (const chunk of splitText(text, 10)) {
      expect(charLength(chunk)).toBeLessThanOrEqual(10);
    }
  });

  it("leaves short text untouched", () => {
    expect(splitText(`${THINKING} короткий`, 4096)).toEqual([`${THINKING} короткий`]);
  });
});

describe("telegramVisibleLength", () => {
  it("counts an emoji once", () => {
    expect(telegramVisibleLength(`${THINKING}abc`, null)).toBe(4);
    expect(telegramVisibleLength(`<b>${THINKING}abc</b>`, "HTML")).toBe(4);
  });
});

describe("formatAdminPreview", () => {
  it("truncates a long emoji-only original without breaking a character", () => {
    const preview = formatAdminPreview({
      id: 1,
      user_id: 42,
      username: "u",
      message_type: "text",
      original_text: THINKING.repeat(400),
      draft_text: "",
      file_id: null,
      status: "pending",
      created_at: "2026-08-16T14:00:00+00:00",
      tags: [],
    });

    expect(hasLoneSurrogate(preview)).toBe(false);
  });
});
