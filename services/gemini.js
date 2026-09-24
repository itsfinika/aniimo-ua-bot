import fs from "node:fs";
import path from "node:path";

import { t } from "./i18n.js";
import { getLogger } from "./logger.js";
import { SOURCE_ATTRIBUTIONS, allowsPublicSourceAttribution, stripPublicSourceAttribution } from "./post_footer.js";
import {
  charLength,
  errorText,
  escapeRegExp,
  formatTemplate,
  partition,
  rfindChars,
  rstrip,
  sliceChars,
  sleep,
  strip,
  WORD,
} from "./pyutils.js";

const logger = getLogger("services.gemini");

// Gemini's free tier throttles by requests-per-minute; a burst (e.g. several
// dedup + draft calls in one scheduler tick) trips a 429 that is transient. Retry
// it a few times with a bounded backoff so one throttle doesn't drop a draft.
// The free tier answers 503 «This model is currently experiencing high demand»
// in bursts that outlast a couple of quick retries, and a lost draft costs a
// post. Five attempts with up to 45 s between them wait out roughly two
// minutes, which a background collector does not feel at all.
const GEMINI_MAX_ATTEMPTS = 5;
const GEMINI_MAX_RETRY_DELAY_SECONDS = 45.0;

const PROMPTS_DIR = path.resolve(import.meta.dirname, "..", "prompts");
export const PROMPT_PATH = path.join(PROMPTS_DIR, "gemini_news_uk.md");
export const SHORT_FORM_PROMPT_PATH = path.join(PROMPTS_DIR, "gemini_shortform_uk.md");
export const STYLE_PROMPT_PATH = path.join(PROMPTS_DIR, "official_news_style.md");
export const DEDUP_PROMPT_PATH = path.join(PROMPTS_DIR, "gemini_dedup_uk.md");
export const WIKI_CREATURE_PROMPT_PATH = path.join(PROMPTS_DIR, "gemini_wiki_creature_uk.md");

export const POST_SEPARATOR = "---POST---";
export const TAGS_SEPARATOR = "---TAGS---";
// The site and the app's own Steam announcement feed both carry first-party
// statements, so both get the long-form article prompt.
export const OFFICIAL_SOURCE_TYPES = new Set(["official_aniimo", "steam"]);
// Sources whose items are unofficial leaks/datamines: the short-form draft must
// frame them as rumours (чутки), never as confirmed/official statements.
export const RUMOR_SOURCE_TYPES = new Set(["reddit"]);
// Sources that get the dedicated "Аніімо тижня" creature-spotlight prompt (turn a
// wiki fact sheet into a post) instead of the social short-form prompt.
export const WIKI_SOURCE_TYPES = new Set(["wiki_aniimo"]);
// Just the channel tag. «#Офіційно» used to mark site/Steam posts, but every
// post here is sourced from the developers anyway, so the marker separated
// nothing and only made the tail longer.
export const OFFICIAL_BASE_HASHTAGS = ["#Aniimo"];
// Topic keywords, matched against the TITLE first and the body only as a
// fallback (see topicHashtags). The lists deliberately leave out words that
// show up in nearly every Aniimo article regardless of topic — "aniimo" itself,
// "world"/"idyll" (the setting), "issue" (every FAQ), "store" (App Store),
// "video", "test", a bare "balance" (account balance) — because on a 12 000-
// character body such a word fires the rule on almost every post.
const OFFICIAL_TOPIC_TAG_RULES = [
  [["patch notes", "update notice", "version update", "game update", "patch", "hotfix"], "#Оновлення"],
  [["fix", "fixes", "bug", "known issue", "crash", "optimization", "optimisation", "optimized", "optimised", "stability"], "#Виправлення"],
  [["balance adjustment", "balance adjustments", "balance changes", "adjustment", "nerf", "buff"], "#Баланс"],
  [["event", "challenge", "reward", "rewards", "login", "bonus", "milestone", "celebration"], "#Подія"],
  [
    ["shop", "in-game store", "bundle", "pack", "price", "limited-time", "limited time", "top-up", "glimmer"],
    "#Магазин",
  ],
  [["outfit", "costume", "skin", "cosmetic", "accessory", "accessories", "hair", "appearance"], "#Косметика"],
  [["trailer", "teaser", "pv", "showcase"], "#Трейлер"],
  [["creature", "legendary", "evolution", "evolve", "hatch", "egg", "bond pact", "sparkling", "prismana"], "#Аніімо"],
  [["character", "companion", "npc", "story", "quest", "legendary journey", "chapter"], "#Сюжет"],
  [["region", "map", "habitat", "area", "zone"], "#Локації"],
  // Anti-cheat and account-rules posts, which read nothing like a feature
  // announcement. This rule sits above the gameplay one on purpose: their lead
  // paragraph always promises "a great gameplay experience", which used to tag
  // a ban-policy notice «#Геймплей».
  [
    [
      "fair play",
      "prohibited activit",
      "cheat",
      "cheating",
      "exploit",
      "botting",
      "multiboxing",
      "third-party software",
      "account trading",
      "account sharing",
      "violation",
    ],
    "#ЧеснаГра",
  ],
  // "gameplay" deliberately absent: it is boilerplate in the opening lines of
  // almost every official post, and the body is scanned only there.
  [["mode", "co-op", "coop", "multiplayer", "pvp", "raid", "housing", "farm"], "#Геймплей"],
  [["season", "version 1.", "new version", "roadmap"], "#Версія"],
  [["maintenance", "server", "downtime", "offline", "compensation"], "#ТехнічніРоботи"],
  [["ranked", "competitive", "rank", "league"], "#Рейтинг"],
  // "pre-download" deliberately absent: PC and console get pre-downloads too,
  // and it used to tag a PC launch notice as a mobile one.
  [["mobile", "ios", "android", "smartphone", "tablet"], "#МобільнаВерсія"],
  [
    [
      "pc",
      "steam",
      "epic",
      "console",
      "consoles",
      "platform",
      "platforms",
      "ps5",
      "playstation",
      "xbox",
      "dlss",
      "geforce now",
      "cloud",
    ],
    "#Платформи",
  ],
  [["beta", "closed beta"], "#Бета"],
  [["creator", "creators", "recruitment", "partner"], "#Креатори"],
  [["vote", "voting", "poll", "survey", "q&a", "feedback"], "#Спільнота"],
  // No rule for "announcement"/"notice"/"letter": almost every official title
  // carries one of those words, so it competed with the real topic. "#Анонс"
  // is the fallback below instead, used only when nothing else matched.
];
const OFFICIAL_POST_TYPE_RULES = [
  [
    "patch",
    "Patch notes / update notice",
    ["patch notes", "update notice", "version update", "game update", "patch", "hotfix"],
  ],
  [
    "maintenance",
    "Maintenance / server notice",
    ["maintenance", "server maintenance", "downtime", "servers will be offline", "compensation"],
  ],
  ["trailer", "Trailer / teaser / reveal", ["trailer", "teaser", "pv", "showcase", "character reveal", "reveal"]],
  [
    "event",
    "Event / rewards / login bonus",
    ["event", "challenge", "reward", "rewards", "login bonus", "milestone", "celebration", "legendary journey"],
  ],
  [
    "shop",
    "Shop / outfits / bundles",
    ["shop", "in-game store", "outfit", "costume", "skin", "bundle", "pack", "cosmetic", "glimmer", "top-up", "price"],
  ],
  ["announcement", "Announcement / notice", ["announcement", "notice", "letter", "roadmap"]],
];
const OFFICIAL_NORMAL_MAX_LENGTH = 1200;
const OFFICIAL_PATCH_MAX_LENGTH = 1600;
// Every reader-link label a source may close its post with (post_footer renders
// them as anchors); a model that hands one back already wrapped in <a> is
// unwrapped here so the draft stores plain text.
const SOURCE_LINK_LABELS = Object.values(SOURCE_ATTRIBUTIONS).map((parts) => parts.label);
const SOURCE_LINK_PATTERN = new RegExp(
  `<a\\s+[^>]*href=["'][^"']+["'][^>]*>\\s*(${SOURCE_LINK_LABELS.map(escapeRegExp).join("|")})\\s*<\\/a>`,
  "gi",
);

