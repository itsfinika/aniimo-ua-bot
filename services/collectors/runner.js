/**
 * Shared collector orchestration engine.
 *
 * This module holds `BaseNewsCollector`, the abstract base every news collector
 * extends. It is kept separate from services/collectors/base.js (which carries
 * only the lightweight types the UI/registry import) because the orchestration
 * here depends on the moderation/Gemini layers — importing those from `base`
 * would create a `base -> moderation -> keyboards -> base` cycle.
 *
 * To add a new source, extend `BaseNewsCollector` and implement `fetchListing`,
 * `parseEntry` and `missingGeminiWarning`.
 */

import { DateTime } from "luxon";

import { buildUtcTimeConversionNotes } from "../date_utils.js";
import { GeminiDraftGenerator, geminiDraftInput } from "../gemini.js";
import { t } from "../i18n.js";
import { getLogger } from "../logger.js";
import { sendSubmissionToModeration } from "../moderation.js";
import { compareCalendarDates, dateFromIsoFormat, errorText, fromIsoFormat, hasIsoOffset } from "../pyutils.js";
import { collectPublishableLinks } from "../source_links.js";
import { CollectionMode, emptyStats } from "./base.js";
import { SubmissionThrottle } from "./throttle.js";

const logger = getLogger("services.collectors.runner");

export class BaseNewsCollector {
  /**
   * Shared `runOnce` orchestration for every news collector.
   *
   * Subclasses provide only the source-specific behaviour:
   *
   *  * `fetchListing()` — return the listing entries to consider.
   *  * `parseEntry(entry)` — turn one entry into a draft candidate.
   *  * `missingGeminiWarning()` — the message shown when the Gemini key is absent.
   *
   * The generic dedup/date-gating/draft/moderation pipeline lives here so new
   * sources do not re-implement it.
   */

  // Whether this collector's items may be dropped as cross-source duplicates of
  // items already seen from OTHER sources. The authoritative official source
  // sets this false so its full-detail article is never suppressed in favour of
  // a shorter social post that surfaced the same story first; its titles still
  // remain visible for other sources to dedup against.
  static participates_in_cross_source_dedup = true;

  constructor({ config, db, bot }) {
    this.config = config;
    this.db = db;
    this.bot = bot;
    // No-op by default so a single manual run is never delayed. `runAllCollectors`
    // swaps in one shared, configured throttle so a multi-item tick is spaced out.
    this.throttle = new SubmissionThrottle(0);
    // Copied onto the instance (rather than read through the class) so a single
    // collector can opt out at runtime, exactly as the Python attribute allowed.
    this.participatesInCrossSourceDedup = this.constructor.participates_in_cross_source_dedup;
  }

  get definition() {
    return this.constructor.definition;
  }

  // --- source-specific hooks -------------------------------------------------

  /** Fetch the listing and return one listing entry per item. */
  async fetchListing() {
    throw new Error("fetchListing must be implemented by the collector");
  }

  /** Fetch and parse a single entry into a normalized draft candidate. */
  async parseEntry(entry) {
    throw new Error("parseEntry must be implemented by the collector");
  }

  /** User-facing warning appended to stats when GEMINI_API_KEY is missing. */
  missingGeminiWarning() {
    throw new Error("missingGeminiWarning must be implemented by the collector");
  }

  // --- shared orchestration --------------------------------------------------

