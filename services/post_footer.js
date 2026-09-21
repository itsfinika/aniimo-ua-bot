import { t, tOptional } from "./i18n.js";
import { htmlEscape, rstrip } from "./pyutils.js";
import { isSafeHttpUrl } from "./urlutils.js";

// The reader call-to-action each linking source closes its post with, split into
// the parts the renderer needs: only `label` becomes the anchor text, so the link
// never swallows the sentence around it. The full line (prefix + label + suffix)
// MUST equal the matching gemini.attribution.<source_type> locale string — the
// draft is written from the locale, the link is applied from this table, and the
// two only meet when they spell the line identically.
export const SOURCE_ATTRIBUTIONS = Object.freeze({
  official_aniimo: { prefix: "Повні деталі — на ", label: "офіційному сайті", suffix: "." },
  steam: { prefix: "Повні деталі — на ", label: "сторінці у Steam", suffix: "." },
  wiki_aniimo: { prefix: "Більше про цю істоту — в ", label: "офіційній вікі", suffix: "." },
});

/** The full attribution line for a source type, or null when it carries none. */
export function attributionLine(sourceType) {
  const parts = SOURCE_ATTRIBUTIONS[String(sourceType ?? "").trim()];
  if (parts === undefined) {
    return null;
  }
  return `${parts.prefix}${parts.label}${parts.suffix}`;
}

// The official site's line, kept under its old name because other modules and
// tests still import it as "the" official attribution.
export const OFFICIAL_SOURCE_ATTRIBUTION = attributionLine("official_aniimo");
// Source metadata is admin-only: the moderation card already names the source and
// carries its URL, so a public post does not repeat it. A "Джерело: <name>" line
// (gemini.source_line) is therefore stripped from every collector post; the
// sources that do point readers somewhere use the call-to-action lines above
// instead, which are reader links rather than source labels and are left alone.
const GENERIC_SOURCE_PREFIX = "Джерело:";
// Label prefixes that mark a whole line as source metadata, in any post that is
// not allowed to name its source publicly.
const SOURCE_LINE_PREFIXES = [GENERIC_SOURCE_PREFIX.toLowerCase(), "source:"];
// Empty on purpose: no source may keep a "Джерело:" line publicly any more (the
// wiki rubric, once the only member, now uses its CTA line). The set and the
// stripping mechanism stay so a future licence-bound source can opt back in.
export const PUBLIC_SOURCE_ATTRIBUTION_TYPES = new Set();
// Footer link copy and URLs both live in locales/uk.json under post_footer.links.
export const FOOTER_LINK_KEYS = [
  "post_footer.links.chat",
  "post_footer.links.submission",
  "post_footer.links.discord",
];

// A private-use marker (U+E000) placed in front of the appended community footer
// so its position is found STRUCTURALLY, never by matching the visible footer
// text. An untrusted post body could otherwise contain that text to suppress or
// hijack the footer. The sentinel is stripped from incoming text and from the
// final output, so it never reaches Telegram.
const FOOTER_SENTINEL = "";

/**
 * The footer is the links line and nothing else — no rule above it, no heading.
 * Both were dropped deliberately: under a short post they took up more room than
 * the post itself and made every message read like a signature block.
 */
export function formatCommunityFooter() {
  const links = FOOTER_LINK_KEYS.map((keyPrefix) => formatPlainLink(keyPrefix));
  return links.filter(Boolean).join(t("post_footer.link_separator")).trim();
}

/**
 * The community footer as ready HTML (links applied) for callers that build
 * their own HTML body and bypass formatPostHtml — e.g. the album digest caption.
 */
export function formatCommunityFooterHtml() {
  return linkFooterItems(FOOTER_SENTINEL + htmlEscape(formatCommunityFooter()));
}

export function formatPostHtml(
  text,
  { source_url = null, allow_source_link = false, include_community_footer = false, source_type = null } = {},
) {
  const publicText = hidesSourceAttribution(source_type) ? stripPublicSourceAttribution(text) : text;
  const body = prepareBodyText(publicText, include_community_footer);
  const renderedBody = formatBodyHtml(body, {
    sourceUrl: source_url,
    sourceType: source_type,
    allowSourceLink: allow_source_link,
    linkFooter: include_community_footer,
  });
  // Belt-and-suspenders: the sentinel is consumed by linkFooterItems, but make
  // absolutely sure it never reaches Telegram even on an unexpected path.
  return renderedBody.split(FOOTER_SENTINEL).join("");
}