export class GeminiDraftError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "GeminiDraftError";
  }
}

/**
 * Normalised input for one draft.
 *
 * `extra_links` are (label, url) pairs lifted from the ORIGINAL post and already
 * validated by services/source_links. They are appended after the draft rather
 * than fed to the model, so a published link is never one the model wrote.
 */
export function geminiDraftInput({
  title,
  article_url,
  article_date_display = null,
  datetime_notes = null,
  body_text,
  source_type,
  source_name,
  extra_links = [],
}) {
  return Object.freeze({
    title,
    article_url,
    article_date_display,
    datetime_notes,
    body_text,
    source_type,
    source_name,
    extra_links,
  });
}

export class GeminiDraftGenerator {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generateDrafts(draftInput, { maxPartLength }) {
    const pkg = await this.generateDraftPackage(draftInput, { maxPartLength });
    return pkg.draft_parts;
  }

  async generateDraftPackage(draftInput, { maxPartLength }) {
    const prompt = buildPrompt(draftInput, { maxLength: effectiveMaxLength(draftInput, maxPartLength) });
    let draft;
    try {
      draft = await this.generateOnce(prompt);
    } catch (error) {
      if (error instanceof GeminiDraftError) {
        throw error;
      }
      if (isRateLimitError(error)) {
        throw new GeminiDraftError(
          "Gemini вичерпав ліміт запитів (rate limit). Спробуйте ще раз за хвилину.",
          { cause: error },
        );
      }
      throw new GeminiDraftError("Gemini draft generation failed", { cause: error });
    }

    draft = cleanResponseText(draft);
    if (!draft) {
      throw new GeminiDraftError("Gemini returned an empty draft");
    }

    const [draftText, extractedTags] = extractTags(draft);
    if (!draftText) {
      throw new GeminiDraftError("Gemini returned tags without draft text");
    }

    let tags;
    if (isOfficialSource(draftInput)) {
      tags = officialDatabaseTags(draftInput);
    } else {
      tags = extractedTags.length ? extractedTags : fallbackTags(draftInput);
    }

    let draftParts;
    if (isOfficialSource(draftInput)) {
      draftParts = [prepareOfficialDraft(draftText, draftInput, { maxPartLength })];
    } else {
      draftParts = splitDraftParts(draftText, { maxPartLength }).map((part) =>
        ensureRequiredMetadata(part, draftInput),
      );
    }
    return { draft_parts: draftParts, tags };
  }

  async generateDraft(draftInput) {
    const drafts = await this.generateDrafts(draftInput, { maxPartLength: 3500 });
    return drafts[0];
  }

  /**
   * Ask Gemini whether `newTitle` is the same specific story as any of
   * `existingTitles`. Returns a not-duplicate verdict when there is nothing
   * meaningful to compare; throws GeminiDraftError if the model call fails.
   */
  async findDuplicateTitle(newTitle, existingTitles) {
    const candidate = String(newTitle ?? "").trim();
    const known = existingTitles.filter((title) => title && title.trim()).map((title) => title.trim());
    if (!candidate || !known.length) {
      return { is_duplicate: false, matched_title: null };
    }

    const prompt = buildDedupPrompt(candidate, known);
    const raw = await this.generateOnce(prompt);
    return parseDuplicateVerdict(raw, known);
  }

