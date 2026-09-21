/**
 * Tests for the collector album branch: a single-part draft with 2+ photos becomes
 * one grouped album submission; single-image / text / multi-part stay as before.
 */

import { afterEach, expect, it, vi } from "vitest";

import { collectionStats, collectorDefinition, draftCandidate } from "../services/collectors/base.js";
import { BaseNewsCollector, albumImagesOf } from "../services/collectors/runner.js";
import * as moderationModule from "../services/moderation.js";
import { needsExternalVideoDownload } from "../services/publisher.js";

const DEFN = collectorDefinition({
  collector_id: "bluesky",
  source_type: "bluesky",
  title_key: "collectors.bluesky.title",
  button_key: "buttons.collector_bluesky",
});

afterEach(() => {
  vi.restoreAllMocks();
});

function candidateWith(images) {
  return draftCandidate({
    source_id: "s1",
    source_url: "https://example.com/p",
    title: "t",
    body_text: "b",
    source_name: "MR",
    username: "u",
    original_text: "o",
    has_media: images.length > 0,
    media_url: images.length ? images[0] : null,
    media_type: images.length ? "photo" : "none",
    additional_media_urls: images.length > 1 ? images.slice(1) : null,
  });
}

function videoCandidate() {
  return draftCandidate({
    source_id: "v1",
    source_url: "https://bsky.app/profile/x/post/1",
    title: "t",
    body_text: "b",
    source_name: "Bluesky",
    username: "u",
    original_text: "o",
    has_media: true,
    media_url: "https://pds.bsky.network/xrpc/com.atproto.sync.getBlob?did=d&cid=c",
    media_type: "video",
    additional_media_urls: null,
  });
}

class FakeDb {
  constructor() {
    this.album = null;
    this.single = null;
    this.marked = [];
  }

  async createAlbumSubmission(kwargs) {
    this.album = kwargs;
    return 1;
  }

  async createAiNewsSubmission(kwargs) {
    this.single = kwargs;
    return 2;
  }

  async markSourceSeen(kwargs) {
    this.marked.push(kwargs);
  }
}

class TestCollector extends BaseNewsCollector {
  static definition = DEFN;

  async fetchListing() {
    return [];
  }

  async parseEntry() {
    throw new Error("unused");
  }

  missingGeminiWarning() {
    return "";
  }
}

async function run(candidate, parts) {
  const db = new FakeDb();
  const collector = new TestCollector({ config: { article_timezone: "Europe/Kyiv" }, db, bot: null });
  const sent = [];
  vi.spyOn(moderationModule, "sendSubmissionToModeration").mockImplementation(async (_bot, _config, _db, id) => {
    sent.push(id);
  });
  const generator = {
    async generateDraftPackage() {
      return { draft_parts: parts, tags: ["t"] };
    },
  };
  const stats = collectionStats({ collector_id: "bluesky", source_type: "bluesky", source_title: "x" });
  await collector.createModerationSubmissions(candidate, generator, stats);
  return { db, sent };
}

it("stores a video candidate as a video part", async () => {
  // Both the moderation preview and the publisher route on message_type, and the
  // native-video download path is keyed on "video". Stored as "photo" (the old
  // behaviour) a Bluesky MP4 went to sendPhoto and could only degrade to text.
  const { db } = await run(videoCandidate(), ["draft"]);

  expect(db.album).toBeNull();
  expect(db.single).not.toBeNull();
  expect(db.single.message_type).toBe("video");
  expect(db.single.media_type).toBe("video");
});

it("routes the stored video part to the native download path", async () => {
  const { db } = await run(videoCandidate(), ["draft"]);
  const part = {
    message_type: db.single.message_type,
    source_type: db.single.source_type,
    media_url: db.single.media_url,
    file_id: null,
  };

  expect(needsExternalVideoDownload(part)).toBe(true);
});

it("still stores a photo candidate as a photo part", async () => {
  const { db } = await run(candidateWith(["https://cdn.bsky.app/a.jpg"]), ["draft"]);
  expect(db.single.message_type).toBe("photo");
});

it("still stores a text candidate as text", async () => {
  const { db } = await run(candidateWith([]), ["draft"]);
  expect(db.single.message_type).toBe("text");
});

it("creates an album for two photos in a single part", async () => {
  const { db, sent } = await run(candidateWith(["a", "b", "c"]), ["caption"]);

  expect(db.album).not.toBeNull();
  expect(db.single).toBeNull();
  expect(db.album.image_urls).toEqual(["a", "b", "c"]);
  expect(db.album.caption).toBe("caption");
  expect(sent).toEqual([1]);
  expect(db.marked.length).toBeGreaterThan(0); // marked seen after a successful send
});

it("uses a normal submission for a single photo", async () => {
  const { db, sent } = await run(candidateWith(["a"]), ["caption"]);
  expect(db.single).not.toBeNull();
  expect(db.album).toBeNull();
  expect(sent).toEqual([2]);
});

it("uses a normal submission for text only", async () => {
  const { db } = await run(candidateWith([]), ["caption"]);
  expect(db.single).not.toBeNull();
  expect(db.album).toBeNull();
});

it("does not album a multi-part draft", async () => {
  // A multi-part article keeps the per-part image mapping, never an album.
  const { db } = await run(candidateWith(["a", "b"]), ["part1", "part2"]);
  expect(db.single).not.toBeNull();
  expect(db.album).toBeNull();
});

it("collects the album images", () => {
  expect(albumImagesOf(candidateWith(["a", "b"]))).toEqual(["a", "b"]);
  expect(albumImagesOf(candidateWith(["a"]))).toEqual(["a"]);
  expect(albumImagesOf(candidateWith([]))).toEqual([]);
});
