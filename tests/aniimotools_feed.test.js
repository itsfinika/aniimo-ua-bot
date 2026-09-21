/**
 * Tests for the aniimotools.dev news collector: RSS 2.0 parsing of the captured
 * feed through a stubbed fetch, body text from <content:encoded> or the
 * <description> summary, on-site image picking (rejecting off-site hosts,
 * dropping a picture that recurs across articles), pubDate normalisation, and
 * the collector -> DraftCandidate mapping (a third-party, non-rumour source).
 */

import fs from "node:fs";

import { afterEach, expect, it, vi } from "vitest";

import { listingEntry } from "../services/collectors/base.js";
import { AniimoToolsCollector, DEFINITION, FALLBACK_TITLE } from "../services/collectors/aniimotools/collector.js";
import {
  AniimoToolsFeedFetcher,
  normalizePubDate,
  parseFeed,
} from "../services/collectors/aniimotools/feed_fetcher.js";
import { OFFICIAL_SOURCE_TYPES, RUMOR_SOURCE_TYPES } from "../services/gemini.js";

const FEED_URL = "https://aniimotools.dev/articles/rss.xml";
const FIXTURE_XML = fs.readFileSync(new URL("./fixtures/aniimo/aniimotools_rss.xml", import.meta.url), "utf8");

const HERO = "https://aniimotools.dev/images/articles/pre-download-servers.png";
const OFFSITE = "https://evil.example.com/x.jpg";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fetch stub that answers the feed URL with the given body (or throws). */
function stubFeed({ body = FIXTURE_XML, status = 200, error = null } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, init) => {
    calls.push({ url: String(url), init });
    if (error) {
      throw error;
    }
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  });
  return calls;
}

function itemXml(
  title,
  {
    postId,
    link = "https://aniimotools.dev/articles/aniimo-pre-download-open-launch-servers/",
    pubdate = "Mon, 14 Sep 2026 00:00:00 GMT",
    description = "Pre-download opened on September 14.",
    imgs = null,
    body = null,
  },
) {
  const encoded =
    imgs === null && body === null
      ? ""
      : "<content:encoded><![CDATA[<div>" +
        (imgs ?? []).map((url) => `<img src="${url}"/>`).join("") +
        `<p>${body ?? description}</p></div>]]></content:encoded>`;
  return (
    "<item>" +
    `<title>${title}</title>` +
    `<link>${link}</link>` +
    `<guid>${postId}</guid>` +
    `<pubDate>${pubdate}</pubDate>` +
    `<description>${description}</description>` +
    encoded +
    "</item>"
  );
}

function feedXml(...items) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">' +
    `<channel><title>Aniimo Tools News</title>${items.join("")}</channel></rss>`
  );
}

it("fetches and parses the captured feed", async () => {
  const calls = stubFeed();
  const fetcher = new AniimoToolsFeedFetcher(FEED_URL);

  const posts = await fetcher.fetchRecentPosts();

  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(FEED_URL);
  expect(calls[0].init.headers["User-Agent"]).toContain("AniimoUACollector");
  expect(posts).toHaveLength(38);

  const first = posts[0];
  expect(first.title).toBe("Aniimo Pre-Download Is Open: Launch Server Times, Accounts and New Specs");
  expect(first.post_id).toBe("https://aniimotools.dev/articles/aniimo-pre-download-open-launch-servers/");
  expect(first.web_url).toBe("https://aniimotools.dev/articles/aniimo-pre-download-open-launch-servers/");
  expect(first.created_at).toBe("2026-09-14T00:00:00+00:00");
  // The captured feed carries only summaries: the description is the body and
  // there is no picture to attach.
  expect(first.body_text).toMatch(/^Pre-download opened on September 14 at 10:00 UTC\+8 on PC, PS5 and Xbox\./);
  expect(first.image_url).toBeNull();
  expect(first.additional_image_urls).toEqual([]);

  // Every item is unique by guid and keeps its own article link.
  expect(new Set(posts.map((post) => post.post_id)).size).toBe(38);
  expect(posts.every((post) => post.web_url.startsWith("https://aniimotools.dev/articles/"))).toBe(true);
  expect(posts.every((post) => post.body_text.length > 0)).toBe(true);
});

