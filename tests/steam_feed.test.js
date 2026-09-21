/**
 * Tests for the Steam announcements collector: RSS parsing of the app's real
 * feed (CDATA links, guid dedup, newest-first order), turning Steam's bbcode
 * HTML into block text with the fullwidth "（UTC+8）" brackets normalised,
 * picking only Steam-hosted images for the album, pubDate normalisation, and
 * the collector -> DraftCandidate mapping (an official source).
 */

import fs from "node:fs";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { listingEntry } from "../services/collectors/base.js";
import { BaseNewsCollector } from "../services/collectors/runner.js";
import { DEFINITION, FALLBACK_TITLE, SteamNewsCollector, __testing } from "../services/collectors/steam/collector.js";
import {
  normalizeFullwidthParens,
  normalizePubDate,
  parseDescription,
  parseFeed,
  SteamFeedFetcher,
} from "../services/collectors/steam/feed_fetcher.js";
import { OFFICIAL_SOURCE_TYPES, RUMOR_SOURCE_TYPES } from "../services/gemini.js";

const { deriveTitle } = __testing;

const FIXTURE_PATH = path.join(import.meta.dirname, "fixtures", "aniimo", "steam_news.xml");
const FEED_URL = "https://store.steampowered.com/feeds/news/app/4126040/";
const NEWS_BASE = "https://store.steampowered.com/news/app/4126040/view/";

const CDN = "https://clan.fastly.steamstatic.com/images/45891884/";
const COVER = `${CDN}4e293654d5e2e5d1aba8a28118c966e216e2e73e.jpg`;
const SECOND = `${CDN}second-screenshot.png`;
const OFFSITE = "https://evil.example.com/x.jpg";

function fixtureXml() {
  return fs.readFileSync(FIXTURE_PATH, "utf8");
}

function itemXml(
  title,
  {
    guid,
    link = `${NEWS_BASE}703279756977636272`,
    pubdate = "Mon, 21 Sep 2026 16:30:22 +0000",
    imgs = [COVER],
    body = '<p class="bb_paragraph">Dear Pathfinders,</p><p class="bb_paragraph">Оновлення вже тут.</p>',
  },
) {
  const imgHtml = imgs.map((url) => `<img class="bb_img" src="${url}"/>`).join("");
  const guidXml = guid === undefined ? "" : `<guid isPermaLink="true">${guid}</guid>`;
  return (
    "<item>" +
    `<title>${title}</title>` +
    `<link><![CDATA[${link}]]></link>` +
    `<pubDate>${pubdate}</pubDate>` +
    guidXml +
    `<description><![CDATA[${imgHtml}${body}]]></description>` +
    "</item>"
  );
}

function feedXml(...items) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">' +
    `<channel><title>4126040 RSS Feed</title><link><![CDATA[${FEED_URL}]]></link>${items.join("")}</channel></rss>`
  );
}

function stubFeedFetch(xml, { ok = true, status = 200 } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, options) => {
    calls.push({ url, options });
    return { ok, status, text: async () => xml };
  });
  return calls;
}

// --- the real feed --------------------------------------------------------

it("parses every announcement of the captured feed", () => {
  const posts = parseFeed(fixtureXml());

  expect(posts).toHaveLength(10);
  const newest = posts[0];
  expect(newest.title).toBe("Upcoming Update Preview & Server Maintenance");
  // <link> is CDATA-wrapped in the real feed; it must come out as the bare URL.
  expect(newest.web_url).toBe(`${NEWS_BASE}703279756977636272`);
  expect(newest.post_id).toBe(`${NEWS_BASE}703279756977636272`);
  expect(newest.created_at).toBe("2026-09-21T16:30:22+00:00");
  expect(posts.map((post) => post.title)).toContain("Patch Notes-v1.0.3551601.0");
  expect(posts.map((post) => post.title)).toContain("Sign-ups for Aniimo's Global Closed Beta are now open!");
});

