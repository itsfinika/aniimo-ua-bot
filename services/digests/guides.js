/**
 * Weekly "Гайди тижня" digest.
 *
 * Once a week (GUIDES_DIGEST_WEEKDAY at GUIDES_DIGEST_HOUR, ARTICLE_TIMEZONE) the
 * bot pulls the top GUIDES_FLAIR posts of the past week from GUIDES_SUBREDDIT,
 * asks Gemini for a Ukrainian title and a one-line summary for each, and queues
 * ONE text submission — a numbered list where every entry links to its own
 * Reddit post — into the normal moderation queue.
 *
 * It is a pointer to other people's work, never a retelling of it: the reader
 * gets enough to decide whether to open the guide, and the author keeps the
 * traffic and the credit. That is also why the post is a list rather than a
 * rewritten guide.
 *
 * Structurally this mirrors the fan-art digest (same fetcher, same weekly
 * scheduler, same per-ISO-week seen-key) and differs in two ways: the post is
 * text rather than an album, and its body is pre-rendered HTML — a list whose
 * every line links somewhere different cannot be expressed by the renderer's
 * single-`source_url` attribution.
 */

import { DateTime } from "luxon";

import { cancellableSleep, createTask } from "../background.js";
import { RedditSearchFetcher } from "../collectors/reddit/feed_fetcher.js";
import { GeminiDraftGenerator } from "../gemini.js";
import { t } from "../i18n.js";
import { getLogger } from "../logger.js";
import { sendSubmissionToModeration } from "../moderation.js";
import { formatCommunityFooterHtml } from "../post_footer.js";
import { collapseWhitespace, htmlEscape, lstrip } from "../pyutils.js";
import { isSafeHttpUrl } from "../urlutils.js";
import { nextWeeklyRunAt, pickDigestArts, resolveTimezone } from "./fanart.js";

const logger = getLogger("services.digests.guides");

export const SOURCE_TYPE = "reddit_guides";

// A weekly job gets one shot, so a Gemini outage at that exact minute would cost
// a whole week. Same policy as the "Аніімо тижня" rubric: a few spaced retries
// turn an outage into a post that is late by minutes instead of missing.
export const WEEKLY_RETRY_ATTEMPTS = 3;
export const WEEKLY_RETRY_DELAY_SECONDS = 600;

// At most this many guides by one author, so a single prolific writer does not
// become the whole digest.
export const MAX_GUIDES_PER_AUTHOR = 2;

/** Start the weekly digest loop, or return null when the feature is off. */
export function startGuidesDigestScheduler(bot, config, db) {
  if (!config.enable_guides_digest) {
    logger.info("Weekly guides digest is disabled (ENABLE_GUIDES_DIGEST).");
    return null;
  }

  logger.info(
    `Weekly guides digest enabled: weekday ${config.guides_digest_weekday} at ` +
      `${String(config.guides_digest_hour).padStart(2, "0")}:00 ${config.article_timezone}, ` +
      `top ${config.guides_digest_count} "${config.guides_flair}" from r/${config.guides_subreddit}`,
  );
  return createTask("guides-digest-scheduler", (signal) => digestLoop(bot, config, db, signal));
}

async function digestLoop(bot, config, db, signal) {
  const zone = resolveTimezone(config.article_timezone);
  for (;;) {
    const now = DateTime.now().setZone(zone);
    const nextRun = nextWeeklyRunAt(now, config.guides_digest_weekday, config.guides_digest_hour);
    await cancellableSleep(Math.max(1.0, nextRun.diff(now).as("seconds")), signal);
    await runWeeklyWithRetries(bot, config, db, signal);
  }
}

// The runner and the wait are injectable so the retry policy can be tested
// without Reddit, a model or a ten-minute pause.
async function runWeeklyWithRetries(
  bot,
  config,
  db,
  signal,
  { runOnce = runGuidesDigestOnce, sleep = cancellableSleep } = {},
) {
  for (let attempt = 1; attempt <= WEEKLY_RETRY_ATTEMPTS; attempt += 1) {
    try {
      if (await runOnce(bot, config, db)) {
        return;
      }
    } catch (error) {
      logger.exception(`Weekly guides digest attempt ${attempt} failed.`, error);
    }
    if (attempt < WEEKLY_RETRY_ATTEMPTS) {
      logger.warning(
        `Guides digest produced no post; retrying in ${WEEKLY_RETRY_DELAY_SECONDS / 60} min ` +
          `(attempt ${attempt + 1}/${WEEKLY_RETRY_ATTEMPTS}).`,
      );
      await sleep(WEEKLY_RETRY_DELAY_SECONDS, signal);
    } else {
      logger.error("Guides digest produced no post after every retry; waiting for next week.");
    }
  }
}

/**
 * Build and queue this week's digest. Returns true when a submission was
 * created, false when it was skipped (already done this week, or the week had
 * no usable guides).
 *
 * `force` bypasses the per-week guard so an admin can trigger a digest on demand
 * even if this week was already queued.
 */
