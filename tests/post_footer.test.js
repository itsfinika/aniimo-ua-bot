/**
 * Tests for the community-footer rendering, especially that the footer is located
 * by a structural sentinel — so an untrusted post body containing the visible
 * footer text can no longer suppress, hijack or forge the footer — and for the
 * per-source reader call-to-action lines that become the post's only link.
 */

import fs from "node:fs/promises";

import { expect, it } from "vitest";

import { t } from "../services/i18n.js";
import {
  OFFICIAL_SOURCE_ATTRIBUTION,
  PUBLIC_SOURCE_ATTRIBUTION_TYPES,
  SOURCE_ATTRIBUTIONS,
  attributionLine,
  formatCommunityFooter,
  formatCommunityFooterHtml,
  formatPostHtml,
} from "../services/post_footer.js";

const CHAT_LINK = '<a href="https://t.me/AniimoUAChat">Чат</a>';
const SUBMISSION_LINK = '<a href="https://t.me/AniimoUABot">Запропонувати новину</a>';
// The Discord link is parked: its copy stays in locales/uk.json but the url is
// blank until the community server exists, and a blank url keeps a link out of
// the footer altogether rather than printing it as dead text.
// The footer is one line of links now — no rule above it, no heading — so every
// label ends up inside an anchor and none of it survives as plain text. That is
// what an attacker would have to reproduce to forge it.
const FOOTER_TEXT = formatCommunityFooter();
// The private-use marker post_footer places before the appended footer. It is
// intentionally not exported: these tests assert it never reaches the output.
const FOOTER_SENTINEL = "";

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

it("appends the footer as one line of links", () => {
  const html = formatPostHtml("Свіжа новина.", { include_community_footer: true });

  expect(html).toContain(CHAT_LINK);
  expect(html).toContain(SUBMISSION_LINK);
  expect(html).not.toContain("Discord");
  expect(html).not.toContain(FOOTER_SENTINEL); // the marker never reaches output
});

it("carries no rule and no heading above the links", () => {
  const html = formatPostHtml("Свіжа новина.", { include_community_footer: true });

  expect(FOOTER_TEXT).toBe("💬 Чат | 🤖 Запропонувати новину");
  expect(html).not.toContain("─");
  expect(html).not.toContain("Навігація");
  // Body, one blank line, links — nothing between them.
  expect(html.startsWith("Свіжа новина.\n\n💬 ")).toBe(true);
});

it("does not let a body containing the footer text suppress the footer", () => {
  // The attack: a feed body that embeds the visible footer text used to make the
  // old substring check think the footer was already present and skip it.
  const malicious = `Дивіться: ${FOOTER_TEXT} (підробка) і ще текст.`;
  const html = formatPostHtml(malicious, { include_community_footer: true });

  // The real footer is still appended with working links...
  expect(html).toContain(CHAT_LINK);
  // ...and the label now appears at least twice: the attacker's escaped copy plus
  // the genuine appended footer (i.e. it was NOT suppressed).
  expect(countOccurrences(html, "Запропонувати новину")).toBeGreaterThanOrEqual(2);
  expect(html).not.toContain(FOOTER_SENTINEL);
});

it("strips a sentinel injected into the body", () => {
  const html = formatPostHtml(`зло${FOOTER_SENTINEL}текст`, { include_community_footer: true });
  expect(html).not.toContain(FOOTER_SENTINEL); // an injected sentinel cannot survive
  expect(html).toContain(CHAT_LINK); // and cannot move/suppress the real footer
});

it("adds no footer when it was not requested", () => {
  const html = formatPostHtml("Просто текст.", { include_community_footer: false });

  expect(html).not.toContain(CHAT_LINK);
  expect(html).not.toContain("Запропонувати новину");
  expect(html).not.toContain(FOOTER_SENTINEL);
});

it("linkifies the standalone footer helper without leaking the sentinel", () => {
  // The album digest caption builds its own HTML via this helper.
  const html = formatCommunityFooterHtml();

  expect(html).toContain(CHAT_LINK);
  expect(html).toContain(SUBMISSION_LINK);
  expect(html).not.toContain("Discord");
  expect(html).not.toContain(FOOTER_SENTINEL);
});

// --- per-source attribution ---------------------------------------------------

const ATTRIBUTION_CASES = [
  ["official_aniimo", "https://www.aniimo.com/newslist/detail/100145", "офіційному сайті"],
  ["steam", "https://store.steampowered.com/news/app/4126040/view/1", "сторінці у Steam"],
  ["wiki_aniimo", "https://wiki.aniimo.com/en/item/001", "офіційній вікі"],
];

