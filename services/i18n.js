import fs from "node:fs";
import path from "node:path";

import { formatTemplate } from "./pyutils.js";

export const DEFAULT_LOCALE = "uk";
export const LOCALES_DIR = path.resolve(import.meta.dirname, "..", "locales");

const localeCache = new Map();

export function t(key, values) {
  const value = lookup(key);
  if (typeof value !== "string") {
    throw new Error(`Translation key does not point to a string: ${key}`);
  }

  return values !== undefined && values !== null ? formatTemplate(value, values) : value;
}

export function tOptional(key, fallback) {
  let value;
  try {
    value = lookup(key);
  } catch {
    return fallback;
  }

  return typeof value === "string" ? value : fallback;
}

function lookup(key) {
  let current = loadLocale(DEFAULT_LOCALE);
  for (const part of String(key).split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current) || !(part in current)) {
      throw new Error(`Missing translation key: ${key}`);
    }
    current = current[part];
  }

  return current;
}

function loadLocale(locale) {
  const cached = localeCache.get(locale);
  if (cached !== undefined) return cached;

  const file = path.join(LOCALES_DIR, `${locale}.json`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Locale file must contain a JSON object: ${file}`);
  }

  localeCache.set(locale, data);
  return data;
}
