/**
 * Tests for the official Aniimo site collector over the site's JSON API: listing
 * parsing (envelope checks, newline titles, `is_top` pin vs. publishTime order),
 * the UTC+8 server-stamp conversion, detail parsing (body blocks, fullwidth
 * parentheses, site-hosted media), the listing fallback when the detail fetch
 * fails, and the collector -> DraftCandidate mapping with the request headers.
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import { listingEntry } from "../services/collectors/base.js";
import {
  ArticleParser,
  collectArticleMedia,
  extractBodyText,
  MAX_ARTICLE_MEDIA_ITEMS,
  MAX_ARTICLE_TEXT_LENGTH,
  normalizeBodyText,
  parseServerDate,
} from "../services/collectors/official_aniimo/article_parser.js";
import { DEFINITION, OfficialAniimoCollector } from "../services/collectors/official_aniimo/collector.js";
import {
  articleUrlFor,
  normalizeImageUrl,
  OfficialNewsFetcher,
  parseOfficialNewsList,
  USER_AGENT,
} from "../services/collectors/official_aniimo/news_fetcher.js";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures", "aniimo");
const NEWS_URL = "https://www.aniimo.com/newslist";
const API_URL = "https://worldx-office-api.aniimo.com";
const CONFIG = {
  official_news_url: NEWS_URL,
  official_news_api_url: API_URL,
  official_news_region: "en",
  article_timezone: "Europe/Kyiv",
};
const COVER = "https://worldx-website-cdn.aniimo.com/official-website/worldx-global-stage/office/aniimo/en_aUZqJrwL.png";
const STORE_IMAGE =
  "https://worldx-website-cdn.aniimo.com/official-website/worldx-global-stage/office/aniimo/mobile-store_Qw12Ab34.jpg";

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

/**
 * Route the listing and detail endpoints to canned responses and record every
 * request (URL + init) so the tests can assert on the headers and query.
 */
function stubApi({ listing = fixture("official_list.json"), details = {}, detailStatus = 200 } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", async (url, init) => {
    const text = String(url);
    calls.push({ url: text, init });
    if (text.includes("/api/information/list")) {
      if (listing instanceof Error) {
        throw listing;
      }
      return jsonResponse(listing);
    }
    const id = new URL(text).searchParams.get("id");
    const detail = details[id];
    if (detail instanceof Error) {
      throw detail;
    }
    if (detail === undefined) {
      return jsonResponse({ code: 500, msg: "not found" }, detailStatus);
    }
    return jsonResponse(detail, detailStatus);
  });
  return calls;
}

function newFetcher() {
  return new OfficialNewsFetcher({ news_url: NEWS_URL, api_url: API_URL, region: "en" });
}

function newCollector() {
  return new OfficialAniimoCollector({ config: CONFIG, db: null, bot: null });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- listing -------------------------------------------------------------------

it("parses the listing fixture into summaries with public page URLs", () => {
  const articles = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL);

  expect(articles).toHaveLength(30);
  const first = articles[0];
  expect(first.id).toBe("100137");
  expect(first.canonical_url).toBe("https://www.aniimo.com/newslist/detail/100137");
  expect(first.article_url).toBe(first.canonical_url);
  expect(first.information_type).toBe("new");
  expect(first.raw_date).toBe("2026-09-22 00:00:12");
  expect(first.cover_image_url).toBe(COVER);
  expect(first.raw_excerpt).toMatch(/^Aniimo mobile pre-download is now available/);
});

it("collapses a newline inside a title to one space", () => {
  const articles = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL);

  expect(articles[0].title).toBe(
    "Aniimo Mobile Pre-Download Now Available! Coming to All Platforms on September 23!",
  );
  // A trailing space in the raw title is dropped too.
  expect(articles.find((article) => article.id === "100115").title).toBe("Aniimo Is Now Live on PC & Console!");
});

it("turns an empty cover and a blank describe into nulls", () => {
  const articles = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL);
  const notice = articles.find((article) => article.id === "100145");

  expect(notice.cover_image_url).toBeNull();
  // `describe` is " " for this item.
  expect(notice.raw_excerpt).toBeNull();
  expect(notice.information_type).toBe("announcement");
});

