/**
 * Tests for the weekly "Аніімо тижня" rubric: the wiki backend client (roster
 * and page parsing from the captured fixtures), the collector's selection
 * contract and candidate shape, the weekly scheduler helpers, the /aniimoweek
 * admin command, and the dedicated Gemini prompt.
 */

import fs from "node:fs";

import { afterEach, expect, it, vi } from "vitest";

import { buildAdminComposer } from "../handlers/admin.js";
import { listingEntry } from "../services/collectors/base.js";
import { BaseNewsCollector } from "../services/collectors/runner.js";
import {
  DEFAULT_API_URL,
  ELEMENT_LABELS,
  ROLE_LABELS,
  USER_AGENT,
  WIKI_LANGUAGE,
  WikiAniimoClient,
  creaturePageUrl,
  elementLabel,
  evolutionLine,
  parseCreatureDetail,
  parseCreatureList,
  roleLabel,
} from "../services/collectors/wiki_aniimo/client.js";
import * as wikiCollector from "../services/collectors/wiki_aniimo/collector.js";
import {
  DEFINITION,
  WikiAniimoCollector,
  runWikiAniimoOnce,
  startWikiAniimoScheduler,
} from "../services/collectors/wiki_aniimo/collector.js";
import { WIKI_CREATURE_PROMPT_PATH, __testing, geminiDraftInput } from "../services/gemini.js";
import { t } from "../services/i18n.js";
import { attributionLine } from "../services/post_footer.js";
import { dispatch, fakeBot, messageUpdate, sentTexts } from "./helpers/telegram.js";

const { buildPrompt, fallbackTags, publicHashtagLine, selectPromptTemplate, sourceAttributionLine } = __testing;
const { dedupKey, buildFactSheet } = wikiCollector.__testing;

const FIXTURES = new URL("./fixtures/aniimo/", import.meta.url);
const readFixture = (name) => JSON.parse(fs.readFileSync(new URL(name, FIXTURES), "utf8"));
const ENTRIES = readFixture("wiki_entries_en.json");
const DETAIL = readFixture("wiki_detail_001.json");
const SITE_URL = "https://wiki.aniimo.com/en";

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Make the collector's Fisher-Yates roster shuffle a no-op.
 *
 * A value just under 1 makes `floor(r * (i + 1)) === i`, i.e. every element
 * swaps with itself and the roster order is preserved.
 */
function stubShuffleAsIdentity() {
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => payload };
}

// --- client: roster ---------------------------------------------------------------

it("parses the creature roster from the fixture", () => {
  const creatures = parseCreatureList(ENTRIES.data, { site_url: SITE_URL });

  expect(creatures).toHaveLength(86);
  const emberpup = creatures[0];
  expect(emberpup.entry_id).toBe("001");
  expect(emberpup.name).toBe("Emberpup");
  expect(emberpup.image_url).toMatch(/^https:\/\/worldx-website-cdn\.aniimo\.com\/.+\.png$/);
  expect(emberpup.description).toContain("follow Flameruffs around");
  expect(emberpup.morphology).toBe("Basic Form");
  expect(emberpup.stage).toBe("1");
  // The `attributes-` / `position-` prefixes are stripped at parse time.
  expect(emberpup.elements).toEqual(["fire"]);
  expect(emberpup.roles).toEqual(["dps"]);
  expect(emberpup.page_url).toBe("https://wiki.aniimo.com/en/item/001");
  // Every element/role in the live roster is one the label maps know.
  for (const creature of creatures) {
    expect(creature.elements.every((element) => element in ELEMENT_LABELS)).toBe(true);
    expect(creature.roles.every((role) => role in ROLE_LABELS)).toBe(true);
  }
});