it("orders the captured feed newest-first by pubDate", () => {
  const dates = parseFeed(fixtureXml()).map((post) => post.created_at);
  const sorted = [...dates].sort().reverse();
  expect(dates).toEqual(sorted);
  expect(dates[0]).toBe("2026-09-21T16:30:22+00:00");
  expect(dates[dates.length - 1]).toBe("2026-06-06T20:11:25+00:00");
});

it("turns Steam's bbcode HTML into block text with headings and normalised brackets", () => {
  const newest = parseFeed(fixtureXml())[0];
  const lines = newest.body_text.split("\n");

  expect(lines[0]).toBe("Dear Pathfinders,");
  // Steam renders headings as <div class="bb_h2">; they must survive as lines.
  expect(lines).toContain(">Maintenance Schedule");
  expect(lines).toContain(">New Content Preview");
  // Fullwidth （UTC+8） becomes ASCII so the time-zone converter sees it, and
  // the bbcode `\[` escape is dropped.
  expect(newest.body_text).toContain("[Maintenance Window]: September 23, 2026, 00:00 – 10:00(UTC+8)");
  expect(newest.body_text).toContain("00:00 to 10:00(UTC+8)");
  expect(newest.body_text).not.toContain("（");
  expect(newest.body_text).not.toContain("）");
  expect(newest.body_text).not.toContain("\\[");
  expect(newest.body_text).toContain("[Compensation]: Glimmer x500");
  // The HTML itself never leaks through.
  expect(newest.body_text).not.toContain("<p");
  expect(newest.body_text).not.toContain("bb_paragraph");
});

it("picks the Steam-hosted image of a captured announcement", () => {
  const posts = parseFeed(fixtureXml());
  const geforce = posts.find((post) => post.title === "NVIDIA GeForce NOW is live on Aniimo");
  expect(geforce.image_url).toBe(COVER);
  expect(geforce.additional_image_urls).toEqual([]);

  // A text-only patch note stays media-less rather than borrowing a picture.
  const patch = posts.find((post) => post.title === "Patch Notes-v1.0.3551601.0");
  expect(patch.image_url).toBeNull();

  // The YouTube embed's placeholder gif (steamcommunity.com, .gif) is not a photo.
  for (const post of posts) {
    expect(post.image_url ?? "").not.toContain("youtube_16x9_placeholder");
  }
});

it("caps the body at the shared article limit", () => {
  for (const post of parseFeed(fixtureXml())) {
    expect(Array.from(post.body_text).length).toBeLessThanOrEqual(12000);
  }
});

it("fetches the feed with the Aniimo User-Agent and parses it", async () => {
  const calls = stubFeedFetch(fixtureXml());
  const fetcher = new SteamFeedFetcher(FEED_URL);

  const posts = await fetcher.fetchRecentPosts();

  expect(posts).toHaveLength(10);
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe(FEED_URL);
  expect(calls[0].options.headers["User-Agent"]).toContain("AniimoUACollector/1.0");
  expect(calls[0].options.headers.Accept).toContain("application/rss+xml");
});

it("returns no posts when the feed request fails", async () => {
  stubFeedFetch("", { ok: false, status: 503 });
  expect(await new SteamFeedFetcher(FEED_URL).fetchRecentPosts()).toEqual([]);

  vi.stubGlobal("fetch", async () => {
    throw new Error("connect ETIMEDOUT");
  });
  expect(await new SteamFeedFetcher(FEED_URL).fetchRecentPosts()).toEqual([]);
});

// --- synthetic items ------------------------------------------------------

it("extracts the fields and the cover image", () => {
  const guid = `${NEWS_BASE}1`;
  const posts = parseFeed(feedXml(itemXml("Patch Notes-v1.0.1", { guid })));

  expect(posts).toHaveLength(1);
  const post = posts[0];
  expect(post.title).toBe("Patch Notes-v1.0.1");
  expect(post.post_id).toBe(guid);
  expect(post.web_url).toBe(`${NEWS_BASE}703279756977636272`);
  expect(post.image_url).toBe(COVER);
  expect(post.additional_image_urls).toEqual([]);
  expect(post.body_text).toBe("Dear Pathfinders,\nОновлення вже тут.");
  expect(post.created_at).toBe("2026-09-21T16:30:22+00:00");
});