it("orders the listing by publishTime descending, not by the API order", () => {
  // The API interleaves: 100089 (Sep 15 19:42) and 100067 (Sep 16 09:00) come
  // after 100100 (Sep 14) in the raw list.
  const ids = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL).map((article) => article.id);

  expect(ids.slice(0, 7)).toEqual(["100137", "100145", "100115", "100067", "100089", "100111", "100100"]);
});

it("does not let is_top pin an older item ahead of newer ones", () => {
  const listing = {
    code: 200,
    msg: "",
    data: {
      list: [
        { id: "1", title: "Pinned", is_top: true, publishTime: "2026-09-01 10:00:00" },
        { id: "2", title: "Newer", is_top: false, publishTime: "2026-09-20 10:00:00" },
        { id: "3", title: "Newest", is_top: false, publishTime: "2026-09-21 10:00:00" },
      ],
    },
  };

  const ids = parseOfficialNewsList(listing, NEWS_URL).map((article) => article.id);
  expect(ids).toEqual(["3", "2", "1"]);
});

it("falls back from publishTime to showTime and then createTime", () => {
  const listing = {
    code: 200,
    data: {
      list: [
        { id: "a", title: "A", publishTime: "", showTime: "2026-09-10 08:00:00", createTime: "2026-09-01 00:00:00" },
        { id: "b", title: "B", publishTime: null, showTime: null, createTime: "2026-09-12 00:00:00" },
        { id: "c", title: "C" },
      ],
    },
  };

  const articles = parseOfficialNewsList(listing, NEWS_URL);
  expect(articles.map((article) => article.raw_date)).toEqual(["2026-09-12 00:00:00", "2026-09-10 08:00:00", null]);
  expect(articles.map((article) => article.id)).toEqual(["b", "a", "c"]);
});

it("dedups repeated ids and skips items without one", () => {
  const listing = {
    code: 200,
    data: {
      list: [
        { id: "7", title: "First", publishTime: "2026-09-21 10:00:00" },
        { id: "7", title: "Again", publishTime: "2026-09-21 11:00:00" },
        { title: "No id", publishTime: "2026-09-21 12:00:00" },
        "junk",
        null,
      ],
    },
  };

  const articles = parseOfficialNewsList(listing, NEWS_URL);
  expect(articles).toHaveLength(1);
  expect(articles[0].title).toBe("First");
});

it("treats a non-200 envelope or a missing list as an empty listing", () => {
  expect(parseOfficialNewsList({ code: 500, msg: "Article Query Failed", data: null }, NEWS_URL)).toEqual([]);
  expect(parseOfficialNewsList({ code: 200, data: { list: null } }, NEWS_URL)).toEqual([]);
  expect(parseOfficialNewsList({ code: 200, data: { list: "nope" } }, NEWS_URL)).toEqual([]);
  expect(parseOfficialNewsList({ code: 200, data: [] }, NEWS_URL)).toEqual([]);
  expect(parseOfficialNewsList(null, NEWS_URL)).toEqual([]);
  expect(parseOfficialNewsList("<html>", NEWS_URL)).toEqual([]);
});

it("never throws out of fetchRecentArticles", async () => {
  stubApi({ listing: { code: 401, msg: "denied" } });
  expect(await newFetcher().fetchRecentArticles()).toEqual([]);

  vi.stubGlobal("fetch", async () => jsonResponse({}, 503));
  expect(await newFetcher().fetchRecentArticles()).toEqual([]);

  stubApi({ listing: new Error("socket hang up") });
  expect(await newFetcher().fetchRecentArticles()).toEqual([]);

  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
  }));
  expect(await newFetcher().fetchRecentArticles()).toEqual([]);
});