it("keeps only visible creature entries", () => {
  const visible = ENTRIES.data[0];
  const hidden = { ...visible, visible: false, searchKey: { ...visible.searchKey, entryId: "900", name: "Hidden" } };
  const item = { ...visible, searchKey: { ...visible.searchKey, type: "ITEM", entryId: "901", name: "Potion" } };
  const duplicate = { ...visible };
  const junk = [null, "x", { visible: true }, { visible: true, searchKey: { type: "ANIIMO", entryId: "", name: "" } }];

  const creatures = parseCreatureList([visible, hidden, item, duplicate, ...junk]);

  expect(creatures.map((creature) => creature.entry_id)).toEqual(["001"]);
  expect(parseCreatureList(null)).toEqual([]);
  expect(parseCreatureList({ list: [] })).toEqual([]);
});

it("builds the wiki page URL and tolerates a trailing slash", () => {
  expect(creaturePageUrl("https://wiki.aniimo.com/en/", "001")).toBe("https://wiki.aniimo.com/en/item/001");
  expect(new WikiAniimoClient(DEFAULT_API_URL, { site_url: "https://wiki.aniimo.com/en" }).pageUrl("042")).toBe(
    "https://wiki.aniimo.com/en/item/042",
  );
});

// --- client: creature page --------------------------------------------------------

it("parses the creature page from the fixture", () => {
  const detail = parseCreatureDetail(DETAIL.data);

  expect(detail.serial_number).toBe("001");
  expect(detail.description).toContain("smoldering fur");
  expect(detail.elements).toEqual(["fire"]);
  expect(detail.roles).toEqual(["dps"]);
  expect(detail.gender).toEqual(["male", "female"]);
  // The card's weightMin/weightMax (23.4–34.93 on every live creature) is a
  // template placeholder, not a fact, so the detail never carries a weight.
  expect(detail).not.toHaveProperty("weight");
  // The capsules under the "Habitats" crumb, in page order; the "Homeland
  // Ability" capsules next to them are not habitats and stay out.
  expect(detail.habitats).toEqual([
    "Nimbus Fields",
    "The Mistwoods",
    "The Argent Strait",
    "Echoback Landing",
    "Beast Fang Ridge",
  ]);
  expect(detail.evolution).toBe("Emberpup → Flameruff → Scorchhowl / Inferlupa");
  expect(detail.trait).toEqual({
    title: "Scorching Flames",
    text: "Increases damage dealt to elementally countered targets by 25%.",
  });
  expect(detail.mobility).toEqual({
    title: "Hustle",
    text: "Enters Hustle state, increasing movement speed by consuming stamina.",
  });
});

it("degrades an oddly built page to empty facts instead of throwing", () => {
  const empty = parseCreatureDetail({ directories: [{ title: "Basic Info", components: [{ type: "richText" }] }] });
  expect(empty.habitats).toEqual([]);
  expect(empty.evolution).toBe("");
  expect(empty.trait).toBeNull();
  expect(empty.mobility).toBeNull();
  expect(empty.gender).toEqual([]);
  expect(parseCreatureDetail(null).habitats).toEqual([]);
});

it("reads the evolution tree stage by stage", () => {
  // A fork at the last stage is one row joined by " / ", the way the wiki draws it.
  expect(evolutionLine({ name: "A", children: [{ name: "B", children: [{ name: "C" }, { name: "D" }] }] })).toBe(
    "A → B → C / D",
  );
  expect(evolutionLine({ name: "Solo" })).toBe("Solo");
  expect(evolutionLine(null)).toBe("");
});

it("drops an untranslated Chinese evolution name instead of leaking it", () => {
  // Live Eko (031): the stage-3 fork is Eklue plus an unreleased creature the
  // en-US backend only knows by its Chinese name (no English field at all).
  const eko = {
    name: "Eko",
    stage: 1,
    children: [
      { id: "91502179_22881", name: "怪盗蝠", label: "怪盗蝠", stage: 3, children: [] },
      { name: "Eklue", label: "Eklue", stage: 3, children: [] },
    ],
  };
  expect(evolutionLine(eko)).toBe("Eko → Eklue");
  // The skipped node's own children are still walked, so a deeper stage survives.
  expect(evolutionLine({ name: "A", children: [{ name: "蹦蹦貂", children: [{ name: "C" }] }] })).toBe("A → C");
  // A stage made only of hidden names disappears entirely rather than leaving " → ".
  expect(evolutionLine({ name: "Bolty", children: [{ name: "蹦蹦貂" }] })).toBe("Bolty");
});

