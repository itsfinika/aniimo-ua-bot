/**
 * Every prompt file must render with the exact keys its caller passes.
 *
 * The prompts go through `formatTemplate`, which reproduces Python's
 * `str.format`: `{` and `}` are structural, and a literal brace has to be
 * doubled. A JSON example written as {"duplicate": true} instead of
 * {{"duplicate": true}} is therefore read as a replacement field named
 * `"duplicate": true`, and rendering throws "Missing format key" every time.
 *
 * That failure is close to invisible in production — the caller catches it and
 * falls back — so the feature would be silently dead rather than broken. These
 * tests render each template exactly the way the code does, which is the only
 * check that would have caught it.
 */

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEDUP_PROMPT_PATH,
  PROMPT_PATH,
  SHORT_FORM_PROMPT_PATH,
  STYLE_PROMPT_PATH,
  WIKI_CREATURE_PROMPT_PATH,
} from "../services/gemini.js";
import { formatTemplate } from "../services/pyutils.js";

// The key sets buildPrompt / buildDedupPrompt actually pass.
const DRAFT_KEYS = {
  style_prompt: "s",
  source_type: "s",
  source_name: "s",
  title: "s",
  article_url: "s",
  article_type_label: "s",
  date_line: "s",
  source_line: "s",
  hashtag_line: "s",
  datetime_notes: "s",
  body_text: "s",
  rumor_notice: "s",
};

const TEMPLATES = [
  ["gemini_news_uk.md", PROMPT_PATH, DRAFT_KEYS],
  ["gemini_shortform_uk.md", SHORT_FORM_PROMPT_PATH, DRAFT_KEYS],
  // The creature prompt is rendered through the same buildPrompt call as the
  // news prompts, so it must accept the same key set.
  ["gemini_wiki_creature_uk.md", WIKI_CREATURE_PROMPT_PATH, DRAFT_KEYS],
  ["gemini_dedup_uk.md", DEDUP_PROMPT_PATH, { new_title: "t", existing_titles: "1. a" }],
];

// Python's text mode normalised these; loadCachedText now does the same.
const read = (file) => fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n").trim();

it("points the wiki rubric at the creature prompt", () => {
  expect(path.basename(WIKI_CREATURE_PROMPT_PATH)).toBe("gemini_wiki_creature_uk.md");
  expect(path.dirname(WIKI_CREATURE_PROMPT_PATH)).toBe(path.dirname(PROMPT_PATH));
});

it("ships no retired prompt files", () => {
  // The trivia "pick" and "fact" prompts went with the old wiki collector; a
  // leftover copy would be dead weight that looks like it is used.
  const promptsDir = path.dirname(PROMPT_PATH);
  expect(fs.existsSync(path.join(promptsDir, "gemini_wiki_fact_uk.md"))).toBe(false);
  expect(fs.existsSync(path.join(promptsDir, "gemini_wiki_pick_uk.md"))).toBe(false);
});

// Skip a template that is not on disk yet rather than fail on it: the creature
// prompt ships separately from the code that names it.
describe.each(TEMPLATES.filter(([, file]) => fs.existsSync(file)))("%s", (name, file, keys) => {
  it("renders with the keys its caller passes", () => {
    expect(() => formatTemplate(read(file), keys)).not.toThrow();
  });

  it("leaves no unreplaced placeholder behind", () => {
    const rendered = formatTemplate(read(file), keys);
    // A surviving single brace means a literal brace was not doubled.
    expect(rendered).not.toMatch(/\{[a-z_][a-z0-9_]*\}/);
  });
});

it("keeps the JSON example escaped so it survives rendering", () => {
  // The prompt that asks for a JSON reply must still SHOW real JSON braces to
  // the model after rendering - that is the whole point of doubling them.
  expect(formatTemplate(read(DEDUP_PROMPT_PATH), { new_title: "t", existing_titles: "1. a" })).toContain(
    '{"duplicate":',
  );
});

it("has no style prompt placeholder left unfilled", () => {
  // The style prompt is inlined into the news prompt, not formatted itself.
  expect(read(STYLE_PROMPT_PATH)).not.toContain("{");
});
