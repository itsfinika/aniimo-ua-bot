/**
 * Tests for the YouTube collector: Atom-feed parsing (video id / link / thumbnail
 * / description, dedup by video id, newest-first sort, malformed handling) and the
 * collector wiring — esports/Shorts keyword filtering and the normalised-title
 * dedup that collapses the channel's re-uploads of the same trailer.
 */

import { expect, it } from "vitest";

import { listingEntry } from "../services/collectors/base.js";
import { YouTubeCollector, __testing } from "../services/collectors/youtube/collector.js";
import { parseFeed } from "../services/collectors/youtube/feed_fetcher.js";

const { dedupKey, isExcluded, normalizeTitle } = __testing;

function video(videoId, webUrl, title, description, published, thumbnailUrl, channelName) {
  return { video_id: videoId, web_url: webUrl, title, description, published, thumbnail_url: thumbnailUrl, channel_name: channelName };
}

function entryXml(
  videoId,
  title,
  published,
  { description = "Опис відео.", thumb = true, withVideoId = true, link = true } = {},
) {
  const lines = ["  <entry>", `    <id>yt:video:${videoId}</id>`];
  if (withVideoId) {
    lines.push(`    <yt:videoId>${videoId}</yt:videoId>`);
  }
  lines.push(`    <title>${title}</title>`);
  if (link) {
    lines.push(`    <link rel="alternate" href="https://www.youtube.com/watch?v=${videoId}"/>`);
  }
  lines.push("    <author><name>Aniimo</name></author>");
  lines.push(`    <published>${published}</published>`);
  lines.push("    <media:group>");
  lines.push(`      <media:title>${title}</media:title>`);
  if (thumb) {
    lines.push(
      `      <media:thumbnail url="https://i.ytimg.com/vi/${videoId}/hqdefault.jpg" width="480" height="360"/>`,
    );
  }
  lines.push(`      <media:description>${description}</media:description>`);
  lines.push("    </media:group>");
  lines.push("  </entry>");
  return lines.join("\n");
}

function feedXml(entries, { channel = "Aniimo" } = {}) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" ' +
    'xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">\n' +
    `  <title>${channel}</title>\n` +
    `${entries.join("\n")}\n` +
    "</feed>"
  );
}

it("extracts the fields of a feed entry", () => {
  const videos = parseFeed(feedXml([entryXml("VID1", "Version 1.1 Official Trailer", "2026-06-12T16:00:00+00:00")]));

  expect(videos).toHaveLength(1);
  const parsed = videos[0];
  expect(parsed.video_id).toBe("VID1");
  expect(parsed.title).toBe("Version 1.1 Official Trailer");
  expect(parsed.web_url).toBe("https://www.youtube.com/watch?v=VID1");
  expect(parsed.published).toBe("2026-06-12T16:00:00+00:00");
  expect(parsed.description).toBe("Опис відео.");
  expect(parsed.thumbnail_url).toBe("https://i.ytimg.com/vi/VID1/hqdefault.jpg");
  expect(parsed.channel_name).toBe("Aniimo");
});

it("sorts newest first", () => {
  // Older entry listed first (entry[0] is backdated) — must come out newest-first.
  const videos = parseFeed(
    feedXml([
      entryXml("OLD", "Old video", "2026-06-10T09:00:00+00:00"),
      entryXml("NEW", "New video", "2026-06-14T09:00:00+00:00"),
    ]),
  );

  expect(videos.map((item) => item.video_id)).toEqual(["NEW", "OLD"]);
});

it("dedups by video id", () => {
  const videos = parseFeed(
    feedXml([
      entryXml("SAME", "First", "2026-06-12T16:00:00+00:00"),
      entryXml("SAME", "Duplicate", "2026-06-12T16:00:00+00:00"),
    ]),
  );

  expect(videos).toHaveLength(1);
});

it("skips an entry with no video id", () => {
  const videos = parseFeed(
    feedXml([
      entryXml("NOID", "No id", "2026-06-12T16:00:00+00:00", { withVideoId: false }),
      entryXml("OK", "Good", "2026-06-12T16:00:00+00:00"),
    ]),
  );

  expect(videos.map((item) => item.video_id)).toEqual(["OK"]);
});

it("falls back to the standard thumbnail when missing", () => {
  const videos = parseFeed(feedXml([entryXml("NOTHUMB", "No thumb", "2026-06-12T16:00:00+00:00", { thumb: false })]));
  expect(videos[0].thumbnail_url).toBe("https://i.ytimg.com/vi/NOTHUMB/hqdefault.jpg");
});

it("returns nothing for invalid XML", () => {
  expect(parseFeed("not xml at all")).toEqual([]);
  expect(parseFeed("")).toEqual([]);
});

it("normalises the title by case and punctuation", () => {
  expect(normalizeTitle("Version 1.1 — Official Trailer!")).toBe(normalizeTitle("version 1 1   official trailer"));
});

it("collapses a same-day re-upload but not a cross-day one", () => {
  // Same title, same publish day (the channel's double-post quirk) -> same key.
  const a = video("ID1", "u1", "Version 1.1 Trailer", "", "2026-06-13T18:00:00+00:00", null, "Aniimo");
  const b = video("ID2", "u2", "Version 1.1 Trailer", "", "2026-06-13T18:05:00+00:00", null, "Aniimo");
  expect(dedupKey(a)).toBe(dedupKey(b));
  expect(dedupKey(a).startsWith("yt-title:")).toBe(true);

  // Same title reused on a DIFFERENT day -> distinct key, so a genuinely-new
  // video with a recycled title is not dropped forever (seen_sources has no TTL).
  const c = video("ID3", "u3", "Version 1.1 Trailer", "", "2026-07-20T18:00:00+00:00", null, "Aniimo");
  expect(dedupKey(a)).not.toBe(dedupKey(c));

  // Empty title falls back to a per-video key so distinct videos stay distinct.
  const e = video("ID4", "u4", "", "", "2026-06-13T18:00:00+00:00", null, "Aniimo");
  const f = video("ID5", "u5", "", "", "2026-06-13T18:00:00+00:00", null, "Aniimo");
  expect(dedupKey(e)).not.toBe(dedupKey(f));
  expect(dedupKey(e)).toBe("yt-video:ID4");
});