it("maps element and role labels to the channel's terms", () => {
  expect(elementLabel("attributes-fire")).toBe("Вогонь");
  expect(elementLabel("holy")).toBe("Світло");
  expect(roleLabel("position-break")).toBe("Break (пробиття)");
  expect(roleLabel("sup")).toBe("Підтримка");
  // An unmapped value falls back to capitalised English rather than breaking.
  expect(elementLabel("attributes-plasma")).toBe("Plasma");
  expect(roleLabel("position-tank")).toBe("Tank");
  expect(elementLabel("")).toBe("");
});

// --- client: transport ------------------------------------------------------------

it("posts JSON with the en-US language header", async () => {
  const calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(url.endsWith("/entries/getBaseAll") ? ENTRIES : DETAIL);
  });
  const client = new WikiAniimoClient("https://wiki-backend.example/", { site_url: SITE_URL });

  const creatures = await client.fetchCreatures();
  const detail = await client.fetchCreatureDetail(creatures[0]);

  expect(creatures).toHaveLength(86);
  expect(detail.habitats).toHaveLength(5);
  expect(calls.map((call) => call.url)).toEqual([
    "https://wiki-backend.example/entries/getBaseAll",
    "https://wiki-backend.example/entries/detailByAnchor",
  ]);
  for (const { init } of calls) {
    expect(init.method).toBe("POST");
    expect(init.headers["X-Lang"]).toBe(WIKI_LANGUAGE);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["User-Agent"]).toBe(USER_AGENT);
  }
  expect(JSON.parse(calls[0].init.body)).toEqual({});
  expect(JSON.parse(calls[1].init.body)).toEqual({ entryId: "001", currentMorphology: "Basic Form" });
});

it("treats an API error code, an HTTP error and a network error as empty", async () => {
  const client = new WikiAniimoClient("https://wiki-backend.example", { site_url: SITE_URL });

  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ code: 10001, message: "language not supported" }));
  expect(await client.fetchCreatures()).toEqual([]);
  expect(await client.fetchCreatureDetail({ entry_id: "001", morphology: "Basic Form" })).toBeNull();

  vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, { ok: false, status: 503 }));
  expect(await client.fetchCreatures()).toEqual([]);

  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("boom"));
  expect(await client.fetchCreatures()).toEqual([]);
});

// --- collector ------------------------------------------------------------------

class FakeDb {
  constructor(seen = []) {
    this.seen = new Set(seen);
  }

  async isSourceSeen(_sourceType, sourceId) {
    return this.seen.has(sourceId);
  }
}

function creature(entryId, name, overrides = {}) {
  return {
    entry_id: entryId,
    name,
    image_url: `https://cdn.example/${entryId}.png`,
    description: `${name} blurb.`,
    morphology: "Basic Form",
    stage: "1",
    elements: ["fire"],
    roles: ["dps"],
    page_url: `${SITE_URL}/item/${entryId}`,
    ...overrides,
  };
}

function buildCollector(roster, { db = new FakeDb(), detail = null } = {}) {
  const collector = new WikiAniimoCollector({
    config: { wiki_aniimo_api_url: "https://wiki-backend.example", wiki_aniimo_site_url: SITE_URL },
    db,
    bot: null,
  });
  collector.client = {
    async fetchCreatures() {
      return [...roster];
    },
    async fetchCreatureDetail() {
      return detail;
    },
  };
  return collector;
}

