/**
 * The r/Aniimo topic watch.
 *
 * Two properties decide whether this source is useful or just noise, and both
 * are covered here: the phrase must be in the post TITLE, and the source must be
 * allowed to recognise duplicates of its OWN earlier posts, because several
 * players writing up the same vendor shelf on the same day is the normal case.
 */

import { expect, it, vi, afterEach } from "vitest";

import { listingEntry } from "../services/collectors/base.js";
import * as redditFeedFetcher from "../services/collectors/reddit/feed_fetcher.js";
import { RedditSearchFetcher, buildFlairQuery } from "../services/collectors/reddit/feed_fetcher.js";
import { RedditWatchCollector, __testing } from "../services/collectors/reddit_watch/collector.js";

const { titleMatches } = __testing;

afterEach(() => {
  vi.restoreAllMocks();
});

function post(id, title, { body = "", image = null, author = "/u/someone" } = {}) {
  return {
    post_id: id,
    web_url: `https://www.reddit.com/r/Aniimo/comments/${id}/x/`,
    title,
    body_text: body,
    created_at: "2026-09-24T09:00:00+00:00",
    image_url: image,
    author,
  };
}

function config(overrides = {}) {
  return {
    reddit_watch_subreddit: "Aniimo",
    reddit_watch_queries: ["mysterious vendor"],
    reddit_watch_title_only: true,
    gemini_api_key: "k",
    article_timezone: "Europe/Kyiv",
    ...overrides,
  };
}

function stubFetcher(posts) {
  vi.spyOn(redditFeedFetcher, "RedditSearchFetcher").mockImplementation(function stub() {
    return {
      async fetchRecentPosts() {
        return posts;
      },
    };
  });
}

function collector(overrides = {}) {
  const made = new RedditWatchCollector({ config: config(overrides), db: {}, bot: null });
  made.sleep = async () => {};
  return made;
}

// --- the title filter, which is what keeps the source usable ---------------------

it("keeps only posts whose TITLE mentions the phrase", async () => {
  // These are real r/Aniimo titles from the day the vendor sold a Sparkling Egg.
  stubFetcher([
    post("a", "FYI! MYSTERIOUS VENDOR IS SELLING A SPARKLING EGG TODAY!! GO GRAB IT"),
    post("b", "Sparkling Egg sold at Mysterious Vendor!"),
    post("c", "Stores are bugged T_T", { body: "even the mysterious vendor is broken" }),
    post("d", "Bugs!!", { body: "mysterious vendor won't open" }),
  ]);

  const entries = await collector().fetchListing();

  expect(entries.map((e) => e.dedup_key)).toEqual(["a", "b"]);
});

it("can be told to accept body matches too", async () => {
  stubFetcher([post("c", "Stores are bugged T_T", { body: "the mysterious vendor is broken" })]);

  const entries = await collector({ reddit_watch_title_only: false }).fetchListing();

  expect(entries.map((e) => e.dedup_key)).toEqual(["c"]);
});

it("matches the words in order, not as one rigid substring", () => {
  expect(titleMatches("Mysterious Vendor is selling a Sparkling Egg", "mysterious vendor")).toBe(true);
  expect(titleMatches("Sparkling Egg at the Mysterious Vendor!", "mysterious vendor")).toBe(true);
  expect(titleMatches("MYSTERIOUS VENDOR TODAY", "mysterious vendor")).toBe(true);
  // Right words, wrong order: not this topic.
  expect(titleMatches("Vendor of the mysterious kind", "mysterious vendor")).toBe(false);
  expect(titleMatches("Where is the vendor?", "mysterious vendor")).toBe(false);
  expect(titleMatches("", "mysterious vendor")).toBe(false);
  expect(titleMatches("anything", "")).toBe(false);
});

it("drops duplicates when two searches return the same post", async () => {
  stubFetcher([post("a", "Mysterious Vendor has a Sparkling Egg")]);

  const entries = await collector({ reddit_watch_queries: ["mysterious vendor", "sparkling egg"] }).fetchListing();

  expect(entries).toHaveLength(1);
});

// --- duplicate policy -------------------------------------------------------------

it("is allowed to dedup against its own earlier posts", () => {
  // Three people posting the same shelf in one day is normal here, unlike a news
  // feed where each story is published once.
  expect(RedditWatchCollector.dedups_within_source).toBe(true);
  expect(collector().dedupsWithinSource).toBe(true);
});

// --- the parsed candidate ---------------------------------------------------------

it("carries the post through with its image and author", async () => {
  const candidate = await collector().parseEntry(
    listingEntry("a", post("a", "Mysterious Vendor stock today", { body: "Sparkling Egg, 2M credits", image: "https://i.redd.it/a.jpg", author: "/u/alice" })),
  );

  expect(candidate.source_id).toBe("a");
  expect(candidate.source_url).toBe("https://www.reddit.com/r/Aniimo/comments/a/x/");
  expect(candidate.title).toBe("Mysterious Vendor stock today");
  expect(candidate.has_media).toBe(true);
  expect(candidate.media_url).toBe("https://i.redd.it/a.jpg");
  expect(candidate.article_date_display).toBe("2026-09-24");
  expect(candidate.original_text).toContain("/u/alice");
  expect(candidate.original_text).toContain("Sparkling Egg, 2M credits");
});

// --- the fetcher's new phrase mode ------------------------------------------------

it("searches by phrase instead of flair when a query is given", () => {
  const byQuery = new RedditSearchFetcher("Aniimo", [], { query: "mysterious vendor" });
  expect(byQuery.query).toBe("mysterious vendor");

  // The flair mode is untouched.
  expect(buildFlairQuery(["Media"])).toBe('flair:"Media"');
});
