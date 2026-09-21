/**
 * Tests for opt-in collector gating: every optional source is registered but
 * only surfaces / runs when its flag is on; the official site is always
 * available; Bluesky additionally needs an actor to poll.
 */

import { afterEach, expect, it, vi } from "vitest";

import { collectionStats } from "../services/collectors/base.js";
import { OfficialAniimoCollector } from "../services/collectors/official_aniimo/collector.js";
import * as registry from "../services/collectors/registry.js";
import { BaseNewsCollector } from "../services/collectors/runner.js";
import { sleep } from "../services/pyutils.js";

const {
  createAllCollectors,
  createCollector,
  listCollectorDefinitions,
  runAllCollectors,
} = registry;

afterEach(() => {
  vi.restoreAllMocks();
});

function config({
  bluesky,
  blueskyActor = "someone.bsky.social",
  steam = false,
  youtube = false,
  reddit = false,
  aniimotools = false,
  wikiAniimo = false,
}) {
  return {
    enable_bluesky_source: bluesky,
    bluesky_actor: blueskyActor,
    enable_steam_source: steam,
    steam_feed_url: "https://store.steampowered.com/feeds/news/app/4126040/",
    enable_youtube_source: youtube,
    youtube_channel_id: "UC2YdJw53sP73T-lffzrqTZA",
    youtube_exclude_keywords: new Set(),
    enable_reddit_source: reddit,
    reddit_subreddit: "Aniimo",
    reddit_flairs: ["News", "Leak", "Datamine"],
    reddit_exclude_keywords: new Set(["megathread"]),
    enable_aniimotools_source: aniimotools,
    aniimotools_feed_url: "https://aniimotools.dev/articles/rss.xml",
    enable_wiki_aniimo: wikiAniimo,
    wiki_aniimo_api_url: "https://wiki-backend.aniimo.com",
    wiki_aniimo_site_url: "https://wiki.aniimo.com/en",
    official_news_url: "https://www.aniimo.com/newslist",
    official_news_api_url: "https://worldx-office-api.aniimo.com",
    official_news_region: "en",
    article_timezone: "Europe/Kyiv",
  };
}

function idsFor(cfg) {
  return new Set(listCollectorDefinitions(cfg).map((definition) => definition.collector_id));
}

it("hides Bluesky when disabled", () => {
  const ids = idsFor(config({ bluesky: false }));
  expect(ids.has("bluesky")).toBe(false);
  expect(ids.has("official_aniimo")).toBe(true);
});

it("shows Bluesky when enabled", () => {
  expect(idsFor(config({ bluesky: true })).has("bluesky")).toBe(true);
});

it("keeps Bluesky off without an actor even when the flag is on", () => {
  // Aniimo has no official Bluesky account, so the default actor is empty; a
  // flag turned on by itself must not poll a feed for "".
  for (const blueskyActor of ["", "   "]) {
    const cfg = config({ bluesky: true, blueskyActor });
    expect(idsFor(cfg).has("bluesky")).toBe(false);
    expect(createCollector("bluesky", { config: cfg, db: null, bot: null })).toBeNull();
    const tick = createAllCollectors({ config: cfg, db: null, bot: null }).map(
      (collector) => collector.definition.collector_id,
    );
    expect(tick).not.toContain("bluesky");
  }
});

const gatedSources = [
  ["steam", "steam"],
  ["youtube", "youtube"],
  ["reddit", "reddit"],
  ["aniimotools", "aniimotools"],
  ["wiki_aniimo", "wikiAniimo"],
];

it.each(gatedSources)("hides %s when disabled and shows it when enabled", (collectorId, flag) => {
  expect(idsFor(config({ bluesky: false, [flag]: false })).has(collectorId)).toBe(false);
  expect(idsFor(config({ bluesky: false, [flag]: true })).has(collectorId)).toBe(true);
});

it.each(gatedSources)("gates createCollector for %s", (collectorId, flag) => {
  expect(createCollector(collectorId, { config: config({ bluesky: false, [flag]: false }), db: null, bot: null })).toBeNull();
  const collector = createCollector(collectorId, {
    config: config({ bluesky: false, [flag]: true }),
    db: null,
    bot: null,
  });
  expect(collector).not.toBeNull();
  expect(collector.definition.collector_id).toBe(collectorId);
});