it("declares the collector the registry wires", () => {
  expect(DEFINITION.collector_id).toBe("wiki_aniimo");
  expect(DEFINITION.source_type).toBe("wiki_aniimo");
  expect(DEFINITION.title).toBe(t("collectors.wiki_aniimo.title"));
  expect(DEFINITION.button_text).toBe(t("buttons.collector_wiki_aniimo"));
  expect(WikiAniimoCollector.definition).toBe(DEFINITION);
});

it("opts the collector out of cross-source dedup", () => {
  expect(WikiAniimoCollector.participates_in_cross_source_dedup).toBe(false);
  expect(BaseNewsCollector.participates_in_cross_source_dedup).toBe(true);
});

it("points the client at the configured backend and site", () => {
  const collector = new WikiAniimoCollector({
    config: { wiki_aniimo_api_url: "https://wiki-backend.example", wiki_aniimo_site_url: "https://wiki.example/en" },
    db: new FakeDb(),
    bot: null,
  });
  expect(collector.client.api_url).toBe("https://wiki-backend.example");
  expect(collector.client.pageUrl("007")).toBe("https://wiki.example/en/item/007");
  expect(collector.missingGeminiWarning()).toBe(t("collectors.wiki_aniimo.errors.missing_gemini_api_key"));
});

it("keys a creature by its wiki entry id", () => {
  expect(dedupKey(creature("001", "Emberpup"))).toBe("wiki_aniimo:001");
});

it("lists the seen creatures first and the winner as the first unseen", async () => {
  // The runner publishes the first UNSEEN entry, so fetchListing must put the
  // week's pick right after every already-featured creature.
  stubShuffleAsIdentity();
  const a = creature("001", "Emberpup");
  const b = creature("002", "Flameruff");
  const c = creature("003", "Scorchhowl");
  const db = new FakeDb([dedupKey(b)]);

  const entries = await buildCollector([a, b, c], { db }).fetchListing();

  expect(entries.map((entry) => entry.dedup_key)).toEqual([dedupKey(b), dedupKey(a), dedupKey(c)]);
  expect(entries[1].payload).toBe(a);
});

it("returns only seen entries once the whole roster has featured", async () => {
  const a = creature("001", "Emberpup");
  const entries = await buildCollector([a], { db: new FakeDb([dedupKey(a)]) }).fetchListing();
  expect(entries.map((entry) => entry.dedup_key)).toEqual([dedupKey(a)]);
  expect(await buildCollector([]).fetchListing()).toEqual([]);
});

it("shuffles the roster before choosing", async () => {
  // With randomness pinned to 0, Fisher-Yates always swaps with index 0, which
  // rotates the roster — the pick is no longer the wiki's first creature.
  vi.spyOn(Math, "random").mockReturnValue(0);
  const roster = [creature("001", "A"), creature("002", "B"), creature("003", "C")];
  const entries = await buildCollector(roster).fetchListing();
  expect(entries).toHaveLength(3);
  expect(entries[0].dedup_key).not.toBe("wiki_aniimo:001");
});

