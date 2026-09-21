/**
 * Tests for the Reddit leaks collector: search.rss Atom parsing (t3 id, comments
 * URL, selftext from div.md, full-res i.redd.it image vs preview-thumbnail
 * fallback), dedup, and the collector wiring (megathread keyword filter,
 * DraftCandidate mapping).
 */

import { afterEach, expect, it, vi } from "vitest";

import { listingEntry } from "../services/collectors/base.js";
import { RedditLeaksCollector, __testing } from "../services/collectors/reddit/collector.js";
import {
  buildFlairQuery,
  parseFeed,
  upgradePreviewImages,
} from "../services/collectors/reddit/feed_fetcher.js";
import { htmlEscape } from "../services/pyutils.js";

const { isExcluded } = __testing;

afterEach(() => {
  vi.unstubAllGlobals();
});

function entryXml(postId, title, { contentHtml, published = "2026-06-10T21:00:00+00:00", thumb = null, link = null }) {
  const href = link ?? `https://www.reddit.com/r/Aniimo/comments/${postId.slice(3)}/x/`;
  const thumbEl = thumb ? `<media:thumbnail url="${htmlEscape(thumb)}"/>` : "";
  return (
    "<entry><author><name>/u/tester</name></author>" +
    '<category term="Aniimo" label="r/Aniimo"/>' +
    `<content type="html">${htmlEscape(contentHtml)}</content>` +
    `<id>${postId}</id>${thumbEl}` +
    `<link href="${htmlEscape(href)}" />` +
    `<published>${published}</published><title>${htmlEscape(title)}</title></entry>`
  );
}

function feedXml(...entries) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">' +
    "<title>r/Aniimo</title>" +
    entries.join("") +
    "</feed>"
  );
}

const IMAGE_CONTENT =
  '<table><tr><td><a href="https://www.reddit.com/r/x/comments/abc/y/">' +
  '<img src="https://preview.redd.it/abc.jpeg?width=640&crop=smart&s=sig" alt="t"/></a></td>' +
  '<td><!-- SC_OFF --><div class="md"><p>Leak description here.</p></div><!-- SC_ON --> ' +
  'submitted by <a href="https://www.reddit.com/user/tester">/u/tester</a> <br/> ' +
  '<span><a href="https://i.redd.it/abc.jpeg">[link]</a></span> ' +
  '<span><a href="https://www.reddit.com/r/x/comments/abc/y/">[comments]</a></span></td></tr></table>';

const VIDEO_CONTENT =
  '<table><tr><td><a href="https://youtu.be/vid"><img src="https://external-preview.redd.it/p.jpg?s=sig"/></a></td>' +
  '<td><div class="md"><p>Outfit trailer.</p></div> submitted by /u/tester <br/> ' +
  '<span><a href="https://youtu.be/vid">[link]</a></span></td></tr></table>';

const TEXT_CONTENT = '<!-- SC_OFF --><div class="md"><p>Just discussion, no image.</p></div><!-- SC_ON -->';

it("uses the full-res i.redd.it image for an image post", () => {
  const posts = parseFeed(
    feedXml(
      entryXml("t3_abc", "Legendary Irisalis datamined for version 1.2!", {
        contentHtml: IMAGE_CONTENT,
        thumb: "https://preview.redd.it/abc.jpeg?width=640&crop=smart&s=sig",
      }),
    ),
  );

  expect(posts).toHaveLength(1);
  const post = posts[0];
  expect(post.post_id).toBe("t3_abc");
  expect(post.title).toBe("Legendary Irisalis datamined for version 1.2!");
  expect(post.web_url).toBe("https://www.reddit.com/r/Aniimo/comments/abc/x/");
  expect(post.body_text).toBe("Leak description here.");
  expect(post.created_at).toBe("2026-06-10T21:00:00+00:00");
  // Full-resolution direct image (no query), preferred over the preview thumbnail.
  expect(post.image_url).toBe("https://i.redd.it/abc.jpeg");
});

it("falls back to the thumbnail for a video post", () => {
  const post = parseFeed(
    feedXml(
      entryXml("t3_vid", "Highland Form outfit trailer", {
        contentHtml: VIDEO_CONTENT,
        thumb: "https://external-preview.redd.it/p.jpg?width=640&s=sig",
      }),
    ),
  )[0];

  // No i.redd.it image -> keep the signed preview thumbnail (query intact).
  expect(post.image_url).toBe("https://external-preview.redd.it/p.jpg?width=640&s=sig");
  expect(post.body_text).toBe("Outfit trailer.");
});

it("rejects a host-spoofed image link", () => {
  // A [link] whose host only CONTAINS "i.redd.it" (subdomain spoof) must NOT be
  // accepted as the photo; fall back to the genuine preview thumbnail.
  const spoof =
    '<table><tr><td><div class="md"><p>Leak.</p></div> submitted by /u/x <br/> ' +
    '<span><a href="https://i.redd.it.attacker.com/x.png">[link]</a></span></td></tr></table>';
  const post = parseFeed(
    feedXml(entryXml("t3_spoof", "Spoof", { contentHtml: spoof, thumb: "https://preview.redd.it/safe.jpg?s=sig" })),
  )[0];

  expect(post.image_url).toBe("https://preview.redd.it/safe.jpg?s=sig");
});

