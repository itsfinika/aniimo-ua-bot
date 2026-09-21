/**
 * Weekly fan-art digest.
 *
 * Once a week (FANART_DIGEST_WEEKDAY at FANART_DIGEST_HOUR, ARTICLE_TIMEZONE) the
 * bot pulls the top "Fan Art" posts of the past week from FANART_SUBREDDIT and
 * queues ONE album submission — the top images plus a credited caption — into the
 * normal moderation queue. A per-ISO-week seen-key guards against double posting,
 * exactly like the collectors' source dedup; failures are logged and retried next
 * week, mirroring the news and backup schedulers.
 */

import { DateTime, FixedOffsetZone, IANAZone } from "luxon";

import { cancellableSleep, createTask } from "../background.js";
import { RedditSearchFetcher } from "../collectors/reddit/feed_fetcher.js";
import { t } from "../i18n.js";
import { getLogger } from "../logger.js";
import { sendSubmissionToModeration } from "../moderation.js";
import { htmlEscape, lstrip } from "../pyutils.js";
import { formatCommunityFooterHtml } from "../post_footer.js";
import { urlsplit } from "../urlutils.js";

const logger = getLogger("services.digests.fanart");

export const SOURCE_TYPE = "reddit_fanart";

/** Start the weekly digest loop, or return null when the feature is off. */
export function startFanartDigestScheduler(bot, config, db) {
  if (!config.enable_fanart_digest) {
    logger.info("Weekly fan-art digest is disabled (ENABLE_FANART_DIGEST).");
    return null;
  }

  logger.info(
    `Weekly fan-art digest enabled: weekday ${config.fanart_digest_weekday} at ` +
      `${String(config.fanart_digest_hour).padStart(2, "0")}:00 ${config.article_timezone}, ` +
      `top ${config.fanart_digest_count} from r/${config.fanart_subreddit}`,
  );
  return createTask("fanart-digest-scheduler", (signal) => digestLoop(bot, config, db, signal));
}

async function digestLoop(bot, config, db, signal) {
  const zone = resolveTimezone(config.article_timezone);
  for (;;) {
    const now = DateTime.now().setZone(zone);
    const nextRun = nextWeeklyRunAt(now, config.fanart_digest_weekday, config.fanart_digest_hour);
    await cancellableSleep(Math.max(1.0, nextRun.diff(now).as("seconds")), signal);
    try {
      await runFanartDigestOnce(bot, config, db);
    } catch (error) {
      logger.exception("Weekly fan-art digest failed; retrying next week.", error);
    }
  }
}

/** The next occurrence of `weekday` (Mon=0) at `hour`:00 strictly after now. */
export function nextWeeklyRunAt(now, weekday, hour) {
  let candidate = now.set({ hour, minute: 0, second: 0, millisecond: 0 });
  // luxon's `weekday` is 1=Mon..7=Sun; the config uses Python's 0=Mon..6=Sun.
  const daysAhead = (weekday - (now.weekday - 1) + 7) % 7;
  candidate = candidate.plus({ days: daysAhead });
  if (candidate <= now) {
    candidate = candidate.plus({ days: 7 });
  }
  return candidate;
}

/**
 * Build and queue this week's digest. Returns true when a submission was
 * created, false when it was skipped (already done this week, or no art found).
 *
 * `force` bypasses the per-week guard so an admin can trigger a digest on demand
 * (e.g. for testing) even if this week was already queued.
 */
export async function runFanartDigestOnce(bot, config, db, { now = null, force = false } = {}) {
  const zone = resolveTimezone(config.article_timezone);
  const current = now ?? DateTime.now().setZone(zone);
  const weekKey = isoWeekKey(current);

  if (!force && (await db.isSourceSeen(SOURCE_TYPE, weekKey))) {
    logger.info(`Fan-art digest for ${weekKey} already queued; skipping.`);
    return false;
  }

  const fetcher = new RedditSearchFetcher(config.fanart_subreddit, [config.fanart_flair], {
    sort: "top",
    time_filter: "week",
    limit: Math.max(config.fanart_digest_count * 2, config.fanart_digest_count),
  });
  const posts = await fetcher.fetchRecentPosts();
  // A media group is atomic — ONE URL Telegram can't fetch fails the whole album.
  // So include only direct i.redd.it images, which Telegram reliably fetches.
  // The fetcher already upgrades preview.redd.it thumbnails to their full-res
  // i.redd.it original, so only posts with no Reddit-hosted image at all
  // (gallery/video/external-link previews) are skipped here.
  const arts = pickDigestArts(
    posts.filter((post) => isDirectImage(post.image_url)),
    config.fanart_digest_count,
  );
  if (!arts.length) {
    logger.warning(`Fan-art digest for ${weekKey} found no direct-image posts; not marking the week done.`);
    return false;
  }

  const subredditUrl = `https://www.reddit.com/r/${config.fanart_subreddit}/`;
  const caption = buildCaption(arts, config.fanart_subreddit);
  const submissionId = await db.createAlbumSubmission({
    username: t("digests.fanart.username"),
    original_text: buildOriginalText(arts, weekKey),
    caption,
    image_urls: arts.map((post) => String(post.image_url)),
    source_type: SOURCE_TYPE,
    source_id: weekKey,
    source_url: subredditUrl,
    article_date: current.toFormat("yyyy-MM-dd"),
    article_date_display: null,
    tags: [t("digests.fanart.tag")],
  });
  await sendSubmissionToModeration(bot, config, db, submissionId);
  await db.markSourceSeen({
    source_type: SOURCE_TYPE,
    source_id: weekKey,
    source_url: subredditUrl,
    title: `${t("digests.fanart.title")} (${weekKey})`,
    article_date: current.toFormat("yyyy-MM-dd"),
  });
  logger.info(`Queued fan-art digest for ${weekKey} with ${arts.length} arts (submission ${submissionId})`);
  return true;
}