it("requests the listing with the documented query and headers", async () => {
  const calls = stubApi();
  const articles = await newFetcher().fetchRecentArticles();

  expect(articles).toHaveLength(30);
  expect(calls).toHaveLength(1);
  const { url, init } = calls[0];
  expect(url.startsWith(`${API_URL}/api/information/list?`)).toBe(true);
  const params = new URL(url).searchParams;
  expect(params.get("pageNum")).toBe("1");
  expect(params.get("pageSize")).toBe("20");
  expect(params.get("hasPublish")).toBe("1");
  expect(params.get("type")).toBe("latest");
  expect(params.get("hasContent")).toBe("false");
  expect(params.get("region")).toBe("en");
  expect(init.headers).toEqual({ "User-Agent": USER_AGENT, Accept: "application/json", Region: "en" });
  expect(init.signal).toBeInstanceOf(AbortSignal);
});

it("builds the public page URL from OFFICIAL_NEWS_URL", () => {
  expect(articleUrlFor("https://www.aniimo.com/newslist", "100145")).toBe(
    "https://www.aniimo.com/newslist/detail/100145",
  );
  expect(articleUrlFor("https://www.aniimo.com/newslist/", 100145)).toBe(
    "https://www.aniimo.com/newslist/detail/100145",
  );
});

// --- dates ---------------------------------------------------------------------

it("reads a server stamp as UTC+8 and converts it to Kyiv time", () => {
  // Midnight UTC+8 on the 22nd is 19:00 Kyiv summer time on the 21st.
  const info = parseServerDate("2026-09-22 00:00:12", "Europe/Kyiv");

  expect(info).toEqual({
    original: "2026-09-22 00:00:12",
    article_date: "2026-09-21T19:00+03:00",
    article_date_display: "Дата публікації: 21 вересня 2026, 19:00 за Києвом",
    has_time: true,
  });
});

it("keeps a date-only stamp as a calendar date and rejects garbage", () => {
  expect(parseServerDate("2026-09-22", "Europe/Kyiv")).toEqual({
    original: "2026-09-22",
    article_date: "2026-09-22",
    article_date_display: "Дата публікації: 22 вересня 2026",
    has_time: false,
  });
  expect(parseServerDate("", "Europe/Kyiv")).toBeNull();
  expect(parseServerDate(null, "Europe/Kyiv")).toBeNull();
  expect(parseServerDate("yesterday", "Europe/Kyiv")).toBeNull();
});

it("converts into the configured zone and survives a bad one", () => {
  expect(parseServerDate("2026-01-15 08:00:00", "UTC").article_date).toBe("2026-01-15T00:00+00:00");
  // An unknown ARTICLE_TIMEZONE falls back to Europe/Kyiv (winter: UTC+2).
  expect(parseServerDate("2026-01-15 08:00:00", "Mars/Olympus").article_date).toBe("2026-01-15T02:00+02:00");
});

// --- detail --------------------------------------------------------------------

it("parses the detail fixture into body blocks", async () => {
  const detail = fixture("official_article_100145.json");
  stubApi({ details: { 100145: detail } });
  const summaries = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL);
  const summary = summaries.find((article) => article.id === "100145");

  const article = await new ArticleParser(newFetcher(), "Europe/Kyiv").fetchAndParse(summary);

  expect(article.title).toBe("September 23 Update Notice — Setting Out in Pursuit of the Wind: Part I");
  expect(article.canonical_url).toBe("https://www.aniimo.com/newslist/detail/100145");
  expect(article.information_type).toBe("announcement");
  expect(article.raw_date).toBe("2026-09-21 22:32:24");
  expect(article.date_info.article_date).toBe("2026-09-21T17:32+03:00");

  const lines = article.body_text.split("\n");
  expect(lines[0]).toBe("Dear Pathfinders,");
  expect(lines).toContain(">Maintenance Schedule");
  expect(lines).toContain("[Compensation]: Glimmer x500");
  expect(lines).toContain("6. Optimized memory management and performance overhead for select environmental assets.");
  // `<p><br></p>` spacers and the span styling leave no trace.
  expect(lines.every((line) => line.trim().length > 0)).toBe(true);
  expect(article.body_text).not.toContain("rgb(");
  expect(article.body_text.length).toBeLessThanOrEqual(MAX_ARTICLE_TEXT_LENGTH);
  // No cover and no inline images in this article.
  expect(article.media_type).toBe("none");
  expect(article.media_url).toBeNull();
  expect(article.media_urls).toEqual([]);
});

