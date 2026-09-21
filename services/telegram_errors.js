/**
 * Telegram error classification.
 *
 * aiogram exposed one exception hierarchy (`TelegramAPIError` with
 * `TelegramBadRequest` / `TelegramForbiddenError` / `TelegramRetryAfter` /
 * `TelegramNetworkError` beneath it) that the whole codebase caught by type.
 * grammY splits the same failures across two unrelated classes — `GrammyError`
 * for anything Telegram answered with, `HttpError` for anything that never got
 * an answer — plus the plain `AbortError` a request timeout raises.
 *
 * These predicates re-create the old categories so the ported `catch` blocks
 * keep their exact meaning, including the "re-raise what we did not expect"
 * behaviour that a bare `catch` would otherwise swallow.
 */

import { GrammyError, HttpError } from "grammy";

/** aiogram's `TelegramAPIError` — any failure of a Telegram API call. */
export function isTelegramApiError(error) {
  return error instanceof GrammyError || error instanceof HttpError;
}

/** aiogram's `TelegramBadRequest`. */
export function isTelegramBadRequest(error) {
  return error instanceof GrammyError && error.error_code === 400;
}

/** aiogram's `TelegramForbiddenError`. */
export function isTelegramForbidden(error) {
  return error instanceof GrammyError && error.error_code === 403;
}

/** aiogram's `TelegramNetworkError` — the request never reached Telegram. */
export function isTelegramNetworkError(error) {
  return error instanceof HttpError;
}

/**
 * A request that timed out or was aborted. `AbortSignal.timeout()` raises a
 * `TimeoutError` DOMException; some transports surface `ETIMEDOUT` instead.
 */
export function isTimeoutError(error) {
  if (!error) return false;
  const name = error.name ?? "";
  if (name === "TimeoutError" || name === "AbortError") return true;
  const code = error.code ?? "";
  return code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNABORTED";
}

/**
 * The union the send/publish paths caught as
 * `(TelegramAPIError, TimeoutError, ClientOSError)`.
 */
export function isTelegramSendFailure(error) {
  return isTelegramApiError(error) || isTimeoutError(error);
}

/**
 * `TelegramRetryAfter.retry_after`, or null when this is not a flood-wait.
 *
 * Telegram reports it as `parameters.retry_after` on a 429.
 */
export function retryAfterSeconds(error) {
  if (!(error instanceof GrammyError) || error.error_code !== 429) {
    return null;
  }
  const seconds = error.parameters?.retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null;
}

/** The errors `services/telegram_retry` is willing to retry. */
export function isRetryableSendError(error) {
  return isTelegramNetworkError(error) || isTimeoutError(error) || retryAfterSeconds(error) !== null;
}

/**
 * The text the Python code matched substrings against via `str(exc).lower()`
 * ("message is not modified", "query is too old", "not enough rights", ...).
 *
 * grammY's `description` holds Telegram's own wording; `message` wraps it with
 * the method name. Both are included so a match cannot be lost to either shape.
 */
export function telegramErrorText(error) {
  if (!error) return "";
  const description = error.description ?? "";
  const message = error.message ?? "";
  return `${description} ${message}`.trim() || String(error);
}