it("returns nothing when the feed request fails", async () => {
  stubFeed({ status: 503 });
  expect(await new AniimoToolsFeedFetcher(FEED_URL).fetchRecentPosts()).toEqual([]);

  stubFeed({ error: new Error("ECONNRESET") });
  expect(await new AniimoToolsFeedFetcher(FEED_URL).fetchRecentPosts()).toEqual([]);
});

it("prefers the full content:encoded body over the summary", () => {
  const posts = parseFeed(
    feedXml(itemXml("Letter", { postId: "p1", description: "Short summary.", body: "The full dev letter text." })),
  );

  expect(posts[0].body_text).toBe("The full dev letter text.");
});

it("strips markup from an HTML description", () => {
  const posts = parseFeed(
    feedXml(
      itemXml("Patch", {
        postId: "p2",
        description: "<![CDATA[<p>Runes are <b>gone</b>.</p><p>Irisalis redesigned.</p>]]>",
      }),
    ),
  );

  expect(posts[0].body_text).toBe("Runes are gone . Irisalis redesigned.");
  expect(posts[0].image_url).toBeNull();
});

it("picks the on-site image and keeps the rest for the album", () => {
  const second = "https://aniimotools.dev/images/articles/pre-download-specs.png";
  const posts = parseFeed(feedXml(itemXml("Specs", { postId: "p3", imgs: [HERO, second] })));

  expect(posts[0].image_url).toBe(HERO);
  expect(posts[0].additional_image_urls).toEqual([second]);
});

it("drops an image that repeats across articles", () => {
  // A site-wide promo under every article is not that article's content, and
  // hardcoding its filename would not survive the next promo — recurrence
  // within one fetch is the durable signal.
  const promo = "https://aniimotools.dev/images/promo/launch-banner.png";
  const otherHero = "https://aniimotools.dev/images/articles/dev-letter.png";
  const posts = parseFeed(
    feedXml(
      itemXml("Specs", { postId: "p4", imgs: [HERO, promo] }),
      itemXml("Letter", { postId: "p5", imgs: [otherHero, promo] }),
    ),
  );

  expect(posts[0].image_url).toBe(HERO);
  expect(posts[0].additional_image_urls).toEqual([]);
  expect(posts[1].image_url).toBe(otherHero);
  expect(posts[1].additional_image_urls).toEqual([]);
});

it("leaves an article with nothing but a recurring image media-less", () => {
  const promo = "https://aniimotools.dev/images/promo/launch-banner.png";
  const posts = parseFeed(
    feedXml(itemXml("A", { postId: "p6", imgs: [promo] }), itemXml("B", { postId: "p7", imgs: [promo] })),
  );

  expect(posts[0].image_url).toBeNull();
  expect(posts[1].image_url).toBeNull();
});

it("rejects an off-site image host", () => {
  const posts = parseFeed(feedXml(itemXml("Specs", { postId: "p8", imgs: [OFFSITE] })));
  expect(posts[0].image_url).toBeNull();
});

it("dedups by guid", () => {
  const posts = parseFeed(feedXml(itemXml("First", { postId: "same" }), itemXml("Dup", { postId: "same" })));
  expect(posts).toHaveLength(1);
});

it("returns nothing for invalid XML", () => {
  expect(parseFeed("not xml")).toEqual([]);
  expect(parseFeed("")).toEqual([]);
});

it("rejects an entity-expansion bomb", () => {
  // The feed is untrusted: a DTD with nested entities (billion-laughs) must be
  // refused by the parser, not expanded — parseFeed returns [].
  const bomb =
    '<?xml version="1.0"?>' +
    '<!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa">' +
    '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">' +
    '<!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>' +
    '<rss version="2.0"><channel><item><title>&c;</title></item></channel></rss>';
  expect(parseFeed(bomb)).toEqual([]);
});