export async function runGuidesDigestOnce(bot, config, db, { now = null, force = false, generator = null } = {}) {
  const zone = resolveTimezone(config.article_timezone);
  const current = now ?? DateTime.now().setZone(zone);
  const weekKey = isoWeekKey(current);

  if (!force && (await db.isSourceSeen(SOURCE_TYPE, weekKey))) {
    logger.info(`Guides digest for ${weekKey} already queued; skipping.`);
    return false;
  }

  if (!config.gemini_api_key) {
    logger.warning("Guides digest needs GEMINI_API_KEY to write the Ukrainian summaries; skipping.");
    return false;
  }

  const fetcher = new RedditSearchFetcher(config.guides_subreddit, [config.guides_flair], {
    sort: "top",
    time_filter: "week",
    // Over-fetch: the per-author cap and the usability filter both discard
    // posts, and a short week should still fill the list.
    limit: Math.max(config.guides_digest_count * 3, config.guides_digest_count),
  });
  const posts = await fetcher.fetchRecentPosts();
  const guides = pickDigestArts(posts.filter(isUsableGuide), config.guides_digest_count, MAX_GUIDES_PER_AUTHOR);
  if (!guides.length) {
    logger.warning(`Guides digest for ${weekKey} found no usable guides; not marking the week done.`);
    return false;
  }

  const summariser = generator ?? new GeminiDraftGenerator(config.gemini_api_key, config.gemini_model);
  // A model failure must NOT mark the week done — the retry wrapper gets another
  // go, and next week's run is unaffected either way.
  const summaries = await summariser.summariseGuides(guides);

  const subredditUrl = `https://www.reddit.com/r/${config.guides_subreddit}/`;
  const body = buildDigestHtml(guides, summaries);
  const submissionId = await db.createAiNewsSubmission({
    username: t("digests.guides.username"),
    original_text: buildOriginalText(guides, weekKey),
    draft_text: body,
    message_type: "text",
    media_url: null,
    media_type: "none",
    source_type: SOURCE_TYPE,
    source_id: weekKey,
    source_url: subredditUrl,
    article_date: current.toFormat("yyyy-MM-dd"),
    article_date_display: null,
    tags: [t("digests.guides.tag")],
  });
  await db.markSourceSeen({
    source_type: SOURCE_TYPE,
    source_id: weekKey,
    source_url: subredditUrl,
    title: `${t("digests.guides.title")} (${weekKey})`,
    article_date: current.toFormat("yyyy-MM-dd"),
  });
  // Marked seen BEFORE the send, like the news collectors: the submission is
  // already queued at this point, so a send that fails halfway must cost one
  // card, never a digest that is rebuilt and re-sent on the next attempt.
  await sendSubmissionToModeration(bot, config, db, submissionId);
  logger.info(`Queued guides digest for ${weekKey} with ${guides.length} guides (submission ${submissionId})`);
  return true;
}

/**
 * A post worth listing: it has a title and a link to open.
 *
 * The flair itself is the quality filter — on r/Aniimo the "Guide" flair is
 * applied carefully — so nothing else is judged here. The moderation queue is
 * the human check, and over-filtering would quietly drop good guides whose
 * value lives in an image or a video rather than in the post body.
 */
function isUsableGuide(post) {
  return Boolean(String(post?.title ?? "").trim()) && isSafeHttpUrl(String(post?.web_url ?? ""));
}

/**
 * The finished post as HTML.
 *
 * Every interpolated value is escaped here: the titles, summaries and author
 * nicks all originate outside the bot (Reddit posts and the model's reading of
 * them), and this is the one place where they become markup.
 */
export function buildDigestHtml(guides, summaries) {
  const lines = [htmlEscape(t("digests.guides.title")), "", htmlEscape(t("digests.guides.intro")), ""];

  guides.forEach((guide, position) => {
    const summary = summaries[position] ?? null;
    // No Ukrainian title means the model skipped or mangled this entry; the
    // guide still gets listed under its own English title rather than vanishing.
    const label = summary?.title || collapseWhitespace(String(guide.title ?? ""));
    lines.push(`${position + 1}. <a href="${htmlEscape(guide.web_url, true)}">${htmlEscape(label)}</a>`);
    const credit = authorHandle(guide.author) || t("digests.guides.unknown_author");
    const tail = summary?.summary ? `${summary.summary} ` : "";
    lines.push(`${htmlEscape(tail)}(${htmlEscape(credit)})`);
    lines.push("");
  });

  lines.push(htmlEscape(t("digests.guides.engagement")));
  lines.push("", htmlEscape(t("digests.guides.hashtags")));

  const footer = formatCommunityFooterHtml();
  if (footer) {
    lines.push("", footer);
  }

  return lines.join("\n").trim();
}

/** What the moderation card shows an admin: the untranslated week, as fetched. */
function buildOriginalText(guides, weekKey) {
  const lines = [`Гайди тижня (${weekKey}), ${guides.length} шт.:`, ""];
  guides.forEach((guide, position) => {
    lines.push(`${position + 1}. ${guide.title} ${authorHandle(guide.author)} ${guide.web_url}`.trim());
  });
  return lines.join("\n").trim();
}

function authorHandle(author) {
  let name = lstrip(String(author ?? "").trim(), "/");
  if (name.startsWith("u/")) {
    name = name.slice(2);
  }
  name = name.trim();
  return name ? `u/${name}` : "";
}

function isoWeekKey(moment) {
  return `${moment.weekYear}-W${String(moment.weekNumber).padStart(2, "0")}`;
}

// Exported for the unit tests, which cover the helpers and the retry policy
// directly, without Reddit or a model.
export const __testing = { authorHandle, isoWeekKey, isUsableGuide, runWeeklyWithRetries };