it("builds a creature-of-the-week candidate", async () => {
  const detail = parseCreatureDetail(DETAIL.data);
  const emberpup = parseCreatureList(ENTRIES.data, { site_url: SITE_URL })[0];
  const collector = buildCollector([emberpup], { detail });
  const entry = listingEntry(dedupKey(emberpup), emberpup);

  const candidate = await collector.parseEntry(entry);

  expect(candidate.source_id).toBe("wiki_aniimo:001"); // == dedup_key, so the seen-check is consistent
  expect(candidate.source_url).toBe("https://wiki.aniimo.com/en/item/001");
  expect(candidate.title).toBe(t("collectors.wiki_aniimo.creature_title", { name: "Emberpup" }));
  expect(candidate.title).toBe("Аніімо тижня: Emberpup");
  expect(candidate.source_name).toBe(t("collectors.wiki_aniimo.source_name"));
  expect(candidate.username).toBe(t("collectors.wiki_aniimo.username"));
  expect(candidate.article_date).toBeNull();
  expect(candidate.article_date_display).toBeNull();
  // The wiki art rides along as the post photo.
  expect(candidate.has_media).toBe(true);
  expect(candidate.media_type).toBe("photo");
  expect(candidate.media_url).toBe(emberpup.image_url);
  expect(candidate.additional_media_urls).toBeNull();
  // The English fact sheet Gemini writes the post from.
  expect(candidate.body_text.split("\n")).toEqual([
    "Name: Emberpup",
    "No.: 001",
    "Form: Basic Form",
    "Evolution stage: 1",
    "Element: Вогонь (fire)",
    "Role: DPS (dps)",
    `Description: ${detail.description}`,
    "Gender: male, female",
    "Habitats: Nimbus Fields, The Mistwoods, The Argent Strait, Echoback Landing, Beast Fang Ridge",
    "Evolution: Emberpup → Flameruff → Scorchhowl / Inferlupa",
    "Trait: Scorching Flames — Increases damage dealt to elementally countered targets by 25%.",
    "Mobility: Hustle — Enters Hustle state, increasing movement speed by consuming stamina.",
  ]);
  expect(candidate.original_text).toContain("https://wiki.aniimo.com/en/item/001");
  expect(candidate.original_text).toContain(emberpup.image_url);
  expect(candidate.original_text).toContain("Habitats: Nimbus Fields");
});

it("falls back to the roster summary when the page fetch fails", async () => {
  const fallback = creature("005", "Gustling", { elements: ["wind"], roles: ["sup", "heal"], image_url: "" });
  const candidate = await buildCollector([fallback], { detail: null }).parseEntry(
    listingEntry(dedupKey(fallback), fallback),
  );

  expect(candidate.body_text.split("\n")).toEqual([
    "Name: Gustling",
    "No.: 005",
    "Form: Basic Form",
    "Evolution stage: 1",
    "Element: Вітер (wind)",
    "Role: Підтримка (sup), Зцілення (heal)",
    "Description: Gustling blurb.",
  ]);
  expect(candidate.body_text).not.toContain("Habitats");
  // No art on the roster row -> a text post, never a photo with an empty URL.
  expect(candidate.has_media).toBe(false);
  expect(candidate.media_url).toBeNull();
  expect(candidate.media_type).toBe("none");
});

it("leaves an unknown fact out of the sheet instead of writing unknown", () => {
  const sheet = buildFactSheet(creature("009", "Blank", { stage: "", description: "", elements: [], roles: [] }), {
    serial_number: "",
    description: "",
    elements: [],
    roles: [],
    gender: [],
    habitats: [],
    evolution: "",
    trait: { title: "Only Name", text: "" },
    mobility: null,
  });
  expect(sheet).toBe("Name: Blank\nNo.: 009\nForm: Basic Form\nTrait: Only Name");
});

// --- weekly scheduler --------------------------------------------------------------

function schedulerConfig(overrides = {}) {
  return {
    enable_wiki_aniimo: true,
    gemini_api_key: "k",
    wiki_aniimo_weekday: 0,
    wiki_aniimo_hour: 12,
    article_timezone: "Europe/Kyiv",
    ...overrides,
  };
}

it("does not start the scheduler when the rubric is off or has no Gemini key", () => {
  expect(startWikiAniimoScheduler(null, schedulerConfig({ enable_wiki_aniimo: false }), {})).toBeNull();
  expect(startWikiAniimoScheduler(null, schedulerConfig({ gemini_api_key: "" }), {})).toBeNull();
});

it("starts a cancellable weekly task when enabled", async () => {
  const runOnce = vi.spyOn(WikiAniimoCollector.prototype, "runOnce");
  const task = startWikiAniimoScheduler(null, schedulerConfig(), {});

  expect(task).not.toBeNull();
  expect(task.name).toBe("wiki-aniimo-scheduler");
  task.cancel();
  await task.done;
  // The loop was sleeping until the next Monday 12:00; cancelling it never ran a fetch.
  expect(runOnce).not.toHaveBeenCalled();
});

