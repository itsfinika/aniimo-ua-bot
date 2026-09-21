/**
 * Tests for Bluesky author-feed parsing: reposts/replies are dropped, image posts
 * expose full-size URLs and a public web URL, video posts are flagged but carry no
 * media, and nanosecond timestamps are normalized for date-gating.
 */

import { afterEach, expect, it, vi } from "vitest";

import { listingEntry } from "../services/collectors/base.js";
import { BlueskyCollector } from "../services/collectors/bluesky/collector.js";
import { normalizeTimestamp, parseAuthorFeed } from "../services/collectors/bluesky/feed_fetcher.js";
import * as videoModule from "../services/collectors/bluesky/video.js";
import { fromIsoFormat } from "../services/pyutils.js";

// Aniimo has no official Bluesky account (the config default is empty), so the
// tests use a stand-in handle — the parser only needs it to filter reposts.
const ACTOR = "aniimo.bsky.social";
const VIDEO_CID = "bafkreieyoi3vyluyzrqqzctywn2we7zwdpl6nkpcd5hz43tuprkgy6odke";

afterEach(() => {
  vi.restoreAllMocks();
});

function imagePost(uri, text, { handle = ACTOR } = {}) {
  return {
    post: {
      uri: `at://did:plc:abc/app.bsky.feed.post/${uri}`,
      author: { handle },
      record: { text, createdAt: "2026-06-12T16:00:37.994523881Z" },
      embed: {
        $type: "app.bsky.embed.images#view",
        images: [
          { fullsize: "https://cdn.bsky.app/img/feed_fullsize/a.jpg", alt: "" },
          { fullsize: "https://cdn.bsky.app/img/feed_fullsize/b.jpg", alt: "" },
        ],
      },
    },
  };
}

function videoPost(uri, text, { cid = VIDEO_CID } = {}) {
  const embed = { $type: "app.bsky.embed.video#view", playlist: "https://video.bsky.app/x.m3u8" };
  if (cid !== null) {
    embed.cid = cid;
  }
  return {
    post: {
      uri: `at://did:plc:abc/app.bsky.feed.post/${uri}`,
      author: { handle: ACTOR },
      record: { text, createdAt: "2026-06-11T10:00:00.000Z" },
      embed,
    },
  };
}

function textPost(uri, text) {
  return {
    post: {
      uri: `at://did:plc:abc/app.bsky.feed.post/${uri}`,
      author: { handle: ACTOR },
      record: { text, createdAt: "2026-06-10T09:00:00Z" },
    },
  };
}

function blueskyPost(overrides) {
  const base = {
    uri: "at://did:plc:abc/app.bsky.feed.post/zzz",
    web_url: "https://bsky.app/profile/h/post/zzz",
    text: "",
    created_at: null,
    image_urls: [],
    has_video: false,
    video_cid: null,
    ...overrides,
  };
  return {
    ...base,
    get author_did() {
      const parts = base.uri.split("/");
      return parts.length > 2 ? parts[2] : "";
    },
  };
}

it("extracts images and the public web URL", () => {
  const posts = parseAuthorFeed({ feed: [imagePost("aaa", "New event!")] }, { actor: ACTOR });

  expect(posts).toHaveLength(1);
  const post = posts[0];
  expect(post.text).toBe("New event!");
  expect(post.image_urls).toEqual([
    "https://cdn.bsky.app/img/feed_fullsize/a.jpg",
    "https://cdn.bsky.app/img/feed_fullsize/b.jpg",
  ]);
  expect(post.has_video).toBe(false);
  expect(post.web_url).toBe(`https://bsky.app/profile/${ACTOR}/post/aaa`);
});

it("drops image URLs outside the Bluesky CDN", () => {
  // A tampered fullsize value must never become a media URL: only Bluesky's own
  // image CDN (https cdn.bsky.app) is trusted; anything else (an internal SSRF
  // target, a non-CDN host, or http) is dropped so it is never fetched bot-side
  // or handed to Telegram.
  const post = {
    post: {
      uri: "at://did:plc:abc/app.bsky.feed.post/evil",
      author: { handle: ACTOR },
      record: { text: "Pic", createdAt: "2026-06-12T16:00:00Z" },
      embed: {
        $type: "app.bsky.embed.images#view",
        images: [
          { fullsize: "https://cdn.bsky.app/img/feed_fullsize/ok.jpg", alt: "" },
          { fullsize: "http://169.254.169.254/latest/meta-data/", alt: "" },
          { fullsize: "https://evil.example.com/x.jpg", alt: "" },
          { fullsize: "https://cdn.bsky.app.attacker.com/x.jpg", alt: "" },
        ],
      },
    },
  };
  const posts = parseAuthorFeed({ feed: [post] }, { actor: ACTOR });

  expect(posts[0].image_urls).toEqual(["https://cdn.bsky.app/img/feed_fullsize/ok.jpg"]);
});

