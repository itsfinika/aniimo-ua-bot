/**
 * Tests for keeping a source post's own links: only trusted sources, only
 * allowlisted destinations, shorteners judged by where they actually go.
 *
 * The Python version swapped out httpx's AsyncClient; here the global `fetch` is
 * replaced, which is the same seam one level lower.
 */

import { afterEach, expect, it, vi } from "vitest";

import { __testing, geminiDraftInput } from "../services/gemini.js";
import { collectPublishableLinks } from "../services/source_links.js";

const { appendExtraLinks } = __testing;

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeResponse(status, location = null) {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === "location" ? location : null) },
  };
}

async function run(text, { sourceType = "bluesky", redirects = {}, articleUrl = "" } = {}) {
  const calls = [];
  vi.stubGlobal("fetch", async (url) => {
    calls.push(String(url));
    const result = redirects[String(url)];
    if (result instanceof Error) {
      throw result;
    }
    return result ?? fakeResponse(404);
  });

  const links = await collectPublishableLinks(text, { source_type: sourceType, article_url: articleUrl });
  return { links, calls };
}

it("keeps an allowlisted link without any request", async () => {
  const { links, calls } = await run("Watch it here: https://www.twitch.tv/aniimo now!");

  expect(links).toEqual([["Twitch", "https://www.twitch.tv/aniimo"]]);
  expect(calls).toEqual([]); // a direct allowlisted host needs no resolution
});

it("resolves a shortener and keeps it when it lands somewhere allowed", async () => {
  // The real case: the official account posts a bit.ly link to its Spotify playlist.
  const { links, calls } = await run("Add it to your rotation: https://bit.ly/3RSAwZl", {
    redirects: { "https://bit.ly/3RSAwZl": fakeResponse(301, "https://open.spotify.com/playlist/abc") },
  });

  expect(links).toEqual([["Spotify", "https://open.spotify.com/playlist/abc"]]);
  expect(calls).toEqual(["https://bit.ly/3RSAwZl"]);
});

it("drops a shortener pointing somewhere unlisted", async () => {
  const { links } = await run("Free skins here https://bit.ly/scam", {
    redirects: { "https://bit.ly/scam": fakeResponse(301, "https://totally-legit-skins.example.com/claim") },
  });

  expect(links).toEqual([]);
});

it("follows only one redirect hop", async () => {
  // A shortener that redirects to another shortener is not chased further.
  const { links, calls } = await run("https://bit.ly/a", {
    redirects: {
      "https://bit.ly/a": fakeResponse(301, "https://tinyurl.com/b"),
      "https://tinyurl.com/b": fakeResponse(301, "https://www.twitch.tv/x"),
    },
  });

  expect(links).toEqual([]);
  expect(calls).toEqual(["https://bit.ly/a"]);
});

it("never keeps links from untrusted sources", async () => {
  // Reddit carries user-submitted leak content — the likeliest place for a
  // hostile link — and Aniimo Tools is an unvetted third party, so nothing is
  // kept even from an allowlisted host.
  for (const sourceType of ["reddit", "aniimotools", "official_aniimo", "steam", "youtube", "wiki_aniimo"]) {
    const { links, calls } = await run("See https://www.twitch.tv/aniimo", { sourceType });
    expect(links, sourceType).toEqual([]);
    expect(calls, sourceType).toEqual([]);
  }
});

it("labels the official site, the wiki and the store pages", async () => {
  // The devs link their own site (and its subdomains), plus the platform stores
  // for the mobile and PC launches; each gets a readable label.
  const cases = [
    ["https://www.aniimo.com/newslist/detail/100145", "Офіційний сайт"],
    ["https://wiki.aniimo.com/en/item/001", "Офіційний сайт"],
    ["https://pawprintstudio.com/about", "Pawprint Studio"],
    ["https://store.steampowered.com/app/4126040/Aniimo/", "Steam"],
    ["https://store.epicgames.com/en-US/p/aniimo", "Epic Games Store"],
    ["https://apps.apple.com/app/aniimo/id123", "App Store"],
    ["https://play.google.com/store/apps/details?id=com.aniimo", "Google Play"],
  ];
  for (const [url, label] of cases) {
    const { links, calls } = await run(`Get it: ${url}`);
    expect(links, url).toEqual([[label, url]]);
    expect(calls, url).toEqual([]);
  }
});

