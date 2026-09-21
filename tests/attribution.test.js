/**
 * Tests for per-source attribution: the source line is admin-only metadata, so a
 * public post carries none — except the reader call-to-action the official site,
 * Steam and the wiki rubric close with. Covers the Gemini source/hashtag lines,
 * the shared allow-source-link predicate, and the footer linkification of those
 * call-to-action lines.
 */

import { expect, it } from "vitest";

import { __testing, geminiDraftInput } from "../services/gemini.js";
import { t } from "../services/i18n.js";
import {
  OFFICIAL_SOURCE_ATTRIBUTION,
  SOURCE_ATTRIBUTIONS,
  attributionLine,
  formatPostHtml,
  submissionAllowsSourceLink,
} from "../services/post_footer.js";

const { buildPrompt, ensureRequiredMetadata, fallbackTags, publicHashtagLine, selectPromptTemplate, sourceAttributionLine } =
  __testing;

const WIKI_ATTRIBUTION = "Більше про цю істоту — в офіційній вікі.";
const STEAM_ATTRIBUTION = "Повні деталі — на сторінці у Steam.";

function draft(sourceType, sourceName = "Bluesky Aniimo") {
  return geminiDraftInput({
    title: "title",
    article_url: "https://example.com/1",
    article_date_display: null,
    datetime_notes: null,
    body_text: "body",
    source_type: sourceType,
    source_name: sourceName,
  });
}

it("gives an ordinary collector post no public source line", () => {
  // The source is shown to moderators in the submission card, not to readers.
  expect(sourceAttributionLine(draft("bluesky", "Bluesky Aniimo"))).toBe("");
  expect(sourceAttributionLine(draft("youtube", "YouTube Aniimo"))).toBe("");
  expect(sourceAttributionLine(draft("reddit", "Reddit"))).toBe("");
  expect(sourceAttributionLine(draft("aniimotools", "Aniimo Tools"))).toBe("");
});

it("closes the wiki rubric with its reader link, not a source credit", () => {
  // The official wiki needs no CC BY-SA credit; the post points readers at the
  // creature's page instead.
  expect(sourceAttributionLine(draft("wiki_aniimo", "офіційна вікі Aniimo"))).toBe(WIKI_ATTRIBUTION);
  expect(sourceAttributionLine(draft("wiki_aniimo"))).not.toContain("Джерело");
});

it("leaves official attribution unchanged", () => {
  expect(sourceAttributionLine(draft("official_aniimo"))).toBe(OFFICIAL_SOURCE_ATTRIBUTION);
  expect(OFFICIAL_SOURCE_ATTRIBUTION).toBe("Повні деталі — на офіційному сайті.");
});

it("gives Steam its own reader link", () => {
  expect(sourceAttributionLine(draft("steam"))).toBe(t("gemini.attribution.steam"));
  expect(sourceAttributionLine(draft("steam"))).toBe(STEAM_ATTRIBUTION);
});

it("spells every call-to-action the same in the locale and the link table", () => {
  // The draft is written from gemini.attribution.<type>; the link is applied from
  // SOURCE_ATTRIBUTIONS. They only meet when the two spell the line identically.
  expect(Object.keys(SOURCE_ATTRIBUTIONS).sort()).toEqual(["official_aniimo", "steam", "wiki_aniimo"]);
  for (const sourceType of Object.keys(SOURCE_ATTRIBUTIONS)) {
    expect(attributionLine(sourceType)).toBe(t(`gemini.attribution.${sourceType}`));
  }
  expect(attributionLine("bluesky")).toBeNull();
});

it("drops #Офіційно from non-official hashtags", () => {
  const line = publicHashtagLine(draft("bluesky"));
  expect(line).not.toContain("#Офіційно");
  expect(line).toContain("#AniimoUA");
  expect(line.replace("#AniimoUA", "")).toContain("#"); // also carries a topic tag now
});

it("gives non-official posts topic tags", () => {
  const line = publicHashtagLine(
    geminiDraftInput({
      title: "New trailer reveal",
      article_url: "https://x",
      article_date_display: null,
      datetime_notes: null,
      body_text: "watch the trailer",
      source_type: "youtube",
      source_name: "YT",
    }),
  );
  expect(line).toContain("#Трейлер");
  expect(line).toContain("#AniimoUA");
  expect(line).not.toContain("#Офіційно");
});