  /**
   * One model call, with the same bounded retry the Python version performed
   * inside its worker thread.
   */
  async generateOnce(prompt) {
    let client;
    try {
      const { GoogleGenAI } = await import("@google/genai");
      client = new GoogleGenAI({ apiKey: this.apiKey });
    } catch (error) {
      throw new GeminiDraftError("@google/genai is not installed", { cause: error });
    }

    for (let attempt = 0; attempt < GEMINI_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await client.models.generateContent({ model: this.model, contents: prompt });
        return response?.text ?? "";
      } catch (error) {
        if (attempt >= GEMINI_MAX_ATTEMPTS - 1 || !isRetryableGeminiError(error)) {
          throw error;
        }
        const delay = geminiRetryDelaySeconds(error, attempt);
        logger.warning(
          `Gemini call throttled/unavailable (${error?.status ?? "?"}); ` +
            `retrying in ${delay.toFixed(0)}s (attempt ${attempt + 1}/${GEMINI_MAX_ATTEMPTS})`,
        );
        await sleep(delay);
      }
    }
    // Unreachable: the final attempt either returns or re-throws above.
    throw new GeminiDraftError("Gemini call exhausted all retries");
  }
}

function isRateLimitError(error) {
  const code = error?.status;
  return code === 429 || errorText(error).includes("RESOURCE_EXHAUSTED");
}

/**
 * Retry per-minute rate limits (429) and transient server errors (500/503), but
 * NOT a per-DAY free-tier cap — that won't clear on a short retry, so failing
 * fast gives a clear message instead of stalling for nothing.
 */
function isRetryableGeminiError(error) {
  const text = errorText(error);
  if (text.includes("PerDay") || text.includes("RequestsPerDay")) {
    return false;
  }
  const code = error?.status;
  if (code === 429 || code === 500 || code === 503) {
    return true;
  }
  return ["RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL"].some((marker) => text.includes(marker));
}

/**
 * Honour the API's suggested retryDelay when present (capped), else use a
 * bounded exponential backoff.
 */
function geminiRetryDelaySeconds(error, attempt) {
  const match = /retryDelay['"]?\s*:\s*['"]?(\d+(?:\.\d+)?)/.exec(errorText(error));
  if (match) {
    return Math.min(Number(match[1]) + 1.0, GEMINI_MAX_RETRY_DELAY_SECONDS);
  }
  return Math.min(8.0 * (attempt + 1), GEMINI_MAX_RETRY_DELAY_SECONDS);
}

/**
 * How many characters this post may actually use.
 *
 * The post-type ceiling is only half of it: a photo post carries its text as
 * a Telegram caption, which is capped far lower than a message, so the
 * collector passes the real per-part budget in. Telling the model the same
 * number the truncator enforces is what keeps a draft from being cut off
 * mid-sentence.
 */
function effectiveMaxLength(draftInput, maxPartLength) {
  if (isOfficialSource(draftInput)) {
    return Math.min(officialMaxLength(draftInput), maxPartLength);
  }
  return maxPartLength;
}

function buildPrompt(draftInput, { maxLength = null } = {}) {
  const sourceLine = sourceAttributionLine(draftInput);
  const maxLengthValue = String(maxLength ?? OFFICIAL_NORMAL_MAX_LENGTH);
  return formatTemplate(selectPromptTemplate(draftInput), {
    style_prompt: formatTemplate(loadStylePrompt(), { max_length: maxLengthValue }),
    source_type: draftInput.source_type,
    source_name: draftInput.source_name,
    title: draftInput.title,
    article_url: draftInput.article_url,
    article_type_label: officialPostTypeLabel(draftInput),
    date_line: draftInput.article_date_display || t("gemini.fallback_date"),
    source_line: sourceLine,
    hashtag_line: publicHashtagLine(draftInput),
    datetime_notes: draftInput.datetime_notes || "UTC/GMT-часів для конвертації не знайдено.",
    body_text: draftInput.body_text || t("gemini.fallback_body"),
    rumor_notice: rumorNotice(draftInput),
    max_length: maxLengthValue,
  });
}

function isRumorSource(draftInput) {
  return RUMOR_SOURCE_TYPES.has(draftInput.source_type);
}

/**
 * A strong, source-scoped instruction for leak/datamine sources so the draft is
 * framed as a rumour. Empty for every other source (the placeholder then renders
 * as nothing).
 */
function rumorNotice(draftInput) {
  if (!isRumorSource(draftInput)) {
    return "";
  }

  return (
    "УВАГА: це НЕОФІЦІЙНИЙ злив/витік (датамайн або чутка), НЕ підтверджений розробниками. " +
    "Обов'язково познач це в тексті як чутку/неофіційну інформацію (напр. «за чутками», " +
    "«за даними датамайну», «неофіційно») і коротко нагадай, що деталі ще можуть змінитися. " +
    "Не подавай це як офіційну заяву чи підтверджений факт."
  );
}

/**
 * The wiki rubric uses the "Аніімо тижня" creature prompt; official articles use
 * the long-form article prompt; every other (social / short-form) source uses the
 * concise short-form prompt. All accept the same format placeholders, so the
 * values in buildPrompt stay shared.
 */
function selectPromptTemplate(draftInput) {
  if (isWikiSource(draftInput)) {
    return loadWikiCreaturePromptTemplate();
  }
  if (isOfficialSource(draftInput)) {
    return loadPromptTemplate();
  }

  return loadShortFormPromptTemplate();
}

function cleanResponseText(value) {
  return strip(strip(strip(String(value ?? "")), "`"));
}

function buildDedupPrompt(newTitle, existingTitles) {
  const numbered = existingTitles.map((title, index) => `${index + 1}. ${title}`).join("\n");
  return formatTemplate(loadDedupPromptTemplate(), { new_title: newTitle, existing_titles: numbered });
}

/**
 * Interpret the model's `duplicate` field, biased toward not-a-duplicate.
 *
 * A genuine JSON `true`/`1` counts as a duplicate; everything else — including
 * the common stringified `"false"`/`"no"`/`"0"` deviations — is treated as NOT a
 * duplicate, so a formatting quirk never drops real news.
 */
function coerceDuplicateFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value === "string") {
    return ["true", "yes", "1"].includes(value.trim().toLowerCase());
  }
  return false;
}