it("rejects substring and scheme spoofs when there is no thumbnail", () => {
  for (const badHref of [
    "https://evil.com/i.redd.it/x.jpg", // path contains the host substring
    "javascript:alert(1)//i.redd.it/a.jpg", // non-http scheme
  ]) {
    const content =
      '<table><tr><td><div class="md"><p>Leak.</p></div> ' +
      `<span><a href="${htmlEscape(badHref)}">[link]</a></span></td></tr></table>`;
    const post = parseFeed(feedXml(entryXml("t3_b", "Bad", { contentHtml: content })))[0];
    expect(post.image_url, badHref).toBeNull();
  }
});

it("drops a non-Reddit thumbnail", () => {
  const post = parseFeed(
    feedXml(entryXml("t3_t", "T", { contentHtml: TEXT_CONTENT, thumb: "https://evil.com/x.jpg" })),
  )[0];

  expect(post.image_url).toBeNull();
});

it("gives a text post no image", () => {
  const post = parseFeed(feedXml(entryXml("t3_txt", "Discussion", { contentHtml: TEXT_CONTENT })))[0];

  expect(post.image_url).toBeNull();
  expect(post.body_text).toBe("Just discussion, no image.");
});

it("dedups by id and skips a missing id", () => {
  const posts = parseFeed(
    feedXml(
      entryXml("t3_dup", "First", { contentHtml: TEXT_CONTENT }),
      entryXml("t3_dup", "Duplicate", { contentHtml: TEXT_CONTENT }),
    ),
  );
  expect(posts).toHaveLength(1);

  // An entry whose <id> is empty is skipped.
  const noId = entryXml("t3_x", "No id", { contentHtml: TEXT_CONTENT }).replace("<id>t3_x</id>", "<id></id>");
  expect(parseFeed(feedXml(noId))).toEqual([]);
});

it("returns nothing for invalid XML", () => {
  expect(parseFeed("not xml")).toEqual([]);
  expect(parseFeed("")).toEqual([]);
});

it("ORs quoted flairs in the search query", () => {
  expect(buildFlairQuery(["News", "Leak"])).toBe('flair:"News" OR flair:"Leak"');
});

it("matches the megathread keyword", () => {
  const keywords = new Set(["megathread"]);
  expect(isExcluded("Aniimo Version 1.1 Megathread", keywords)).toBe(true);
  expect(isExcluded("Legendary Irisalis datamined for version 1.2!", keywords)).toBe(false);
});

// --- the preview-thumbnail upgrade ----------------------------------------------

function headResponse(status, contentType) {
  return { status, headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) } };
}

async function runUpgrade(posts, responses) {
  const calls = [];
  vi.stubGlobal("fetch", async (url) => {
    calls.push(String(url));
    const result = responses[String(url)] ?? headResponse(403, "text/html");
    if (result instanceof Error) {
      throw result;
    }
    return result;
  });
  return { upgraded: await upgradePreviewImages(posts), calls };
}

function redditPost(imageUrl, postId = "t3_a") {
  return {
    post_id: postId,
    web_url: `https://www.reddit.com/r/Aniimo/comments/${postId.slice(3)}/x/`,
    title: "Leak",
    body_text: "body",
    created_at: "2026-07-25T20:00:00+00:00",
    image_url: imageUrl,
    author: "/u/tester",
  };
}

it("swaps a tiny thumbnail for the full-res original", async () => {
  const posts = [redditPost("https://preview.redd.it/abc123.png?width=140&height=125&s=sig")];
  const { upgraded, calls } = await runUpgrade(posts, {
    "https://i.redd.it/abc123.png": headResponse(200, "image/png"),
  });

  expect(calls).toEqual(["https://i.redd.it/abc123.png"]);
  // The signed 140px thumbnail is replaced by the full-resolution original.
  expect(upgraded[0].image_url).toBe("https://i.redd.it/abc123.png");
  // Every other field is carried over untouched.
  expect(upgraded[0].post_id).toBe(posts[0].post_id);
  expect(upgraded[0].title).toBe(posts[0].title);
});

it("leaves external-preview alone", async () => {
  // external-preview mirrors an image hosted ELSEWHERE: it has no i.redd.it twin,
  // so it must not even be probed.
  const url = "https://external-preview.redd.it/Nx-9Zq.jpeg?width=640&s=sig";
  const { upgraded, calls } = await runUpgrade([redditPost(url)], {});

  expect(calls).toEqual([]);
  expect(upgraded[0].image_url).toBe(url);
});

it("leaves direct and missing images alone", async () => {
  const posts = [redditPost("https://i.redd.it/already.jpeg", "t3_a"), redditPost(null, "t3_b")];
  const { upgraded, calls } = await runUpgrade(posts, {});

  expect(calls).toEqual([]);
  expect(upgraded.map((post) => post.image_url)).toEqual(["https://i.redd.it/already.jpeg", null]);
});

