/**
 * Minimal logging façade shaped like Python's `logging`.
 *
 * The bot's production logs are read through `docker compose logs`, and the
 * deploy playbook, the grep habits and the README all assume the line format
 * `basicConfig` produced:
 *
 *     2026-08-16 14:42:32,123 INFO [services.publisher] Published submission 41
 *
 * Bare `console.log` would drop the timestamp, the level and — most usefully
 * when something misbehaves — the module name. So the format is reproduced
 * here, along with the level threshold (INFO by default, DEBUG suppressed) and
 * `logger.exception(...)`, which logs at ERROR and appends the stack.
 */

import process from "node:process";

const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };

let threshold = LEVELS.INFO;

/** The analogue of `logging.basicConfig(level=...)`, called once from main. */
export function setLogLevel(levelName) {
  const level = LEVELS[String(levelName).toUpperCase()];
  if (level !== undefined) {
    threshold = level;
  }
}

export function getLogger(name) {
  return {
    debug: (...args) => emit(LEVELS.DEBUG, "DEBUG", name, args),
    info: (...args) => emit(LEVELS.INFO, "INFO", name, args),
    warning: (...args) => emit(LEVELS.WARNING, "WARNING", name, args),
    error: (...args) => emit(LEVELS.ERROR, "ERROR", name, args),
    critical: (...args) => emit(LEVELS.CRITICAL, "CRITICAL", name, args),
    /**
     * `logging.exception` — ERROR plus the traceback. Pass the caught error as
     * the last argument, exactly as `exc_info` did implicitly in Python.
     */
    exception: (message, error) => {
      const stack = error instanceof Error ? `\n${error.stack}` : error === undefined ? "" : `\n${String(error)}`;
      emit(LEVELS.ERROR, "ERROR", name, [`${message}${stack}`]);
    },
  };
}

function emit(level, levelName, name, args) {
  if (level < threshold) return;
  const line = `${timestamp()} ${levelName} [${name}] ${args.map(render).join(" ")}`;
  const stream = level >= LEVELS.WARNING ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

function render(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function timestamp() {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())},${pad(now.getMilliseconds(), 3)}`
  );
}
