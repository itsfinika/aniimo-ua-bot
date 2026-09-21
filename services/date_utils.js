import { DateTime, FixedOffsetZone, IANAZone } from "luxon";

import { t } from "./i18n.js";
import { getLogger } from "./logger.js";
import { collapseWhitespace, WORD } from "./pyutils.js";

const logger = getLogger("services.date_utils");

// The Python patterns used `\b`, which is Unicode-aware for `str` in Python but
// ASCII-only in JavaScript: an English month name butting against a Cyrillic
// letter would match here where it did not there. The explicit word-character
// lookarounds restore Python's meaning.
const NOT_WORD_BEFORE = `(?<!${WORD})`;
const NOT_WORD_AFTER = `(?!${WORD})`;

export const UTC_TIME_PATTERN = new RegExp(
  `${NOT_WORD_BEFORE}(?<hour>[01]?\\d|2[0-3]):(?<minute>[0-5]\\d)\\s*` +
    `(?<zone>UTC|GMT)(?<offset>\\s*[+-]\\s*\\d{1,2}(?::?[0-5]\\d)?)?${NOT_WORD_AFTER}`,
  "giu",
);

// The zone marker on its own: "UTC", "GMT+2", "(UTC+8)", "（UTC+8）". Aniimo
// writes a range as "September 23, 2026, 00:00 – 10:00（UTC+8）" — one marker at
// the END of the range, fullwidth parentheses straight from the CJK editor —
// so the marker has to be found first and then applied to every clock time
// before it; UTC_TIME_PATTERN alone would only ever see the last endpoint.
// The bracketed and bare forms are separate alternatives (with their own group
// names, since a regex cannot make the closing bracket conditional on the
// opening one) so "(all times 10:00 UTC+8)" never swallows the sentence's
// bracket into the marker. A marker glued to its time ("18:30GMT+2") is still
// a marker, hence the second lookbehind.
const zoneMarker = (prefix) =>
  `(?:${NOT_WORD_BEFORE}|(?<=\\d:[0-5]\\d))(?<${prefix}zone>UTC|GMT)` +
  `(?<${prefix}offset>\\s*[+-]\\s*\\d{1,2}(?::?[0-5]\\d)?)?${NOT_WORD_AFTER}`;
export const UTC_ZONE_PATTERN = new RegExp(
  `(?<open>[(（])\\s*${zoneMarker("")}\\s*[)）]|${zoneMarker("bare_")}`,
  "giu",
);

// A clock time as it appears in a range or a sentence. The lookbehind keeps
// the "00:12" tail of "00:00:12" from being read as a time of its own, and the
// optional seconds are consumed for the same reason. A trailing meridiem is
// captured so "5:00 PM (UTC+8)" converts as 17:00, not 05:00.
const CLOCK_TIME_PATTERN = new RegExp(
  `${NOT_WORD_BEFORE}(?<!\\d:)(?<hour>[01]?\\d|2[0-3]):(?<minute>[0-5]\\d)(?::[0-5]\\d)?` +
    `(?:\\s*(?<meridiem>[ap]\\.?m\\.?)(?!\\p{L}))?${NOT_WORD_AFTER}`,
  "giu",
);