  async runOnce(mode = CollectionMode.MANUAL_LATEST) {
    const stats = emptyStats(this.definition);
    const entries = await this.fetchListing();
    stats.found = entries.length;

    if (!entries.length) {
      logger.warning(`${this.definition.collector_id} collector found no entries`);
      return stats;
    }

    if (!this.config.gemini_api_key) {
      const warning = this.missingGeminiWarning();
      logger.warning(
        `GEMINI_API_KEY is missing. Skipping AI draft generation for ${this.definition.collector_id}.`,
      );
      stats.errors.push(warning);
      await this.countSeenAndNewWithoutGemini(entries, stats, mode);
      return stats;
    }

    const generator = new GeminiDraftGenerator(this.config.gemini_api_key, this.config.gemini_model);
    let latestSeenArticleDate = null;
    if (mode === CollectionMode.SCHEDULED_SINCE_LAST) {
      latestSeenArticleDate = await this.db.getLatestSeenArticleDate(this.definition.source_type);
    }

    if (mode === CollectionMode.FORCE_LATEST) {
      const candidate = await this.forceLatestCandidate(entries, stats);
      if (candidate !== null) {
        await this.createModerationSubmissions(candidate, generator, stats);
      }
      return stats;
    }

    if (mode === CollectionMode.MANUAL_LATEST) {
      const candidate = await this.findLatestUnseenCandidate(entries, stats, generator);
      if (candidate !== null) {
        await this.createModerationSubmissions(candidate, generator, stats);
      }
      return stats;
    }

    for (const entry of entries) {
      const candidate = await this.parseCandidateIfNeeded(entry, stats, latestSeenArticleDate, generator);
      if (candidate === null) {
        continue;
      }

      await this.createModerationSubmissions(candidate, generator, stats);
    }

    return stats;
  }

  async countSeenAndNewWithoutGemini(entries, stats, mode) {
    for (const entry of entries) {
      if (await this.db.isSourceSeen(this.definition.source_type, entry.dedup_key)) {
        stats.duplicates += 1;
      } else {
        stats.new += 1;
        if (mode === CollectionMode.MANUAL_LATEST) {
          break;
        }
      }
    }
  }

  /**
   * Parse the newest listing item and hand it back regardless of dedup.
   *
   * Both dedup checks are skipped ON PURPOSE. The seen-check would reject the
   * item — being already seen is the whole reason this mode exists — and the
   * cross-source check would match the article against its own published title
   * and, worse, mark it seen on the way out. Nothing here writes to
   * `seen_sources`; the submission that follows is an ordinary moderation draft
   * an admin can reject, so a forced run leaves no state behind if unused.
   */
  async forceLatestCandidate(entries, stats) {
    const entry = entries[0] ?? null;
    if (entry === null) {
      return null;
    }
    stats.duplicates = Math.max(0, entries.length - 1);
    const candidate = await this.parseEntry(entry);
    stats.new += 1;
    return candidate;
  }

  async findLatestUnseenCandidate(entries, stats, generator) {
    for (const entry of entries) {
      const candidate = await this.parseCandidateIfNeeded(entry, stats, null, generator);
      if (candidate !== null) {
        return candidate;
      }
    }

    return null;
  }

  async parseCandidateIfNeeded(entry, stats, latestSeenArticleDate, generator) {
    const sourceType = this.definition.source_type;
    if (await this.db.isSourceSeen(sourceType, entry.dedup_key)) {
      stats.duplicates += 1;
      return null;
    }

    const candidate = await this.parseEntry(entry);

    if (candidate.source_id !== entry.dedup_key && (await this.db.isSourceSeen(sourceType, candidate.source_id))) {
      stats.duplicates += 1;
      return null;
    }

    if (latestSeenArticleDate && !isNewerOrSameArticleDate(candidate.article_date, latestSeenArticleDate)) {
      return null;
    }

    if (await this.isCrossSourceDuplicate(candidate, generator)) {
      stats.duplicates += 1;
      // Record it as seen so we don't re-fetch, re-parse and re-ask Gemini
      // about the same item on every subsequent run.
      await this.db.markSourceSeen({
        source_type: sourceType,
        source_id: candidate.source_id,
        source_url: candidate.source_url,
        title: candidate.title,
        article_date: candidate.article_date,
        outcome: "duplicate",
      });
      return null;
    }

    stats.new += 1;
    return candidate;
  }

