/**
 * Tests for the pure text pipeline in services/gemini.js, run against the real
 * official listing: topic hashtags and post type (title first, body as a
 * fallback), the per-endpoint datetime notes applied to a draft, and the
 * reader-link line the model spells its own way.
 */

import fs from "node:fs";

import { expect, it } from "vitest";

import { buildUtcTimeConversionNotes } from "../services/date_utils.js";
import { __testing, geminiDraftInput } from "../services/gemini.js";
import { getText, loadHtml } from "../services/html.js";
import { t } from "../services/i18n.js";

const { applyDatetimeNotes, ensureRequiredMetadata, officialPostType, prepareOfficialDraft, publicHashtagLine } =
  __testing;

const FIXTURES = new URL("./fixtures/aniimo/", import.meta.url);
const readFixture = (name) => JSON.parse(fs.readFileSync(new URL(name, FIXTURES), "utf8"));
const LISTING = readFixture("official_list.json").data.list;
const ARTICLE = readFixture("official_article_100145.json");

function official(title, body = "", sourceType = "official_aniimo", extra = {}) {
  return geminiDraftInput({
    title,
    article_url: "https://www.aniimo.com/newslist/detail/1",
    article_date_display: null,
    datetime_notes: null,
    body_text: body,
    source_type: sourceType,
    source_name: "офіційний сайт Aniimo",
    ...extra,
  });
}

/** A listing row as the collector's summary fallback would draft it: title + excerpt. */
function listingDraft(id) {
  const row = LISTING.find((item) => item.id === id);
  return official(row.title.replace(/\s*\n\s*/g, " ").trim(), row.describe.trim());
}

// ---- topic hashtags on the real listing ----------------------------------------- //

it.each([
  ["100137", "#МобільнаВерсія #Платформи"], // Aniimo Mobile Pre-Download Now Available! Coming to All Platforms…
  ["100145", "#Оновлення"], // September 23 Update Notice — Setting Out in Pursuit of the Wind: Part I
  ["100115", "#Платформи"], // Aniimo Is Now Live on PC & Console!
  ["100111", "#Подія #Бета"], // IMPORTANT NOTICE: How to Claim Your Beta Test Rewards
  ["100100", "#Виправлення"], // Intel CPU Stability Issues and Solutions
  ["100089", "#Платформи"], // Aniimo PC & Console Pre-Download Now Available! Launching on September 16!
  ["100067", "#Правила"], // Aniimo Fair Play Announcement
  ["100064", "#Анонс"], // A Letter from the Aniimo Dev Team
  ["100051", "#МобільнаВерсія #Платформи"], // Aniimo Global Launch Dates: Coming to PC & Consoles…, Mobile…
  ["100062", "#Анонс"], // A New Way to Connect with Your Aniimo (no topic word, empty excerpt)
  ["100046", "#Бета"], // Global Closed Beta End Notice
  ["100041", "#Подія #Аніімо #Бета"], // Global Closed Beta Bond Pact Event FAQ
  ["100035", "#Бета"], // Welcome to Idyll — nothing in the title, "The Global Closed Beta Begins" in the excerpt
  ["100036", "#Бета"], // Global Closed Beta: Download Guide
  ["100024", "#Креатори"], // Aniimo Global Creator Recruitment Now Open
  ["100025", "#Анонс"], // Your Chance to Join the Adventure before its Global Launch
  ["100023", "#Платформи"], // DLSS 4.5 Coming to Aniimo with Smoother Idyll Adventures
  ["100022", "#Оновлення"], // February 6 Update Notice
  ["100021", "#Бета"], // End Date Announcement of Second Closed Beta
  ["100020", "#Подія #Бета"], // Second Closed Beta: [Reunion Promise] Event FAQ
  ["100011", "#Виправлення"], // Optimized item acquisition conditions
  ["100010", "#Оновлення"], // January 27 Patch Notes
])("tags listing item %s as %s", (id, expected) => {
  expect(publicHashtagLine(listingDraft(id))).toBe(`#Aniimo ${expected}`);
});