/**
 * Parse the model's JSON verdict, failing open (not a duplicate) on anything
 * unexpected — a missed dedup only costs a rare double post, but a false
 * positive would silently drop real news.
 */
export function parseDuplicateVerdict(raw, knownTitles) {
  const text = cleanResponseText(raw);
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) {
    return { is_duplicate: false, matched_title: null };
  }

  let data;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return { is_duplicate: false, matched_title: null };
  }

  if (data === null || typeof data !== "object" || Array.isArray(data) || !coerceDuplicateFlag(data.duplicate)) {
    return { is_duplicate: false, matched_title: null };
  }

  const matched = data.match;
  let matchedTitle = null;
  if (typeof matched === "string" && matched.trim()) {
    const lowered = matched.trim().toLowerCase();
    matchedTitle = knownTitles.find((title) => title.toLowerCase() === lowered) ?? matched.trim();
  }

  return { is_duplicate: true, matched_title: matchedTitle };
}

function ensureRequiredMetadata(draft, draftInput) {
  // Short-form (non-official) posts deliberately carry NO publication-date line:
  // the post itself is the announcement, and a bare "2026-06-12" mid-post reads
  // as noise. The article date stays available to admins via the original_text.
  let result = cleanModelDraft(draft, draftInput).trim();
  result = applyDatetimeNotes(result, draftInput.datetime_notes);
  result = appendExtraLinks(result, draftInput);

  const sourceLine = sourceAttributionLine(draftInput);
  if (!allowsPublicSourceAttribution(draftInput.source_type)) {
    // The source belongs to the moderation card only, so a "Джерело: …" line the
    // model added anyway is dropped here rather than stored in the draft — for a
    // CTA source too, or its reader link would never be appended below.
    result = stripPublicSourceAttribution(result);
  }
  if (sourceLine) {
    // The model's own spelling of the CTA line ("- в", "– в", no dash) is
    // replaced by the canonical one, which is the only spelling post_footer
    // links; anything else it wrote that names the label stays.
    result = removeSourceAttributionLines(result);
    if (!hasSourceAttribution(result)) {
      result = `${result}\n\n${sourceLine}`.trim();
    }
  }

  const hashtags = publicHashtagLine(draftInput);
  if (!result.includes(hashtags)) {
    result = `${result}\n\n${hashtags}`;
  }

  return normalizeBlankLines(result);
}

/**
 * Re-attach the post's own validated links, which URL stripping removed.
 *
 * They are added AFTER cleaning, so the strip cannot take them out again, and
 * they are rendered as bare URLs: Telegram makes those clickable on its own, and
 * the collector paths that carry links publish with previews disabled, so no
 * preview card appears.
 */
function appendExtraLinks(text, draftInput) {
  if (!draftInput.extra_links.length) {
    return text;
  }

  const lines = draftInput.extra_links
    .filter(([, url]) => !text.includes(url))
    .map(([label, url]) => `🔗 ${label}: ${url}`);
  if (!lines.length) {
    return text;
  }

  return text ? `${text}\n\n${lines.join("\n")}` : lines.join("\n");
}

function cleanModelDraft(draft, draftInput) {
  const lines = [];
  for (const line of draft.split("\n")) {
    const stripped = line.trim();
    if (!stripped) {
      lines.push(line);
      continue;
    }
    if (stripped === t("gemini.fallback_date")) {
      continue;
    }
    if (stripped.includes(draftInput.article_url)) {
      const cleanedLine = stripRawUrls(line).trim();
      if (!cleanedLine || looksLikeSourceOnlyLine(cleanedLine)) {
        continue;
      }
      lines.push(stripUnsupportedMarkdown(cleanedLine));
      continue;
    }
    if (/https?:\/\/|www\./i.test(stripped)) {
      const cleanedLine = stripRawUrls(line).trim();
      if (!cleanedLine || looksLikeSourceOnlyLine(cleanedLine)) {
        continue;
      }
      lines.push(stripUnsupportedMarkdown(cleanedLine));
      continue;
    }
    if (isHashtagOnlyLine(stripped)) {
      continue;
    }
    lines.push(stripUnsupportedMarkdown(line));
  }

  return stripRawUrls(lines.join("\n"));
}

function extractTags(draft) {
  if (!draft.includes(TAGS_SEPARATOR)) {
    return [draft, []];
  }

  const [draftText, , rawTags] = partition(draft, TAGS_SEPARATOR);
  return [draftText.trim(), normalizeTags(rawTags)];
}