it("skips reposts", () => {
  const repost = imagePost("ccc", "Reposted");
  repost.reason = { $type: "app.bsky.feed.defs#reasonRepost" };
  const posts = parseAuthorFeed({ feed: [repost, textPost("ddd", "Own post")] }, { actor: ACTOR });

  expect(posts.map((post) => post.text)).toEqual(["Own post"]);
});

it("exposes the blob CID and author DID of a video post", () => {
  const posts = parseAuthorFeed({ feed: [videoPost("vvv", "Watch the trailer")] }, { actor: ACTOR });

  expect(posts).toHaveLength(1);
  expect(posts[0].has_video).toBe(true);
  expect(posts[0].image_urls).toEqual([]);
  expect(posts[0].video_cid).toBe(VIDEO_CID);
  expect(posts[0].author_did).toBe("did:plc:abc"); // owns the blob, used for getBlob
});

it("does not flag a video post without a CID", () => {
  // No CID -> the original MP4 cannot be fetched, so the post is not a video post
  // (it falls back to a text post downstream).
  const posts = parseAuthorFeed({ feed: [videoPost("nocid", "Trailer", { cid: null })] }, { actor: ACTOR });

  expect(posts[0].has_video).toBe(false);
  expect(posts[0].video_cid).toBeNull();
});

it("rejects a malformed CID", () => {
  const posts = parseAuthorFeed({ feed: [videoPost("badcid", "Trailer", { cid: "not-a-valid-cid!!" })] }, {
    actor: ACTOR,
  });

  expect(posts[0].has_video).toBe(false);
  expect(posts[0].video_cid).toBeNull();
});

it("collapses duplicate URIs", () => {
  const posts = parseAuthorFeed({ feed: [textPost("same", "First"), textPost("same", "Dup")] }, { actor: ACTOR });
  expect(posts).toHaveLength(1);
});

it("skips malformed entries", () => {
  const feed = { feed: [null, {}, { post: { author: { handle: "x" } } }, textPost("ok", "Good")] };
  const posts = parseAuthorFeed(feed, { actor: ACTOR });

  expect(posts.map((post) => post.text)).toEqual(["Good"]);
});

it("tolerates a non-object record or author without dropping valid posts", () => {
  // A truthy non-object record/author (partial/garbage payload) must be tolerated,
  // not throw and abort the whole feed — which would drop every other valid post
  // collected in that run.
  const badRecord = {
    post: {
      uri: "at://did:plc:abc/app.bsky.feed.post/b1",
      author: { handle: "h" },
      record: "oops-a-string",
    },
  };
  const badAuthor = {
    post: {
      uri: "at://did:plc:abc/app.bsky.feed.post/b2",
      author: ["not", "an", "object"],
      record: { text: "Валідний текст" },
    },
  };
  const feed = { feed: [badRecord, badAuthor, textPost("ok", "Good")] };

  const texts = parseAuthorFeed(feed, { actor: ACTOR }).map((post) => post.text);

  expect(texts).toContain("Good");
  expect(texts).toContain("Валідний текст"); // badAuthor still has a valid record
});

it("returns nothing for a non-object payload", () => {
  // A 200 with a valid but non-object JSON body must not crash the parser.
  for (const payload of [[], null, "oops", 42, { feed: "not-a-list" }]) {
    expect(parseAuthorFeed(payload, { actor: "x" })).toEqual([]);
  }
});

it("normalises nanosecond timestamps and Z", () => {
  const normalized = normalizeTimestamp("2026-06-12T16:00:37.994523881Z");
  // Trimmed to microseconds, Z -> +00:00, and parseable as ISO.
  expect(normalized).toBe("2026-06-12T16:00:37.994523+00:00");
  expect(fromIsoFormat(normalized).year).toBe(2026);
});

it("normalises a plain UTC timestamp", () => {
  expect(normalizeTimestamp("2026-06-10T09:00:00Z")).toBe("2026-06-10T09:00:00+00:00");
});

