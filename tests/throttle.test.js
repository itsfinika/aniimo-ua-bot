/**
 * Tests for the moderation-queue send throttle and its wiring into the collector
 * orchestration (the gap that stops a tick dumping many items at once).
 */

import { describe, expect, it, vi } from "vitest";

import { collectionStats, collectorDefinition, draftCandidate } from "../services/collectors/base.js";
import { BaseNewsCollector } from "../services/collectors/runner.js";
import { SubmissionThrottle } from "../services/collectors/throttle.js";
import * as moderationModule from "../services/moderation.js";

/** Returns the supplied times in order, holding the last value afterwards. */
function fakeClock(...times) {
  let index = 0;
  return () => {
    const value = times[Math.min(index, times.length - 1)];
    index += 1;
    return value;
  };
}

function makeThrottle(interval, ...times) {
  const slept = [];
  const throttle = new SubmissionThrottle(interval, {
    clock: fakeClock(...times),
    sleep: async (seconds) => {
      slept.push(seconds);
    },
  });
  return { throttle, slept };
}

describe("SubmissionThrottle", () => {
  it("never sleeps with a zero interval", async () => {
    const { throttle, slept } = makeThrottle(0, 0.0, 0.0, 0.0, 0.0);
    await throttle.wait();
    await throttle.wait();
    expect(slept).toEqual([]);
  });

  it("does not delay the first send", async () => {
    const { throttle, slept } = makeThrottle(5, 0.0, 0.0);
    await throttle.wait();
    expect(slept).toEqual([]);
  });

  it("makes a rapid second send wait the full interval", async () => {
    // Both sends happen at t=0 -> the second waits the whole window. Clock reads:
    // first wait stamps (0.0); second wait measures (0.0) then re-stamps (0.0).
    const { throttle, slept } = makeThrottle(5, 0.0, 0.0, 0.0);
    await throttle.wait();
    await throttle.wait();
    expect(slept).toEqual([5]);
  });

  it("waits only the remaining time", async () => {
    // First send stamps t=0; second is measured at t=2 -> only 3s of a 5s window left.
    const { throttle, slept } = makeThrottle(5, 0.0, 2.0, 2.0);
    await throttle.wait();
    await throttle.wait();
    expect(slept).toEqual([3]);
  });

  it("does not sleep once the window has elapsed", async () => {
    // Second send measured at t=10, well past the 5s window -> no wait.
    const { throttle, slept } = makeThrottle(5, 0.0, 10.0, 10.0);
    await throttle.wait();
    await throttle.wait();
    expect(slept).toEqual([]);
  });
});

// --- wiring: the runner waits on the throttle BEFORE each moderation send -------

const DEFINITION = collectorDefinition({
  collector_id: "t",
  source_type: "t",
  title_key: "collectors.bluesky.title",
  button_key: "buttons.collector_bluesky",
});

const CANDIDATE = draftCandidate({
  source_id: "s1",
  source_url: "https://example.com/1",
  title: "A perfectly fine news title",
  body_text: "Some body text without any times in it.",
  source_name: "Test Source",
  username: "tester",
  original_text: "original",
  article_date: "2026-06-16",
  article_date_display: "16 червня 2026",
});

class FakeDb {
  async createAiNewsSubmission() {
    return 42;
  }

  async createAlbumSubmission() {
    return 42;
  }

  async markSourceSeen() {
    return undefined;
  }
}

class TestCollector extends BaseNewsCollector {
  static definition = DEFINITION;

  async fetchListing() {
    return [];
  }

  async parseEntry() {
    return CANDIDATE;
  }

  missingGeminiWarning() {
    return "no gemini";
  }
}

function stubGenerator() {
  return {
    async generateDraftPackage() {
      return { draft_parts: ["draft text"], tags: [] };
    },
  };
}

