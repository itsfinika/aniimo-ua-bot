/**
 * The activity report: what every source actually did, and what the queue looks
 * like now.
 *
 * Until this existed, the only numbers the operator ever saw were the ones
 * `/fetch_news` prints for a single manual run. Nothing said which source feeds
 * the channel and which just knocks on the network every five minutes, or how
 * long a draft has been waiting for a decision. The same builder serves the
 * weekly message and the on-demand `/stats` command, so the two can never drift.
 */

import { DateTime } from "luxon";

import { STATUS_PENDING, STATUS_PUBLISHED, STATUS_REJECTED } from "../database.js";
import { createTask, cancellableSleep } from "./background.js";
import { listCollectorDefinitions } from "./collectors/registry.js";
import { nextWeeklyRunAt, resolveTimezone } from "./digests/fanart.js";
import { t } from "./i18n.js";
import { htmlEscape } from "./pyutils.js";
import { getLogger } from "./logger.js";

const logger = getLogger("services.reports");

// Sources that never pass through a collector: the fan-art digest queues itself,
// and readers' own submissions carry no source type at all.
const USER_SOURCE = "";
export const FANART_SOURCE_TYPE = "reddit_fanart";

/**
 * Gather the window's activity and render it.
 *
 * `days` counts back from now; the backlog line ignores it, because a draft
 * waiting three weeks is exactly what a weekly report should surface.
 */
export async function buildActivityReport(db, config, { days = 7, now = null } = {}) {
  const zone = resolveTimezone(config.article_timezone);
  const until = now ?? DateTime.now().setZone(zone);
  const since = until.minus({ days });
  const activity = await db.collectActivity({ since: since.toUTC().toISO() });
  return formatActivityReport(activity, { since, until, days, sources: reportSources(config) });
}

/** The sources a report lists, in a stable order, with their display names. */
function reportSources(config) {
  const collectors = listCollectorDefinitions().map((definition) => ({
    source_type: definition.source_type,
    title: t(definition.title_key),
    enabled: config === null ? true : isSourceEnabled(definition, config),
  }));
  return [
    ...collectors,
    { source_type: FANART_SOURCE_TYPE, title: t("reports.sources.fanart"), enabled: Boolean(config?.enable_fanart_digest) },
    { source_type: USER_SOURCE, title: t("reports.sources.user"), enabled: true },
  ];
}

function isSourceEnabled(definition, config) {
  const flags = {
    official_aniimo: true,
    steam: config.enable_steam_source,
    // The registry also refuses to run Bluesky without an actor, so the report
    // must not claim the source is on when only the flag is set.
    bluesky: config.enable_bluesky_source && Boolean(String(config.bluesky_actor ?? "").trim()),
    youtube: config.enable_youtube_source,
    reddit: config.enable_reddit_source,
    aniimotools: config.enable_aniimotools_source,
    wiki_aniimo: config.enable_wiki_aniimo,
  };
  return Boolean(flags[definition.source_type]);
}

/**
 * Render the gathered numbers as the Telegram message.
 *
 * Exported for the tests, which drive it with fixtures rather than a database.
 */
export function formatActivityReport(activity, { since, until, days, sources }) {
  const seen = indexBy(activity.seen, (row) => `${row.source_type}:${row.outcome}`);
  const submissions = indexBy(activity.submissions, (row) => `${row.source_type}:${row.status}`);

  const lines = [
    `<b>${htmlEscape(t("reports.title", { days }))}</b>`,
    htmlEscape(t("reports.period", { since: formatDay(since), until: formatDay(until) })),
    "",
  ];

  const totals = { published: 0, rejected: 0, queued: 0, duplicates: 0 };
  for (const source of sources) {
    const found = (seen.get(`${source.source_type}:queued`) ?? 0) + (seen.get(`${source.source_type}:unknown`) ?? 0);
    const duplicates = seen.get(`${source.source_type}:duplicate`) ?? 0;
    const published = submissions.get(`${source.source_type}:${STATUS_PUBLISHED}`) ?? 0;
    const rejected = submissions.get(`${source.source_type}:${STATUS_REJECTED}`) ?? 0;
    const pending = submissions.get(`${source.source_type}:${STATUS_PENDING}`) ?? 0;
    const queued = published + rejected + pending;

    totals.published += published;
    totals.rejected += rejected;
    totals.queued += queued;
    totals.duplicates += duplicates;

    lines.push(formatSourceLine(source, { found, duplicates, published, rejected, pending, queued }));
  }

  lines.push("", htmlEscape(t("reports.totals", totals)));
  lines.push(htmlEscape(formatBacklog(activity, until)));
  return lines.join("\n");
}