it("keeps the thumbnail when the twin is missing", async () => {
  // Video/gallery previews have no i.redd.it original — Reddit answers 403/404.
  const url = "https://preview.redd.it/novideo.jpg?width=140&s=sig";
  const { upgraded, calls } = await runUpgrade([redditPost(url)], {});

  expect(calls).toEqual(["https://i.redd.it/novideo.jpg"]);
  expect(upgraded[0].image_url).toBe(url);
});

it("rejects a non-image response", async () => {
  const url = "https://preview.redd.it/page.jpg?s=sig";
  const { upgraded } = await runUpgrade([redditPost(url)], {
    "https://i.redd.it/page.jpg": headResponse(200, "text/html; charset=utf-8"),
  });

  expect(upgraded[0].image_url).toBe(url);
});

it("survives a network error", async () => {
  const url = "https://preview.redd.it/flaky.jpg?s=sig";
  const { upgraded } = await runUpgrade([redditPost(url)], {
    "https://i.redd.it/flaky.jpg": new Error("boom"),
  });

  expect(upgraded[0].image_url).toBe(url);
});

it("skips paths that are not plain filenames", async () => {
  // Anything but a single-segment image file name is left as-is rather than
  // guessed at, so a crafted path can never be turned into a fetched URL.
  for (const suffix of ["/../../evil.jpg", "/nested/dir/img.jpg", "/noextension", "/img.svg"]) {
    const url = `https://preview.redd.it${suffix}?s=sig`;
    const { upgraded, calls } = await runUpgrade([redditPost(url)], {});
    expect(calls, suffix).toEqual([]);
    expect(upgraded[0].image_url, suffix).toBe(url);
  }
});

it("handles a mixed batch", async () => {
  const posts = [
    redditPost("https://preview.redd.it/one.png?width=140&s=sig", "t3_a"),
    redditPost("https://external-preview.redd.it/two.jpg?width=640&s=sig", "t3_b"),
    redditPost("https://i.redd.it/three.jpeg", "t3_c"),
    redditPost("https://preview.redd.it/four.jpg?width=140&s=sig", "t3_d"),
  ];
  const { upgraded, calls } = await runUpgrade(posts, {
    "https://i.redd.it/one.png": headResponse(200, "image/png"),
  });

  expect([...calls].sort()).toEqual(["https://i.redd.it/four.jpg", "https://i.redd.it/one.png"]);
  expect(upgraded.map((post) => post.image_url)).toEqual([
    "https://i.redd.it/one.png", // upgraded
    "https://external-preview.redd.it/two.jpg?width=640&s=sig", // untouched
    "https://i.redd.it/three.jpeg", // already full-res
    "https://preview.redd.it/four.jpg?width=140&s=sig", // twin missing, kept
  ]);
});

// --- collector wiring -----------------------------------------------------------

function buildCollector(posts) {
  const config = {
    reddit_subreddit: "Aniimo",
    reddit_flairs: ["News", "Leak", "Datamine"],
    reddit_exclude_keywords: new Set(["megathread"]),
  };
  const collector = new RedditLeaksCollector({ config, db: null, bot: null });
  collector.fetcher = { async fetchRecentPosts() { return posts; } };
  return collector;
}

it("filters out a megathread", async () => {
  const posts = [
    {
      post_id: "t3_mt",
      web_url: "https://reddit/x",
      title: "Version 1.1 Megathread",
      body_text: "body",
      created_at: "2026-06-12T00:00:00+00:00",
      image_url: null,
      author: "/u/a",
    },
    {
      post_id: "t3_leak",
      web_url: "https://reddit/y",
      title: "Legendary Irisalis datamined for version 1.2!",
      body_text: "body",
      created_at: "2026-06-10T00:00:00+00:00",
      image_url: "https://i.redd.it/d.jpg",
      author: "/u/b",
    },
  ];
  const entries = await buildCollector(posts).fetchListing();

  expect(entries.map((entry) => entry.dedup_key)).toEqual(["t3_leak"]);
});

it("maps a post to a candidate", async () => {
  const post = {
    post_id: "t3_leak",
    web_url: "https://www.reddit.com/r/Aniimo/comments/leak/x/",
    title: "Legendary Irisalis datamined for version 1.2!",
    body_text: "Datamine context.",
    created_at: "2026-06-10T21:00:00+00:00",
    image_url: "https://i.redd.it/d.jpeg",
    author: "/u/tester",
  };

  const candidate = await buildCollector([]).parseEntry(listingEntry(post.post_id, post));

  expect(candidate.source_id).toBe("t3_leak");
  expect(candidate.source_url).toBe(post.web_url);
  expect(candidate.title).toBe("Legendary Irisalis datamined for version 1.2!");
  expect(candidate.body_text).toBe("Datamine context.");
  expect(candidate.source_name).toBe("Reddit (витоки та чутки Aniimo)");
  expect(candidate.has_media).toBe(true);
  expect(candidate.media_url).toBe("https://i.redd.it/d.jpeg");
  expect(candidate.media_type).toBe("photo");
  expect(candidate.article_date_display).toBe("2026-06-10");
});
