import { t } from "../i18n.js";
import { getLogger } from "../logger.js";
import { errorText } from "../pyutils.js";
import {
  CollectionMode,
  emptyStats,
  formatCollectionReport,
  formatCollectionReports,
} from "./base.js";
import { DEFINITION as ANIIMOTOOLS_DEFINITION, AniimoToolsCollector } from "./aniimotools/collector.js";
import { DEFINITION as BLUESKY_DEFINITION, BlueskyCollector } from "./bluesky/collector.js";
import { DEFINITION as OFFICIAL_ANIIMO_DEFINITION, OfficialAniimoCollector } from "./official_aniimo/collector.js";
import { DEFINITION as REDDIT_DEFINITION, RedditLeaksCollector } from "./reddit/collector.js";
import { DEFINITION as REDDIT_WATCH_DEFINITION, RedditWatchCollector } from "./reddit_watch/collector.js";
import { DEFINITION as STEAM_DEFINITION, SteamNewsCollector } from "./steam/collector.js";
import { SubmissionThrottle } from "./throttle.js";
import { DEFINITION as WIKI_ANIIMO_DEFINITION, WikiAniimoCollector } from "./wiki_aniimo/collector.js";
import { DEFINITION as YOUTUBE_DEFINITION, YouTubeCollector } from "./youtube/collector.js";

const logger = getLogger("services.collectors.registry");

function alwaysEnabled() {
  return true;
}

let blueskyActorWarned = false;

/**
 * Bluesky needs an account to poll, and Aniimo has no official one, so the
 * default actor is empty. A flag turned on without an actor would otherwise
 * fetch a feed for "" every tick; treat it as off and say so once, not per tick.
 */
function blueskyEnabled(config) {
  if (!config.enable_bluesky_source) {
    return false;
  }
  if (String(config.bluesky_actor ?? "").trim()) {
    return true;
  }
  if (!blueskyActorWarned) {
    blueskyActorWarned = true;
    logger.warning("ENABLE_BLUESKY_SOURCE is on but BLUESKY_ACTOR is empty; the Bluesky source stays disabled.");
  }
  return false;
}

/**
 * `scheduled: false` marks a source that runs on its OWN schedule: it stays
 * selectable as a manual /fetch_news button but must never join the shared news
 * tick, which would post from it every NEWS_CHECK_INTERVAL_MINUTES instead of
 * weekly.
 */
const COLLECTORS = new Map([
  [
    OFFICIAL_ANIIMO_DEFINITION.collector_id,
    {
      definition: OFFICIAL_ANIIMO_DEFINITION,
      factory: OfficialAniimoCollector,
      isEnabled: alwaysEnabled,
      scheduled: true,
    },
  ],
  [
    // Right after the site: Steam repeats the site's announcements, and running
    // second lets cross-source dedup see the site's copy first.
    STEAM_DEFINITION.collector_id,
    {
      definition: STEAM_DEFINITION,
      factory: SteamNewsCollector,
      isEnabled: (config) => config.enable_steam_source,
      scheduled: true,
    },
  ],
  [
    BLUESKY_DEFINITION.collector_id,
    {
      definition: BLUESKY_DEFINITION,
      factory: BlueskyCollector,
      isEnabled: blueskyEnabled,
      scheduled: true,
    },
  ],
  [
    YOUTUBE_DEFINITION.collector_id,
    {
      definition: YOUTUBE_DEFINITION,
      factory: YouTubeCollector,
      isEnabled: (config) => config.enable_youtube_source,
      scheduled: true,
    },
  ],
  [
    REDDIT_DEFINITION.collector_id,
    {
      definition: REDDIT_DEFINITION,
      factory: RedditLeaksCollector,
      isEnabled: (config) => config.enable_reddit_source,
      scheduled: true,
    },
  ],
  [
    REDDIT_WATCH_DEFINITION.collector_id,
    {
      definition: REDDIT_WATCH_DEFINITION,
      factory: RedditWatchCollector,
      isEnabled: (config) => config.enable_reddit_watch && config.reddit_watch_queries.length > 0,
      scheduled: true,
    },
  ],
  [
    ANIIMOTOOLS_DEFINITION.collector_id,
    {
      definition: ANIIMOTOOLS_DEFINITION,
      factory: AniimoToolsCollector,
      isEnabled: (config) => config.enable_aniimotools_source,
      scheduled: true,
    },
  ],
  [
    WIKI_ANIIMO_DEFINITION.collector_id,
    {
      definition: WIKI_ANIIMO_DEFINITION,
      factory: WikiAniimoCollector,
      isEnabled: (config) => config.enable_wiki_aniimo,
      scheduled: false, // weekly rubric: manual button only, never on the tick
    },
  ],
]);

