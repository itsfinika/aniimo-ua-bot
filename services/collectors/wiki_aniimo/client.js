/**
 * Read creature entries from the official Aniimo wiki backend.
 *
 * The wiki (wiki.aniimo.com) is a thin front-end over a JSON API at
 * wiki-backend.aniimo.com. Every call is a POST with a JSON body and an
 * `X-Lang: en-US` header — any other language value is answered with
 * `{"code":10001,"message":"language not supported"}`. This client only reads:
 * it lists the creature roster (`/entries/getBaseAll`) and pulls one creature's
 * page (`/entries/detailByAnchor`), then flattens the page's component tree into
 * the handful of facts the weekly rubric needs (habitats, evolution line, trait,
 * mobility, element/role/gender).
 */

import { getLogger } from "../../logger.js";
import { collapseWhitespace, errorText } from "../../pyutils.js";

const logger = getLogger("services.collectors.wiki_aniimo.client");

export const DEFAULT_API_URL = "https://wiki-backend.aniimo.com";
export const DEFAULT_SITE_URL = "https://wiki.aniimo.com/en";
export const USER_AGENT = "AniimoUACollector/1.0 (Telegram news bot; +https://t.me/AniimoUABot)";
export const REQUEST_TIMEOUT_SECONDS = 25.0;
// The only language the backend serves; the bot translates itself.
export const WIKI_LANGUAGE = "en-US";
// The roster endpoint mixes entry types; only the creatures are the rubric's.
export const CREATURE_ENTRY_TYPE = "ANIIMO";

/**
 * Element / role labels as the channel writes them.
 *
 * The API tags a creature with `attributes-fire` / `position-dps`; the prefix is
 * stripped and the remainder looked up here. The value set is the complete one
 * observed in the live roster (86 creatures); anything new falls back to the
 * capitalised English word so an unmapped element never breaks a post, it just
 * reads slightly off until the map is extended.
 */
export const ELEMENT_LABELS = Object.freeze({
  rock: "Камінь",
  wind: "Вітер",
  grass: "Трава",
  water: "Вода",
  fire: "Вогонь",
  dark: "Темрява",
  electric: "Електрика",
  ice: "Лід",
  holy: "Світло",
});
export const ROLE_LABELS = Object.freeze({
  dps: "DPS",
  break: "Break (пробиття)",
  sup: "Підтримка",
  energy: "Енергія",
  heal: "Зцілення",
});

const ELEMENT_PREFIX = "attributes-";
const ROLE_PREFIX = "position-";

// The `crumbTitle` headings the detail page groups its components under.
const HABITATS_CRUMB = "habitats";
const EVOLUTION_CRUMB = "evolution";
const TRAIT_CRUMB = "trait";
const MOBILITY_CRUMB = "mobility";

/**
 * @typedef {{entry_id: string, name: string, image_url: string, description: string,
 *            morphology: string, stage: string, elements: string[], roles: string[],
 *            page_url: string}} WikiCreature
 * @typedef {{title: string, text: string}} WikiAbility
 * @typedef {{serial_number: string, description: string, elements: string[], roles: string[],
 *            gender: string[], habitats: string[], evolution: string, trait: WikiAbility|null,
 *            mobility: WikiAbility|null}} WikiCreatureDetail
 */