function normalizeTags(rawTags) {
  const normalizedTags = [];
  const seen = new Set();
  for (const value of rawTags.split(/[,;\n]/)) {
    // lstrip("#"): the LEADING hashes only — a trailing "#" is punctuation the
    // final strip() below deals with.
    let normalized = value.trim().toLowerCase().replace(/^#+/, "");
    normalized = normalized.replace(/[_-]+/g, " ");
    normalized = normalized.replace(/\s+/g, " ");
    normalized = strip(normalized, ".,;:!?'\"()[]{}");
    if (!normalized || seen.has(normalized) || normalized.length > 40) {
      continue;
    }

    seen.add(normalized);
    normalizedTags.push(normalized);

    if (normalizedTags.length >= 12) {
      break;
    }
  }

  return normalizedTags;
}

function fallbackTags(draftInput) {
  const fallbackTag = t("gemini.fallback_tag");
  if (isWikiSource(draftInput)) {
    // Keep the stored tags in step with the rubric's public hashtags.
    return [fallbackTag, t("collectors.wiki_aniimo.tag")];
  }

  const tags = [fallbackTag];
  if (isRumorSource(draftInput)) {
    // Keep the stored tags in step with the permanent public "#Чутки" marker.
    tags.push(t("gemini.rumor_tag"));
  }
  const lowered = `${draftInput.title}\n${draftInput.body_text}`.toLowerCase();
  const keywordTags = [
    ["patch", "патч"],
    ["balance", "баланс"],
    ["outfit", "костюм"],
    ["costume", "костюм"],
    ["event", "івент"],
    ["version", "версія"],
    ["region", "локація"],
    ["mode", "режим"],
    ["aniimo", "аніімо"],
    ["creature", "аніімо"],
    ["mobile", "мобільна"],
    ["bug", "виправлення"],
    ["fix", "виправлення"],
  ];
  for (const [keyword, tag] of keywordTags) {
    if (lowered.includes(keyword) && !tags.includes(tag)) {
      tags.push(tag);
    }
  }

  return tags;
}

function isOfficialSource(draftInput) {
  return OFFICIAL_SOURCE_TYPES.has(draftInput.source_type);
}

function isWikiSource(draftInput) {
  return WIKI_SOURCE_TYPES.has(draftInput.source_type);
}

function prepareOfficialDraft(draftText, draftInput, { maxPartLength }) {
  const collapsedDraft = collapsePostParts(draftText);
  const result = sanitizeOfficialPublicDraft(collapsedDraft, draftInput);
  const maxLength = Math.min(officialMaxLength(draftInput), maxPartLength);
  return enforceOfficialLength(result, draftInput, { maxLength });
}

function sanitizeOfficialPublicDraft(draft, draftInput) {
  let result = cleanModelDraft(draft, draftInput);
  result = removeOfficialPublicMetadata(result, draftInput);
  result = applyDatetimeNotes(result, draftInput.datetime_notes);
  result = stripUnsupportedMarkdown(result);
  result = stripRawUrls(result);
  result = removeOfficialPublicMetadata(result, draftInput);
  result = ensureOfficialSourceAttribution(result, draftInput);
  result = ensureHashtagsAtBottom(result, draftInput);
  return normalizeBlankLines(result);
}

function publicHashtagLine(draftInput) {
  if (isOfficialSource(draftInput)) {
    return officialHashtags(draftInput).join(" ");
  }

  // The creature rubric gets its own fixed tags. The news topic rules are keyed on
  // patch/event/shop wording that a creature fact sheet never contains, so it fell
  // through to the "#Анонс" default — labelling a habitat list an announcement.
  if (isWikiSource(draftInput)) {
    return t("collectors.wiki_aniimo.hashtags");
  }

  // A leak is never an announcement, so rumour sources carry a permanent
  // "#Чутки" marker instead of the "#Анонс" default. It is added on EVERY such
  // post, not only when no topic matched: a marker that appears at random is one
  // readers cannot rely on, and as a constant it doubles as a channel-wide
  // filter separating rumours from official news.
  if (isRumorSource(draftInput)) {
    return [t("gemini.hashtags"), t("gemini.rumor_hashtag"), ...topicHashtags(draftInput, { fallback: false })].join(
      " ",
    );
  }

  // Non-official (social/short-form) posts get the base tag PLUS the same topic
  // tags, so they are tagged too — not bare.
  return [t("gemini.hashtags"), ...topicHashtags(draftInput)].join(" ");
}

function officialDatabaseTags(draftInput) {
  return officialHashtags(draftInput).map((tag) => tag.replace(/^#+/, ""));
}

/**
 * Up to three topic tags, matched against the title first and the body only
 * when the title gave nothing.
 *
 * The title is what the article is ABOUT; a 12 000-character body mentions
 * rewards, fixes, the store and a video somewhere in almost every post, so
 * matching title+body together tagged a mobile pre-download notice
 * "#Виправлення #Баланс #Подія". The body is still consulted for a title that says
 * nothing ("Welcome to Idyll"), where any signal beats the bare "#Анонс".
 *
 * `fallback` adds "#Анонс" when nothing matched. Callers that already supply
 * their own marker (rumour sources) turn it off, so a leak is never labelled an
 * announcement just because no keyword hit.
 */
function topicHashtags(draftInput, { fallback = true } = {}) {
  let topicTags = [];
  for (const text of matchTexts(draftInput)) {
    topicTags = matchTopicTags(text);
    if (topicTags.length) {
      break;
    }
  }

  if (!topicTags.length && fallback) {
    topicTags.push("#Анонс");
  }

  // Up to four, and only what actually matched: the noise came from scanning a
  // whole patch note, not from the count, so a post that genuinely touches
  // four topics may carry four tags.
  return topicTags.slice(0, 4);
}

function matchTopicTags(text) {
  const topicTags = [];
  for (const [keywords, hashtag] of OFFICIAL_TOPIC_TAG_RULES) {
    if (topicTags.includes(hashtag)) {
      continue;
    }
    if (keywords.some((keyword) => matchesKeyword(text, keyword))) {
      topicTags.push(hashtag);
    }
    if (topicTags.length >= 3) {
      break;
    }
  }
  return topicTags;
}

/** The lowercased title, then the lowercased body — the order the rules try them in. */
// How far into the body a topic keyword still counts. The title is the honest
// signal; the body is only a fallback for a title that says nothing, and a
// whole patch note mentions rewards, fixes and the store somewhere, so only
// its opening is read. Beyond that the matches are incidental, not the topic.
const BODY_TOPIC_SCAN_CHARS = 600;

function matchTexts(draftInput) {
  return [
    String(draftInput.title ?? "").toLowerCase(),
    String(draftInput.body_text ?? "").slice(0, BODY_TOPIC_SCAN_CHARS).toLowerCase(),
  ];
}

function officialHashtags(draftInput) {
  return [...OFFICIAL_BASE_HASHTAGS, ...topicHashtags(draftInput)];
}

/** The post type by the same title-first rule as the topic tags. */
function officialPostType(draftInput) {
  for (const text of matchTexts(draftInput)) {
    for (const [postType, , keywords] of OFFICIAL_POST_TYPE_RULES) {
      if (keywords.some((keyword) => matchesKeyword(text, keyword))) {
        return postType;
      }
    }
  }

  return "announcement";
}

function officialPostTypeLabel(draftInput) {
  const postType = officialPostType(draftInput);
  for (const [ruleType, label] of OFFICIAL_POST_TYPE_RULES) {
    if (ruleType === postType) {
      return label;
    }
  }

  return "Short announcement";
}

function officialMaxLength(draftInput) {
  if (officialPostType(draftInput) === "patch") {
    return OFFICIAL_PATCH_MAX_LENGTH;
  }

  return OFFICIAL_NORMAL_MAX_LENGTH;
}

/**
 * The attribution line a public post carries, or "" when it carries none.
 *
 * The source is admin-only metadata — the moderation card shows it, the post does
 * not. The exception is a reader call-to-action: the official site, Steam and the
 * wiki rubric each close with their own "read more" line (gemini.attribution.*),
 * which post_footer turns into the link. Everything else gets nothing — unless a
 * source is licence-bound to name itself, in which case it keeps a "Джерело:" line.
 */
function sourceAttributionLine(draftInput) {
  if (Object.hasOwn(SOURCE_ATTRIBUTIONS, draftInput.source_type)) {
    return t(`gemini.attribution.${draftInput.source_type}`);
  }

  if (!allowsPublicSourceAttribution(draftInput.source_type)) {
    return "";
  }

  return t("gemini.source_line", { source_name: draftInput.source_name });
}

function hasSourceAttribution(text) {
  const lowered = text.toLowerCase();
  return (
    SOURCE_LINK_LABELS.some((label) => lowered.includes(label.toLowerCase())) || lowered.includes("джерело:")
  );
}

function removeOfficialPublicMetadata(text, draftInput) {
  const lines = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped) {
      lines.push("");
      continue;
    }

    if (isOfficialMetadataLine(stripped, draftInput)) {
      continue;
    }

    lines.push(stripped);
  }

  return normalizeBlankLines(lines.join("\n"));
}

function isOfficialMetadataLine(line, draftInput) {
  const lowered = line.toLowerCase().trim();
  const normalized = strip(lowered, ":-—– ");
  if (!normalized) {
    return false;
  }

  if (draftInput.article_date_display && normalized === draftInput.article_date_display.toLowerCase()) {
    return true;
  }

  if (draftInput.article_url && lowered.includes(draftInput.article_url.toLowerCase())) {
    return true;
  }

  const metadataPrefixes = [
    "дата публікації",
    "дата статті",
    "оригінальна дата",
    "дата статті після",
    "джерело",
    "url",
    "source",
    "source url",
    "article date",
    "publication date",
    "посилання",
    "тип джерела",
    "назва джерела",
  ];
  if (metadataPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }

  const sourceName = draftInput.source_name.toLowerCase().trim();
  if (sourceName && (normalized === sourceName || normalized === "офіційний сайт aniimo")) {
    return true;
  }

  return false;
}

function ensureOfficialSourceAttribution(text, draftInput) {
  const sourceLine = sourceAttributionLine(draftInput);
  const body = removeSourceAttributionLines(text);
  if (!body) {
    return sourceLine;
  }

  return `${body}\n\n${sourceLine}`;
}

function removeSourceAttributionLines(text) {
  const lines = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped) {
      lines.push("");
      continue;
    }

    if (isSourceAttributionLine(stripped)) {
      continue;
    }

    if (looksLikeSourceOnlyLine(stripped)) {
      continue;
    }

    lines.push(stripped);
  }

  return normalizeBlankLines(lines.join("\n"));
}