it("waits on the throttle before sending to moderation", async () => {
  const events = [];
  vi.spyOn(moderationModule, "sendSubmissionToModeration").mockImplementation(async () => {
    events.push("send");
  });

  const collector = new TestCollector({
    config: { article_timezone: "Europe/Kyiv" },
    db: new FakeDb(),
    bot: null,
  });
  collector.throttle = {
    async wait() {
      events.push("wait");
    },
  };
  const stats = collectionStats({ collector_id: "t", source_type: "t", source_title: "Test" });

  const sent = await collector.createModerationSubmissions(CANDIDATE, stubGenerator(), stats);

  expect(sent).toBe(true);
  expect(events).toEqual(["wait", "send"]); // the gap is enforced BEFORE the send
  expect(stats.sent_to_moderation).toBe(1);
});

// --- end-to-end: a multi-item tick spaces every send AND still sends them all ---

/** A controllable monotonic clock; sleeps and item prep advance it explicitly. */
class VirtualClock {
  constructor() {
    this.t = 0.0;
  }

  now() {
    return this.t;
  }

  advance(dt) {
    this.t += dt;
  }
}

async function driveTick({ interval, prep, itemCount }) {
  const clock = new VirtualClock();
  const slept = [];
  const sendTimes = [];

  vi.spyOn(moderationModule, "sendSubmissionToModeration").mockImplementation(async () => {
    sendTimes.push(clock.now());
  });

  const throttle = new SubmissionThrottle(interval, {
    clock: () => clock.now(),
    sleep: async (seconds) => {
      slept.push(seconds);
      clock.advance(seconds);
    },
  });
  const config = { article_timezone: "Europe/Kyiv" };
  const collectorA = new TestCollector({ config, db: new FakeDb(), bot: null });
  const collectorB = new TestCollector({ config, db: new FakeDb(), bot: null });
  collectorA.throttle = throttle;
  collectorB.throttle = throttle; // shared, exactly like runAllCollectors
  // A draft generator whose "Gemini call" takes `prep` seconds of clock time.
  const generator = {
    async generateDraftPackage() {
      clock.advance(prep);
      return { draft_parts: ["draft text"], tags: [] };
    },
  };
  const stats = collectionStats({ collector_id: "t", source_type: "t", source_title: "Test" });

  // First two items on collector A, the rest on collector B — proving the gap
  // carries ACROSS sources within a tick, not just within one collector.
  for (let index = 0; index < itemCount; index += 1) {
    const collector = index < 2 ? collectorA : collectorB;
    await collector.createModerationSubmissions(CANDIDATE, generator, stats);
  }

  return { sendTimes, slept, stats };
}

function gapsOf(times) {
  return times.slice(1).map((value, index) => Number((value - times[index]).toFixed(6)));
}

it("spaces fast items by the interval", async () => {
  // The original complaint: cheap items that would otherwise dump at once.
  const { sendTimes, slept, stats } = await driveTick({ interval: 5, prep: 0.5, itemCount: 4 });

  expect(stats.sent_to_moderation).toBe(4); // ALL items still get through
  expect(sendTimes).toHaveLength(4);
  expect(gapsOf(sendTimes)).toEqual([5, 5, 5]); // every consecutive send is one interval apart
  expect(slept).toEqual([4.5, 4.5, 4.5]); // first send paid nothing; the rest waited the remainder
});

it("adds no extra delay to already-slow items", async () => {
  // When each Gemini call already exceeds the interval, sends are naturally >5s
  // apart, so the throttle correctly adds nothing — and there is no burst anyway.
  const { sendTimes, slept, stats } = await driveTick({ interval: 5, prep: 6.0, itemCount: 3 });

  expect(stats.sent_to_moderation).toBe(3);
  expect(gapsOf(sendTimes)).toEqual([6, 6]); // already wider than the interval
  expect(slept).toEqual([]); // no artificial delay added
  expect(gapsOf(sendTimes).every((gap) => gap >= 5)).toBe(true); // never a burst
});