it("normalises fullwidth parentheses around the zone marker", async () => {
  stubApi({ details: { 100145: fixture("official_article_100145.json") } });
  const summary = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL).find(
    (article) => article.id === "100145",
  );

  const article = await new ArticleParser(newFetcher(), "Europe/Kyiv").fetchAndParse(summary);

  expect(article.body_text).not.toContain("（");
  expect(article.body_text).not.toContain("）");
  expect(article.body_text).toContain("[Maintenance Window]: September 23, 2026, 00:00 – 10:00 (UTC+8)");
  expect(article.body_text).toContain("September 25, 2026, 10:00 – December 10, 2026, 07:59 (UTC+8)");
  // The span split left a space before the sentence's full stop; it is tidied.
  expect(article.body_text).toContain("from September 23, 2026, 00:00 to 10:00 (UTC+8). Following this update");
});

it("normalizeBodyText keeps ordinary text intact", () => {
  expect(normalizeBodyText("  Hello（UTC+8）  world . ")).toBe("Hello(UTC+8) world.");
  expect(normalizeBodyText("1. Added a toggle: Settings - Audio")).toBe("1. Added a toggle: Settings - Audio");
});

it("extractBodyText dedups repeated blocks and handles empty input", () => {
  expect(extractBodyText("")).toBe("");
  expect(extractBodyText(null)).toBe("");
  expect(extractBodyText("<p>Same</p><p>Same</p><h3>Other</h3><script>x()</script>")).toBe("Same\nOther");
  // No block elements at all: the flat text is used.
  expect(extractBodyText("<span>Just <b>text</b></span>")).toBe("Just text");
});

it("collects the cover and the site-hosted body images, deduplicated", async () => {
  const detail = fixture("official_article_with_images.json");
  stubApi({ details: { 100137: detail } });
  const summary = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL).find(
    (article) => article.id === "100137",
  );

  const article = await new ArticleParser(newFetcher(), "Europe/Kyiv").fetchAndParse(summary);

  // Cover first; the same file inside the body is not repeated; the hotlinked
  // image, the look-alike host and the mp4 are skipped; the repeated store
  // image is kept once.
  expect(article.media_type).toBe("photo");
  expect(article.media_url).toBe(COVER);
  expect(article.media_urls).toEqual([COVER, STORE_IMAGE]);
  expect(article.body_text.split("\n")).toEqual([
    "Dear Pathfinders,",
    "Aniimo mobile pre-download is now available as of September 22, 2026, at 00:00 (UTC+8), with the game officially launching on all platforms on September 23, 2026.",
    ">Where to Download",
    "App Store",
    "Google Play",
    "See you in Idyll!",
  ]);
});

it("caps the media at ten items", () => {
  const imgs = Array.from(
    { length: 15 },
    (_, index) => `<img src="https://worldx-website-cdn.aniimo.com/office/aniimo/pic_${index}.png">`,
  ).join("");

  const media = collectArticleMedia(null, imgs, "https://www.aniimo.com/newslist/detail/1");
  expect(media.media_urls).toHaveLength(MAX_ARTICLE_MEDIA_ITEMS);
  expect(media.media_url).toBe("https://worldx-website-cdn.aniimo.com/office/aniimo/pic_0.png");
});