  /**
   * Ask Gemini whether this candidate's title already matches a recently seen
   * one from any source. Fails open (returns false) so a check error never drops
   * real news.
   */
  async isCrossSourceDuplicate(candidate, generator) {
    if (!this.participatesInCrossSourceDedup) {
      return false;
    }

    if (!this.config.enable_cross_source_dedup) {
      return false;
    }

    const limit = this.config.cross_source_dedup_title_limit;
    if (limit <= 0) {
      return false;
    }

    // Compare only against OTHER sources: a source never dedups against its own
    // titles, so with a single source configured this is a safe no-op and cannot
    // suppress genuinely-new articles from that same source.
    const existingTitles = await this.db.getRecentSeenTitles({
      limit,
      exclude_source_type: this.definition.source_type,
    });
    if (!existingTitles.length) {
      return false;
    }

    let verdict;
    try {
      verdict = await generator.findDuplicateTitle(candidate.title, existingTitles);
    } catch (error) {
      logger.exception(
        `Cross-source dedup check failed for ${candidate.source_url}; treating it as unique`,
        error,
      );
      return false;
    }

    if (verdict.is_duplicate) {
      logger.info(
        `Skipping cross-source duplicate ${JSON.stringify(candidate.title)} ` +
          `(matches ${JSON.stringify(verdict.matched_title)}) from ${candidate.source_url}`,
      );
    }

    return verdict.is_duplicate;
  }

  async createModerationSubmissions(candidate, generator, stats) {
    const sourceUrl = candidate.source_url;
    let draftPackage;
    let draftParts;
    try {
      const maxPartLength = candidate.has_media ? 900 : 1600;
      const datetimeNotes = buildUtcTimeConversionNotes(candidate.body_text, {
        article_date: candidate.article_date,
        target_timezone: this.config.article_timezone,
      });
      // Taken from the original post, not from the draft: URL stripping removes
      // every link the model writes, and a model-written URL should never be
      // published anyway.
      const extraLinks = await collectPublishableLinks(candidate.body_text, {
        source_type: this.definition.source_type,
        article_url: sourceUrl,
      });
      draftPackage = await generator.generateDraftPackage(
        geminiDraftInput({
          title: candidate.title,
          article_url: sourceUrl,
          article_date_display: candidate.article_date_display,
          datetime_notes: datetimeNotes,
          body_text: candidate.body_text,
          source_type: this.definition.source_type,
          source_name: candidate.source_name,
          extra_links: extraLinks,
        }),
        { maxPartLength },
      );
      draftParts = draftPackage.draft_parts;
      stats.drafts_created += draftParts.length;
    } catch (error) {
      stats.failed += 1;
      stats.errors.push(t("collector_report.gemini_failed", { url: sourceUrl, error: errorText(error) }));
      logger.exception(`Gemini draft generation failed for ${sourceUrl}`, error);
      return false;
    }

    const albumImages = albumImagesOf(candidate);
    try {
      let submissionId;
      // A single-part draft with 2+ photos becomes ONE grouped album post
      // (e.g. a Bluesky post with several infographics). Multi-part article
      // drafts keep the per-part image mapping; text / single-image stay as is.
      if (draftParts.length === 1 && albumImages.length >= 2) {
        submissionId = await this.db.createAlbumSubmission({
          username: candidate.username,
          original_text: candidate.original_text,
          caption: draftParts[0],
          image_urls: albumImages,
          source_type: this.definition.source_type,
          source_id: candidate.source_id,
          source_url: sourceUrl,
          article_date: candidate.article_date,
          article_date_display: candidate.article_date_display,
          tags: draftPackage.tags,
        });
      } else {
        submissionId = await this.db.createAiNewsSubmission({
          username: candidate.username,
          original_text: candidate.original_text,
          draft_text: draftParts[0],
          draft_parts: draftParts,
          message_type: partMessageType(candidate),
          media_url: candidate.has_media ? candidate.media_url : null,
          media_type: candidate.has_media ? candidate.media_type : "none",
          source_type: this.definition.source_type,
          source_id: candidate.source_id,
          source_url: sourceUrl,
          article_date: candidate.article_date,
          article_date_display: candidate.article_date_display,
          tags: draftPackage.tags,
          additional_media_urls: candidate.has_media ? candidate.additional_media_urls : null,
        });
      }
      // Space this send from the previous one so a tick with many new items
      // does not flood the moderation chat. No-op for the first/manual send.
      await this.throttle.wait();
      await sendSubmissionToModeration(this.bot, this.config, this.db, submissionId);
      stats.sent_to_moderation += 1;
    } catch (error) {
      stats.failed += 1;
      stats.errors.push(
        t("collector_report.moderation_send_failed", { url: sourceUrl, error: errorText(error) }),
      );
      logger.exception(
        `Failed to send ${this.definition.collector_id} article to moderation: ${sourceUrl}`,
        error,
      );
      return false;
    }

    await this.db.markSourceSeen({
      source_type: this.definition.source_type,
      source_id: candidate.source_id,
      source_url: sourceUrl,
      title: candidate.title,
      article_date: candidate.article_date,
      outcome: "queued",
    });
    logger.info(`Created moderation draft for ${this.definition.collector_id} article ${sourceUrl}`);
    return true;
  }
}