it("drops an unlisted host", async () => {
  const { links } = await run("Check https://evil.example.com/free-units");
  expect(links).toEqual([]);
});

it("does not treat a look-alike host as allowlisted", async () => {
  for (const url of [
    "https://aniimo.com.attacker.example/x",
    "https://store.epicgames.com.evil.example/x",
    "https://nottwitch.tv/x",
    "https://twitch.tv.evil.example/x",
  ]) {
    const { links } = await run(`Look ${url}`);
    expect(links, url).toEqual([]);
  }
});

it("upgrades http links to allowed hosts", async () => {
  const { links } = await run("Watch http://www.twitch.tv/aniimo");
  expect(links).toEqual([["Twitch", "https://www.twitch.tv/aniimo"]]);
});

it("still drops http links elsewhere", async () => {
  const { links } = await run("Deal here http://free-units.example.com/x");
  expect(links).toEqual([]);
});

it("upgrades a shortener that resolves to http", async () => {
  // bit.ly really does hand back an http URL for a YouTube Short; dropping that
  // would lose a perfectly good link on a technicality.
  const { links } = await run("https://bit.ly/4vGjcok", {
    redirects: { "https://bit.ly/4vGjcok": fakeResponse(301, "http://youtube.com/shorts/CQOBa-OwJMQ") },
  });

  expect(links).toEqual([["YouTube", "https://youtube.com/shorts/CQOBa-OwJMQ"]]);
});

it("rejects non-http schemes", async () => {
  for (const text of ["javascript:alert(1)//www.twitch.tv/x", "ftp://www.twitch.tv/x", "data:text/html;base64,AAAA"]) {
    const { links } = await run(`Look ${text}`);
    expect(links, text).toEqual([]);
  }
});

it("does not repeat the source URL itself", async () => {
  const post = "https://www.twitch.tv/aniimo and https://bsky.app/profile/x/post/1";
  const { links } = await run(post, { articleUrl: "https://bsky.app/profile/x/post/1" });

  expect(links).toEqual([["Twitch", "https://www.twitch.tv/aniimo"]]);
});

it("trims trailing punctuation", async () => {
  const { links } = await run("Watch (https://www.twitch.tv/aniimo).");
  expect(links).toEqual([["Twitch", "https://www.twitch.tv/aniimo"]]);
});

it("keeps at most two links", async () => {
  const text = ["https://www.twitch.tv/a", "https://www.youtube.com/watch?v=b", "https://discord.gg/c"].join(" ");
  const { links } = await run(text);
  expect(links).toHaveLength(2);
});

it("simply drops a failing shortener", async () => {
  const { links } = await run("https://bit.ly/down", {
    redirects: { "https://bit.ly/down": new Error("boom") },
  });

  expect(links).toEqual([]);
});

// --- rendering -----------------------------------------------------------------

function draftInputWith(links) {
  return geminiDraftInput({
    title: "t",
    article_url: "https://bsky.app/x",
    article_date_display: null,
    datetime_notes: null,
    body_text: "b",
    source_type: "bluesky",
    source_name: "Bluesky Aniimo",
    extra_links: links,
  });
}

it("appends links after the draft", () => {
  const result = appendExtraLinks(
    "Готуйтеся до нового кліпу.",
    draftInputWith([["Spotify", "https://open.spotify.com/p"]]),
  );

  expect(result.split("\n")[0]).toBe("Готуйтеся до нового кліпу.");
  expect(result.endsWith("🔗 Spotify: https://open.spotify.com/p")).toBe(true);
});

it("leaves the draft untouched when there are no links", () => {
  expect(appendExtraLinks("Текст", draftInputWith([]))).toBe("Текст");
});

it("does not duplicate a link the draft already contains", () => {
  const draft = "Слухайте тут: https://open.spotify.com/p";
  expect(appendExtraLinks(draft, draftInputWith([["Spotify", "https://open.spotify.com/p"]]))).toBe(draft);
});
