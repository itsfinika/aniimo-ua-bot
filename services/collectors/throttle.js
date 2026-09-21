/**
 * Spacing for moderation-queue sends within one collection tick.
 *
 * A scheduler tick can find several new items across all sources at once and,
 * left unthrottled, fire them into the admin chat back-to-back in a second or
 * two. That both reads as spam and risks Telegram's per-chat flood limit.
 * SubmissionThrottle enforces a MINIMUM gap between consecutive sends so a burst
 * trickles in instead.
 */

import { performance } from "node:perf_hooks";

import { sleep } from "../pyutils.js";

function defaultClock() {
  // Monotonic time; never goes backwards, so an NTP step cannot skip a wait.
  return performance.now() / 1000;
}

export class SubmissionThrottle {
  /**
   * Enforces a minimum interval between successive `wait()` calls.
   *
   * The first call (and any call made after the interval has already elapsed)
   * returns immediately, so a single item is never delayed — only a rapid
   * follow-up sleeps out the time still remaining in the window. A zero or
   * negative interval disables throttling entirely. One instance is shared
   * across every collector in a tick, so the gap is honoured across sources too.
   *
   * `clock`/`sleep` are injectable purely so the timing can be unit-tested
   * without real waits; production uses the monotonic clock and a real sleep.
   */
  constructor(minIntervalSeconds, { clock = null, sleep: sleepFn = null } = {}) {
    this.min_interval_seconds = Math.max(0, Number(minIntervalSeconds));
    this._clock = clock ?? defaultClock;
    this._sleep = sleepFn ?? sleep;
    this._lastSendAt = null;
  }

  async wait() {
    if (this.min_interval_seconds <= 0) {
      return;
    }

    if (this._lastSendAt !== null) {
      const remaining = this.min_interval_seconds - (this._clock() - this._lastSendAt);
      if (remaining > 0) {
        await this._sleep(remaining);
      }
    }

    // Stamp the moment the caller is cleared to send (after any wait), so the
    // next gap is measured from this send, not from when we started waiting.
    this._lastSendAt = this._clock();
  }
}
