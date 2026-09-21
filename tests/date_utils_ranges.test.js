/**
 * Tests for the UTC+8 time handling Aniimo's copy needs: a single "(UTC+8)" /
 * "（UTC+8）" marker at the end of a range converting EVERY clock time before
 * it, each endpoint with its own calendar date; the legacy adjacent forms
 * ("10:00 UTC", "18:30 GMT+2") staying byte-for-byte the same; and
 * parseArticleDate reading the API's naive "2026-09-22 00:00:12" stamps in the
 * studio's clock when told to.
 */

import fs from "node:fs";

import { expect, it } from "vitest";

import {
  MAX_DATETIME_NOTES,
  UTC_ZONE_PATTERN,
  buildUtcTimeConversionNotes,
  parseArticleDate,
  truncatedNotesLine,
} from "../services/date_utils.js";
import { getText, loadHtml } from "../services/html.js";

const KYIV = "Europe/Kyiv";
const ARTICLE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/aniimo/official_article_100145.json", import.meta.url), "utf8"),
);

function notes(text, articleDate = "2026-09-21T19:00+03:00") {
  return buildUtcTimeConversionNotes(text, { article_date: articleDate, target_timezone: KYIV });
}

function lines(text) {
  return text ? text.split("\n") : [];
}

/** The body the official collector produces: one line per block element. */
function articleBodyLines(html) {
  const $ = loadHtml(html);
  const blocks = [];
  $("h2, h3, h4, p, li").each((_index, element) => {
    const text = getText($(element)).replace(/\s+/g, " ").trim();
    if (text) {
      blocks.push(text);
    }
  });
  return blocks;
}

function normalizeFullwidthParens(text) {
  return text.replaceAll("（", "(").replaceAll("）", ")");
}

// ---- ranges ---------------------------------------------------------------- //

it("applies a trailing fullwidth (UTC+8) to both endpoints of a same-day range", () => {
  expect(lines(notes("September 23, 2026, 00:00 – 10:00（UTC+8）"))).toEqual([
    "- 00:00 UTC+8 (2026-09-23) -> 19:00 за Києвом (22 вересня 2026)",
    "- 10:00 UTC+8 (2026-09-23) -> 05:00 за Києвом",
  ]);
});

it.each([
  "September 23, 2026, 00:00 - 10:00 (UTC+8)",
  "September 23, 2026, 00:00 to 10:00 (UTC+8)",
  "[Maintenance Window]: September 23, 2026, 00:00 – 10:00 (UTC+8)",
  "from September 23, 2026, 00:00 to 10:00 （UTC+8） .",
])("accepts ASCII parentheses, hyphens and 'to' as range syntax: %s", (text) => {
  expect(lines(notes(text))).toEqual([
    "- 00:00 UTC+8 (2026-09-23) -> 19:00 за Києвом (22 вересня 2026)",
    "- 10:00 UTC+8 (2026-09-23) -> 05:00 за Києвом",
  ]);
});

it("gives each endpoint of a multi-month range its own date and DST offset", () => {
  // Kyiv is UTC+3 in September and UTC+2 in December: -5h and -6h from UTC+8.
  expect(lines(notes("September 25, 2026, 10:00 – December 10, 2026, 07:59（UTC+8）"))).toEqual([
    "- 10:00 UTC+8 (2026-09-25) -> 05:00 за Києвом",
    "- 07:59 UTC+8 (2026-12-10) -> 01:59 за Києвом",
  ]);
});

it("converts a single time followed by a bracketed zone", () => {
  expect(lines(notes("as of September 22, 2026, at 00:00 (UTC+8)"))).toEqual([
    "- 00:00 UTC+8 (2026-09-22) -> 19:00 за Києвом (21 вересня 2026)",
  ]);
});

it("applies a bare trailing UTC+8 to every time in the sentence", () => {
  expect(lines(notes("Servers are down September 23, 2026, 00:00 – 10:00 UTC+8 for the update"))).toEqual([
    "- 00:00 UTC+8 (2026-09-23) -> 19:00 за Києвом (22 вересня 2026)",
    "- 10:00 UTC+8 (2026-09-23) -> 05:00 за Києвом",
  ]);
});

it("falls back to the article date for a range with no date on its line", () => {
  expect(lines(notes("Every week from Thursday 04:00 to Monday 03:59 post-update（UTC+8）"))).toEqual([
    "- 04:00 UTC+8 (2026-09-21) -> 23:00 за Києвом (20 вересня 2026)",
    "- 03:59 UTC+8 (2026-09-21) -> 22:59 за Києвом (20 вересня 2026)",
  ]);
});