// Where a range/sentence segment ends: a sentence terminator that is followed
// by a capitalised word (or ends the text), a line break, or the previous zone
// marker. Everything between the previous boundary and a marker is what that
// marker describes. Requiring the capital keeps "v1.2 goes live", "Sep. 23"
// and "5:00 p.m. (UTC+8)" in one piece.
const SENTENCE_BREAK_PATTERN = /[.!?;](?=\s*$|\s+[\p{Lu}"'«])/gu;

// "10:00 PT and 19:00 CET, that is 18:00 UTC" — the first two carry a zone of
// their own and must not be re-read as UTC just because they share a sentence
// with the marker. Any all-caps abbreviation that is not our marker counts.
const FOREIGN_ZONE_PATTERN = /^\s*(?<zone>[A-Z]{2,4})(?![\p{L}\p{N}_])/u;

const MONTH_ALTERNATION =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|" +
  "Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

export const DATE_CONTEXT_PATTERN = new RegExp(
  `${NOT_WORD_BEFORE}(?:` +
    `(?:${MONTH_ALTERNATION})\\s+\\d{1,2}(?:,\\s*\\d{4})?` +
    "|" +
    `\\d{1,2}\\s+(?:${MONTH_ALTERNATION})(?:\\s+\\d{4})?` +
    "|" +
    "\\d{4}-\\d{1,2}-\\d{1,2}" +
    "|" +
    "\\d{1,2}/\\d{1,2}/\\d{2,4}" +
    `)${NOT_WORD_AFTER}`,
  "giu",
);

/**
 * @typedef {{original: string, article_date: string, article_date_display: string, has_time: boolean}} ParsedArticleDate
 */

/**
 * @param {string} value
 * @param {string} targetTimezone
 * @param {{assumeZone?: string | null}} [options] `assumeZone` is the IANA zone
 *   a timestamp WITHOUT an offset is read in. The Aniimo API stamps every
 *   article "2026-09-22 00:00:12" in the studio's own clock (Asia/Shanghai)
 *   and says so nowhere, so the collector has to say it here; without the
 *   option such a value keeps its date and drops its time, as it always did.
 * @returns {ParsedArticleDate | null}
 */
export function parseArticleDate(value, targetTimezone, { assumeZone = null } = {}) {
  if (!value || !String(value).trim()) {
    return null;
  }

  const rawValue = cleanDateText(String(value));
  if (!rawValue) {
    return null;
  }

  const parsed = parseFuzzyDateTime(rawValue);
  if (parsed === null) {
    logger.warning(`Could not parse article date ${JSON.stringify(value)}`);
    return null;
  }

  const hasTime = looksLikeDatetime(rawValue);
  if (parsed.offsetMinutes === null && hasTime && assumeZone) {
    const assumed = loadAssumedZone(assumeZone);
    if (assumed !== null) {
      const converted = DateTime.fromObject(
        {
          year: parsed.year,
          month: parsed.month,
          day: parsed.day,
          hour: parsed.hour,
          minute: parsed.minute,
          second: parsed.second,
        },
        { zone: assumed },
      ).setZone(loadTimezone(targetTimezone));
      return {
        original: rawValue,
        article_date: isoMinutes(converted),
        article_date_display: formatUkrainianArticleDate(converted, true, targetTimezone),
        has_time: true,
      };
    }
  }

  if (parsed.offsetMinutes === null) {
    return {
      original: rawValue,
      article_date: isoDate(parsed),
      article_date_display: formatUkrainianArticleDate(
        DateTime.fromObject(
          { year: parsed.year, month: parsed.month, day: parsed.day, hour: 0, minute: 0, second: 0 },
          { zone: "utc" },
        ),
        false,
        targetTimezone,
      ),
      has_time: false,
    };
  }

  const converted = toDateTime(parsed).setZone(loadTimezone(targetTimezone));
  const machineValue = hasTime ? isoMinutes(converted) : converted.toFormat("yyyy-MM-dd");

  return {
    original: rawValue,
    article_date: machineValue,
    article_date_display: formatUkrainianArticleDate(converted, hasTime, targetTimezone),
    has_time: hasTime,
  };
}

export function formatUkrainianArticleDate(value, hasTime, targetTimezone) {
  const month = t(`date.months.${value.month}`);
  const datePart = `${value.day} ${month} ${value.year}`;

  if (!hasTime) {
    return t("date.published_date", { date: datePart });
  }

  const zoneLabel = timezoneLabel(targetTimezone, value);
  return t("date.published_datetime", {
    date: datePart,
    time: value.toFormat("HH:mm"),
    timezone_label: zoneLabel,
  });
}

// How many conversion notes a prompt gets. A note is ~60 characters, so even
// the cap is a few hundred bytes next to a 12 000-character body; it exists
// only to keep a pathological page (a timetable) from flooding the prompt. The
// Aniimo update notices legitimately carry 16+ distinct windows (every event's
// start and end, each with its own date), which the old cap of 12 silently cut.
export const MAX_DATETIME_NOTES = 32;

/**
 * One note per clock time that carries a UTC/GMT zone, converted into the
 * target zone: "00:00 UTC+8 (2026-09-23) -> 19:00 за Києвом (22 вересня 2026)".
 *
 * The zone is taken from the marker that FOLLOWS the time within the same
 * range/sentence segment, so "00:00 – 10:00 (UTC+8)" converts both endpoints,
 * and "September 25, 2026, 10:00 – December 10, 2026, 07:59 (UTC+8)" gives each
 * endpoint its own calendar date (the nearest date before it on the line, per
 * findContextDate). The old adjacent form "10:00 UTC" / "18:30 GMT+2" is the
 * degenerate one-time segment and keeps its exact label, which gemini.js
 * matches back against the draft.
 *
 * Notes whose date was found on the line come first, in text order; a note
 * that had to borrow the article's own date (a recurring "every Thursday
 * 04:00 to Monday 03:59" sentence) goes after them, so when the cap bites it
 * is the guesswork that is cut, never a real dated window. When something IS
 * cut, a final line says how many times are left unconverted, so the model
 * leaves them in the source zone instead of extrapolating from the notes it
 * did get (the one window past a DST switch is exactly the kind that would be
 * extrapolated wrong).
 */
export function buildUtcTimeConversionNotes(text, { article_date, target_timezone }) {
  if (!text) {
    return "";
  }

  const conversions = findZonedTimes(text);
  if (!conversions.length) {
    return "";
  }

  const targetTz = loadTimezone(target_timezone);
  const baseDate = machineDateToDate(article_date);
  const dated = [];
  const undated = [];
  const seen = new Set();

  for (const { label, position, hour, minute, offset } of conversions) {
    const contextDate = findContextDate(text, position, baseDate);
    const sourceDate = contextDate ?? baseDate;

    let note;
    if (sourceDate === null) {
      note =
        `${label}: дата не знайдена, тому конвертація в Europe/Kyiv ненадійна. ` +
        "Не вигадуй час; якщо згадуєш його, залиш оригінальний UTC/GMT.";
    } else {
      const sourceDt = DateTime.fromObject(
        { year: sourceDate.year, month: sourceDate.month, day: sourceDate.day, hour, minute },
        { zone: timezoneFromUtcOffset(offset) },
      );
      const converted = sourceDt.setZone(targetTz);
      const convertedLabel = formatConvertedTimeLabel(converted, target_timezone, sourceDate);
      note = `${label} (${formatIsoDate(sourceDate)}) -> ${convertedLabel}`;
    }

    if (seen.has(note)) {
      continue;
    }

    seen.add(note);
    (contextDate === null ? undated : dated).push(note);
  }

  const unique = dated.concat(undated);
  if (!unique.length) {
    return "";
  }

  const notes = unique.slice(0, MAX_DATETIME_NOTES);
  const dropped = unique.length - notes.length;
  if (dropped > 0) {
    notes.push(truncatedNotesLine(dropped));
  }

  return notes.map((note) => `- ${note}`).join("\n");
}

/**
 * The trailer that tells the model some times did not get a note. Exported for
 * the tests, which assert the prompt is told rather than left to guess.
 */
export function truncatedNotesLine(dropped) {
  return (
    `Ще ${dropped} ${pluralTimes(dropped)} у тексті не сконвертовано — залиш їх в оригінальному поясі ` +
    "(UTC+8 / UTC / GMT), не вигадуй конвертацію за аналогією з нотатками вище."
  );
}

/** "1 час", "2 часи", "5 часів" — the Ukrainian count form of "time (of day)". */
function pluralTimes(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return "час";
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "часи";
  }
  return "часів";
}

/**
 * Every clock time that a UTC/GMT marker applies to, in text order, with the
 * marker's offset text and the label the note should carry.
 *
 * @returns {Array<{label: string, position: number, hour: number, minute: number, offset: string | undefined}>}
 */
function findZonedTimes(text) {
  const found = [];
  let previousMarkerEnd = 0;

  UTC_ZONE_PATTERN.lastIndex = 0;
  for (const marker of text.matchAll(UTC_ZONE_PATTERN)) {
    const markerEnd = marker.index + marker[0].length;
    const segmentStart = findSegmentStart(text, marker.index, previousMarkerEnd);
    previousMarkerEnd = markerEnd;

    const segment = text.slice(segmentStart, marker.index);
    CLOCK_TIME_PATTERN.lastIndex = 0;
    for (const time of segment.matchAll(CLOCK_TIME_PATTERN)) {
      const timeEnd = time.index + time[0].length;
      const trailing = segment.slice(timeEnd);
      const foreign = FOREIGN_ZONE_PATTERN.exec(trailing);
      if (foreign !== null && !/^(?:UTC|GMT)$/.test(foreign.groups.zone)) {
        continue;
      }

      const position = segmentStart + time.index;
      found.push({
        label: zonedTimeLabel(text, position, segmentStart + timeEnd, marker),
        position,
        hour: clockHour(Number(time.groups.hour), time.groups.meridiem),
        minute: Number(time.groups.minute),
        offset: marker.groups.offset ?? marker.groups.bare_offset,
      });
    }
  }

  return found;
}

function findSegmentStart(text, markerStart, previousMarkerEnd) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, markerStart - 1)) + 1;
  const windowStart = Math.max(lineStart, previousMarkerEnd);

  const window = text.slice(windowStart, markerStart);
  let lastBreak = -1;
  SENTENCE_BREAK_PATTERN.lastIndex = 0;
  for (const match of window.matchAll(SENTENCE_BREAK_PATTERN)) {
    lastBreak = match.index;
  }

  return lastBreak === -1 ? windowStart : windowStart + lastBreak + 1;
}