it("keeps every screenshot of a post for the album", () => {
  const posts = parseFeed(feedXml(itemXml("Update Preview", { guid: "p3", imgs: [COVER, SECOND] })));

  expect(posts[0].image_url).toBe(COVER);
  expect(posts[0].additional_image_urls).toEqual([SECOND]);
});

it("accepts every Steam CDN host and rejects the rest", () => {
  const userContent = "https://images.steamusercontent.com/ugc/1/2/hero.jpg";
  const akamai = "https://steamcdn-a.akamaihd.net/steamcommunity/public/images/clans/1/x.png";
  const http = "http://clan.fastly.steamstatic.com/images/45891884/plain.jpg";
  const gif = `${CDN}animated.gif`;
  const posts = parseFeed(
    feedXml(itemXml("Hosts", { guid: "p8", imgs: [OFFSITE, http, gif, userContent, akamai, COVER] })),
  );

  expect(posts[0].image_url).toBe(userContent);
  expect(posts[0].additional_image_urls).toEqual([akamai, COVER]);
});

it("dedups repeated images and caps the album at ten", () => {
  const many = Array.from({ length: 12 }, (_, index) => `${CDN}shot-${index}.jpg`);
  const posts = parseFeed(feedXml(itemXml("Gallery", { guid: "p9", imgs: [COVER, COVER, ...many] })));

  expect(posts[0].image_url).toBe(COVER);
  expect(posts[0].additional_image_urls).toHaveLength(9);
  expect(posts[0].additional_image_urls[0]).toBe(many[0]);
});

it("leaves a post without a Steam image media-less", () => {
  const posts = parseFeed(feedXml(itemXml("Text only", { guid: "p2", imgs: [OFFSITE] })));
  expect(posts[0].image_url).toBeNull();
  expect(posts[0].additional_image_urls).toEqual([]);
});

it("dedups by guid and falls back to the link when the guid is missing", () => {
  const posts = parseFeed(
    feedXml(
      itemXml("First", { guid: "same" }),
      itemXml("Dup", { guid: "same" }),
      itemXml("No guid", { link: `${NEWS_BASE}42` }),
    ),
  );

  expect(posts).toHaveLength(2);
  expect(posts.map((post) => post.post_id).sort()).toEqual([`${NEWS_BASE}42`, "same"]);
});

it("skips an item without a link", () => {
  const broken = "<item><title>Orphan</title><guid>x</guid><description>text</description></item>";
  expect(parseFeed(feedXml(broken))).toEqual([]);
});

it("sorts synthetic items newest-first", () => {
  const posts = parseFeed(
    feedXml(
      itemXml("Old", { guid: "old", pubdate: "Mon, 14 Sep 2026 17:08:18 +0000" }),
      itemXml("New", { guid: "new", pubdate: "Sat, 19 Sep 2026 09:09:20 +0000" }),
    ),
  );
  expect(posts.map((post) => post.title)).toEqual(["New", "Old"]);
});

it("returns nothing for invalid XML or a feed without a channel", () => {
  expect(parseFeed("not xml")).toEqual([]);
  expect(parseFeed("")).toEqual([]);
  expect(parseFeed('<?xml version="1.0"?><feed><entry/></feed>')).toEqual([]);
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
  expect(normalizePubDate("Mon, 21 Sep 2026 16:30:22 +0000")).toBe("2026-09-21T16:30:22+00:00");
  // A non-UTC offset is converted to UTC.
  expect(normalizePubDate("Mon, 21 Sep 2026 19:30:22 +0300")).toBe("2026-09-21T16:30:22+00:00");
  expect(normalizePubDate("")).toBeNull();
  expect(normalizePubDate("garbage")).toBeNull();
});