it("matches exclusion keywords as a case-insensitive substring", () => {
  const keywords = new Set(["esports", "highlights", "#shorts"]);
  expect(isExcluded("Grand Finals HIGHLIGHTS", keywords)).toBe(true);
  expect(isExcluded("Funny clip #Shorts", keywords)).toBe(true);
  expect(isExcluded("Version 1.1 Official Trailer", keywords)).toBe(false);
  expect(isExcluded("", keywords)).toBe(false);
});

function buildCollector(videos) {
  const config = {
    youtube_channel_id: "UC2YdJw53sP73T-lffzrqTZA",
    youtube_exclude_keywords: new Set(["esports", "highlights"]),
  };
  const collector = new YouTubeCollector({ config, db: null, bot: null });
  collector.fetcher = { async fetchRecentVideos() { return videos; } };
  return collector;
}

it("filters excluded videos and collapses re-uploads", async () => {
  const videos = [
    video("E1", "u", "Pro League Highlights Day 1", "", "2026-06-14T00:00:00+00:00", null, "Aniimo"),
    video("T1", "u", "Version 1.1 Trailer", "desc", "2026-06-13T00:00:00+00:00", null, "Aniimo"),
    video("T2", "u", "Version 1.1 Trailer", "desc", "2026-06-13T00:01:00+00:00", null, "Aniimo"),
    video("R1", "u", "Developer Letter", "desc", "2026-06-12T00:00:00+00:00", null, "Aniimo"),
  ];

  const entries = await buildCollector(videos).fetchListing();

  // Highlights excluded; the two identical-title trailers collapse to one entry.
  const titles = entries.map((entry) => entry.payload.title);
  expect(titles).not.toContain("Pro League Highlights Day 1");
  expect(titles.filter((title) => title === "Version 1.1 Trailer")).toHaveLength(1);
  expect(titles).toContain("Developer Letter");
  expect(entries).toHaveLength(2);
});

it("prefers the described full upload over a Short", async () => {
  // The channel ships the same trailer as a description-less Short (listed first
  // in the feed) AND a full /watch upload that carries the real description. The
  // collapsed entry must keep the described upload so the AI draft has text.
  const videos = [
    video(
      "SHORT",
      "https://www.youtube.com/shorts/SHORT",
      "Legendary Journey: Windchaser's Departure | #Aniimo",
      "",
      "2026-06-09T12:00:00+00:00",
      null,
      "Aniimo",
    ),
    video(
      "FULL",
      "https://www.youtube.com/watch?v=FULL",
      "Legendary Journey: Windchaser's Departure | Aniimo",
      "A new legendary Aniimo awaits in the Mistwoods...",
      "2026-06-09T11:59:00+00:00",
      null,
      "Aniimo",
    ),
  ];

  const entries = await buildCollector(videos).fetchListing();

  expect(entries).toHaveLength(1); // the Short and the full upload collapse to one trailer
  expect(entries[0].payload.video_id).toBe("FULL"); // the described variant wins regardless of order
  expect(entries[0].payload.description.startsWith("A new legendary Aniimo")).toBe(true);
});

it("keeps the described upload when the Short comes later", async () => {
  // Symmetric case: the described upload is seen first, a description-less Short
  // of the same trailer comes later — the Short must not overwrite it.
  const videos = [
    video(
      "FULL",
      "https://www.youtube.com/watch?v=FULL",
      "Nimbus Fields: Highland Form Showcase | Aniimo",
      "Every Highland Form in one showcase...",
      "2026-06-09T12:00:00+00:00",
      null,
      "Aniimo",
    ),
    video(
      "SHORT",
      "https://www.youtube.com/shorts/SHORT",
      "Nimbus Fields: Highland Form Showcase | #Aniimo",
      "",
      "2026-06-09T11:00:00+00:00",
      null,
      "Aniimo",
    ),
  ];

  const entries = await buildCollector(videos).fetchListing();

  expect(entries).toHaveLength(1);
  expect(entries[0].payload.video_id).toBe("FULL");
});

it("maps a video to a draft candidate", async () => {
  const item = video(
    "VID9",
    "https://www.youtube.com/watch?v=VID9",
    "Version 1.1 Official Trailer",
    "Опис трейлера.",
    "2026-06-12T16:00:00+00:00",
    "https://i.ytimg.com/vi/VID9/hqdefault.jpg",
    "Aniimo",
  );
  const entry = listingEntry(dedupKey(item), item);

  const candidate = await buildCollector([]).parseEntry(entry);

  expect(candidate.source_id).toBe(entry.dedup_key); // normalised-title key, not the video id
  expect(candidate.source_url).toBe(item.web_url);
  expect(candidate.title).toBe("Version 1.1 Official Trailer");
  expect(candidate.body_text).toBe("Опис трейлера.");
  expect(candidate.source_name).toBe("YouTube Aniimo");
  // No attached photo: published as text + a playable link preview of the video.
  expect(candidate.has_media).toBe(false);
  expect(candidate.media_url).toBeNull();
  expect(candidate.media_type).toBe("none");
  expect(candidate.article_date).toBe("2026-06-12T16:00:00+00:00");
  expect(candidate.article_date_display).toBe("2026-06-12");
});