it("does not let a marker reach back past a sentence boundary or a line break", () => {
  expect(lines(notes("Ends June 12 at 09:00. Maintenance 10:00 – 12:00 (UTC+8)"))).toEqual([
    "- 10:00 UTC+8 (2026-06-12) -> 05:00 за Києвом",
    "- 12:00 UTC+8 (2026-06-12) -> 07:00 за Києвом",
  ]);
  expect(lines(notes("Local time 09:00 on June 12\nMaintenance 10:00 – 12:00 (UTC+8)"))).toEqual([
    "- 10:00 UTC+8 (2026-09-21) -> 05:00 за Києвом",
    "- 12:00 UTC+8 (2026-09-21) -> 07:00 за Києвом",
  ]);
});

it("does not let a marker reach back past an earlier marker", () => {
  expect(lines(notes("June 12: 10:00 UTC, then 12:00 – 14:00 (UTC+8)"))).toEqual([
    "- 10:00 UTC (2026-06-12) -> 13:00 за Києвом",
    "- 12:00 UTC+8 (2026-06-12) -> 07:00 за Києвом",
    "- 14:00 UTC+8 (2026-06-12) -> 09:00 за Києвом",
  ]);
});

it("leaves times that carry a zone of their own alone", () => {
  expect(lines(notes("Live June 12 at 10:00 PT and 19:00 CET, that is 18:00 UTC"))).toEqual([
    "- 18:00 UTC (2026-06-12) -> 21:00 за Києвом",
  ]);
});

it("reads a 12-hour clock before a bracketed zone", () => {
  expect(lines(notes("Opens June 12 at 5:00 PM (UTC+8)"))).toEqual([
    "- 5:00 PM UTC+8 (2026-06-12) -> 12:00 за Києвом",
  ]);
});

it("does not read the seconds of a timestamp as a second time", () => {
  expect(lines(notes("Server time 2026-09-22 00:00:12 (UTC+8)"))).toEqual([
    "- 00:00:12 UTC+8 (2026-09-22) -> 19:00 за Києвом (21 вересня 2026)",
  ]);
});

it("ignores a zone marker with no clock time in front of it", () => {
  expect(notes("All times are UTC+8 unless stated otherwise")).toBe("");
  expect(notes("Nothing to convert here")).toBe("");
  expect(notes("")).toBe("");
});

it("dedups identical conversions", () => {
  expect(lines(notes("June 12: 10:00 UTC+8 and again 10:00 – 10:00 (UTC+8)"))).toEqual([
    "- 10:00 UTC+8 (2026-06-12) -> 05:00 за Києвом",
  ]);
});

it("keeps every distinct window of a long notice under the cap", () => {
  // The real update notices carry 16+ windows; the old cap of 12 silently cut
  // the tail, which is where the post-DST endpoints live.
  expect(MAX_DATETIME_NOTES).toBeGreaterThanOrEqual(32);
  const times = Array.from({ length: 20 }, (_, index) => `${String(index).padStart(2, "0")}:00`);
  const result = lines(notes(`June 12: ${times.join(" – ")} (UTC+8)`));
  expect(result).toHaveLength(20);
  expect(result[0]).toBe("- 00:00 UTC+8 (2026-06-12) -> 19:00 за Києвом (11 червня 2026)");
  expect(result[19]).toBe("- 19:00 UTC+8 (2026-06-12) -> 14:00 за Києвом");
  expect(result.join("\n")).not.toContain("не сконвертовано");
});

it("tells the prompt how many times were cut when the cap bites", () => {
  // Half-hour steps: 35 distinct clock times fit inside one day.
  const times = Array.from(
    { length: MAX_DATETIME_NOTES + 3 },
    (_, index) => `${String(Math.floor(index / 2)).padStart(2, "0")}:${index % 2 ? "30" : "00"}`,
  );
  const result = lines(notes(`June 12: ${times.join(" – ")} (UTC+8)`));
  // The cap's worth of notes plus one trailer line, never a silent cut.
  expect(result).toHaveLength(MAX_DATETIME_NOTES + 1);
  expect(result[MAX_DATETIME_NOTES]).toBe(`- ${truncatedNotesLine(3)}`);
  expect(result[MAX_DATETIME_NOTES]).toBe(
    "- Ще 3 часи у тексті не сконвертовано — залиш їх в оригінальному поясі (UTC+8 / UTC / GMT), " +
      "не вигадуй конвертацію за аналогією з нотатками вище.",
  );
  // The Ukrainian count forms of the trailer.
  expect(truncatedNotesLine(1)).toMatch(/^Ще 1 час у тексті/);
  expect(truncatedNotesLine(5)).toMatch(/^Ще 5 часів у тексті/);
  expect(truncatedNotesLine(11)).toMatch(/^Ще 11 часів у тексті/);
  expect(truncatedNotesLine(22)).toMatch(/^Ще 22 часи у тексті/);
});