function leak(title, body, sourceType = "reddit") {
  return geminiDraftInput({
    title,
    article_url: "https://reddit.com/x",
    article_date_display: null,
    datetime_notes: null,
    body_text: body,
    source_type: sourceType,
    source_name: "Reddit (витоки та чутки Aniimo)",
  });
}

it("always carries the rumour tag on a leak", () => {
  // Even when a topic tag matches, the marker stays — a label that shows up at
  // random is one readers cannot rely on.
  const line = publicHashtagLine(leak("New outfit leaked", "a datamined costume for Emberpup"));

  expect(line).toContain("#Чутки");
  expect(line).toContain("#Косметика");
  expect(line).not.toContain("#Офіційно");
});

it("does not call a topic-less leak an announcement", () => {
  const line = publicHashtagLine(leak("Something odd in the files", "an unnamed asset showed up"));

  expect(line).toContain("#Чутки");
  expect(line).not.toContain("#Анонс");
});

it("does not treat Aniimo Tools as a rumour", () => {
  // A fan news site is unofficial but not a leak: it gets the ordinary
  // short-form tags, without either marker.
  const line = publicHashtagLine(
    geminiDraftInput({
      title: "Outfit render",
      article_url: "https://aniimotools.dev/articles/outfit-render/",
      article_date_display: null,
      datetime_notes: null,
      body_text: "upcoming render",
      source_type: "aniimotools",
      source_name: "Aniimo Tools",
    }),
  );

  expect(line).toContain("#AniimoUA");
  expect(line).toContain("#Косметика");
  expect(line).not.toContain("#Чутки");
  expect(line).not.toContain("#Офіційно");
});

it("gives the wiki rubric its fixed hashtags", () => {
  // A creature fact sheet never matches the news topic rules, so it must not fall
  // through to "#Анонс".
  const line = publicHashtagLine(draft("wiki_aniimo"));

  expect(line).toBe(t("collectors.wiki_aniimo.hashtags"));
  expect(line).toBe("#AniimoUA #АніімоТижня");
});

it("keeps the stored rumour tags in step with the public marker", () => {
  const tags = fallbackTags(leak("New outfit leaked", "a datamined costume"));

  expect(tags).toContain("чутки");
  expect(tags).toContain("aniimoua");
});

it("keeps the announcement fallback for non-rumour sources", () => {
  // Bluesky/YouTube really do carry announcements, so their default is untouched.
  const line = publicHashtagLine(draft("bluesky"));

  expect(line).toContain("#Анонс");
  expect(line).not.toContain("#Чутки");
  expect(fallbackTags(draft("bluesky"))).not.toContain("чутки");
});

it("leaves official hashtags untouched by the rumour branch", () => {
  for (const sourceType of ["official_aniimo", "steam"]) {
    const line = publicHashtagLine(draft(sourceType));

    expect(line.startsWith("#AniimoUA #Офіційно")).toBe(true);
    expect(line).not.toContain("#Чутки");
  }
});

it("gates the source link on both a source type and a URL", () => {
  expect(submissionAllowsSourceLink({ source_type: "official_aniimo", source_url: "https://x" })).toBe(true);
  expect(submissionAllowsSourceLink({ source_type: "bluesky", source_url: "https://x" })).toBe(true);
  expect(submissionAllowsSourceLink({ source_type: "", source_url: "https://x" })).toBe(false); // user submission
  expect(submissionAllowsSourceLink({ source_type: "bluesky", source_url: "" })).toBe(false);
  expect(submissionAllowsSourceLink({})).toBe(false);
});

it("strips a generic source line from the wiki rubric too", () => {
  // The wiki used to be the one source allowed to keep "Джерело:" publicly (its
  // CC BY-SA credit); the official wiki needs none, so nothing keeps it now.
  const html = formatPostHtml("Текст новини.\n\nДжерело: офіційна вікі Aniimo", {
    source_url: "https://wiki.aniimo.com/en/item/001",
    source_type: "wiki_aniimo",
    allow_source_link: true,
  });
  expect(html).not.toContain("<a");
  expect(html).not.toContain("Джерело");
  expect(html).toContain("Текст новини.");
});

it("strips the generic source line whether or not linking is allowed", () => {
  const html = formatPostHtml("Текст новини.\n\nДжерело: офіційна вікі Aniimo", {
    source_url: "https://wiki.aniimo.com/en/item/001",
    source_type: "wiki_aniimo",
    allow_source_link: false,
  });
  expect(html).not.toContain("<a");
  expect(html).not.toContain("Джерело");
});

