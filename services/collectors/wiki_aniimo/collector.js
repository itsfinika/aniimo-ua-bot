/**
 * Weekly "Аніімо тижня" creature-spotlight rubric, sourced from the official
 * Aniimo wiki backend.
 *
 * It is registered in the registry with scheduled=false: that keeps it out of the
 * per-tick news run (which would post a creature every interval instead of
 * weekly) while still offering it as a manual /fetch_news button. It runs on its
 * own weekly schedule, like the fan-art digest, and reuses the shared
 * BaseNewsCollector pipeline: the creature's English fact sheet is turned into a
 * Ukrainian post by Gemini and queued for moderation with the creature's wiki
 * art as the photo and a "read more" line pointing at the wiki page. It opts
 * out of cross-source dedup (a creature profile is not a news story).
 */

import { DateTime } from "luxon";

import { cancellableSleep, createTask } from "../../background.js";
import { nextWeeklyRunAt, resolveTimezone } from "../../digests/fanart.js";
import { t } from "../../i18n.js";
import { getLogger } from "../../logger.js";
import { CollectionMode, collectorDefinition, draftCandidate, listingEntry } from "../base.js";
import { BaseNewsCollector } from "../runner.js";
import { elementLabel, roleLabel, WikiAniimoClient } from "./client.js";

const logger = getLogger("services.collectors.wiki_aniimo.collector");

// A weekly job gets one shot: when Gemini is overloaded at that exact minute the
// rubric would skip a whole week. These retries turn a transient outage into a
// post that is late by minutes instead of missing.
const WEEKLY_RETRY_ATTEMPTS = 3;
const WEEKLY_RETRY_DELAY_SECONDS = 600;

export const COLLECTOR_ID = "wiki_aniimo";
export const SOURCE_TYPE = "wiki_aniimo";

export const DEFINITION = collectorDefinition({
  collector_id: COLLECTOR_ID,
  source_type: SOURCE_TYPE,
  title_key: "collectors.wiki_aniimo.title",
  button_key: "buttons.collector_wiki_aniimo",
});

export class WikiAniimoCollector extends BaseNewsCollector {
  static definition = DEFINITION;
  // A creature profile must never be dropped as a "duplicate" of a news story,
  // nor suppress one.
  static participates_in_cross_source_dedup = false;

  constructor({ config, db, bot }) {
    super({ config, db, bot });
    this.client = new WikiAniimoClient(config.wiki_aniimo_api_url, { site_url: config.wiki_aniimo_site_url });
  }

  missingGeminiWarning() {
    return t("collectors.wiki_aniimo.errors.missing_gemini_api_key");
  }

  /**
   * Return the whole roster, ordered so the creature we WANT published is the
   * first unseen element.
   *
   * The runner publishes `entries[first unseen]`, so this method is the only
   * place selection can happen. The roster is shuffled, then partitioned: the
   * already-seen creatures stay at the head (so `stats.found` and
   * `stats.duplicates` still describe the whole roster) and the first unseen one
   * after them is the week's pick. Once every creature has featured, the run
   * yields only seen entries and runWikiAniimoOnce logs the empty week.
   */
  async fetchListing() {
    const creatures = await this.client.fetchCreatures();
    if (!creatures.length) {
      return [];
    }

    shuffleInPlace(creatures);
    const seenEntries = [];
    const unseenEntries = [];
    for (const creature of creatures) {
      const entry = listingEntry(dedupKey(creature), creature);
      if (await this.db.isSourceSeen(SOURCE_TYPE, entry.dedup_key)) {
        seenEntries.push(entry);
      } else {
        unseenEntries.push(entry);
      }
    }
    return [...seenEntries, ...unseenEntries];
  }

  async parseEntry(entry) {
    const creature = entry.payload;
    // A failed page fetch degrades to the roster summary (name, blurb, element,
    // role, art): a thinner post beats a missed week, and the prompt is told not
    // to invent the missing sections.
    const detail = await this.client.fetchCreatureDetail(creature);
    if (detail === null) {
      logger.warning(`Aniimo wiki page for ${creature.name} (#${creature.entry_id}) is unavailable; using the roster summary`);
    }
    const factSheet = buildFactSheet(creature, detail);
    const hasMedia = Boolean(creature.image_url);

    return draftCandidate({
      source_id: entry.dedup_key,
      source_url: creature.page_url,
      title: t("collectors.wiki_aniimo.creature_title", { name: creature.name }),
      body_text: factSheet,
      source_name: t("collectors.wiki_aniimo.source_name"),
      username: t("collectors.wiki_aniimo.username"),
      original_text: buildOriginalText(creature, factSheet),
      article_date: null,
      article_date_display: null,
      has_media: hasMedia,
      media_url: hasMedia ? creature.image_url : null,
      media_type: hasMedia ? "photo" : "none",
      additional_media_urls: null,
    });
  }
}

// Exported for the unit tests, which assert the key shape and the sheet layout.
export const __testing = { dedupKey, buildFactSheet, runWeeklyWithRetries, WEEKLY_RETRY_ATTEMPTS, WEEKLY_RETRY_DELAY_SECONDS };

/** `wiki_aniimo:<entryId>` — the entry id is the wiki's own stable creature number. */
function dedupKey(creature) {
  return `${SOURCE_TYPE}:${creature.entry_id}`;
}

/**
 * The English fact sheet Gemini turns into the post.
 *
 * One "Label: value" line per fact, in the order the post should mention them;
 * an unknown fact is left out rather than written as "unknown", so the model has
 * nothing to hedge about. Element and role carry the Ukrainian label first and
 * the wiki's English word in brackets, so the post uses the channel's own term
 * without the model translating on its own.
 */