/**
 * Build the album caption as HTML (sent raw, not via formatPostHtml): each art is
 * credited by its author's Reddit nick, hyperlinked to the post — no post titles
 * — followed by an engagement prompt, the tags and the community footer.
 */
function buildCaption(arts, subreddit) {
  const lines = [htmlEscape(t("digests.fanart.title")), "", htmlEscape(t("digests.fanart.intro")), ""];
  arts.forEach((post, position) => {
    const author = authorHandle(post.author) || t("digests.fanart.unknown_author");
    const credit = isSafeHttpUrl(post.web_url)
      ? `<a href="${htmlEscape(post.web_url, true)}">${htmlEscape(author)}</a>`
      : htmlEscape(author);
    lines.push(`${position + 1}. ${credit}`);
  });

  lines.push("", htmlEscape(t("digests.fanart.engagement")));
  lines.push("", htmlEscape(t("digests.fanart.hashtags")));

  const footer = formatCommunityFooterHtml();
  if (footer) {
    lines.push("", footer);
  }

  return lines.join("\n").trim();
}

function isSafeHttpUrl(url) {
  const parsed = urlsplit(String(url ?? "").trim());
  return (parsed.scheme === "http" || parsed.scheme === "https") && Boolean(parsed.netloc);
}

function buildOriginalText(arts, weekKey) {
  const lines = [`Фан-арт тижня (${weekKey}) — ${arts.length} робіт:`, ""];
  arts.forEach((post, position) => {
    const author = authorHandle(post.author);
    lines.push(`${position + 1}. ${post.title} ${author} ${post.web_url}`.trim());
  });
  return lines.join("\n").trim();
}

const STILL_IMAGE_SUFFIXES = [".jpg", ".jpeg", ".png", ".webp"];

/**
 * True only for a direct https://i.redd.it/... STILL image — the host Telegram
 * can reliably fetch inside a media group (signed preview/external URLs cannot),
 * and a still type the album upload accepts (animated .gif is excluded so an
 * all-gif week doesn't create a submission whose every image is then skipped).
 */
function isDirectImage(url) {
  if (!url) {
    return false;
  }
  const parsed = urlsplit(url);
  if (parsed.scheme !== "https" || parsed.netloc.toLowerCase() !== "i.redd.it") {
    return false;
  }
  const path = parsed.path.toLowerCase();
  return STILL_IMAGE_SUFFIXES.some((suffix) => path.endsWith(suffix));
}

// Exported for the unit tests, which cover the image/author/week helpers directly.
export const __testing = { authorHandle, isDirectImage, isoWeekKey };

/** At most this many works by one artist in a single digest. */
export const MAX_ARTS_PER_AUTHOR = 3;

/**
 * The week's top art, capped per artist.
 *
 * Reddit's weekly top is ranked per post, so one prolific artist could take
 * four of ten slots and the digest stopped reading as a community round-up.
 * Posts keep their original ranking; a fourth work by the same artist is only
 * held back, and is used to refill the album if capping would otherwise leave
 * it short — a digest with fewer images is worse than a slightly lopsided one.
 * An empty/unknown author is never capped, since those are not one person.
 */
export function pickDigestArts(posts, limit, maxPerAuthor = MAX_ARTS_PER_AUTHOR) {
  const picked = [];
  const heldBack = [];
  const perAuthor = new Map();

  for (const post of posts) {
    if (picked.length >= limit) break;
    const author = authorHandle(post.author).toLowerCase();
    if (!author) {
      picked.push(post);
      continue;
    }
    const used = perAuthor.get(author) ?? 0;
    if (used >= maxPerAuthor) {
      heldBack.push(post);
      continue;
    }
    perAuthor.set(author, used + 1);
    picked.push(post);
  }

  for (const post of heldBack) {
    if (picked.length >= limit) break;
    picked.push(post);
  }
  return picked;
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

export function resolveTimezone(name) {
  if (IANAZone.isValidZone(name)) {
    return IANAZone.create(name);
  }
  logger.warning(`Unknown ARTICLE_TIMEZONE ${JSON.stringify(name)}; using UTC for the digest schedule.`);
  return FixedOffsetZone.utcInstance;
}