export class WikiAniimoClient {
  constructor(apiUrl = DEFAULT_API_URL, { site_url = DEFAULT_SITE_URL } = {}) {
    this.api_url = String(apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    this.site_url = String(site_url ?? DEFAULT_SITE_URL).replace(/\/+$/, "");
  }

  /** The whole visible creature roster, in the wiki's own order. */
  async fetchCreatures() {
    const data = await this.post("/entries/getBaseAll", {});
    if (data === null) {
      return [];
    }
    const creatures = parseCreatureList(data, { site_url: this.site_url });
    if (!creatures.length) {
      logger.warning("Aniimo wiki roster returned no visible creatures");
    } else {
      logger.info(`Fetched ${creatures.length} creatures from the Aniimo wiki`);
    }
    return creatures;
  }

  /**
   * One creature's page, flattened to the facts the rubric uses, or null when
   * the page cannot be fetched (the collector then falls back to the roster
   * summary rather than skipping the week).
   */
  async fetchCreatureDetail(creature) {
    const data = await this.post("/entries/detailByAnchor", {
      entryId: creature.entry_id,
      currentMorphology: creature.morphology,
    });
    if (data === null) {
      return null;
    }
    return parseCreatureDetail(data);
  }

  /** The human-facing page a post links to (`/item/<entryId>`). */
  pageUrl(entryId) {
    return creaturePageUrl(this.site_url, entryId);
  }

  /**
   * POST `body` to `endpoint` and return the response's `data`, or null on any
   * transport, HTTP, JSON or application (`code !== 200`) failure — every
   * failure is logged and the caller degrades, exactly as the other fetchers do.
   */
  async post(endpoint, body) {
    try {
      const response = await fetch(`${this.api_url}${endpoint}`, {
        method: "POST",
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Lang": WIKI_LANGUAGE,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!isObject(payload)) {
        throw new Error("response is not a JSON object");
      }
      if (Number(payload.code) !== 200) {
        throw new Error(`API code ${payload.code}: ${payload.message ?? ""}`.trim());
      }
      return payload.data ?? null;
    } catch (error) {
      logger.warning(`Aniimo wiki request failed (${endpoint}): ${errorText(error)}`);
      return null;
    }
  }
}

export function creaturePageUrl(siteUrl, entryId) {
  return `${String(siteUrl ?? DEFAULT_SITE_URL).replace(/\/+$/, "")}/item/${encodeURIComponent(entryId)}`;
}

/**
 * The roster from a `getBaseAll` response `data` array.
 *
 * Only visible creature entries (`searchKey.type === "ANIIMO"`) are kept; the
 * endpoint may also list items/locations, and a hidden entry is one the wiki
 * itself does not show yet, so posting it would leak an unreleased creature.
 */
export function parseCreatureList(data, { site_url = DEFAULT_SITE_URL } = {}) {
  if (!Array.isArray(data)) {
    return [];
  }
  const creatures = [];
  const seen = new Set();
  for (const row of data) {
    if (!isObject(row) || row.visible !== true || !isObject(row.searchKey)) {
      continue;
    }
    const key = row.searchKey;
    if (String(key.type ?? "") !== CREATURE_ENTRY_TYPE) {
      continue;
    }
    const entryId = String(key.entryId ?? "").trim();
    const name = collapseWhitespace(String(key.name ?? ""));
    if (!entryId || !name || seen.has(entryId)) {
      continue;
    }
    seen.add(entryId);
    creatures.push(
      Object.freeze({
        entry_id: entryId,
        name,
        image_url: String(key.imageUrl ?? "").trim(),
        description: collapseWhitespace(String(key.description ?? "")),
        morphology: String(key.currentMorphology ?? "").trim() || "Basic Form",
        stage: String(key.currentStage ?? "").trim(),
        elements: stripPrefixes(key.attributes, ELEMENT_PREFIX),
        roles: stripPrefixes(key.position, ROLE_PREFIX),
        page_url: creaturePageUrl(site_url, entryId),
      }),
    );
  }
  return creatures;
}

/**
 * The facts of one creature from a `detailByAnchor` response `data` object.
 *
 * The page is a tree of typed components (`crumbTitle` headings with `capsule`
 * / `circle` / `evolution` children, plus one `aniimoInfo` card). Every field is
 * optional: a creature with no Habitats crumb yields an empty list, not a throw,
 * so one oddly-built page cannot kill the rubric.
 */
export function parseCreatureDetail(data) {
  const components = [];
  for (const directory of asArray(data?.directories)) {
    components.push(...asArray(directory?.components));
  }

  const info = findComponent(components, "aniimoInfo");
  const formData = isObject(info?.props?.formData) ? info.props.formData : {};

  const sections = crumbSections(components);
  const habitats = [];
  for (const capsule of sections.get(HABITATS_CRUMB) ?? []) {
    if (capsule.type !== "capsule") {
      continue;
    }
    const title = collapseWhitespace(String(capsule.props?.title ?? ""));
    if (title && !habitats.includes(title)) {
      habitats.push(title);
    }
  }
  const evolutionNode = (sections.get(EVOLUTION_CRUMB) ?? []).find((node) => node.type === "evolution");

  return Object.freeze({
    serial_number: String(formData.serialNumber ?? "").trim(),
    description: collapseWhitespace(String(formData.desc ?? "")),
    elements: stripPrefixes(formData.attributes, ELEMENT_PREFIX),
    roles: stripPrefixes(formData.position, ROLE_PREFIX),
    gender: asArray(formData.gender)
      .map((value) => String(value ?? "").trim())
      .filter(Boolean),
    // The card's weightMin/weightMax and heightMin/heightMax are deliberately
    // NOT read: every one of the 86 live creatures carries the identical
    // 23.4–34.93 kg / 0–0 placeholder, and the rendered wiki page shows no
    // weight at all, so the numbers are template filler, not a fact.
    habitats: Object.freeze(habitats),
    evolution: evolutionLine(evolutionNode?.props?.data),
    trait: abilityOf(sections.get(TRAIT_CRUMB)),
    mobility: abilityOf(sections.get(MOBILITY_CRUMB)),
  });
}

// A name the en-US backend never translated. Some evolution nodes point at a
// creature that is not released yet and carry only its Chinese working name
// (e.g. 怪盗蝠 next to Eklue under Eko); such a node has no English field at all.
const HAN_SCRIPT = /\p{Script=Han}/u;

/**
 * "Emberpup → Flameruff → Scorchhowl / Inferlupa": the evolution tree read stage
 * by stage, with the alternatives of one stage joined by " / ". Reading it by
 * level (rather than by branch) keeps a forked line on one row, which is how the
 * wiki itself draws it.
 *
 * A node whose name is still in Chinese is skipped (its children are still
 * walked): the post is told to keep creature names verbatim, so the untranslated
 * name would land in the channel as-is and reveal an unpublished creature.
 */
export function evolutionLine(tree) {
  if (!isObject(tree)) {
    return "";
  }
  const stages = [];
  let level = [tree];
  while (level.length) {
    const names = [];
    const next = [];
    for (const node of level) {
      if (!isObject(node)) {
        continue;
      }
      const name = collapseWhitespace(String(node.name ?? node.label ?? ""));
      if (name && !HAN_SCRIPT.test(name) && !names.includes(name)) {
        names.push(name);
      }
      next.push(...asArray(node.children));
    }
    if (names.length) {
      stages.push(names.join(" / "));
    }
    level = next;
  }
  return stages.join(" → ");
}

/** `attributes-fire` → "Вогонь"; an unmapped value → its capitalised English. */
export function elementLabel(raw) {
  return labelOf(raw, ELEMENT_PREFIX, ELEMENT_LABELS);
}

/** `position-dps` → "DPS"; an unmapped value → its capitalised English. */
export function roleLabel(raw) {
  return labelOf(raw, ROLE_PREFIX, ROLE_LABELS);
}

function labelOf(raw, prefix, labels) {
  const key = stripPrefix(raw, prefix).toLowerCase();
  if (!key) {
    return "";
  }
  return labels[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function stripPrefix(raw, prefix) {
  const value = String(raw ?? "").trim();
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function stripPrefixes(values, prefix) {
  const result = [];
  for (const value of asArray(values)) {
    const stripped = stripPrefix(value, prefix).toLowerCase();
    if (stripped && !result.includes(stripped)) {
      result.push(stripped);
    }
  }
  return Object.freeze(result);
}

/**
 * The components under each `crumbTitle` heading, keyed by the lowercase
 * heading. A crumb's children are nested under it in the tree, so a heading's
 * section is its own `children` array.
 */
function crumbSections(components) {
  const sections = new Map();
  walk(components, (node) => {
    if (node.type !== "crumbTitle") {
      return;
    }
    const title = collapseWhitespace(String(node.props?.title ?? "")).toLowerCase();
    if (!title) {
      return;
    }
    const existing = sections.get(title) ?? [];
    sections.set(title, existing.concat(asArray(node.children).filter(isObject)));
  });
  return sections;
}

function abilityOf(nodes) {
  const circle = (nodes ?? []).find((node) => node.type === "circle");
  if (circle === undefined) {
    return null;
  }
  const title = collapseWhitespace(String(circle.props?.descTitle ?? ""));
  const text = collapseWhitespace(String(circle.props?.descContent ?? ""));
  if (!title && !text) {
    return null;
  }
  return Object.freeze({ title, text });
}

function findComponent(components, type) {
  let found = null;
  walk(components, (node) => {
    if (found === null && node.type === type) {
      found = node;
    }
  });
  return found;
}

function walk(nodes, visit) {
  for (const node of asArray(nodes)) {
    if (!isObject(node)) {
      continue;
    }
    visit(node);
    walk(node.children, visit);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
