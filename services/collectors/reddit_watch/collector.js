/**
 * Topic watch on r/Aniimo: surface the community's own posts about a subject the
 * bot has no other source for.
 *
 * It exists for the Mysterious Vendor. His shelf is drawn daily from a pool of 34
 * offers and NOBODY publishes what is on it — not the official site, not Steam,
 * not any of the fan databases, which only list the pool and its odds. The one
 * place today's shelf appears is r/Aniimo, where a player posts "MYSTERIOUS
 * VENDOR IS SELLING A SPARKLING EGG TODAY" whenever something rare turns up. So
 * the watch is deliberately second-hand: it is late by however long it takes a
 * player to post, and that is still better than nothing.
 *
 * Two things keep it from becoming noise:
 *
 *  * **The phrase must be in the TITLE.** Reddit's search also matches the body,
 *    which drags in "Stores are bugged T_T" and every thread that mentions the
 *    vendor in passing.
 *  * **It dedups against its OWN recent titles.** Three people posting about the
 *    same Sparkling Egg on the same day is the normal case here, unlike a news
 *    feed where each item is published once.
 */

import { t } from "../../i18n.js";
import { getLogger } from "../../logger.js";
import { charLength, rsplitOnce, sliceChars } from "../../pyutils.js";
import { collectorDefinition, draftCandidate, listingEntry } from "../base.js";
import { RedditSearchFetcher } from "../reddit/feed_fetcher.js";
import { BaseNewsCollector } from "../runner.js";

const logger = getLogger("services.collectors.reddit_watch.collector");

export const COLLECTOR_ID = "reddit_watch";
export const SOURCE_TYPE = "reddit_watch";

export const TITLE_MAX_LENGTH = 140;
export const FALLBACK_TITLE = "Допис спільноти Aniimo (Reddit)";

// Reddit rate-limits hard, so several phrases are searched one after another
// with a pause rather than in parallel.
export const SEARCH_GAP_MS = 3000;

export const DEFINITION = collectorDefinition({
  collector_id: COLLECTOR_ID,
  source_type: SOURCE_TYPE,
  title_key: "collectors.reddit_watch.title",
  button_key: "buttons.collector_reddit_watch",
});

export class RedditWatchCollector extends BaseNewsCollector {
  static definition = DEFINITION;
  // Several players describing the same shelf is the norm here, so this source
  // must be allowed to recognise its own duplicates.
  static dedups_within_source = true;

  constructor({ config, db, bot }) {
    super({ config, db, bot });
    this.subreddit = config.reddit_watch_subreddit;
    this.queries = config.reddit_watch_queries;
    this.titleOnly = config.reddit_watch_title_only;
    this.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  }

  missingGeminiWarning() {
    return t("collectors.reddit_watch.errors.missing_gemini_api_key");
  }

  async fetchListing() {
    const byId = new Map();
    for (const [index, query] of this.queries.entries()) {
      if (index > 0) {
        await this.sleep(SEARCH_GAP_MS);
      }
      const fetcher = new RedditSearchFetcher(this.subreddit, [], { query, sort: "new" });
      const posts = await fetcher.fetchRecentPosts();
      for (const post of posts) {
        if (this.titleOnly && !titleMatches(post.title, query)) {
          continue;
        }
        if (!post.title && !post.body_text) {
          continue;
        }
        if (!byId.has(post.post_id)) {
          byId.set(post.post_id, post);
        }
      }
    }

    if (!byId.size) {
      logger.info(`No r/${this.subreddit} posts matched ${JSON.stringify(this.queries)}`);
    }
    return [...byId.values()].map((post) => listingEntry(post.post_id, post));
  }

  async parseEntry(entry) {
    const post = entry.payload;
    const hasMedia = Boolean(post.image_url);
    const title = deriveTitle(post.title);

    return draftCandidate({
      source_id: post.post_id,
      source_url: post.web_url,
      title,
      body_text: post.body_text,
      source_name: t("collectors.reddit_watch.source_name"),
      username: t("collectors.reddit_watch.username"),
      original_text: buildOriginalText(post, title),
      article_date: post.created_at,
      article_date_display: post.created_at ? post.created_at.slice(0, 10) : null,
      has_media: hasMedia,
      media_url: hasMedia ? post.image_url : null,
      media_type: hasMedia ? "photo" : "none",
      additional_media_urls: null,
    });
  }
}

/**
 * Whether the searched phrase really is in the title.
 *
 * Words are matched in order but not necessarily adjacently, so "Mysterious
 * Vendor is selling…" and "Sparkling Egg at the Mysterious Vendor!" both count
 * while a thread that only mentions the vendor in its body does not.
 */
export function titleMatches(title, query) {
  const haystack = String(title ?? "").toLowerCase();
  const words = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) {
    return false;
  }
  let from = 0;
  for (const word of words) {
    const at = haystack.indexOf(word, from);
    if (at === -1) {
      return false;
    }
    from = at + word.length;
  }
  return true;
}

function deriveTitle(title) {
  const stripped = String(title ?? "").trim();
  if (!stripped) {
    return FALLBACK_TITLE;
  }
  if (charLength(stripped) <= TITLE_MAX_LENGTH) {
    return stripped;
  }
  const head = sliceChars(stripped, 0, TITLE_MAX_LENGTH);
  const parts = rsplitOnce(head, " ");
  return `${(parts[0] || head).trim()}…`;
}

function buildOriginalText(post, title) {
  const parts = [
    t("collectors.common.original_text.article_title", { value: title }),
    t("collectors.common.original_text.article_url", { value: post.web_url }),
  ];
  if (post.author) {
    parts.push(`Автор: ${post.author}`);
  }
  if (post.created_at) {
    parts.push(t("collectors.common.original_text.original_article_date", { value: post.created_at }));
  }
  if (post.body_text) {
    parts.push("", t("collectors.common.original_text.parsed_article_text"), post.body_text);
  }
  return parts.join("\n").trim();
}

export const __testing = { titleMatches, deriveTitle };
