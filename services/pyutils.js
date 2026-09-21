/**
 * Python-compatibility shims.
 *
 * This project was ported from Python, and a handful of standard-library
 * behaviours it relies on have no JavaScript equivalent - or, worse, have a
 * similar-looking equivalent that differs in exactly the cases this bot hits:
 *
 *   * `str.strip(chars)` strips a character SET, not a suffix - `String.trim()`
 *     cannot express it and `replace()` would strip a substring instead.
 *   * `str.split()` with no argument collapses runs of whitespace and drops the
 *     empty edges; `String.split(/\s+/)` keeps a leading empty string.
 *   * `\w` and `\b` are Unicode-aware for Python `str` patterns but ASCII-only
 *     in JavaScript, so a bad-word filter written with `\b` would fire inside
 *     ordinary Ukrainian words. {@link WORD} restores the Python meaning.
 *   * `str.format` supports `{{`/`}}` escaping, which the Gemini dedup prompt
 *     depends on to emit a literal JSON object.
 *   * `datetime.now(timezone.utc).isoformat(timespec="seconds")` renders the
 *     offset as `+00:00`. The database stores every timestamp in that exact
 *     shape and compares them as STRINGS, so emitting a trailing `Z` (what
 *     `Date.toISOString()` gives) would silently break every cleanup cutoff and
 *     cooldown comparison against rows written by the Python version.
 *
 * Everything here is pure and side-effect free.
 */

import { DateTime } from "luxon";

/**
 * A Unicode word character, as Python's `\w` means it for `str` patterns:
 * anything `str.isalnum()` accepts, plus the underscore. Use it with the `u`
 * flag in place of `\w`, and as `(?<!${WORD})...(?!${WORD})` in place of `\b`.
 */
export const WORD = "[\\p{L}\\p{N}_]";

/**
 * The code points Python's `str.isspace()` accepts.
 *
 * Spelled as numbers rather than as a character class so the set is readable
 * and cannot be corrupted by an editor collapsing look-alike blanks. It differs
 * from JavaScript's `\s` in both directions: Python also treats the C0 file/
 * group/record/unit separators and NEL as space, and does NOT treat U+FEFF
 * (the byte-order mark) as space.
 */
const PY_SPACE_CODES = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
  0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
  0x205f, 0x3000,
]);

function isPyWhitespace(char) {
  return PY_SPACE_CODES.has(char.codePointAt(0));
}

/**
 * Build the "should this character be stripped" predicate. `undefined` chars
 * means Python's default (whitespace); an explicit string means that exact set.
 */
function stripPredicate(chars) {
  if (chars === undefined || chars === null) return isPyWhitespace;
  const set = new Set(Array.from(String(chars)));
  return (char) => set.has(char);
}

/** Python `str.lstrip([chars])`. */
export function lstrip(value, chars) {
  const shouldStrip = stripPredicate(chars);
  const text = String(value ?? "");
  let start = 0;
  while (start < text.length && shouldStrip(text[start])) start += 1;
  return text.slice(start);
}