// --- body text ------------------------------------------------------------

it("builds block text from paragraphs, headings and list items", () => {
  const html =
    '<div class="bb_h2">>Bug Fixes</div>' +
    '<p class="bb_paragraph">1. Fixed   an issue.</p>' +
    '<ul class="bb_ul"><li>First</li><li>Second</li></ul>' +
    "<h3>Real heading</h3>" +
    '<p class="bb_paragraph"></p>' +
    '<p class="bb_paragraph">1. Fixed an issue.</p>';

  const [bodyText, images] = parseDescription(html);

  expect(bodyText).toBe(">Bug Fixes\n1. Fixed an issue.\nFirst\nSecond\nReal heading");
  expect(images).toEqual([]);
});

it("falls back to the flat text when the body has no blocks", () => {
  expect(parseDescription("Just a <b>bare</b> sentence.")[0]).toBe("Just a bare sentence.");
  expect(parseDescription("")).toEqual(["", []]);
  expect(parseDescription("   ")).toEqual(["", []]);
});

it("drops embedded players and scripts from the text", () => {
  const html =
    '<p class="bb_paragraph">Watch the trailer:</p>' +
    '<iframe src="https://www.youtube.com/embed/x"></iframe>' +
    "<script>alert(1)</script>";
  expect(parseDescription(html)[0]).toBe("Watch the trailer:");
});

it("normalises fullwidth parentheses", () => {
  expect(normalizeFullwidthParens("00:00 – 10:00（UTC+8）")).toBe("00:00 – 10:00(UTC+8)");
  expect(normalizeFullwidthParens("already (UTC+8)")).toBe("already (UTC+8)");
  expect(normalizeFullwidthParens(null)).toBe("");
});

it("truncates an oversized body on a block boundary", () => {
  // Distinct lines, since an identical block is deduped rather than repeated.
  const lines = Array.from({ length: 15 }, (_, index) => `${index}`.padEnd(1000, "x"));
  const [bodyText] = parseDescription(lines.map((line) => `<p>${line}</p>`).join(""));

  expect(Array.from(bodyText).length).toBeLessThanOrEqual(12000);
  // 11 whole lines (11 * 1000 + 10 newlines = 11010 chars); the twelfth would
  // straddle the limit and is dropped whole instead of being cut mid-line.
  expect(bodyText.split("\n")).toEqual(lines.slice(0, 11));
});

// --- collector ------------------------------------------------------------

it("registers as the official steam source", () => {
  expect(DEFINITION.collector_id).toBe("steam");
  expect(DEFINITION.source_type).toBe("steam");
  expect(DEFINITION.title_key).toBe("collectors.steam.title");
  expect(DEFINITION.button_key).toBe("buttons.collector_steam");
  expect(DEFINITION.button_text).toBe("Steam (патчноути)");
  expect(SteamNewsCollector.definition).toBe(DEFINITION);
  expect(OFFICIAL_SOURCE_TYPES.has("steam")).toBe(true);
  expect(RUMOR_SOURCE_TYPES.has("steam")).toBe(false);
});

it("takes part in cross-source dedup so the site's copy wins", () => {
  expect(SteamNewsCollector.participates_in_cross_source_dedup).toBe(true);
  expect(BaseNewsCollector.participates_in_cross_source_dedup).toBe(true);
  const collector = new SteamNewsCollector({ config: { steam_feed_url: FEED_URL }, db: null, bot: null });
  expect(collector.participatesInCrossSourceDedup).toBe(true);
});

it("lists the captured feed by guid through the configured URL", async () => {
  const calls = stubFeedFetch(fixtureXml());
  const custom = "https://store.steampowered.com/feeds/news/app/999/";
  const collector = new SteamNewsCollector({ config: { steam_feed_url: custom }, db: null, bot: null });

  const entries = await collector.fetchListing();

  expect(calls[0].url).toBe(custom);
  expect(entries).toHaveLength(10);
  expect(entries[0].dedup_key).toBe(`${NEWS_BASE}703279756977636272`);
  expect(entries[0].payload.title).toBe("Upcoming Update Preview & Server Maintenance");
  expect(collector.missingGeminiWarning()).toContain("GEMINI_API_KEY");
});

