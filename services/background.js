/**
 * Cancellable background tasks.
 *
 * The Python schedulers were `asyncio.Task`s: `main` created them, and its
 * `finally` block cancelled each one and awaited it while suppressing
 * `CancelledError`. JavaScript promises cannot be cancelled, so the same shape
 * is rebuilt on `AbortController`: every loop sleeps through
 * {@link cancellableSleep}, which unblocks the moment the task is cancelled, and
 * {@link createTask} exposes the `cancel()` / `done` pair `main` needs to shut
 * down cleanly instead of leaving a timer holding the process open.
 */

import { getLogger } from "./logger.js";

const logger = getLogger("services.background");

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Sleep for `seconds`, unless the task is cancelled first — in which case the
 * promise rejects with {@link CancelledError}, ending the loop.
 */
export function cancellableSleep(seconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, seconds) * 1000);
    // Do not hold the event loop open just for a scheduler that is idling.
    timer.unref?.();
    function onAbort() {
      clearTimeout(timer);
      reject(new CancelledError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Start `run(signal)` as a named background task.
 *
 * Returns `{name, cancel, done}`. `cancel()` aborts the signal; awaiting `done`
 * resolves once the loop has unwound, with cancellation swallowed exactly as the
 * Python `with suppress(asyncio.CancelledError)` block did.
 */
export function createTask(name, run) {
  const controller = new AbortController();
  const done = (async () => {
    try {
      await run(controller.signal);
    } catch (error) {
      if (error instanceof CancelledError || controller.signal.aborted) {
        return;
      }
      logger.exception(`Background task ${name} stopped with an error`, error);
    }
  })();

  return {
    name,
    cancel() {
      controller.abort();
    },
    done,
  };
}

/** Cancel every task and wait for it to unwind; nulls are ignored. */
export async function cancelTasks(tasks) {
  for (const task of tasks) {
    task?.cancel();
  }
  for (const task of tasks) {
    if (task) {
      await task.done;
    }
  }
}
