/**
 * Tests for the weekly rubric's retries: a once-a-week job that meets an
 * overloaded Gemini must come back minutes later, not next week.
 */

import { afterEach, expect, it, vi } from "vitest";

import { __testing } from "../services/collectors/wiki_aniimo/collector.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const { runWeeklyWithRetries, WEEKLY_RETRY_ATTEMPTS, WEEKLY_RETRY_DELAY_SECONDS } = __testing;

/** Drive the loop with a scripted sequence of run outcomes. */
function harness(outcomes) {
  const sleeps = [];
  const runs = [];
  const runOnce = vi.fn(async () => {
    const outcome = outcomes[runs.length];
    runs.push(outcome);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { runs, sleeps, runOnce, sleep: async (seconds) => void sleeps.push(seconds) };
}

it("stops as soon as a post is queued", async () => {
  const h = harness([true]);

  await runWeeklyWithRetries(null, null, null, null, { runOnce: h.runOnce, sleep: h.sleep });

  expect(h.runOnce).toHaveBeenCalledTimes(1);
  expect(h.sleeps).toEqual([]);
});

it("retries after an empty run and stops on the later success", async () => {
  const h = harness([false, true]);

  await runWeeklyWithRetries(null, null, null, null, { runOnce: h.runOnce, sleep: h.sleep });

  expect(h.runOnce).toHaveBeenCalledTimes(2);
  expect(h.sleeps).toEqual([WEEKLY_RETRY_DELAY_SECONDS]);
});

it("retries after a thrown error just as after an empty run", async () => {
  const h = harness([new Error("Gemini draft generation failed"), true]);

  await runWeeklyWithRetries(null, null, null, null, { runOnce: h.runOnce, sleep: h.sleep });

  expect(h.runOnce).toHaveBeenCalledTimes(2);
  expect(h.sleeps).toEqual([WEEKLY_RETRY_DELAY_SECONDS]);
});

it("gives up after the last attempt without sleeping again", async () => {
  const h = harness(Array.from({ length: WEEKLY_RETRY_ATTEMPTS }, () => false));

  await runWeeklyWithRetries(null, null, null, null, { runOnce: h.runOnce, sleep: h.sleep });

  expect(h.runOnce).toHaveBeenCalledTimes(WEEKLY_RETRY_ATTEMPTS);
  // One wait between attempts, none after the final one.
  expect(h.sleeps).toHaveLength(WEEKLY_RETRY_ATTEMPTS - 1);
});