/**
 * A reader call-to-action line in any of its spellings: the plain locale line of
 * any source, or the model's own variant that still names the link label next to
 * its lead-in (or wrapped in an anchor).
 *
 * Only the lead-in WORDS of the prefix ("повні деталі", "більше про цю істоту")
 * are required, not its dash: the model regularly hands back "Повні деталі — на
 * офіційному сайті", "– на" or no dash at all, and each of those must be
 * recognised as the same line — otherwise the canonical line is appended next to
 * the model's, the post says it twice and only the canonical copy gets the link.
 */
function isSourceAttributionLine(line) {
  const lowered = line.toLowerCase();
  return Object.values(SOURCE_ATTRIBUTIONS).some((parts) => {
    if (!lowered.includes(parts.label.toLowerCase())) {
      return false;
    }
    return lowered.includes(attributionLeadIn(parts)) || lowered.includes("<a");
  });
}

/**
 * "Повні деталі на " → "повні деталі": the words that open the line, without
 * the preposition that leads into the label and without a dash if one is
 * present. Our own lines carry no dash any more, but the model still writes
 * "Повні деталі — на ...", so both spellings have to reduce to the same stem.
 */
function attributionLeadIn(parts) {
  return parts.prefix
    .split(/\s*[—–-]\s*/)[0]
    .replace(/\s+(?:на|в|у)\s*$/iu, "")
    .trim()
    .toLowerCase();
}