function buildFactSheet(creature, detail) {
  const elements = (detail?.elements.length ? detail.elements : creature.elements).map(
    (element) => `${elementLabel(element)} (${element})`,
  );
  const roles = (detail?.roles.length ? detail.roles : creature.roles).map((role) => `${roleLabel(role)} (${role})`);
  const lines = [
    `Name: ${creature.name}`,
    `No.: ${detail?.serial_number || creature.entry_id}`,
    `Form: ${creature.morphology}`,
  ];
  if (creature.stage) {
    lines.push(`Evolution stage: ${creature.stage}`);
  }
  if (elements.length) {
    lines.push(`Element: ${elements.join(", ")}`);
  }
  if (roles.length) {
    lines.push(`Role: ${roles.join(", ")}`);
  }
  const description = detail?.description || creature.description;
  if (description) {
    lines.push(`Description: ${description}`);
  }
  if (detail?.gender.length) {
    lines.push(`Gender: ${detail.gender.join(", ")}`);
  }
  if (detail?.habitats.length) {
    lines.push(`Habitats: ${detail.habitats.join(", ")}`);
  }
  if (detail?.evolution) {
    lines.push(`Evolution: ${detail.evolution}`);
  }
  if (detail?.trait) {
    lines.push(`Trait: ${abilityText(detail.trait)}`);
  }
  if (detail?.mobility) {
    lines.push(`Mobility: ${abilityText(detail.mobility)}`);
  }
  return lines.join("\n");
}

function abilityText(ability) {
  if (ability.title && ability.text) {
    return `${ability.title} — ${ability.text}`;
  }
  return ability.title || ability.text;
}

/** Fisher-Yates, the direct equivalent of `random.shuffle`. */
function shuffleInPlace(values) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [values[index], values[swap]] = [values[swap], values[index]];
  }
}

function buildOriginalText(creature, factSheet) {
  const parts = [
    t("collectors.common.original_text.article_title", { value: creature.name }),
    t("collectors.common.original_text.article_url", { value: creature.page_url }),
    "",
    t("collectors.common.original_text.parsed_article_text"),
    factSheet,
  ];
  if (creature.image_url) {
    parts.push(
      "",
      t("collectors.common.original_text.media_url", { value: creature.image_url }),
      t("collectors.common.original_text.media_type", { value: "photo" }),
    );
  }
  return parts.join("\n").trim();
}

// --- weekly scheduler ----------------------------------------------------------

/** Start the weekly "Аніімо тижня" loop, or return null when it is off / unusable. */
export function startWikiAniimoScheduler(bot, config, db) {
  if (!config.enable_wiki_aniimo) {
    logger.info("Weekly Aniimo-of-the-week rubric is disabled (ENABLE_WIKI_ANIIMO).");
    return null;
  }
  if (!config.gemini_api_key) {
    logger.warning("GEMINI_API_KEY is missing; the Aniimo-of-the-week rubric needs drafting and is disabled.");
    return null;
  }

  logger.info(
    `Weekly Aniimo-of-the-week enabled: weekday ${config.wiki_aniimo_weekday} at ` +
      `${String(config.wiki_aniimo_hour).padStart(2, "0")}:00 ${config.article_timezone}`,
  );
  return createTask("wiki-aniimo-scheduler", (signal) => wikiAniimoLoop(bot, config, db, signal));
}

async function wikiAniimoLoop(bot, config, db, signal) {
  const zone = resolveTimezone(config.article_timezone);
  for (;;) {
    const now = DateTime.now().setZone(zone);
    const nextRun = nextWeeklyRunAt(now, config.wiki_aniimo_weekday, config.wiki_aniimo_hour);
    await cancellableSleep(Math.max(1.0, nextRun.diff(now).as("seconds")), signal);
    await runWeeklyWithRetries(bot, config, db, signal);
  }
}


// The runner and the wait are injectable so the retry policy can be tested
// without a wiki, a model or a ten-minute pause.
async function runWeeklyWithRetries(
  bot,
  config,
  db,
  signal,
  { runOnce = runWikiAniimoOnce, sleep = cancellableSleep } = {},
) {
  for (let attempt = 1; attempt <= WEEKLY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      if (await runOnce(bot, config, db)) {
        return;
      }
    } catch (error) {
      logger.exception(`Weekly Aniimo-of-the-week attempt ${attempt} failed.`, error);
    }
    if (attempt < WEEKLY_RETRY_ATTEMPTS) {
      logger.warning(
        `Aniimo-of-the-week produced no post; retrying in ${WEEKLY_RETRY_DELAY_SECONDS / 60} min ` +
          `(attempt ${attempt + 1}/${WEEKLY_RETRY_ATTEMPTS}).`,
      );
      await sleep(WEEKLY_RETRY_DELAY_SECONDS, signal);
    } else {
      logger.error("Aniimo-of-the-week produced no post after every retry; waiting for next week.");
    }
  }
}

/**
 * Queue one "Аніімо тижня" post for moderation. Returns true when a submission
 * was created.
 */
export async function runWikiAniimoOnce(bot, config, db) {
  const collector = new WikiAniimoCollector({ config, db, bot });
  const stats = await collector.runOnce(CollectionMode.MANUAL_LATEST);
  if (stats.sent_to_moderation === 0 && stats.failed === 0) {
    // Make a no-op run observable rather than a silent week-long gap.
    logger.warning(
      `Aniimo-of-the-week run produced no post (found=${stats.found}) — every creature has ` +
        "already featured or the wiki returned no roster.",
    );
  } else {
    logger.info(
      `Aniimo-of-the-week run: found=${stats.found} new=${stats.new} ` +
        `sent=${stats.sent_to_moderation} failed=${stats.failed}`,
    );
  }
  return stats.sent_to_moderation > 0;
}