it("spells every attribution line exactly like its locale string", () => {
  // Gemini writes the line from gemini.attribution.<type>; the renderer finds it
  // via SOURCE_ATTRIBUTIONS. They only meet when both spell it identically.
  for (const sourceType of Object.keys(SOURCE_ATTRIBUTIONS)) {
    expect(attributionLine(sourceType), sourceType).toBe(t(`gemini.attribution.${sourceType}`));
  }
  expect(Object.keys(SOURCE_ATTRIBUTIONS).sort()).toEqual(["official_aniimo", "steam", "wiki_aniimo"]);
});

it("keeps the official line under its old export name", () => {
  expect(OFFICIAL_SOURCE_ATTRIBUTION).toBe(attributionLine("official_aniimo"));
  expect(OFFICIAL_SOURCE_ATTRIBUTION).toBe("Повні деталі на офіційному сайті.");
});

it("has no line for a source without a call-to-action", () => {
  for (const sourceType of ["bluesky", "youtube", "reddit", "aniimotools", "", null, undefined]) {
    expect(attributionLine(sourceType), String(sourceType)).toBeNull();
  }
});

it.each(ATTRIBUTION_CASES)("linkifies only the label of the %s line", (sourceType, url, label) => {
  const line = attributionLine(sourceType);
  const html = formatPostHtml(`Текст.\n\n${line}`, {
    source_url: url,
    source_type: sourceType,
    allow_source_link: true,
  });

  expect(html).toContain(`<a href="${url}">${label}</a>`);
  // The lead-in and the full stop stay outside the anchor.
  expect(html).toContain(line.replace(label, `<a href="${url}">${label}</a>`));
  expect(html.split("<a ").length - 1).toBe(1);
});

it.each(ATTRIBUTION_CASES)("does not link the %s line when the link is disallowed", (sourceType, url) => {
  const line = attributionLine(sourceType);
  expect(formatPostHtml(line, { source_url: url, source_type: sourceType, allow_source_link: false })).not.toContain(
    "<a",
  );
  expect(formatPostHtml(line, { source_url: "", source_type: sourceType, allow_source_link: true })).not.toContain("<a");
  expect(
    formatPostHtml(line, { source_url: "javascript:alert(1)", source_type: sourceType, allow_source_link: true }),
  ).not.toContain("<a");
});

it("links only the line that belongs to the given source type", () => {
  // A Steam post that (wrongly) carries the site's line gets no link: the label
  // would point readers at the site while the URL is a Steam page.
  const html = formatPostHtml(`Текст. ${attributionLine("official_aniimo")}`, {
    source_url: "https://store.steampowered.com/news/app/4126040/view/1",
    source_type: "steam",
    allow_source_link: true,
  });
  expect(html).not.toContain("<a");
  expect(html).toContain("офіційному сайті");
});

it("leaves a label inside a sentence alone", () => {
  const html = formatPostHtml("Читайте про це на офіційному сайті, коли буде час.", {
    source_url: "https://www.aniimo.com/newslist/detail/1",
    source_type: "official_aniimo",
    allow_source_link: true,
  });
  expect(html).not.toContain("<a");
});

it("strips a public source label from every collector post", () => {
  // No source is licensed into naming itself any more: the wiki rubric, once the
  // only member of the allowlist, now uses its call-to-action line instead.
  expect(PUBLIC_SOURCE_ATTRIBUTION_TYPES.size).toBe(0);
  const html = formatPostHtml("Аніімо тижня — Emberpup.\n\nДжерело: офіційна вікі Aniimo\n\n#AniimoUA", {
    source_url: "https://wiki.aniimo.com/en/item/001",
    source_type: "wiki_aniimo",
    allow_source_link: true,
  });
  expect(html).not.toContain("Джерело");
  expect(html).toContain("Аніімо тижня — Emberpup.");
  expect(html).toContain("#AniimoUA");
});

it("parks a community link by blanking its url, keeping the copy for later", async () => {
  const locale = JSON.parse(await fs.readFile(new URL("../locales/uk.json", import.meta.url), "utf8"));
  const discord = locale.post_footer.links.discord;

  // The entry stays in place: restoring the invite is the whole change needed
  // to bring the link back into the footer.
  expect(discord.label).toBe("🎧 Discord");
  expect(discord.url).toBe("");
  // Parked means gone from the line, not shown without a link.
  expect(FOOTER_TEXT).not.toContain("Discord");
  expect(FOOTER_TEXT).toBe("💬 Чат | 🤖 Запропонувати новину");
});