it("never joins the wiki rubric to the news tick", () => {
  // The rubric is weekly and has its own scheduler. It is a manual /fetch_news
  // button only — joining the tick would post a creature every interval instead.
  const ids = createAllCollectors({
    config: config({ bluesky: true, wikiAniimo: true }),
    db: null,
    bot: null,
  }).map((collector) => collector.definition.collector_id);
  expect(ids).not.toContain("wiki_aniimo");
  expect(ids).toContain("official_aniimo"); // ordinary sources still run on the tick
});

it("lists every collector without a config, in registry order", () => {
  // Order matters for cross-source dedup: the official site runs before Steam
  // (which repeats its announcements), so the site's copy wins ties.
  const ids = listCollectorDefinitions(null).map((definition) => definition.collector_id);
  expect(ids).toEqual(["official_aniimo", "steam", "bluesky", "youtube", "reddit", "aniimotools", "wiki_aniimo"]);
});

it("gates createCollector for Bluesky", () => {
  expect(createCollector("bluesky", { config: config({ bluesky: false }), db: null, bot: null })).toBeNull();
  const collector = createCollector("bluesky", { config: config({ bluesky: true }), db: null, bot: null });
  expect(collector).not.toBeNull();
  expect(collector.definition.collector_id).toBe("bluesky");
});

it("gates createAllCollectors", () => {
  const disabled = createAllCollectors({ config: config({ bluesky: false }), db: null, bot: null }).map(
    (collector) => collector.definition.collector_id,
  );
  expect(disabled).not.toContain("bluesky");
  expect(disabled).toContain("official_aniimo");

  const enabled = createAllCollectors({ config: config({ bluesky: true }), db: null, bot: null }).map(
    (collector) => collector.definition.collector_id,
  );
  expect(enabled).toContain("bluesky");
});

it("runs Steam right after the official site on the tick", () => {
  const ids = createAllCollectors({ config: config({ bluesky: false, steam: true }), db: null, bot: null }).map(
    (collector) => collector.definition.collector_id,
  );
  expect(ids.slice(0, 2)).toEqual(["official_aniimo", "steam"]);
});

it("keeps the official collector opted out of cross-source dedup", () => {
  expect(OfficialAniimoCollector.participates_in_cross_source_dedup).toBe(false);
  expect(BaseNewsCollector.participates_in_cross_source_dedup).toBe(true);
});

class FakeCollector {
  constructor(name, order) {
    this.definition = { collector_id: name };
    this.name = name;
    this._order = order;
  }

  async runOnce() {
    this._order.push(`${this.name}:start`);
    await sleep(0);
    this._order.push(`${this.name}:end`);
    return collectionStats({ collector_id: this.name, source_type: this.name, source_title: this.name });
  }
}

function tickConfig(interval = 0) {
  return { moderation_send_interval_seconds: interval };
}

it("runs collectors sequentially", async () => {
  // Sequential execution is what lets each collector's cross-source dedup see the
  // previous collector's just-marked titles. If they ran concurrently, the yield
  // inside runOnce would interleave the start/end markers.
  const order = [];
  const collectors = [new FakeCollector("a", order), new FakeCollector("b", order)];

  const stats = await runAllCollectors({ config: tickConfig(), db: null, bot: null, collectors });

  expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  expect(stats.map((entry) => entry.collector_id)).toEqual(["a", "b"]);
});

it("shares one throttle across the tick", async () => {
  // Every collector in a tick must get the SAME throttle, built from the config
  // interval, so the inter-send gap is honoured across sources, not reset per source.
  const collectors = [new FakeCollector("a", []), new FakeCollector("b", [])];

  await runAllCollectors({ config: tickConfig(7), db: null, bot: null, collectors });

  expect(collectors[0].throttle).toBe(collectors[1].throttle);
  expect(collectors[0].throttle.min_interval_seconds).toBe(7);
});