it("reports whether the run queued a post", async () => {
  const runOnce = vi.spyOn(WikiAniimoCollector.prototype, "runOnce");
  const stats = { found: 86, new: 1, duplicates: 85, sent_to_moderation: 1, failed: 0, errors: [] };
  const config = schedulerConfig();

  runOnce.mockResolvedValue(stats);
  expect(await runWikiAniimoOnce(null, config, {})).toBe(true);
  runOnce.mockResolvedValue({ ...stats, new: 0, duplicates: 86, sent_to_moderation: 0 });
  expect(await runWikiAniimoOnce(null, config, {})).toBe(false);
  runOnce.mockResolvedValue({ ...stats, sent_to_moderation: 0, failed: 1 });
  expect(await runWikiAniimoOnce(null, config, {})).toBe(false);
  expect(runOnce).toHaveBeenCalledTimes(3);
  expect(runOnce).toHaveBeenLastCalledWith("manual_latest");
});

// --- the /aniimoweek admin command ---------------------------------------------------

function adminConfig({ enabled = true, geminiKey = "k", admins = [7] } = {}) {
  return {
    enable_wiki_aniimo: enabled,
    gemini_api_key: geminiKey,
    admin_user_ids: new Set(admins),
    admin_chat_id: 100,
    telegram_moderation_chat_ids: new Set(),
  };
}

async function runAniimoWeekCommand({ config, result, userId = 7, chatId = 100, chatType = "private" }) {
  const calls = [];
  vi.spyOn(wikiCollector, "runWikiAniimoOnce").mockImplementation(async () => {
    calls.push("ran");
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });

  const bot = fakeBot();
  const composer = buildAdminComposer({ config, db: {}, bot });
  await dispatch(composer, messageUpdate({ text: "/aniimoweek", userId, chatId, chatType }), bot);
  return { calls, answers: sentTexts(bot) };
}

it("reports the rubric being switched off", async () => {
  // A disabled rubric is diagnosable from Telegram instead of only from the
  // server log at startup.
  const { calls, answers } = await runAniimoWeekCommand({ config: adminConfig({ enabled: false }), result: true });

  expect(calls).toEqual([]); // never touches the wiki when the feature is off
  expect(answers).toEqual([t("admin.aniimo_week.disabled")]);
  expect(answers[0]).toContain("ENABLE_WIKI_ANIIMO");
});

it("reports a missing Gemini key", async () => {
  const { calls, answers } = await runAniimoWeekCommand({ config: adminConfig({ geminiKey: "" }), result: true });

  expect(calls).toEqual([]);
  expect(answers).toEqual([t("admin.aniimo_week.no_gemini")]);
});

it("queues a creature", async () => {
  const { calls, answers } = await runAniimoWeekCommand({ config: adminConfig(), result: true });

  expect(calls).toEqual(["ran"]);
  expect(answers).toEqual([t("admin.aniimo_week.started"), t("admin.aniimo_week.queued")]);
});

it("reports when nothing was queued", async () => {
  const { answers } = await runAniimoWeekCommand({ config: adminConfig(), result: false });
  expect(answers).toEqual([t("admin.aniimo_week.started"), t("admin.aniimo_week.skipped")]);
});

it("reports a failed run", async () => {
  const { answers } = await runAniimoWeekCommand({ config: adminConfig(), result: new Error("wiki down") });
  expect(answers).toEqual([t("admin.aniimo_week.started"), t("admin.aniimo_week.failed")]);
});

it("rejects non-admins", async () => {
  const { calls, answers } = await runAniimoWeekCommand({ config: adminConfig(), result: true, userId: 999 });

  expect(calls).toEqual([]);
  expect(answers).toEqual([t("admin.aniimo_week.no_permission")]);
});