it("still knows how to link a generic source line", () => {
  // The mechanism stays for a future licence-bound source; with no source type
  // the line is left in place, and with a safe URL it becomes the link.
  const html = formatPostHtml("Текст новини.\n\nДжерело: Bluesky Aniimo", {
    source_url: "https://bsky.app/profile/x",
    allow_source_link: true,
  });
  expect(html).toContain('<a href="https://bsky.app/profile/x">Bluesky Aniimo</a>');
  expect(html).toContain("Джерело:");
});

it("does not link a generic source without a URL", () => {
  const html = formatPostHtml("Джерело: Bluesky Aniimo", {
    source_url: "",
    allow_source_link: true,
  });
  expect(html).not.toContain("<a");
});

it("drops a source line from an ordinary collector post at render time", () => {
  // Covers drafts queued before the line became admin-only: they must not reach
  // the channel with it, and the moderation preview must show what will publish.
  const html = formatPostHtml("Текст новини.\n\nДжерело: YouTube Aniimo\n\n#AniimoUA", {
    source_url: "https://youtube.com/watch?v=1",
    source_type: "youtube",
    allow_source_link: true,
  });

  expect(html).not.toContain("Джерело");
  expect(html).not.toContain("YouTube Aniimo");
  expect(html).toContain("Текст новини.");
  expect(html).toContain("#AniimoUA");
  // The gap the removed line left is closed, not left as a double blank.
  expect(html).not.toContain("\n\n\n");
});

it("links the wiki rubric's call-to-action instead of a source credit", () => {
  const html = formatPostHtml(`🐾 Аніімо тижня — Emberpup\n\nДжерело: офіційна вікі Aniimo\n\n${WIKI_ATTRIBUTION}`, {
    source_url: "https://wiki.aniimo.com/en/item/001",
    source_type: "wiki_aniimo",
    allow_source_link: true,
  });

  expect(html).not.toContain("Джерело");
  expect(html).toContain('Більше про цю істоту — в <a href="https://wiki.aniimo.com/en/item/001">офіційній вікі</a>.');
});

it("leaves a user submission's own text alone", () => {
  // No source type = a reader's submission; its wording is the author's, not ours.
  const html = formatPostHtml("Дивіться, що знайшов.\n\nДжерело: мій друг", {
    source_url: "",
    allow_source_link: false,
  });

  expect(html).toContain("Джерело: мій друг");
});

it("keeps an inline source mention that is not a label line", () => {
  const html = formatPostHtml("Гравці кажуть (джерело: форум), що патч близько.", {
    source_url: "https://reddit.com/x",
    source_type: "reddit",
    allow_source_link: true,
  });

  expect(html).toContain("джерело: форум");
});

it("still linkifies the official source", () => {
  const html = formatPostHtml(`Текст. ${OFFICIAL_SOURCE_ATTRIBUTION}`, {
    source_url: "https://www.aniimo.com/newslist/detail/1",
    source_type: "official_aniimo",
    allow_source_link: true,
  });
  expect(html).toContain('<a href="https://www.aniimo.com/newslist/detail/1">офіційному сайті</a>');
});

it("linkifies the Steam call-to-action", () => {
  const html = formatPostHtml(`Текст. ${STEAM_ATTRIBUTION}`, {
    source_url: "https://store.steampowered.com/news/app/4126040/view/1",
    source_type: "steam",
    allow_source_link: true,
  });
  expect(html).toContain(
    'Повні деталі — на <a href="https://store.steampowered.com/news/app/4126040/view/1">сторінці у Steam</a>.',
  );
});

it("links only the line that belongs to the post's own source", () => {
  // A Steam post that somehow carries the official site's line gets no link: the
  // URL is a Steam page, and the anchor text would promise the wrong place.
  const html = formatPostHtml(`Текст. ${OFFICIAL_SOURCE_ATTRIBUTION}`, {
    source_url: "https://store.steampowered.com/news/app/4126040/view/1",
    source_type: "steam",
    allow_source_link: true,
  });
  expect(html).not.toContain("<a");
  expect(html).toContain(OFFICIAL_SOURCE_ATTRIBUTION);
});

it("plainly escapes text without a source line", () => {
  const html = formatPostHtml("Просто текст без джерела", {
    source_url: "https://x",
    allow_source_link: true,
  });
  expect(html).not.toContain("<a");
  expect(html).toContain("Просто текст без джерела");
});

it("selects the article prompt for the official sources", () => {
  expect(selectPromptTemplate(draft("official_aniimo"))).toContain("Текст статті:");
  expect(selectPromptTemplate(draft("steam"))).toContain("Текст статті:");
});