it("puts notes that borrowed the article date after the ones dated on their line", () => {
  // The recurring weekly-window sentence has no date of its own and comes
  // FIRST in the text; the dated windows after it must not be the ones a cap
  // would displace, so they are listed first.
  const text = [
    "Every week from Thursday 04:00 to Monday 03:59 post-update (UTC+8)",
    "October 1, 2026, 04:00 – October 29, 2026, 03:59 (UTC+8)",
  ].join("\n");
  expect(lines(notes(text))).toEqual([
    "- 04:00 UTC+8 (2026-10-01) -> 23:00 за Києвом (30 вересня 2026)",
    "- 03:59 UTC+8 (2026-10-29) -> 21:59 за Києвом (28 жовтня 2026)",
    "- 04:00 UTC+8 (2026-09-21) -> 23:00 за Києвом (20 вересня 2026)",
    "- 03:59 UTC+8 (2026-09-21) -> 22:59 за Києвом (20 вересня 2026)",
  ]);
});

it("flags a conversion it cannot date rather than inventing one", () => {
  const result = notes("Downtime 00:00 – 10:00 (UTC+8)", null);
  expect(lines(result)).toEqual([
    "- 00:00 UTC+8: дата не знайдена, тому конвертація в Europe/Kyiv ненадійна. Не вигадуй час; якщо згадуєш його, залиш оригінальний UTC/GMT.",
    "- 10:00 UTC+8: дата не знайдена, тому конвертація в Europe/Kyiv ненадійна. Не вигадуй час; якщо згадуєш його, залиш оригінальний UTC/GMT.",
  ]);
});

// ---- legacy adjacent forms ------------------------------------------------- //

it.each([
  ["Servers restart June 12 at 10:00 UTC", "- 10:00 UTC (2026-06-12) -> 13:00 за Києвом"],
  ["Patch drops June 12 at 18:30 GMT+2", "- 18:30 GMT+2 (2026-06-12) -> 19:30 за Києвом"],
  ["Patch drops June 12 at 18:30 GMT +2 sharp", "- 18:30 GMT +2 (2026-06-12) -> 19:30 за Києвом"],
  ["Patch drops June 12 at 18:30GMT+2 sharp", "- 18:30GMT+2 (2026-06-12) -> 19:30 за Києвом"],
  ["Live at 23:30 UTC-5 on June 12", "- 23:30 UTC-5 (2026-06-12) -> 07:30 за Києвом (13 червня 2026)"],
  ["At 10:00 UTC+05:30 on June 12", "- 10:00 UTC+05:30 (2026-06-12) -> 07:30 за Києвом"],
  ["(all times June 12 10:00 UTC+8)", "- 10:00 UTC+8 (2026-06-12) -> 05:00 за Києвом"],
])("keeps the legacy label for a time glued to its zone: %s", (text, expected) => {
  expect(lines(notes(text))).toEqual([expected]);
});

it("still handles a pair of adjacent zones on one line", () => {
  expect(lines(notes("Maintenance 2026-06-12 02:00 UTC to 06:00 UTC"))).toEqual([
    "- 02:00 UTC (2026-06-12) -> 05:00 за Києвом",
    "- 06:00 UTC (2026-06-12) -> 09:00 за Києвом",
  ]);
});

it("matches the zone marker in every spelling the sources use", () => {
  for (const sample of ["（UTC+8）", "(UTC+8)", "UTC+8", "GMT +2", "utc", "(GMT-05:30)"]) {
    UTC_ZONE_PATTERN.lastIndex = 0;
    expect(UTC_ZONE_PATTERN.test(sample), sample).toBe(true);
  }
  for (const sample of ["UTCX", "XUTC+8", "8UTC", "UTC+8:60"]) {
    UTC_ZONE_PATTERN.lastIndex = 0;
    expect(sample.match(UTC_ZONE_PATTERN)?.[0] ?? null, sample).not.toBe(sample);
  }
});

// ---- the real article --------------------------------------------------------- //