export function listCollectorDefinitions(config = null) {
  return [...COLLECTORS.values()]
    .filter((entry) => config === null || entry.isEnabled(config))
    .map((entry) => entry.definition);
}

export function getCollectorDefinition(collectorId) {
  const entry = COLLECTORS.get(collectorId);
  return entry === undefined ? null : entry.definition;
}

export function createCollector(collectorId, { config, db, bot }) {
  const entry = COLLECTORS.get(collectorId);
  if (entry === undefined || !entry.isEnabled(config)) {
    return null;
  }

  return new entry.factory({ config, db, bot });
}

/**
 * The collectors that belong to the periodic news tick — self-scheduled sources
 * are deliberately excluded.
 */
export function createAllCollectors({ config, db, bot }) {
  return [...COLLECTORS.values()]
    .filter((entry) => entry.scheduled && entry.isEnabled(config))
    .map((entry) => new entry.factory({ config, db, bot }));
}

/**
 * Re-draft ONE article chosen by its public URL, whichever enabled source still
 * lists it. Collectors are tried in registry order (the official site first), and
 * a source that fails to answer is skipped rather than aborting the search.
 *
 * @returns {Promise<object|null>} the run's stats, or null when no enabled
 *   source's listing carries that URL.
 */
export async function redraftByUrl({ config, db, bot, url }) {
  for (const entry of COLLECTORS.values()) {
    if (!entry.isEnabled(config)) {
      continue;
    }
    const collector = new entry.factory({ config, db, bot });
    let stats;
    try {
      stats = await collector.redraftUrl(url);
    } catch (error) {
      logger.exception(`Redraft-by-URL failed for ${entry.definition.collector_id}`, error);
      continue;
    }
    if (stats !== null) {
      return stats;
    }
  }
  return null;
}

/**
 * Run one tick over every scheduled collector.
 *
 * `collectors` exists only as a test seam — production always leaves it unset and
 * gets the configured set. (JavaScript cannot intercept a module's call to its own
 * function the way Python's monkeypatch could, so the seam has to be explicit.)
 */
export async function runAllCollectors({
  config,
  db,
  bot,
  mode = CollectionMode.SCHEDULED_SINCE_LAST,
  collectors = null,
}) {
  // Run collectors sequentially (not in parallel): each collector's cross-source
  // dedup reads the seen-titles of the OTHERS, so the previous collector must
  // finish marking its story seen before the next one checks — otherwise the same
  // story arriving in two feeds in one tick slips past dedup.
  const activeCollectors = collectors ?? createAllCollectors({ config, db, bot });
  // One throttle shared across every collector so the inter-send gap is honoured
  // across sources within a tick, not just within a single collector's loop.
  const throttle = new SubmissionThrottle(config.moderation_send_interval_seconds);
  const statsList = [];
  for (const collector of activeCollectors) {
    collector.throttle = throttle;
    statsList.push(await runCollectorSafely(collector, mode));
  }
  return statsList;
}

async function runCollectorSafely(collector, mode) {
  const definition = collector.definition;
  try {
    return await collector.runOnce(mode);
  } catch (error) {
    logger.exception(`Collector ${definition.collector_id} failed`, error);
    const stats = emptyStats(definition);
    stats.failed = 1;
    stats.errors.push(t("collector_report.collector_run_failed", { error: errorText(error) }));
    return stats;
  }
}

export { CollectionMode, formatCollectionReport, formatCollectionReports };