it("does not answer /aniimoweek in a non-admin group chat", async () => {
  // The chat-scope filter declines the update entirely, so it falls through to
  // the next composer instead of being answered here.
  const { calls, answers } = await runAniimoWeekCommand({
    config: adminConfig(),
    result: true,
    chatId: 555,
    chatType: "supergroup",
  });

  expect(calls).toEqual([]);
  expect(answers).toEqual([]);
});

// --- the creature prompt -----------------------------------------------------------

function wikiDraftInput(title, body) {
  return geminiDraftInput({
    title,
    article_url: "https://wiki.aniimo.com/en/item/001",
    article_date_display: null,
    datetime_notes: "",
    body_text: body,
    source_type: "wiki_aniimo",
    source_name: t("collectors.wiki_aniimo.source_name"),
  });
}

it("carries every placeholder gemini.js fills for the wiki prompt", () => {
  const template = fs.readFileSync(WIKI_CREATURE_PROMPT_PATH, "utf8");
  for (const key of ["source_name", "title", "article_url", "body_text", "source_line", "hashtag_line"]) {
    expect(template).toContain(`{${key}}`);
  }
  // Nothing but those six: a stray brace would make buildPrompt throw.
  const placeholders = [...template.matchAll(/\{([a-z_]+)\}/g)].map((match) => match[1]);
  expect(new Set(placeholders)).toEqual(
    new Set(["source_name", "title", "article_url", "body_text", "source_line", "hashtag_line"]),
  );
  expect(template).not.toMatch(/\{\{|\}\}/);
});

it("selects and renders the creature prompt", () => {
  const draftInput = wikiDraftInput("Аніімо тижня: Emberpup", "Name: Emberpup\nElement: Вогонь (fire)");
  const template = selectPromptTemplate(draftInput);
  expect(template).toContain("Аніімо тижня");

  const prompt = buildPrompt(draftInput);
  // The creature prompt is chosen and renders (all placeholders present) with the
  // fact sheet, the wiki call-to-action line, the rubric tags and the injection
  // guard.
  expect(prompt).toContain("🐾 Аніімо тижня");
  expect(prompt).toContain("Name: Emberpup");
  expect(prompt).toContain("https://wiki.aniimo.com/en/item/001");
  expect(prompt).toContain(t("gemini.attribution.wiki_aniimo"));
  expect(prompt).toContain("#AniimoUA #АніімоТижня");
  expect(prompt).toContain("ВАЖЛИВО ПРО БЕЗПЕКУ");
  expect(prompt).not.toMatch(/\{[a-z_]+\}/);
});

it("closes the post with the wiki call-to-action, not a source line", () => {
  const line = sourceAttributionLine(wikiDraftInput("Аніімо тижня: Emberpup", "Name: Emberpup"));
  expect(line).toBe("Більше про цю істоту в офіційній вікі.");
  expect(line).toBe(attributionLine("wiki_aniimo"));
  expect(line).not.toContain("Джерело");
});

it("uses its own rubric hashtag", () => {
  // A creature sheet matches no news topic rule, so it used to fall through to
  // the "#Анонс" default — calling a habitat list an announcement.
  const line = publicHashtagLine(
    wikiDraftInput("Аніімо тижня: Emberpup", "Name: Emberpup\nHabitats: Nimbus Fields, The Mistwoods"),
  );

  expect(line).toBe("#AniimoUA #АніімоТижня");
  expect(line).not.toContain("#Анонс");
});

it("ignores incidental news keywords in a sheet", () => {
  // "evolution", "region" and "legendary" are news topic keywords too; the rubric
  // must still be tagged as the rubric, not as an event or location post.
  const line = publicHashtagLine(
    wikiDraftInput("Аніімо тижня: Irisalis", "Description: A legendary aniimo whose evolution shifts by region."),
  );
  expect(line).toBe("#AniimoUA #АніімоТижня");
});

it("keeps the stored tags in step with the rubric", () => {
  const draftInput = wikiDraftInput("Аніімо тижня: Emberpup", "Name: Emberpup");
  expect(fallbackTags(draftInput)).toEqual(["aniimoua", "аніімотижня"]);
});
