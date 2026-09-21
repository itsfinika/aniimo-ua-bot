import { getLogger } from "./logger.js";
import { isRetryableSendError, retryAfterSeconds } from "./telegram_errors.js";
import { errorText, sleep } from "./pyutils.js";

const logger = getLogger("services.telegram_retry");

export const TELEGRAM_SEND_RETRIES = 3;
export const TELEGRAM_REQUEST_TIMEOUT = 30;
export const TELEGRAM_INTER_MESSAGE_DELAY_SECONDS = 0.35;
export const TELEGRAM_MAX_BACKOFF_SECONDS = 30;

/**
 * Call a Telegram send method, retrying the transient failures.
 *
 * The Python version took the bound method plus its keyword arguments and
 * injected `request_timeout`. grammY has no per-call timeout keyword, but every
 * API method accepts an `AbortSignal` as its final argument — so the call is
 * passed as a callback that receives a fresh signal per attempt. That also keeps
 * the abort timer from carrying over into a retry, which a single shared signal
 * would do (the second attempt would start already expired).
 *
 * @param {(signal: AbortSignal) => Promise<any>} call
 * @param {{label: string, attempts?: number, requestTimeout?: number}} options
 */
export async function sendWithRetries(call, { label, attempts = TELEGRAM_SEND_RETRIES, requestTimeout = TELEGRAM_REQUEST_TIMEOUT } = {}) {
  let delay = 1.0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await call(AbortSignal.timeout(requestTimeout * 1000));
    } catch (error) {
      if (!isRetryableSendError(error)) {
        throw error;
      }
      if (attempt >= attempts) {
        logger.exception(`Telegram send failed after ${attempts} attempts: ${label}`, error);
        throw error;
      }

      const sleepFor = retryDelay(error, delay);
      logger.warning(
        `Telegram send failed for ${label} on attempt ${attempt}/${attempts}: ${errorText(error)}. ` +
          `Retrying in ${sleepFor.toFixed(1)}s.`,
      );
      await sleep(sleepFor);
      delay = Math.min(delay * 2, 4.0);
    }
  }

  throw new Error("unreachable");
}

export async function delayBetweenTelegramSends() {
  await sleep(TELEGRAM_INTER_MESSAGE_DELAY_SECONDS);
}

function retryDelay(error, fallbackDelay) {
  const retryAfter = retryAfterSeconds(error);
  if (retryAfter !== null) {
    return Math.min(Math.max(retryAfter, fallbackDelay), TELEGRAM_MAX_BACKOFF_SECONDS);
  }

  return fallbackDelay;
}