/**
 * The "original" half of a note. A time butting against its marker
 * ("10:00 UTC", "18:30 GMT +2") keeps the literal text so the label is exactly
 * what UTC_TIME_PATTERN used to produce; a range endpoint gets the marker
 * normalised onto it ("00:00 UTC+8") because the literal "00:00 – 10:00（UTC+8）"
 * belongs to two different conversions.
 */
function zonedTimeLabel(text, timeStart, timeEnd, marker) {
  const gap = text.slice(timeEnd, marker.index);
  if (!marker.groups.open && /^\s*$/.test(gap)) {
    return text.slice(timeStart, marker.index + marker[0].length);
  }

  const zone = (marker.groups.zone ?? marker.groups.bare_zone).toUpperCase();
  const offset = (marker.groups.offset ?? marker.groups.bare_offset ?? "").replaceAll(/\s+/g, "");
  return `${text.slice(timeStart, timeEnd).trim()} ${zone}${offset}`;
}

function clockHour(hour, meridiem) {
  if (!meridiem) {
    return hour;
  }

  const isPm = meridiem.toLowerCase().startsWith("p");
  if (isPm && hour < 12) {
    return hour + 12;
  }
  if (!isPm && hour === 12) {
    return 0;
  }
  return hour;
}

function cleanDateText(value) {
  return collapseWhitespace(value);
}