function formatSourceLine(source, counts) {
  const name = `<b>${htmlEscape(source.title)}</b>`;
  if (!source.enabled && !counts.queued && !counts.found) {
    return `${name} — ${htmlEscape(t("reports.source.disabled"))}`;
  }
  if (!counts.queued && !counts.found && !counts.duplicates) {
    return `${name} — ${htmlEscape(t("reports.source.silent"))}`;
  }

  // A reader's submission is never "found" by a collector and never deduplicated,
  // so those two numbers would always read as zero and are left out.
  const parts =
    source.source_type === USER_SOURCE
      ? [t("reports.source.submitted", { count: counts.queued })]
      : [t("reports.source.found", { count: counts.found + counts.duplicates })];
  if (counts.duplicates) {
    parts.push(t("reports.source.duplicates", { count: counts.duplicates }));
  }
  parts.push(t("reports.source.published", { count: counts.published }));
  if (counts.rejected) {
    parts.push(t("reports.source.rejected", { count: counts.rejected }));
  }
  if (counts.pending) {
    parts.push(t("reports.source.pending", { count: counts.pending }));
  }
  return `${name} — ${htmlEscape(parts.join(", "))}`;
}

function formatBacklog(activity, until) {
  if (!activity.pending_total) {
    return t("reports.backlog.empty");
  }
  const oldest = activity.pending_oldest ? DateTime.fromISO(activity.pending_oldest, { zone: "utc" }) : null;
  if (oldest === null || !oldest.isValid) {
    return t("reports.backlog.some", { count: activity.pending_total });
  }
  const ageDays = Math.max(0, Math.floor(until.diff(oldest.setZone(until.zone)).as("days")));
  if (ageDays < 1) {
    return t("reports.backlog.some", { count: activity.pending_total });
  }
  return t("reports.backlog.aged", { count: activity.pending_total, days: ageDays });
}

function formatDay(moment) {
  return moment.toFormat("dd.MM");
}

function indexBy(rows, key) {
  const index = new Map();
  for (const row of rows) {
    index.set(key(row), (index.get(key(row)) ?? 0) + row.total);
  }
  return index;
}

/** Start the weekly report loop, or return null when the feature is off. */
export function startWeeklyReportScheduler(bot, config, db) {
  if (!config.enable_weekly_report) {
    logger.info("Weekly activity report is disabled (ENABLE_WEEKLY_REPORT).");
    return null;
  }

  logger.info(
    `Weekly activity report enabled: weekday ${config.weekly_report_weekday} at ` +
      `${String(config.weekly_report_hour).padStart(2, "0")}:00 ${config.article_timezone}`,
  );
  return createTask("weekly-report-scheduler", (signal) => reportLoop(bot, config, db, signal));
}

async function reportLoop(bot, config, db, signal) {
  const zone = resolveTimezone(config.article_timezone);
  for (;;) {
    const now = DateTime.now().setZone(zone);
    const nextRun = nextWeeklyRunAt(now, config.weekly_report_weekday, config.weekly_report_hour);
    await cancellableSleep(Math.max(1.0, nextRun.diff(now).as("seconds")), signal);
    try {
      await sendActivityReport(bot, config, db, { days: 7 });
    } catch (error) {
      // A failed report must never take the scheduler down with it.
      logger.exception("Weekly activity report failed; retrying next week.", error);
    }
  }
}

/** Send the report to the admin chat. */
export async function sendActivityReport(bot, config, db, { days = 7 } = {}) {
  const text = await buildActivityReport(db, config, { days });
  await bot.api.sendMessage(config.admin_chat_id, text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
  logger.info(`Sent the ${days}-day activity report to chat ${config.admin_chat_id}`);
}