/**
 * The stored part type, which both the moderation preview and the publisher
 * route on.
 *
 * It has to follow the candidate's media_type: a video stored as "photo" is sent
 * with sendPhoto, which Telegram rejects for an MP4, so the post could only ever
 * degrade to text — the native-video download path is keyed on "video".
 */
function partMessageType(candidate) {
  if (!candidate.has_media) {
    return "text";
  }
  return candidate.media_type === "video" ? "video" : "photo";
}

/**
 * The candidate's photo URLs (primary + additional), for deciding whether to
 * publish as one album. Empty unless the candidate carries 'photo' media.
 */
export function albumImagesOf(candidate) {
  if (!(candidate.has_media && candidate.media_type === "photo" && candidate.media_url)) {
    return [];
  }
  return [candidate.media_url, ...(candidate.additional_media_urls ?? [])];
}

export function isNewerOrSameArticleDate(articleDate, latestSeenArticleDate) {
  if (articleDate === null || articleDate === undefined) {
    return true;
  }

  // The official source emits mixed granularity: a normally-parsed article
  // carries a full timestamp, but one whose detail page failed to load falls
  // back to a date-only card date. Comparing a date-only midnight against a
  // same-day afternoon timestamp would wrongly drop genuinely-new news, so when
  // EITHER side lacks a time component compare only the (local) calendar dates.
  if (!hasTimeComponent(articleDate) || !hasTimeComponent(latestSeenArticleDate)) {
    const newDate = articleLocalDate(articleDate);
    const seenDate = articleLocalDate(latestSeenArticleDate);
    if (newDate === null || seenDate === null) {
      return true;
    }
    return compareCalendarDates(newDate, seenDate) >= 0;
  }

  const parsedArticleDate = parseSortableArticleDate(articleDate);
  const parsedLatestDate = parseSortableArticleDate(latestSeenArticleDate);
  if (parsedArticleDate === null || parsedLatestDate === null) {
    return true;
  }

  return parsedArticleDate >= parsedLatestDate;
}

function hasTimeComponent(value) {
  return value.includes("T");
}

/**
 * The calendar date as the source intended it, taken from the raw string's
 * leading `YYYY-MM-DD` so it is never shifted across midnight by a UTC
 * conversion (which would defeat a same-day comparison).
 */
function articleLocalDate(value) {
  return dateFromIsoFormat(value.split("T")[0]);
}

function parseSortableArticleDate(value) {
  // A value with no offset is REINTERPRETED as UTC — Python's
  // `replace(tzinfo=utc)`, not a conversion. Parsing it in the local zone and
  // then converting would shift the instant by the server's offset and could
  // flip a same-day comparison either way.
  const parsed = hasIsoOffset(value)
    ? fromIsoFormat(value)
    : DateTime.fromISO(String(value).trim(), { zone: "utc" });
  if (parsed === null || !parsed.isValid) {
    return null;
  }

  return parsed.toUTC().toMillis();
}