it("accepts only http(s) photos on aniimo.com hosts", () => {
  const page = "https://www.aniimo.com/newslist/detail/1";
  expect(normalizeImageUrl(COVER, page)).toBe(COVER);
  expect(normalizeImageUrl("https://aniimo.com/a.jpg", page)).toBe("https://aniimo.com/a.jpg");
  // A relative path resolves against the page and a space is percent-encoded.
  expect(normalizeImageUrl("/img/image (16).png", page)).toBe("https://www.aniimo.com/img/image%20(16).png");
  expect(normalizeImageUrl("https://aniimo.com.evil.example/a.png", page)).toBeNull();
  expect(normalizeImageUrl("https://cdn.example.com/a.png", page)).toBeNull();
  expect(normalizeImageUrl("https://worldx-website-cdn.aniimo.com/clip.mp4", page)).toBeNull();
  expect(normalizeImageUrl("ftp://aniimo.com/a.png", page)).toBeNull();
  expect(normalizeImageUrl("", page)).toBeNull();
  expect(normalizeImageUrl(null, page)).toBeNull();
});

it("falls back to the listing summary when the detail fetch fails", async () => {
  stubApi({ details: {}, detailStatus: 502 });
  const summary = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL).find(
    (article) => article.id === "100137",
  );

  const article = await new ArticleParser(newFetcher(), "Europe/Kyiv").fetchAndParse(summary);

  expect(article.title).toBe(summary.title);
  expect(article.body_text).toBe(summary.raw_excerpt);
  expect(article.raw_excerpt).toBe(summary.raw_excerpt);
  expect(article.information_type).toBe("new");
  expect(article.media_type).toBe("photo");
  expect(article.media_url).toBe(COVER);
  expect(article.media_urls).toEqual([COVER]);
  expect(article.date_info.article_date).toBe("2026-09-21T19:00+03:00");
});

it("falls back to the summary on a non-200 detail envelope or a thrown fetch", async () => {
  const summary = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL).find(
    (article) => article.id === "100145",
  );

  stubApi({ details: { 100145: { code: 500, msg: "Article Query Failed", data: null } } });
  let article = await new ArticleParser(newFetcher(), "Europe/Kyiv").fetchAndParse(summary);
  expect(article.title).toBe(summary.title);
  expect(article.body_text).toBe("");
  expect(article.media_type).toBe("none");

  stubApi({ details: { 100145: new Error("timeout") } });
  article = await new ArticleParser(newFetcher(), "Europe/Kyiv").fetchAndParse(summary);
  expect(article.title).toBe(summary.title);
  expect(article.date_info.article_date).toBe("2026-09-21T17:32+03:00");
});

it("uses the excerpt when the detail has no content", async () => {
  const listing = parseOfficialNewsList(fixture("official_list.json"), NEWS_URL);
  const summary = listing.find((article) => article.id === "100137");
  const detail = fixture("official_article_with_images.json");
  detail.data.content = null;
  stubApi({ details: { 100137: detail } });

  const article = await new ArticleParser(newFetcher(), "Europe/Kyiv").fetchAndParse(summary);

  expect(article.body_text).toBe(summary.raw_excerpt);
  // The cover still comes through from the detail object.
  expect(article.media_urls).toEqual([COVER]);
});

// --- collector -----------------------------------------------------------------

it("declares the official_aniimo definition and opts out of cross-source dedup", () => {
  expect(DEFINITION.collector_id).toBe("official_aniimo");
  expect(DEFINITION.source_type).toBe("official_aniimo");
  expect(DEFINITION.button_key).toBe("buttons.collector_official_aniimo");
  expect(DEFINITION.title).toBe("Офіційний сайт Aniimo");
  expect(DEFINITION.button_text).toBe("Офіційний сайт");
  expect(OfficialAniimoCollector.participates_in_cross_source_dedup).toBe(false);
  expect(newCollector().missingGeminiWarning()).toContain("GEMINI_API_KEY");
});

it("lists entries keyed by the public page URL, newest first", async () => {
  const calls = stubApi();

  const entries = await newCollector().fetchListing();

  expect(entries).toHaveLength(30);
  expect(entries[0].dedup_key).toBe("https://www.aniimo.com/newslist/detail/100137");
  expect(entries[0].payload.id).toBe("100137");
  expect(entries[1].dedup_key).toBe("https://www.aniimo.com/newslist/detail/100145");
  expect(calls[0].init.headers.Region).toBe("en");
});

