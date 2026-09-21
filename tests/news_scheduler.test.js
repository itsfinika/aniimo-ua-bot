/**
 * Tests for the news scheduler's cadence: it checks immediately on startup and
 * keeps a fixed period regardless of how long a run takes.
 */

import { expect, it } from "vitest";

import { newsScheduler } from "../main.js";

/** Breaks out of the scheduler's infinite loop inside a test. */
class Stop extends Error {}

/**
 * Drive the scheduler until it has slept `runDurations.length` times.
 * Returns the number of collector runs and the sleep durations it asked for.
 */
async function runScheduler({ intervalMinutes, runDurations }) {
  const sleeps = [];
  const runs = [];
  const clock = { now: 1000.0 };

  const runCollectors = async () => {
    // Each run consumes its scripted duration from the fake clock.
    clock.now += runDurations[runs.length] * 1000;
    runs.push(1);
    return [];
  };

  const sleep = async (seconds) => {
    sleeps.push(seconds);
    if (sleeps.length >= runDurations.length) {
      throw new Stop();
    }
  };

  const config = { news_check_interval_minutes: intervalMinutes };
  try {
    await newsScheduler(null, config, null, undefined, { now: () => clock.now, sleep, runCollectors });
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }
  return { runs: runs.length, sleeps };
}

it("checks before any sleep", async () => {
  // A restart used to leave the bot blind for a whole interval — which is exactly
  // when it is most likely to have missed something.
  const { runs, sleeps } = await runScheduler({ intervalMinutes: 5, runDurations: [0.0] });

  expect(runs).toBe(1);
  expect(sleeps).toHaveLength(1);
});

it("measures the period from the start of a run", async () => {
  // A 40-second run must be followed by a 260-second wait, not a 300-second one,
  // so the schedule cannot drift away from the top of the hour.
  const { sleeps } = await runScheduler({ intervalMinutes: 5, runDurations: [40.0, 0.0] });

  expect(sleeps[0]).toBe(300.0 - 40.0);
  expect(sleeps[1]).toBe(300.0);
});

it("still yields when a run overruns the interval", async () => {
  // Never a zero/negative sleep: the loop must give the runtime a chance to do
  // other work even when a tick overruns its own period.
  const { sleeps } = await runScheduler({ intervalMinutes: 1, runDurations: [900.0] });

  expect(sleeps).toEqual([1.0]);
});

it("keeps polling after a failing run", async () => {
  const sleeps = [];
  const calls = [];

  const runCollectors = async () => {
    calls.push(1);
    throw new Error("source exploded");
  };
  const sleep = async (seconds) => {
    sleeps.push(seconds);
    if (sleeps.length >= 2) {
      throw new Stop();
    }
  };

  try {
    await newsScheduler(null, { news_check_interval_minutes: 5 }, null, undefined, {
      now: () => 0,
      sleep,
      runCollectors,
    });
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
  }

  expect(calls).toHaveLength(2); // kept polling after the failure
  expect(sleeps).toEqual([300.0, 300.0]);
});
