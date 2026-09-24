/**
 * Regression test for the repost loop: a moderation send that fails after the
 * draft already reached the chat must not make the collector draft the same
 * article again on the next tick.
 */

import { expect, it, vi } from "vitest";

import { collectionStats, collectorDefinition, draftCandidate } from "../services/collectors/base.js";
import { BaseNewsCollector } from "../services/collectors/runner.js";

const DEFINITION = collectorDefinition({
  collector_id: "test_source",
  source_type: "test_source",
  title_key: "collectors.bluesky.title",
  button_key: "buttons.collector_bluesky",
});

const CANDIDATE = draftCandidate({
  source_id: "s1",
  source_url: "https://example.com/1",
  title: "New shiny trailer",
  body_text: "body",
  source_name: "Test Source",
  username: "tester",
  original_text: "original",
  article_date: "2026-06-16",
});

class FakeDb {
  constructor() {
    this.marked = [];
  }
  async createAiNewsSubmission() {
    return 1;
  }
  async isSourceSeen() {
    return false;
  }
  async markSourceSeen(kwargs) {
    this.marked.push(kwargs);
  }
}

class StubCollector extends BaseNewsCollector {
  static definition = DEFINITION;
  constructor({ db }) {
    super({ config: { article_timezone: "Europe/Kyiv" }, db, bot: null });
  }
  missingGeminiWarning() {
    return "no gemini";
  }
}

function generator() {
  return {
    generateDraftPackage: async () => ({ draft_parts: ["draft"], tags: ["tag"] }),
  };
}

it("marks the article seen even when the moderation send fails", async () => {
  // The send is what used to fail halfway: the draft text landed in the chat,
  // the card did not, and because "seen" was only written afterwards the very
  // same article was drafted and posted again on every following tick.
  const moderation = await import("../services/moderation.js");
  vi.spyOn(moderation, "sendSubmissionToModeration").mockRejectedValue(new Error("Bad Request: message is too long"));

  const db = new FakeDb();
  const collector = new StubCollector({ db });
  const stats = collectionStats({ collector_id: "test_source", source_type: "test_source", source_title: "Test" });

  const ok = await collector.createModerationSubmissions(CANDIDATE, generator(), stats);

  expect(ok).toBe(false);
  expect(stats.failed).toBe(1);
  expect(stats.sent_to_moderation).toBe(0);
  // The point of the fix: the article is recorded, so the next tick skips it.
  expect(db.marked).toHaveLength(1);
  expect(db.marked[0].source_id).toBe("s1");
  expect(db.marked[0].outcome).toBe("queued");
});