it("drops an item with neither title nor text from the listing", async () => {
  const empty = `<item><title></title><link><![CDATA[${NEWS_BASE}7]]></link><description></description></item>`;
  stubFeedFetch(feedXml(empty, itemXml("Kept", { guid: "kept" })));
  const collector = new SteamNewsCollector({ config: { steam_feed_url: FEED_URL }, db: null, bot: null });

  const entries = await collector.fetchListing();
  expect(entries.map((entry) => entry.dedup_key)).toEqual(["kept"]);
});

it("maps a post to an official photo candidate", async () => {
  const post = {
    post_id: `${NEWS_BASE}703279756977635616`,
    web_url: `${NEWS_BASE}703279756977635616`,
    title: "NVIDIA GeForce NOW is live on Aniimo",
    body_text: "Play Aniimo in the cloud.",
    created_at: "2026-09-17T13:44:18+00:00",
    image_url: COVER,
    additional_image_urls: [SECOND],
  };
  const collector = new SteamNewsCollector({ config: { steam_feed_url: FEED_URL }, db: null, bot: null });

  const candidate = await collector.parseEntry(listingEntry(post.post_id, post));

  expect(candidate.source_id).toBe(post.post_id);
  expect(candidate.source_url).toBe(post.web_url);
  expect(candidate.title).toBe("NVIDIA GeForce NOW is live on Aniimo");
  expect(candidate.body_text).toBe("Play Aniimo in the cloud.");
  expect(candidate.has_media).toBe(true);
  expect(candidate.media_url).toBe(COVER);
  expect(candidate.media_type).toBe("photo");
  expect(candidate.additional_media_urls).toEqual([SECOND]);
  expect(candidate.article_date).toBe("2026-09-17T13:44:18+00:00");
  expect(candidate.article_date_display).toBe("2026-09-17");
  expect(candidate.source_name).toBe("Steam-сторінка Aniimo");
  expect(candidate.username).toBe("steam_news_collector");
  expect(candidate.original_text).toContain(post.web_url);
  expect(candidate.original_text).toContain("Play Aniimo in the cloud.");
  expect(candidate.original_text).toContain(COVER);
});

it("maps a text-only post to a media-less candidate", async () => {
  const post = {
    post_id: "p1",
    web_url: `${NEWS_BASE}1`,
    title: "",
    body_text: "Fixed an issue.",
    created_at: null,
    image_url: null,
    additional_image_urls: [],
  };
  const collector = new SteamNewsCollector({ config: { steam_feed_url: FEED_URL }, db: null, bot: null });

  const candidate = await collector.parseEntry(listingEntry(post.post_id, post));

  expect(candidate.title).toBe(FALLBACK_TITLE);
  expect(candidate.has_media).toBe(false);
  expect(candidate.media_url).toBeNull();
  expect(candidate.media_type).toBe("none");
  expect(candidate.additional_media_urls).toBeNull();
  expect(candidate.article_date).toBeNull();
  expect(candidate.article_date_display).toBeNull();
});

it("derives a title within the limit", () => {
  expect(FALLBACK_TITLE).toBe("Оголошення Aniimo у Steam");
  expect(deriveTitle("  ")).toBe(FALLBACK_TITLE);
  expect(deriveTitle("Patch Notes-v1.0.3551601.0")).toBe("Patch Notes-v1.0.3551601.0");

  const long = `${"word ".repeat(40)}tail`;
  const derived = deriveTitle(long);
  expect(derived.endsWith("…")).toBe(true);
  expect(Array.from(derived).length).toBeLessThanOrEqual(141);
  expect(derived).not.toContain("wor…");
});