function ensureHashtagsAtBottom(text, draftInput) {
  const hashtags = publicHashtagLine(draftInput);
  const bodyLines = [];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (!stripped) {
      bodyLines.push("");
      continue;
    }

    if (isHashtagOnlyLine(stripped) || stripped.toLowerCase().startsWith("теги:")) {
      continue;
    }

    bodyLines.push(stripped);
  }

  const body = normalizeBlankLines(bodyLines.join("\n"));
  if (!body) {
    return hashtags;
  }

  return `${body}\n\n${hashtags}`;
}

function collapsePostParts(draft) {
  const parts = draft
    .split(POST_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) {
    return draft.trim();
  }

  return parts.slice(0, 2).join("\n\n").trim();
}

function enforceOfficialLength(text, draftInput, { maxLength }) {
  let result = normalizeBlankLines(text);
  if (charLength(result) <= maxLength) {
    return result;
  }

  const hashtags = publicHashtagLine(draftInput);
  const sourceLine = sourceAttributionLine(draftInput);
  let body = removeExactLine(result, hashtags);
  body = removeExactLine(body, sourceLine).trim();

  const suffix = [sourceLine, hashtags].filter(Boolean).join("\n\n");
  let available = Math.max(260, maxLength - charLength(suffix) - 4);
  let shortened = truncatePlainText(body, available, { sourceLine }).trim();
  if (sourceLine && !shortened.includes(sourceLine)) {
    shortened = `${shortened}\n\n${sourceLine}`.trim();
  }

  result = `${shortened}\n\n${hashtags}`.trim();
  if (charLength(result) <= maxLength) {
    return normalizeBlankLines(result);
  }

  available = Math.max(180, maxLength - charLength(hashtags) - 4);
  shortened = truncatePlainText(shortened, available, { sourceLine });
  return normalizeBlankLines(`${shortened}\n\n${hashtags}`);
}

function matchesKeyword(text, keyword) {
  if (keyword.includes(" ")) {
    return text.includes(keyword);
  }

  return new RegExp(`(?<!${WORD})${escapeRegExp(keyword)}(?!${WORD})`, "u").test(text);
}

function stripUnsupportedMarkdown(text) {
  let result = replaceSourceAnchor(text);
  result = result.replace(/<\/?(?:b|strong|i|em|u|s|span|h[1-6])[^>]*>/gi, "");
  result = result.replace(/<[^>\n]+>/g, "");
  result = result.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  result = result.replace(/\*\*(.*?)\*\*/g, "$1");
  result = result.replace(/__(.*?)__/g, "$1");
  result = result.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "$1");
  result = result.replaceAll("`", "");
  result = result.replace(/^\s*[*-]\s+/gm, "");
  result = result.replace(/^\s*\*\s*$/gm, "");
  result = result.replace(/\*{2,}/g, "");
  return result;
}

function stripRawUrls(text) {
  let result = replaceSourceAnchor(text);
  result = result.replace(/\s*https?:\/\/\S+/g, "");
  result = result.replace(/\s*www\.\S+/g, "");
  result = result.replace(/\s*(?:деталі|повні деталі|details|source|link|url|посилання)\s*:\s*$/i, "");
  return result;
}

function replaceSourceAnchor(text) {
  SOURCE_LINK_PATTERN.lastIndex = 0;
  return text.replace(SOURCE_LINK_PATTERN, "$1");
}

function looksLikeSourceOnlyLine(text) {
  const normalized = strip(text.trim(), ":-—– ").toLowerCase();
  return ["джерело", "source", "url", "link", "посилання", "деталі", "повні деталі"].includes(normalized);
}

function removeExactLine(text, lineToRemove) {
  if (!lineToRemove) {
    return text;
  }

  return text
    .split("\n")
    .filter((line) => line.trim() !== lineToRemove)
    .join("\n");
}

/**
 * Cut `text` down to `maxLength` at a sentence or word boundary, closing with
 * an ellipsis and the source's own reader line so the reader knows where the
 * rest is. Without a source line the cut ends on the ellipsis alone.
 */
function truncatePlainText(text, maxLength, { sourceLine = "" } = {}) {
  if (charLength(text) <= maxLength) {
    return text;
  }

  const ending = sourceLine ? `…\n\n${sourceLine}` : "…";
  const available = Math.max(80, maxLength - charLength(ending));
  let truncated = rstrip(sliceChars(text, 0, available));
  let splitAt = Math.max(
    rfindChars(truncated, "\n\n"),
    rfindChars(truncated, ". "),
    rfindChars(truncated, "! "),
    rfindChars(truncated, "? "),
  );
  if (splitAt > Math.floor(available / 2)) {
    truncated = rstrip(sliceChars(truncated, 0, splitAt + 1));
  } else {
    splitAt = rfindChars(truncated, " ");
    if (splitAt > Math.floor(available / 2)) {
      truncated = rstrip(sliceChars(truncated, 0, splitAt));
    }
  }

  return `${truncated}${ending}`;
}