function looksLikeDatetime(value) {
  return Boolean(/\d{1,2}:\d{2}/.test(value) || new RegExp(`${NOT_WORD_BEFORE}\\d{1,2}\\s*(?:AM|PM)${NOT_WORD_AFTER}`, "iu").test(value) || value.includes("T"));
}

/**
 * Resolve an IANA timezone name, falling back the same way the Python version
 * did: the configured zone, then Europe/Kyiv, then UTC. A typo in
 * ARTICLE_TIMEZONE must never stop the bot.
 */
function loadTimezone(targetTimezone) {
  if (IANAZone.isValidZone(targetTimezone)) {
    return IANAZone.create(targetTimezone);
  }
  logger.warning(`Unknown ARTICLE_TIMEZONE ${JSON.stringify(targetTimezone)}. Falling back to Europe/Kyiv.`);
  if (IANAZone.isValidZone("Europe/Kyiv")) {
    return IANAZone.create("Europe/Kyiv");
  }
  logger.warning("Europe/Kyiv timezone data is unavailable. Falling back to UTC.");
  return FixedOffsetZone.utcInstance;
}

/**
 * The zone a naive timestamp is read in. Unlike the target zone this has no
 * sensible fallback — guessing UTC for a clock that is really UTC+8 would put
 * every article eight hours off — so a bad name means the time is dropped and
 * the value is parsed the way it always was, with a warning to show why.
 */