/** Python `str.rstrip([chars])`. */
export function rstrip(value, chars) {
  const shouldStrip = stripPredicate(chars);
  const text = String(value ?? "");
  let end = text.length;
  while (end > 0 && shouldStrip(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

/** Python `str.strip([chars])`. */
export function strip(value, chars) {
  return rstrip(lstrip(value, chars), chars);
}

/**
 * Python `str.split()` with no separator: split on runs of whitespace and drop
 * the empty leading/trailing pieces. Used wherever the Python code counted
 * words or normalised inner whitespace via `" ".join(value.split())`.
 */
export function splitWhitespace(value) {
  const text = String(value ?? "");
  const parts = [];
  let current = "";
  for (const char of text) {
    if (isPyWhitespace(char)) {
      if (current) parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** `" ".join(value.split())` - collapse every whitespace run to one space. */
export function collapseWhitespace(value) {
  return splitWhitespace(value).join(" ");
}

/**
 * Python `str` as a list of characters, i.e. of code POINTS.
 *
 * Every length limit in this codebase was written against Python's `len()`,
 * which counts code points. JavaScript's `String.prototype.length` counts UTF-16
 * code units instead, so an emoji counts twice — and, far worse, slicing at a
 * code-unit index can cut a surrogate pair in half. The resulting lone surrogate
 * is not a character: it reaches Telegram as a replacement glyph. Titles from
 * Bluesky/Reddit/YouTube and drafts that open with an emoji hit this routinely,
 * so every character-counted limit goes through the three helpers below.
 */
export function chars(value) {
  return Array.from(String(value ?? ""));
}

/** Python `len(str)` - a count of code points, not of UTF-16 code units. */
export function charLength(value) {
  return chars(value).length;
}

/** Python `str[start:end]` - slicing by code point, never mid-surrogate-pair. */
export function sliceChars(value, start, end) {
  return chars(value).slice(start, end).join("");
}

/** Python `str.rfind(sub, 0, end)` - the last index BELOW `end`, in code points. */
export function rfindChars(value, sub, end) {
  const haystack = chars(value);
  const needle = chars(sub);
  const limit = end === undefined ? haystack.length : Math.min(end, haystack.length);
  outer: for (let start = limit - needle.length; start >= 0; start -= 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

/** Python `str.rsplit(sep, 1)`. Returns `[head, tail]`, or `[text]` when absent. */
export function rsplitOnce(value, separator) {
  const text = String(value ?? "");
  const index = text.lastIndexOf(separator);
  if (index === -1) return [text];
  return [text.slice(0, index), text.slice(index + separator.length)];
}

/** Python `str.partition(sep)` - always a 3-tuple. */
export function partition(value, separator) {
  const text = String(value ?? "");
  const index = text.indexOf(separator);
  if (index === -1) return [text, "", ""];
  return [text.slice(0, index), separator, text.slice(index + separator.length)];
}

/** Python `str.title()` - capitalise each word, lowercase the rest. */
export function pyTitle(value) {
  return String(value ?? "").replace(/[\p{L}\p{N}']+/gu, (word) =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
  );
}

/** Python `str.isdigit()` for the ASCII cases this project parses. */
export function isDigits(value) {
  const text = String(value ?? "");
  return text.length > 0 && /^\d+$/.test(text);
}

/** Escape a literal for embedding in a regular expression (Python `re.escape`). */
export function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HTML_ESCAPES = new Map([
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ['"', "&quot;"],
  ["'", "&#x27;"],
]);

/**
 * Python `html.escape(value, quote=True)`.
 *
 * Note the apostrophe: Python emits `&#x27;`, which differs from most JS
 * helpers (`&#39;`). Telegram renders both identically, but keeping Python's
 * spelling means ported tests and stored text compare byte-for-byte.
 */
export function htmlEscape(value, quote = true) {
  let text = String(value ?? "").replace(/[&<>]/g, (char) => HTML_ESCAPES.get(char));
  if (quote) {
    text = text.replace(/["']/g, (char) => HTML_ESCAPES.get(char));
  }
  return text;
}

const HTML_UNESCAPES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["hellip", "…"],
  ["mdash", "—"],
  ["ndash", "–"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
]);

/**
 * Python `html.unescape`, covering the numeric forms plus the named entities
 * this codebase can actually produce or receive. It is used only to measure a
 * message's VISIBLE length against Telegram's limits, so an unknown entity left
 * as-is is harmless - it counts as one "character" either way.
 */
export function htmlUnescape(value) {
  return String(value ?? "").replace(
    /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (match, entity) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const code = Number.parseInt(entity.slice(2), 16);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      if (entity.startsWith("#")) {
        const code = Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      const replacement = HTML_UNESCAPES.get(entity.toLowerCase());
      return replacement === undefined ? match : replacement;
    },
  );
}

/**
 * Python `str.format(**kwargs)` for named placeholders.
 *
 * Supports `{{` / `}}` escaping, which the Gemini dedup prompt relies on to
 * show the model a literal `{"duplicate": ...}` JSON shape. A placeholder with
 * no matching key throws, mirroring Python's KeyError - a silently-empty prompt
 * slot would be far harder to notice than a loud failure.
 */
export function formatTemplate(template, values = {}) {
  const text = String(template ?? "");
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      if (text[index + 1] === "{") {
        result += "{";
        index += 1;
        continue;
      }
      const end = text.indexOf("}", index + 1);
      if (end === -1) {
        throw new Error("Single '{' encountered in format string");
      }
      const key = text.slice(index + 1, end);
      if (!Object.prototype.hasOwnProperty.call(values, key)) {
        throw new Error(`Missing format key: ${key}`);
      }
      result += stringifyValue(values[key]);
      index = end;
      continue;
    }
    if (char === "}") {
      if (text[index + 1] === "}") {
        result += "}";
        index += 1;
        continue;
      }
      throw new Error("Single '}' encountered in format string");
    }
    result += char;
  }
  return result;
}

function stringifyValue(value) {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Error) return errorText(value);
  return String(value);
}

/**
 * Python's `str(exception)` - the message alone.
 *
 * `String(error)` in JavaScript prepends the class name ("Error: ..."), which
 * would leak into the admin-facing collector reports that interpolate `{error}`.
 */
export function errorText(error) {
  if (error === null || error === undefined) return String(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * `datetime.now(timezone.utc).isoformat(timespec="seconds")`.
 *
 * The `+00:00` suffix is load-bearing: `created_at` / `updated_at` are compared
 * lexicographically in SQL, and the database already holds rows written by the
 * Python version in this exact format.
 */
export function utcNowIso(now = new Date()) {
  return utcIsoSeconds(now);
}

/** The same rendering for an arbitrary instant, e.g. a cleanup cutoff. */
export function utcIsoSeconds(date) {
  return `${new Date(date).toISOString().slice(0, 19)}+00:00`;
}

/**
 * Python `datetime.fromisoformat` (3.11+, which accepts a trailing `Z`).
 *
 * Returns a luxon DateTime, or `null` when the value is not parseable - every
 * caller in this project wrapped the call in a try/except and treated a failure
 * as "unknown", so a null is the faithful translation. A value with no offset
 * keeps its naive wall time: callers decide whether that means UTC or local.
 */
export function fromIsoFormat(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const parsed = DateTime.fromISO(text, { setZone: true });
  return parsed.isValid ? parsed : null;
}

/** Whether an ISO string carried an explicit UTC offset (Python's `tzinfo`). */
export function hasIsoOffset(value) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(value ?? "").trim());
}

/**
 * Python `date.fromisoformat` - strictly `YYYY-MM-DD`, returned as a plain
 * `{year, month, day}` record so callers can compare calendar dates without
 * dragging a timezone into it.
 */
export function dateFromIsoFormat(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = DateTime.fromObject({ year, month, day }, { zone: "utc" });
  return probe.isValid ? { year, month, day } : null;
}

/** Compare two `{year, month, day}` records: negative / zero / positive. */
export function compareCalendarDates(left, right) {
  if (left.year !== right.year) return left.year - right.year;
  if (left.month !== right.month) return left.month - right.month;
  return left.day - right.day;
}

/** `sorted(values)` for a set/array of numbers, ascending. */
export function sortedNumbers(values) {
  return [...values].sort((left, right) => left - right);
}

/** Sleep for `seconds` - the direct analogue of `asyncio.sleep`. */
export function sleep(seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, seconds) * 1000);
  });
}