it("normalises an RFC-822 pubDate to a UTC ISO timestamp", () => {
  expect(normalizePubDate("Mon, 14 Sep 2026 00:00:00 GMT")).toBe("2026-09-14T00:00:00+00:00");
  // A non-UTC offset is converted to UTC.
  expect(normalizePubDate("Mon, 14 Sep 2026 03:00:00 +0300")).toBe("2026-09-14T00:00:00+00:00");
  expect(normalizePubDate("")).toBeNull();
  expect(normalizePubDate("garbage")).toBeNull();
});

it("treats aniimotools as a short-form source: neither official nor a rumour", () => {
  expect(DEFINITION.collector_id).toBe("aniimotools");
  expect(DEFINITION.source_type).toBe("aniimotools");
  expect(OFFICIAL_SOURCE_TYPES.has("aniimotools")).toBe(false);
  expect(RUMOR_SOURCE_TYPES.has("aniimotools")).toBe(false);
});

it("maps a post to a photo candidate", async () => {
  const post = {
    post_id: "https://aniimotools.dev/articles/aniimo-pre-download-open-launch-servers/",
    web_url: "https://aniimotools.dev/articles/aniimo-pre-download-open-launch-servers/",
    title: "Aniimo Pre-Download Is Open",
    body_text: "Pre-download opened on September 14.",
    created_at: "2026-09-14T00:00:00+00:00",
    image_url: HERO,
    additional_image_urls: [],
  };
  const collector = new AniimoToolsCollector({ config: { aniimotools_feed_url: FEED_URL }, db: null, bot: null });

  const candidate = await collector.parseEntry(listingEntry(post.post_id, post));

  expect(candidate.source_id).toBe(post.post_id);
  expect(candidate.source_url).toBe(post.web_url);
  expect(candidate.title).toBe("Aniimo Pre-Download Is Open");
  expect(candidate.has_media).toBe(true);
  expect(candidate.media_url).toBe(HERO);
  expect(candidate.media_type).toBe("photo");
  expect(candidate.additional_media_urls).toBeNull();
  expect(candidate.article_date_display).toBe("2026-09-14");
  expect(candidate.source_name).toBe("Aniimo Tools");
  expect(candidate.original_text).toContain(post.web_url);
  expect(candidate.original_text).toContain(post.body_text);
});

it("falls back to a generic title and truncates a long one", async () => {
  const collector = new AniimoToolsCollector({ config: { aniimotools_feed_url: FEED_URL }, db: null, bot: null });
  const base = {
    post_id: "p9",
    web_url: "https://aniimotools.dev/articles/x/",
    body_text: "Body.",
    created_at: null,
    image_url: null,
    additional_image_urls: [],
  };

  const untitled = await collector.parseEntry(listingEntry("p9", { ...base, title: "  " }));
  expect(untitled.title).toBe(FALLBACK_TITLE);
  expect(untitled.has_media).toBe(false);
  expect(untitled.media_type).toBe("none");
  expect(untitled.article_date_display).toBeNull();

  const longTitle = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
  const truncated = await collector.parseEntry(listingEntry("p9", { ...base, title: longTitle }));
  expect(truncated.title.endsWith("…")).toBe(true);
  expect(truncated.title.length).toBeLessThanOrEqual(141);
  expect(truncated.title.slice(0, -1)).toBe(longTitle.slice(0, truncated.title.length - 1));
});

it("lists only posts that have a title or a body", async () => {
  stubFeed({
    body: feedXml(
      itemXml("Titled", { postId: "p10", description: "" }),
      itemXml("", { postId: "p11", description: "Body only." }),
      itemXml("", { postId: "p12", description: "" }),
    ),
  });
  const collector = new AniimoToolsCollector({ config: { aniimotools_feed_url: FEED_URL }, db: null, bot: null });

  const listing = await collector.fetchListing();

  expect(listing.map((entry) => entry.dedup_key)).toEqual(["p10", "p11"]);
  expect(listing[0].payload.title).toBe("Titled");
});