it("returns null for an empty timestamp", () => {
  expect(normalizeTimestamp("")).toBeNull();
  expect(normalizeTimestamp(null)).toBeNull();
});

it("maps a post to a draft candidate", async () => {
  const post = blueskyPost({
    text: "Великий анонс версії 1.1!\nДеталі нижче.",
    created_at: "2026-06-12T16:00:37.994523+00:00",
    image_urls: ["https://cdn/a.jpg", "https://cdn/b.jpg"],
  });
  const collector = new BlueskyCollector({ config: { bluesky_actor: ACTOR }, db: null, bot: null });

  const candidate = await collector.parseEntry(listingEntry(post.uri, post));

  expect(candidate.source_id).toBe(post.uri);
  expect(candidate.source_url).toBe(post.web_url);
  expect(candidate.title).toBe("Великий анонс версії 1.1!"); // first line, no media/tags
  expect(candidate.body_text).toBe(post.text);
  expect(candidate.has_media).toBe(true);
  expect(candidate.media_url).toBe("https://cdn/a.jpg");
  expect(candidate.additional_media_urls).toEqual(["https://cdn/b.jpg"]);
  expect(candidate.source_name).toBe("Bluesky Aniimo");
  expect(candidate.article_date).toBe("2026-06-12T16:00:37.994523+00:00");
  expect(candidate.article_date_display).toBe("2026-06-12");
});

it("resolves a video post to a native-video candidate", async () => {
  vi.spyOn(videoModule, "resolveVideoBlobUrl").mockImplementation(
    async (did, cid) => `https://pds.host.bsky.network/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`,
  );

  const post = blueskyPost({
    uri: "at://did:plc:abc/app.bsky.feed.post/vid",
    web_url: "https://bsky.app/profile/h/post/vid",
    text: "Новий трейлер!",
    created_at: "2026-06-11T10:00:00+00:00",
    has_video: true,
    video_cid: VIDEO_CID,
  });
  const collector = new BlueskyCollector({
    config: { bluesky_actor: "x", enable_bluesky_video_download: true },
    db: null,
    bot: null,
  });

  const candidate = await collector.parseEntry(listingEntry(post.uri, post));

  expect(candidate.has_media).toBe(true);
  expect(candidate.media_type).toBe("video");
  expect(candidate.media_url).toContain("com.atproto.sync.getBlob");
  expect(candidate.additional_media_urls).toBeNull();
});

it("falls back to text when the video download is disabled", async () => {
  const post = blueskyPost({
    uri: "at://did:plc:abc/app.bsky.feed.post/vid",
    web_url: "https://bsky.app/profile/h/post/vid",
    text: "Новий трейлер!",
    has_video: true,
    video_cid: VIDEO_CID,
  });
  const collector = new BlueskyCollector({
    config: { bluesky_actor: "x", enable_bluesky_video_download: false },
    db: null,
    bot: null,
  });

  const candidate = await collector.parseEntry(listingEntry(post.uri, post));

  expect(candidate.has_media).toBe(false);
  expect(candidate.media_type).toBe("none");
});

it("falls back to text when the blob URL cannot be resolved", async () => {
  vi.spyOn(videoModule, "resolveVideoBlobUrl").mockResolvedValue(null);

  const post = blueskyPost({
    uri: "at://did:plc:abc/app.bsky.feed.post/vid",
    web_url: "https://bsky.app/profile/h/post/vid",
    text: "Трейлер!",
    has_video: true,
    video_cid: VIDEO_CID,
  });
  const collector = new BlueskyCollector({
    config: { bluesky_actor: "x", enable_bluesky_video_download: true },
    db: null,
    bot: null,
  });

  const candidate = await collector.parseEntry(listingEntry(post.uri, post));

  expect(candidate.has_media).toBe(false);
  expect(candidate.media_type).toBe("none");
});

it("falls back to a title for an image-only post", async () => {
  const post = blueskyPost({
    uri: "at://did:plc:abc/app.bsky.feed.post/img",
    web_url: "https://bsky.app/profile/h/post/img",
    text: "",
    image_urls: ["https://cdn/a.jpg"],
  });
  const collector = new BlueskyCollector({ config: { bluesky_actor: ACTOR }, db: null, bot: null });

  const candidate = await collector.parseEntry(listingEntry(post.uri, post));

  expect(candidate.title).toBeTruthy(); // non-empty fallback so cross-source dedup has something to compare
  expect(candidate.has_media).toBe(true);
  expect(candidate.article_date_display).toBeNull();
});