/**
 * Whether a submission's attribution line may be rendered as a source link.
 *
 * True for any collector-sourced submission — one that carries both a
 * `source_type` and a `source_url`. User submissions (no source_type) and rows
 * without a URL keep plain-text attribution.
 */
export function submissionAllowsSourceLink(part) {
  return Boolean(String(part?.source_type ?? "").trim()) && Boolean(String(part?.source_url ?? "").trim());
}

/**
 * Whether a collector's posts may name their source in the public text.
 *
 * Currently none may (PUBLIC_SOURCE_ATTRIBUTION_TYPES is empty). User
 * submissions (no source type) are never touched — their text is the author's own.
 */
export function allowsPublicSourceAttribution(sourceType) {
  return PUBLIC_SOURCE_ATTRIBUTION_TYPES.has(String(sourceType ?? "").trim());
}

/**
 * Drop whole "Джерело: <name>" / "Source: <name>" lines from a public post.
 *
 * Applied at render time as well as at draft time, so drafts queued before the
 * source line was made admin-only — and any line the model slips in despite the
 * prompt — never reach the channel. Only a line that IS the label is removed; an
 * inline mention inside a sentence is left alone.
 */
export function stripPublicSourceAttribution(text) {
  const lines = String(text ?? "").split("\n");
  const kept = lines.filter((line) => !isSourceLabelLine(line));
  if (kept.length === lines.length) {
    return String(text ?? "");
  }

  return collapseBlankRuns(kept.join("\n")).trim();
}

function hidesSourceAttribution(sourceType) {
  const normalized = String(sourceType ?? "").trim();
  return Boolean(normalized) && !allowsPublicSourceAttribution(normalized);
}

function isSourceLabelLine(line) {
  const lowered = line.trim().toLowerCase();
  return SOURCE_LINE_PREFIXES.some((prefix) => lowered.startsWith(prefix));
}

function collapseBlankRuns(text) {
  return text.replace(/\n{3,}/g, "\n\n");
}

/**
 * Remove the appended community-footer block, located by its structural
 * sentinel — never by matching the visible title, which an untrusted body could
 * contain. Text without the sentinel (i.e. anything we did not just footer) is
 * returned unchanged.
 */
/**
 * Remove trailing rendered community footers from plain text.
 *
 * `stripCommunityFooter` below cannot do this: it looks for the private-use
 * sentinel, which `formatPostHtml` deletes before the text ever leaves the
 * process. So the footer an admin sees in a draft carries no marker at all, and
 * the only reliable handle on it is the exact block `formatCommunityFooter`
 * produces.
 *
 * Loops, because a draft saved more than once before this was fixed can carry
 * several stacked footers; each pass peels one off.
 */
export function stripRenderedCommunityFooter(text) {
  const footer = rstrip(formatCommunityFooter());
  let result = rstrip(String(text ?? ""));
  if (!footer) {
    return result;
  }
  while (result.endsWith(footer)) {
    result = rstrip(result.slice(0, result.length - footer.length));
  }
  return result;
}

export function stripCommunityFooter(text) {
  const index = String(text).indexOf(FOOTER_SENTINEL);
  if (index === -1) {
    return text;
  }
  return rstrip(String(text).slice(0, index));
}

function formatPlainLink(keyPrefix) {
  const label = t(`${keyPrefix}.label`).trim();
  if (!label) {
    return "";
  }

  return label;
}

function footerLinkUrl(keyPrefix) {
  return tOptional(`${keyPrefix}.url`, "").trim();
}

function prepareBodyText(text, includeCommunityFooter) {
  // Strip any sentinel an untrusted body might contain, so it cannot fake or move
  // the footer marker we add below (the suppression/hijack vector).
  const body = String(text ?? "")
    .split(FOOTER_SENTINEL)
    .join("")
    .trim();
  if (!includeCommunityFooter) {
    return body;
  }

  const footer = formatCommunityFooter();
  if (!footer) {
    return body;
  }

  // The footer is ALWAYS appended fresh (the rendered output strips the sentinel
  // and is never re-fed, so there is nothing to double-append), and is marked with
  // the sentinel so linkFooterItems can find it structurally.
  const block = `${FOOTER_SENTINEL}${footer}`;
  return body ? `${body}\n\n${block}` : block;
}