it("never tags a post with the game's own name, the setting or an FAQ word", () => {
  // "aniimo", "idyll"/"world", "issue", "store", "video", "balance" are in nearly
  // every Aniimo article; none is a topic. Across the whole listing the only
  // #Аніімо is the Bond Pact FAQ, and #Локації / #Магазин / #Трейлер never fire.
  for (const row of LISTING) {
    const line = publicHashtagLine(listingDraft(row.id));
    if (row.id !== "100041") {
      expect(line, row.title).not.toContain("#Аніімо");
    }
    expect(line, row.title).not.toMatch(/#Локації|#Баланс|#Магазин|#Трейлер/);
  }
  expect(publicHashtagLine(official("Aniimo", "Welcome to Idyll, the world of Aniimo"))).toBe(
    "#Aniimo #Анонс",
  );
});

it("leads with the title topic and tops up from the body", () => {
  // The title decides and comes first; the body lead may add what the
  // headline left out, because one headline rarely names every angle.
  const body = ARTICLE.data.content;
  expect(publicHashtagLine(official(ARTICLE.data.title, body))).toBe("#Aniimo #Оновлення #ТехнічніРоботи");
  // The mobile pre-download FAQ: "issue", "balance", "App Store" and "video"
  // deep in the body used to give "#Виправлення #Баланс #Подія". Only the
  // lead is read now, so the headline topic still leads and the tail is short.
  const faq =
    "If you encounter an issue, check your account balance in the App Store. Watch the video. " +
    "Rewards for the launch event will be sent by mail.";
  const line = publicHashtagLine(official("Aniimo Mobile Pre-Download Now Available!", faq));
  expect(line.startsWith("#Aniimo #МобільнаВерсія")).toBe(true);
  expect(line).not.toContain("#Виправлення");
  expect(line).not.toContain("#Баланс");
});

it("falls back to the body only when the title says nothing", () => {
  expect(publicHashtagLine(official("Dear Pathfinders", "A new outfit bundle is in the shop"))).toBe(
    "#Aniimo #Магазин #Косметика",
  );
  // A bare "store"/"balance"/"video"/"test" in the body is no longer a topic.
  expect(publicHashtagLine(official("Dear Pathfinders", "Get it on the App Store; your balance; a video; test"))).toBe(
    "#Aniimo #Анонс",
  );
  expect(publicHashtagLine(official("Dear Pathfinders", "Balance adjustments to the in-game store prices"))).toBe(
    "#Aniimo #Баланс #Магазин",
  );
});

it("keeps the short-form and rumour tagging on the same title-first rule", () => {
  expect(publicHashtagLine(official("New trailer reveal", "watch the trailer", "youtube"))).toBe(
    "#Aniimo #Трейлер",
  );
  expect(publicHashtagLine(official("New outfit leaked", "a datamined costume for Emberpup", "reddit"))).toBe(
    "#Aniimo #Чутки #Косметика",
  );
});

// ---- post type ------------------------------------------------------------------ //

it.each([
  ["100145", "patch"],
  ["100067", "announcement"], // "video" in a Fair Play body no longer makes it a trailer
  ["100100", "announcement"],
  ["100041", "event"],
  ["100010", "patch"],
])("classifies listing item %s as %s", (id, expected) => {
  expect(officialPostType(listingDraft(id))).toBe(expected);
});

it("classifies by the title first and the body only as a fallback", () => {
  expect(officialPostType(official("Aniimo Fair Play Announcement", "watch the video about the event"))).toBe(
    "announcement",
  );
  expect(officialPostType(official("Dear Pathfinders", "a new outfit is in the shop"))).toBe("shop");
  expect(officialPostType(official("Dear Pathfinders", "the App Store listing; a video"))).toBe("announcement");
});

// ---- datetime notes applied to a draft ------------------------------------------ //

/** The captured update notice's body, as the collector lines it up. */
function articleBody() {
  const $ = loadHtml(ARTICLE.data.content);
  const blocks = [];
  $("h2, h3, h4, p, li").each((_index, element) => {
    const text = getText($(element)).replace(/\s+/g, " ").trim();
    if (text) {
      blocks.push(text);
    }
  });
  return blocks.join("\n").replaceAll("（", "(").replaceAll("）", ")");
}

const REAL_NOTES = buildUtcTimeConversionNotes(articleBody(), {
  article_date: "2026-09-21T17:32+03:00",
  target_timezone: "Europe/Kyiv",
});

it("leaves a label with several conversions to the model instead of stamping the first", () => {
  // "04:00 UTC+8" and "03:59 UTC+8" each convert to a different date per window.
  expect(REAL_NOTES.match(/^- 04:00 UTC\+8 /gm).length).toBeGreaterThan(1);
  const draft =
    "Івент триває з 1 жовтня, 04:00 UTC+8 до 29 жовтня, 03:59 UTC+8. " +
    "Відкриття 24 вересня о 04:00 UTC+8. Старт 5:00 PM UTC+8.";
  const result = applyDatetimeNotes(draft, REAL_NOTES);
  // The ambiguous labels stay exactly as written: no "(20 вересня 2026)" next to
  // "1 жовтня", and no 22:59 for the post-DST 29 October endpoint.
  expect(result).toContain("з 1 жовтня, 04:00 UTC+8 до 29 жовтня, 03:59 UTC+8.");
  expect(result).toContain("24 вересня о 04:00 UTC+8.");
  expect(result).not.toContain("20 вересня");
  expect(result).not.toContain("22:59");
});

it("still rewrites a label that maps to exactly one conversion", () => {
  expect(REAL_NOTES).toContain("- 10:00 UTC+8 (2026-09-23) -> 05:00 за Києвом");
  expect(REAL_NOTES).toContain("- 07:59 UTC+8 (2026-12-10) -> 01:59 за Києвом");
  const result = applyDatetimeNotes("Сервери повернуться о 10:00 UTC+8, івент до 07:59 UTC+8.", REAL_NOTES);
  expect(result).toBe("Сервери повернуться о 05:00 за Києвом, івент до 01:59 за Києвом.");
});

it("rewrites the meridiem and seconds labels the notes now carry", () => {
  const notes = [
    "- 5:00 PM UTC+8 (2026-06-12) -> 12:00 за Києвом",
    "- 00:00:12 UTC+8 (2026-09-22) -> 19:00 за Києвом (21 вересня 2026)",
    "- 18:30 GMT +2 (2026-06-12) -> 19:30 за Києвом",
  ].join("\n");
  expect(applyDatetimeNotes("Старт 5:00 PM UTC+8; реліз 00:00:12 UTC+8; патч 18:30 GMT +2.", notes)).toBe(
    "Старт 12:00 за Києвом; реліз 19:00 за Києвом (21 вересня 2026); патч 19:30 за Києвом.",
  );
  // Two notes agreeing on one conversion are one conversion, not an ambiguity.
  const agreeing = "- 10:00 UTC+8 (2026-09-23) -> 05:00 за Києвом\n- 10:00 UTC+8 (2026-09-25) -> 05:00 за Києвом";
  expect(applyDatetimeNotes("о 10:00 UTC+8", agreeing)).toBe("о 05:00 за Києвом");
  expect(applyDatetimeNotes("", notes)).toBe("");
  expect(applyDatetimeNotes("text", null)).toBe("text");
});

// ---- the reader-link line in the model's own spelling --------------------------- //

const CTA_VARIANTS = [
  ["hyphen", (line) => line.replace(" — ", " - ")],
  ["en dash", (line) => line.replace(" — ", " – ")],
  ["no dash", (line) => line.replace(" — ", " ")],
  ["exact", (line) => line],
];

it.each(CTA_VARIANTS)("replaces the official site CTA written with a %s by the canonical line once", (_name, spell) => {
  const canonical = t("gemini.attribution.official_aniimo");
  const draft = `Новина тут.\n\n${spell(canonical)}\n\n#X`;
  const result = prepareOfficialDraft(draft, official("Оголошення"), { maxPartLength: 4000 });
  expect(result).toBe(`Новина тут.\n\n${canonical}\n\n#Aniimo #Анонс`);
  expect(result.split("офіційному сайті")).toHaveLength(2);
});

it.each(CTA_VARIANTS)("replaces the Steam CTA written with a %s by the canonical line once", (_name, spell) => {
  const canonical = t("gemini.attribution.steam");
  const draft = `Новина тут.\n\n${spell(canonical)}\n\n#X`;
  const result = prepareOfficialDraft(draft, official("Оголошення", "", "steam"), { maxPartLength: 4000 });
  expect(result).toBe(`Новина тут.\n\n${canonical}\n\n#Aniimo #Анонс`);
  expect(result.split("сторінці у Steam")).toHaveLength(2);
});

it.each(CTA_VARIANTS)("replaces the wiki CTA written with a %s by the canonical line once", (_name, spell) => {
  const canonical = t("gemini.attribution.wiki_aniimo");
  const draft = `🐾 Аніімо тижня — Emberpup\n\n${spell(canonical)}\n\n#X`;
  const result = ensureRequiredMetadata(draft, official("Аніімо тижня: Emberpup", "Name: Emberpup", "wiki_aniimo"));
  expect(result).toBe(`🐾 Аніімо тижня — Emberpup\n\n${canonical}\n\n#Aniimo #АніімоТижня`);
  expect(result.split("офіційній вікі")).toHaveLength(2);
});

it("does not mistake a sentence that merely mentions the label for the CTA", () => {
  const draft = "Повні подробиці шукайте на офіційному сайті гри.\n\n#X";
  const result = prepareOfficialDraft(draft, official("Оголошення"), { maxPartLength: 4000 });
  // The sentence lacks the lead-in, so it is the model's prose and stays; the
  // official post still closes with its canonical reader line as always.
  expect(result).toBe(
    "Повні подробиці шукайте на офіційному сайті гри.\n\nПовні деталі на офіційному сайті.\n\n#Aniimo #Анонс",
  );
});