function isHashtagOnlyLine(value) {
  return Boolean(value.startsWith("#") && /^(?:#[^\s#]+)(?:\s+#[^\s#]+)*$/.test(value));
}

function normalizeBlankLines(text) {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

// One conversion note as date_utils writes it: "- <original> (<date>) -> <converted>".
// The original half is a clock time with optional seconds and meridiem glued to
// its zone ("04:00 UTC+8", "5:00 PM UTC+8", "00:00:12 UTC+8", "18:30 GMT +2").
const DATETIME_NOTE_PATTERN =
  /^\s*-\s*(?<original>\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?\s*(?:UTC|GMT)(?:\s*[+-]\s*\d{1,2}(?::?[0-5]\d)?)?)\s*\([^)]+\)\s*->\s*(?<converted>.+?)\s*$/i;

/**
 * Replace every source-zone time the model left in the draft with its Kyiv
 * conversion — but only where the replacement is unambiguous.
 *
 * The notes are per endpoint, so one label can carry several conversions
 * ("04:00 UTC+8 (2026-09-24) -> 23:00 … (23 вересня)", "04:00 UTC+8
 * (2026-10-01) -> 23:00 … (30 вересня)"). Rewriting every "04:00 UTC+8" in the
 * draft with the FIRST of them stamped one window's date onto every other
 * window; such a label is left exactly as the model wrote it, and the prompt's
 * own instruction to use the notes is what has to carry it.
 */
function applyDatetimeNotes(text, datetimeNotes) {
  if (!text || !datetimeNotes) {
    return text;
  }

  const conversionsByLabel = new Map();
  for (const line of datetimeNotes.split("\n")) {
    const match = DATETIME_NOTE_PATTERN.exec(line);
    if (match === null) {
      continue;
    }

    const label = match.groups.original.toLowerCase();
    const converted = match.groups.converted.trim();
    const known = conversionsByLabel.get(label) ?? new Set();
    known.add(converted);
    conversionsByLabel.set(label, known);
  }

  let result = text;
  for (const [label, conversions] of conversionsByLabel) {
    if (conversions.size !== 1) {
      continue;
    }
    const [converted] = conversions;
    result = result.replace(new RegExp(escapeRegExp(label), "gi"), converted);
  }

  return result;
}

function splitDraftParts(draft, { maxPartLength }) {
  let explicitParts = draft
    .split(POST_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!explicitParts.length) {
    explicitParts = [draft.trim()];
  }

  const normalizedParts = [];
  for (const part of explicitParts) {
    normalizedParts.push(...splitOversizedPart(part, { maxPartLength }));
  }

  return normalizedParts.length ? normalizedParts : [draft.trim()];
}

function splitOversizedPart(part, { maxPartLength }) {
  if (charLength(part) <= maxPartLength) {
    return [part];
  }

  let paragraphs = part
    .split("\n\n")
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (!paragraphs.length) {
    paragraphs = [part.trim()];
  }

  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}`.trim() : paragraph;
    if (charLength(candidate) <= maxPartLength) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }
    current = paragraph;

    while (charLength(current) > maxPartLength) {
      let splitAt = rfindChars(current, "\n", maxPartLength);
      if (splitAt < Math.floor(maxPartLength / 2)) {
        splitAt = rfindChars(current, " ", maxPartLength);
      }
      if (splitAt < Math.floor(maxPartLength / 2)) {
        splitAt = maxPartLength;
      }

      chunks.push(sliceChars(current, 0, splitAt).trim());
      current = sliceChars(current, splitAt).trim();
    }
  }

  if (current) {
    chunks.push(current);
  }

  if (chunks.length <= 1) {
    return chunks;
  }

  return chunks.map((chunk, index) => prefixPart(chunk, index + 1));
}

function prefixPart(part, number) {
  const [firstLine, separator, rest] = partition(part, "\n");
  const partTitle = t("gemini.part_title", { number });
  if (firstLine.startsWith("📰")) {
    return `${firstLine} · ${partTitle}${separator}${rest}`.trim();
  }

  return `📰 ${partTitle}\n\n${part}`.trim();
}

const templateCache = new Map();

function loadCachedText(file, { trim = true, fallback = null } = {}) {
  if (templateCache.has(file)) {
    return templateCache.get(file);
  }
  let value;
  try {
    // Python read these in text mode, which normalises line endings. Node does
    // not, so on a CRLF checkout every prompt sent to Gemini would silently
    // differ from the one this repo was tuned against.
    const raw = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    value = trim ? raw.trim() : raw;
  } catch (error) {
    if (fallback === null) {
      throw error;
    }
    logger.warning(`Official news style prompt ${file} is unavailable`);
    value = fallback;
  }
  templateCache.set(file, value);
  return value;
}

function loadPromptTemplate() {
  return loadCachedText(PROMPT_PATH);
}

function loadShortFormPromptTemplate() {
  return loadCachedText(SHORT_FORM_PROMPT_PATH);
}

function loadWikiCreaturePromptTemplate() {
  return loadCachedText(WIKI_CREATURE_PROMPT_PATH);
}

function loadDedupPromptTemplate() {
  // Read verbatim (no trim): the dedup prompt is used as-is, exactly as the
  // Python loader did for this one file.
  return loadCachedText(DEDUP_PROMPT_PATH, { trim: false });
}

function loadStylePrompt() {
  return loadCachedText(STYLE_PROMPT_PATH, {
    fallback: "Створи короткий Telegram-пост українською: 400-900 символів, без URL, з тегами в кінці.",
  });
}

// Exported for the unit tests, which exercise the pure text pipeline without
// touching the model.
export const __testing = {
  appendExtraLinks,
  cleanModelDraft,
  cleanResponseText,
  collapsePostParts,
  ensureRequiredMetadata,
  enforceOfficialLength,
  extractTags,
  fallbackTags,
  isHashtagOnlyLine,
  matchesKeyword,
  normalizeBlankLines,
  normalizeTags,
  prepareOfficialDraft,
  officialPostType,
  publicHashtagLine,
  splitDraftParts,
  stripRawUrls,
  stripUnsupportedMarkdown,
  applyDatetimeNotes,
  truncatePlainText,
  buildPrompt,
  buildDedupPrompt,
  geminiRetryDelaySeconds,
  isRateLimitError,
  isRetryableGeminiError,
  loadShortFormPromptTemplate,
  selectPromptTemplate,
  sourceAttributionLine,
};