function formatBodyHtml(text, { sourceUrl, sourceType, allowSourceLink, linkFooter }) {
  const attribution = SOURCE_ATTRIBUTIONS[String(sourceType ?? "").trim()];
  const line = attribution === undefined ? null : `${attribution.prefix}${attribution.label}${attribution.suffix}`;
  let rendered;
  if (!allowSourceLink || !sourceUrl || !isSafeHttpUrl(sourceUrl)) {
    rendered = htmlEscape(text);
  } else if (line !== null && text.includes(line)) {
    // Only the exact line this source is known to close with becomes a link, and
    // only its label: a stray "офіційному сайті" inside a sentence stays plain.
    const sourceLink =
      `${htmlEscape(attribution.prefix)}` +
      `<a href="${htmlEscape(sourceUrl, true)}">${htmlEscape(attribution.label)}</a>` +
      `${htmlEscape(attribution.suffix)}`;
    rendered = text
      .split(line)
      .map((part) => htmlEscape(part))
      .join(sourceLink);
  } else {
    rendered = linkifyGenericSource(text, sourceUrl);
  }

  if (linkFooter) {
    rendered = linkFooterItems(rendered);
  }

  return rendered;
}

/**
 * Turn a "Джерело: <name>" line into a link to the source, escaping the rest.
 *
 * Falls back to plain escaped text when no such line is present, so non-source
 * posts are unaffected.
 */
function linkifyGenericSource(text, sourceUrl) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const stripped = line.trim();
    if (!stripped.startsWith(GENERIC_SOURCE_PREFIX)) {
      continue;
    }

    const name = rstrip(stripped.slice(GENERIC_SOURCE_PREFIX.length).trim(), ".").trim();
    if (!name) {
      continue;
    }

    const leading = line.slice(0, line.length - line.replace(/^\s+/, "").length);
    const linked =
      `${htmlEscape(leading)}${htmlEscape(GENERIC_SOURCE_PREFIX)} ` +
      `<a href="${htmlEscape(sourceUrl, true)}">${htmlEscape(name)}</a>`;
    const renderedLines = lines.map((other) => htmlEscape(other));
    renderedLines[index] = linked;
    return renderedLines.join("\n");
  }

  return htmlEscape(text);
}

function splitFooterLabel(label) {
  const index = label.indexOf(" ");
  if (index === -1) {
    return ["", label];
  }

  return [label.slice(0, index), label.slice(index + 1).trim()];
}

function linkFooterItems(renderedHtml) {
  // Locate the footer by the structural sentinel (placed just before it) rather
  // than the visible title, and drop the sentinel from the output.
  const markerIndex = renderedHtml.indexOf(FOOTER_SENTINEL);
  if (markerIndex === -1) {
    return renderedHtml;
  }

  const beforeFooter = renderedHtml.slice(0, markerIndex);
  let footer = renderedHtml.slice(markerIndex + FOOTER_SENTINEL.length);
  for (const keyPrefix of FOOTER_LINK_KEYS) {
    const url = footerLinkUrl(keyPrefix);
    if (!url || !isSafeHttpUrl(url)) {
      continue;
    }

    const label = t(`${keyPrefix}.label`).trim();
    const [icon, linkLabel] = splitFooterLabel(label);
    if (!linkLabel) {
      continue;
    }

    const plain = htmlEscape(label);
    const linked = `${htmlEscape(icon)} <a href="${htmlEscape(url, true)}">${htmlEscape(linkLabel)}</a>`;
    footer = replaceOnce(footer, plain, linked);
  }

  return beforeFooter + footer;
}

/** Python's `str.replace(old, new, 1)` — first occurrence only. */
function replaceOnce(text, search, replacement) {
  const index = text.indexOf(search);
  if (index === -1) {
    return text;
  }
  return text.slice(0, index) + replacement + text.slice(index + search.length);
}