it("maps a detail article to a draft candidate with the public URL", async () => {
  const calls = stubApi({ details: { 100145: fixture("official_article_100145.json") } });
  const collector = newCollector();
  const entries = await collector.fetchListing();
  const entry = entries.find((candidate) => candidate.payload.id === "100145");

  const candidate = await collector.parseEntry(entry);

  expect(calls[1].url).toBe(`${API_URL}/api/information/new?id=100145`);
  expect(calls[1].init.headers).toEqual({ "User-Agent": USER_AGENT, Accept: "application/json", Region: "en" });
  expect(candidate.source_id).toBe("https://www.aniimo.com/newslist/detail/100145");
  expect(candidate.source_url).toBe("https://www.aniimo.com/newslist/detail/100145");
  expect(candidate.title).toBe("September 23 Update Notice — Setting Out in Pursuit of the Wind: Part I");
  expect(candidate.body_text).toContain("[Compensation]: Glimmer x500");
  expect(candidate.source_name).toBe("офіційний сайт Aniimo");
  expect(candidate.username).toBe("official_news_collector");
  expect(candidate.article_date).toBe("2026-09-21T17:32+03:00");
  expect(candidate.article_date_display).toBe("Дата публікації: 21 вересня 2026, 17:32 за Києвом");
  expect(candidate.has_media).toBe(false);
  expect(candidate.media_type).toBe("none");
  expect(candidate.additional_media_urls).toBeNull();

  expect(candidate.original_text).toContain("Заголовок статті: September 23 Update Notice");
  expect(candidate.original_text).toContain("URL статті: https://www.aniimo.com/newslist/detail/100145");
  expect(candidate.original_text).toContain("Тип: оголошення");
  expect(candidate.original_text).toContain("Оригінальна дата статті: 2026-09-21 22:32:24 (UTC+8)");
  expect(candidate.original_text).toContain("Дата статті після конвертації: Дата публікації: 21 вересня 2026, 17:32 за Києвом");
  expect(candidate.original_text).toContain("Розпізнаний текст статті:\nDear Pathfinders,");
});

it("maps a photo article to an album candidate", async () => {
  stubApi({ details: { 100137: fixture("official_article_with_images.json") } });
  const collector = newCollector();
  const entry = listingEntry(
    "https://www.aniimo.com/newslist/detail/100137",
    parseOfficialNewsList(fixture("official_list.json"), NEWS_URL).find((article) => article.id === "100137"),
  );

  const candidate = await collector.parseEntry(entry);

  expect(candidate.has_media).toBe(true);
  expect(candidate.media_type).toBe("photo");
  expect(candidate.media_url).toBe(COVER);
  expect(candidate.additional_media_urls).toEqual([STORE_IMAGE]);
  expect(candidate.original_text).toContain("Тип: новина");
  expect(candidate.original_text).toContain(`URL медіа: ${COVER}`);
  expect(candidate.original_text).toContain(`URL медіа: ${STORE_IMAGE}`);
  expect(candidate.original_text).toContain("Тип медіа: photo");
});

it("still yields a candidate from the listing when the detail is unavailable", async () => {
  stubApi({ details: {}, detailStatus: 500 });
  const collector = newCollector();
  const entries = await collector.fetchListing();

  const candidate = await collector.parseEntry(entries[0]);

  expect(candidate.source_url).toBe("https://www.aniimo.com/newslist/detail/100137");
  expect(candidate.title).toBe(
    "Aniimo Mobile Pre-Download Now Available! Coming to All Platforms on September 23!",
  );
  expect(candidate.body_text).toMatch(/^Aniimo mobile pre-download is now available/);
  expect(candidate.has_media).toBe(true);
  expect(candidate.media_url).toBe(COVER);
  expect(candidate.additional_media_urls).toEqual([]);
  expect(candidate.article_date).toBe("2026-09-21T19:00+03:00");
  // The excerpt stands in for the body, so it is shown as the parsed text.
  expect(candidate.original_text).toContain("Розпізнаний текст статті:\nAniimo mobile pre-download");
});