function loadAssumedZone(assumeZone) {
  if (IANAZone.isValidZone(assumeZone)) {
    return IANAZone.create(assumeZone);
  }
  logger.warning(`Unknown assumeZone ${JSON.stringify(assumeZone)}. Reading the value as a date only.`);
  return null;
}

function timezoneLabel(targetTimezone, value) {
  const offset = utcOffsetLabel(value);
  if (targetTimezone === "Europe/Kyiv") {
    return t("date.timezone_kyiv");
  }

  return t("date.timezone_generic", { timezone: targetTimezone, offset });
}

function machineDateToDate(value) {
  if (!value) {
    return null;
  }

  const text = String(value);
  const parsed = text.includes("T") ? DateTime.fromISO(text, { setZone: true }) : DateTime.fromISO(text);
  if (!parsed.isValid) {
    return null;
  }
  return { year: parsed.year, month: parsed.month, day: parsed.day };
}

function findContextDate(text, timePosition, fallbackDate) {
  const lineStart = text.lastIndexOf("\n", Math.max(0, timePosition - 1)) + 1;
  let lineEnd = text.indexOf("\n", timePosition);
  if (lineEnd === -1) {
    lineEnd = text.length;
  }

  const window = text.slice(lineStart, lineEnd);
  const relativeTimePosition = timePosition - lineStart;
  const candidates = [];
  DATE_CONTEXT_PATTERN.lastIndex = 0;
  for (const match of window.matchAll(DATE_CONTEXT_PATTERN)) {
    const parsed = parseContextDate(match[0], fallbackDate);
    if (parsed !== null) {
      candidates.push([match.index, parsed]);
    }
  }

  if (!candidates.length) {
    return null;
  }

  const preceding = candidates.filter(([start]) => start <= relativeTimePosition);
  if (preceding.length) {
    return preceding[preceding.length - 1][1];
  }

  return candidates[0][1];
}

function parseContextDate(value, fallbackDate) {
  const hasYear = new RegExp(`${NOT_WORD_BEFORE}\\d{4}${NOT_WORD_AFTER}`, "u").test(value);
  if (!hasYear && fallbackDate === null) {
    return null;
  }

  const defaultYear = (fallbackDate ?? DateTime.now()).year;
  const parsed = parseFuzzyDateTime(value, { year: defaultYear, month: 1, day: 1 });
  if (parsed === null) {
    return null;
  }

  return { year: parsed.year, month: parsed.month, day: parsed.day };
}

/**
 * Python `timezone(sign * timedelta(hours=..., minutes=...))` for the optional
 * `±HH[:MM]` suffix of a "10:00 UTC+3" style time. Anything unparseable falls
 * back to UTC, exactly as before.
 */
function timezoneFromUtcOffset(value) {
  if (!value || !value.trim()) {
    return FixedOffsetZone.utcInstance;
  }

  let normalized = value.replaceAll(" ", "");
  let sign = 1;
  if (normalized.startsWith("-")) {
    sign = -1;
    normalized = normalized.slice(1);
  } else if (normalized.startsWith("+")) {
    normalized = normalized.slice(1);
  }

  let rawHours;
  let rawMinutes;
  if (normalized.includes(":")) {
    const colon = normalized.indexOf(":");
    rawHours = normalized.slice(0, colon);
    rawMinutes = normalized.slice(colon + 1);
  } else if (normalized.length > 2) {
    rawHours = normalized.slice(0, -2);
    rawMinutes = normalized.slice(-2);
  } else {
    rawHours = normalized;
    rawMinutes = "0";
  }

  if (!/^\d+$/.test(rawHours) || !/^\d+$/.test(rawMinutes)) {
    return FixedOffsetZone.utcInstance;
  }
  const hours = Number(rawHours);
  const minutes = Number(rawMinutes);

  if (hours > 23 || minutes > 59) {
    return FixedOffsetZone.utcInstance;
  }

  return FixedOffsetZone.instance(sign * (hours * 60 + minutes));
}