it.each([
  ["as captured (fullwidth parentheses)", (text) => text],
  ["after normalising the parentheses", normalizeFullwidthParens],
])("converts the maintenance windows of the captured article %s", (_label, prepare) => {
  const body = prepare(articleBodyLines(ARTICLE.data.content).join("\n"));
  expect(body).toContain("September 23, 2026, 00:00");

  const result = lines(notes(body, "2026-09-21T19:00+03:00"));
  // Sixteen distinct windows; every one of them gets a note and nothing is cut.
  expect(result).toHaveLength(16);
  expect(result.length).toBeLessThanOrEqual(MAX_DATETIME_NOTES);
  expect(result.join("\n")).not.toContain("не сконвертовано");
  expect(result).toContain("- 00:00 UTC+8 (2026-09-23) -> 19:00 за Києвом (22 вересня 2026)");
  expect(result).toContain("- 10:00 UTC+8 (2026-09-23) -> 05:00 за Києвом");
  expect(result).toContain("- 10:00 UTC+8 (2026-09-25) -> 05:00 за Києвом");
  expect(result).toContain("- 07:59 UTC+8 (2026-12-10) -> 01:59 за Києвом");
  expect(result).toContain("- 04:00 UTC+8 (2026-09-24) -> 23:00 за Києвом (23 вересня 2026)");
  // The tail the old cap of 12 dropped, including the only endpoint after Kyiv
  // leaves DST (25 Oct 2026): 03:59 UTC+8 is 21:59, not the 22:59 of every
  // earlier note.
  expect(result).toContain("- 04:00 UTC+8 (2026-10-05) -> 23:00 за Києвом (4 жовтня 2026)");
  expect(result).toContain("- 03:59 UTC+8 (2026-10-12) -> 22:59 за Києвом (11 жовтня 2026)");
  expect(result).toContain("- 04:00 UTC+8 (2026-10-01) -> 23:00 за Києвом (30 вересня 2026)");
  expect(result).toContain("- 03:59 UTC+8 (2026-10-29) -> 21:59 за Києвом (28 жовтня 2026)");
  // The recurring "every week from Thursday to Monday" sentence borrows the
  // article's date and is listed last, behind every window dated on its line.
  expect(result.slice(-2)).toEqual([
    "- 04:00 UTC+8 (2026-09-21) -> 23:00 за Києвом (20 вересня 2026)",
    "- 03:59 UTC+8 (2026-09-21) -> 22:59 за Києвом (20 вересня 2026)",
  ]);
  for (const note of result) {
    // Every note is a machine-readable "original (date) -> converted" pair.
    expect(note).toMatch(/^- \d{1,2}:\d{2}(?::\d{2})? UTC\+8 \(\d{4}-\d{2}-\d{2}\) -> \d{2}:\d{2} за Києвом/);
  }
});

// ---- parseArticleDate with assumeZone -------------------------------------- //

it("reads a naive API timestamp in the assumed zone", () => {
  expect(parseArticleDate("2026-09-22 00:00:12", KYIV, { assumeZone: "Asia/Shanghai" })).toEqual({
    original: "2026-09-22 00:00:12",
    article_date: "2026-09-21T19:00+03:00",
    article_date_display: "Дата публікації: 21 вересня 2026, 19:00 за Києвом",
    has_time: true,
  });
  // Winter: Kyiv is six hours behind Shanghai.
  expect(parseArticleDate("2026-12-22 00:00:12", KYIV, { assumeZone: "Asia/Shanghai" }).article_date).toBe(
    "2026-12-21T18:00+02:00",
  );
});

it("keeps the default behaviour for a naive timestamp without assumeZone", () => {
  expect(parseArticleDate("2026-09-22 00:00:12", KYIV)).toEqual({
    original: "2026-09-22 00:00:12",
    article_date: "2026-09-22",
    article_date_display: "Дата публікації: 22 вересня 2026",
    has_time: false,
  });
});

it("lets an explicit offset win over assumeZone and ignores it for a date-only value", () => {
  expect(parseArticleDate("2026-09-22T00:00:12+02:00", KYIV, { assumeZone: "Asia/Shanghai" }).article_date).toBe(
    "2026-09-22T01:00+03:00",
  );
  expect(parseArticleDate("2026-09-22", KYIV, { assumeZone: "Asia/Shanghai" })).toMatchObject({
    article_date: "2026-09-22",
    has_time: false,
  });
});

it("drops the time rather than guessing when assumeZone is not a real zone", () => {
  expect(parseArticleDate("2026-09-22 00:00:12", KYIV, { assumeZone: "Nope/Zone" })).toMatchObject({
    article_date: "2026-09-22",
    has_time: false,
  });
});