it("selects the short-form prompt for a non-official source", () => {
  for (const sourceType of ["bluesky", "aniimotools"]) {
    const template = selectPromptTemplate(draft(sourceType));
    expect(template.toLowerCase()).toContain("короткий допис");
    expect(template).not.toContain("Текст статті:");
    // The short-form post must be broken into paragraphs, not one solid block.
    expect(template.toLowerCase()).toContain("абзац");
  }
});

it("gives a short-form draft no publication-date line", () => {
  // Non-official (social/short-form) posts must NOT carry a bare "2026-06-12"
  // publication-date line mid-post — only the body, the source attribution and
  // the hashtags. The date stays available to admins via original_text.
  const draftInput = geminiDraftInput({
    title: "Анонс",
    article_url: "https://bsky.app/profile/x/post/1",
    article_date_display: "2026-06-12",
    datetime_notes: null,
    body_text: "body",
    source_type: "bluesky",
    source_name: "Bluesky Aniimo",
  });

  const result = ensureRequiredMetadata("Текст допису про подію.", draftInput);

  expect(result).not.toContain("2026-06-12");
  expect(result).not.toContain("Джерело");
  expect(result).toContain("#AniimoUA");
});

it("drops a source line the model added to a short-form draft anyway", () => {
  const result = ensureRequiredMetadata("Текст допису.\n\nДжерело: Bluesky Aniimo", draft("bluesky", "Bluesky Aniimo"));

  expect(result).not.toContain("Джерело");
  expect(result).toContain("Текст допису.");
});

it("adds the wiki call-to-action to a creature draft that omitted it", () => {
  const result = ensureRequiredMetadata(
    "🐾 Аніімо тижня — Emberpup\n\nВогняне аніімо, що бігає за Flameruff.",
    draft("wiki_aniimo", "офіційна вікі Aniimo"),
  );

  expect(result).toContain(WIKI_ATTRIBUTION);
  expect(result).not.toContain("Джерело");
  expect(result.endsWith("#AniimoUA #АніімоТижня")).toBe(true);
});

it("swaps a source credit the model wrote into the wiki draft for the call-to-action", () => {
  // The old rubric ended with "Джерело: … (CC BY-SA)", and a model may still
  // produce one; publicly that line is stripped, so it must not count as the
  // attribution — otherwise the post reaches the channel with no link at all.
  const result = ensureRequiredMetadata(
    "🐾 Аніімо тижня — Emberpup\n\nДжерело: офіційна вікі Aniimo",
    draft("wiki_aniimo", "офіційна вікі Aniimo"),
  );

  expect(result).not.toContain("Джерело");
  expect(result).toContain(WIKI_ATTRIBUTION);
});

it("adds the rumour notice to a Reddit prompt", () => {
  const prompt = buildPrompt(draft("reddit", "Reddit (витоки та чутки Aniimo)"));
  expect(prompt).toContain("НЕОФІЦІЙНИЙ");
  expect(prompt).toContain("датамайн");
  expect(prompt).not.toContain("{");
  expect(prompt).not.toContain("}");
});

it("adds no rumour notice to a non-rumour source", () => {
  for (const [sourceType, sourceName] of [
    ["bluesky", "Bluesky Aniimo"],
    ["aniimotools", "Aniimo Tools"],
  ]) {
    const prompt = buildPrompt(draft(sourceType, sourceName));
    expect(prompt).not.toContain("НЕОФІЦІЙНИЙ");
    expect(prompt).not.toContain("датамайн");
  }
});

it("fills every placeholder in the short-form prompt", () => {
  const prompt = buildPrompt(draft("bluesky", "Bluesky Aniimo"));
  expect(prompt).toContain("Bluesky Aniimo");
  expect(prompt).not.toContain("{"); // every placeholder was filled
  expect(prompt).not.toContain("}");
});

it("fills every placeholder in the creature prompt", () => {
  const prompt = buildPrompt(draft("wiki_aniimo", "офіційна вікі Aniimo"));
  expect(prompt).toContain(WIKI_ATTRIBUTION);
  expect(prompt).toContain("#АніімоТижня");
  expect(prompt).not.toContain("{");
  expect(prompt).not.toContain("}");
});

it("tells the short-form prompt not to attribute at all", () => {
  const prompt = buildPrompt(draft("bluesky", "Bluesky Aniimo"));

  expect(prompt).toContain("НЕ додавай атрибуцію");
  expect(prompt).not.toContain("Джерело: Bluesky Aniimo");
});