function formatConvertedTimeLabel(value, targetTimezone, sourceDate) {
  const label =
    targetTimezone === "Europe/Kyiv"
      ? `${value.toFormat("HH:mm")} за Києвом`
      : `${value.toFormat("HH:mm")} за часовим поясом ${targetTimezone}`;

  if (value.year !== sourceDate.year || value.month !== sourceDate.month || value.day !== sourceDate.day) {
    return `${label} (${formatUkrainianDateOnly(value)})`;
  }

  return label;
}

function formatUkrainianDateOnly(value) {
  const month = t(`date.months.${value.month}`);
  return `${value.day} ${month} ${value.year}`;
}

function utcOffsetLabel(value) {
  const totalMinutes = value.offset;
  if (totalMinutes === null || totalMinutes === undefined || Number.isNaN(totalMinutes)) {
    return "UTC";
  }

  const sign = totalMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(totalMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  if (minutes === 0) {
    return `UTC${sign}${hours}`;
  }

  return `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

// --------------------------------------------------------------------------- //
// Fuzzy date parsing (the `dateutil.parser.parse(..., fuzzy=True)` replacement)
// --------------------------------------------------------------------------- //

const MONTH_NAMES = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/**
 * Extract a date/time from free text.
 *
 * `dateutil.parser.parse(..., fuzzy=True)` accepted arbitrary prose and pulled a
 * timestamp out of it. There is no equivalent in the Node ecosystem that behaves
 * the same way, so this covers exactly the shapes the collectors actually feed
 * it — a `<time datetime>` attribute, an `article:published_time` meta tag, and
 * the "June 12, 2026" / "12 June 2026" / "2026-06-12" / "6/12/2026" prose the
 * date-context scanner already enumerates in DATE_CONTEXT_PATTERN.
 *
 * Missing components fall back to `defaults`, matching dateutil's `default=`
 * argument. Returns null when the text carries no date and no time at all.
 *
 * @returns {{year:number, month:number, day:number, hour:number, minute:number,
 *            second:number, offsetMinutes:number|null} | null}
 */
export function parseFuzzyDateTime(text, defaults = null) {
  const value = String(text ?? "").trim();
  if (!value) return null;

  const now = DateTime.now();
  const base = defaults ?? { year: now.year, month: now.month, day: now.day };

  // Fast path: a full ISO-8601 timestamp, which is what every well-behaved feed
  // and `<time datetime="...">` attribute emits.
  const iso = DateTime.fromISO(value, { setZone: true });
  if (iso.isValid && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return {
      year: iso.year,
      month: iso.month,
      day: iso.day,
      hour: iso.hour,
      minute: iso.minute,
      second: iso.second,
      offsetMinutes: hasExplicitOffset(value) ? iso.offset : null,
    };
  }

  const rfc = DateTime.fromRFC2822(value, { setZone: true });
  if (rfc.isValid) {
    return {
      year: rfc.year,
      month: rfc.month,
      day: rfc.day,
      hour: rfc.hour,
      minute: rfc.minute,
      second: rfc.second,
      offsetMinutes: rfc.offset,
    };
  }

  const date = extractDateParts(value);
  const time = extractTimeParts(value);
  if (date === null && time === null) {
    return null;
  }

  const offsetMinutes = extractOffsetMinutes(value);
  return {
    year: date?.year ?? base.year,
    month: date?.month ?? base.month ?? 1,
    day: date?.day ?? base.day ?? 1,
    hour: time?.hour ?? 0,
    minute: time?.minute ?? 0,
    second: time?.second ?? 0,
    offsetMinutes,
  };
}

function hasExplicitOffset(value) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim());
}

function extractDateParts(value) {
  let match = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (match) {
    return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  const monthWord = `(${Object.keys(MONTH_NAMES).sort((a, b) => b.length - a.length).join("|")})`;

  // Day-first ("12 June 2026") is tried BEFORE month-first: on that input the
  // month-first pattern would otherwise read the leading "20" of the year as the
  // day. The `(?!\d)` guards keep either pattern from slicing a day out of a
  // four-digit year in the first place.
  match = new RegExp(
    `${NOT_WORD_BEFORE}(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\s+${monthWord}\\.?(?:,?\\s*(\\d{4}))?`,
    "iu",
  ).exec(value);
  if (match) {
    return validDate(match[3] ? Number(match[3]) : null, MONTH_NAMES[match[2].toLowerCase()], Number(match[1]));
  }

  match = new RegExp(
    `${NOT_WORD_BEFORE}${monthWord}\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`,
    "iu",
  ).exec(value);
  if (match) {
    return validDate(match[3] ? Number(match[3]) : null, MONTH_NAMES[match[1].toLowerCase()], Number(match[2]));
  }

  // dateutil defaults to month/day/year for ambiguous slash dates.
  match = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(value);
  if (match) {
    const rawYear = Number(match[3]);
    const year = match[3].length === 2 ? (rawYear < 69 ? 2000 + rawYear : 1900 + rawYear) : rawYear;
    return validDate(year, Number(match[1]), Number(match[2]));
  }

  return null;
}

function validDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return { year, month, day };
}

function extractTimeParts(value) {
  let match = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i.exec(value);
  if (match) {
    let hour = Number(match[1]);
    const meridiem = match[4]?.toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23 || Number(match[2]) > 59) return null;
    return { hour, minute: Number(match[2]), second: match[3] ? Number(match[3]) : 0 };
  }

  match = new RegExp(`${NOT_WORD_BEFORE}(\\d{1,2})\\s*(am|pm)${NOT_WORD_AFTER}`, "iu").exec(value);
  if (match) {
    let hour = Number(match[1]);
    const meridiem = match[2].toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (hour > 23) return null;
    return { hour, minute: 0, second: 0 };
  }

  return null;
}

function extractOffsetMinutes(value) {
  // "GMT+2" means UTC+02:00 here, i.e. what a news page means by it.
  //
  // This is a DELIBERATE divergence from the Python original, which used
  // dateutil: dateutil follows the POSIX TZ convention and reads "GMT+2" as
  // UTC-02:00, so an article stamped "18:30 GMT+2" was published four hours off.
  // The Python code was also inconsistent with itself — buildUtcTimeConversionNotes
  // below reads the very same suffix the non-inverted way. Do not "restore" the
  // dateutil behaviour to match the old implementation; it was the bug.
  const explicit = /(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?([0-5]\d))?/i.exec(value);
  if (explicit) {
    const sign = explicit[1] === "-" ? -1 : 1;
    return sign * (Number(explicit[2]) * 60 + Number(explicit[3] ?? 0));
  }

  if (new RegExp(`${NOT_WORD_BEFORE}(?:UTC|GMT|Z)${NOT_WORD_AFTER}`, "iu").test(value)) {
    return 0;
  }

  const numeric = /([+-])(\d{2}):?(\d{2})\s*$/.exec(value);
  if (numeric) {
    const sign = numeric[1] === "-" ? -1 : 1;
    return sign * (Number(numeric[2]) * 60 + Number(numeric[3]));
  }

  return null;
}

function toDateTime(parsed) {
  return DateTime.fromObject(
    {
      year: parsed.year,
      month: parsed.month,
      day: parsed.day,
      hour: parsed.hour,
      minute: parsed.minute,
      second: parsed.second,
    },
    { zone: FixedOffsetZone.instance(parsed.offsetMinutes ?? 0) },
  );
}

function isoDate(parsed) {
  return `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-${String(parsed.day).padStart(2, "0")}`;
}

function formatIsoDate(date) {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** Python's `datetime.isoformat(timespec="minutes")` — seconds always dropped. */
function isoMinutes(value) {
  return value.toFormat("yyyy-MM-dd'T'HH:mmZZ");
}
