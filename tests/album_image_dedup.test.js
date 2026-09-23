/**
 * Tests for dropping an image that is byte-identical to an earlier one in the
 * same post: publishers upload the same picture as the cover and again inside
 * the body, under different file names, so URL dedup cannot see it.
 */

import { afterEach, expect, it, vi } from "vitest";

import { dropDuplicateImages } from "../services/media_parser.js";

const COVER = "https://cdn.example.com/en_aUZqJrwL.png";
const BODY_COPY = "https://cdn.example.com/en_BRH4HFuL.png";
const SPECS = "https://cdn.example.com/specs.jpg";

/** A HEAD responder driven by a url -> headers map. */
function headStub(byUrl) {
  return vi.fn(async (url, options) => {
    expect(options.method).toBe("HEAD");
    const entry = byUrl[url];
    if (entry instanceof Error) throw entry;
    if (entry === undefined) return { ok: false, status: 404, headers: new Headers() };
    return { ok: true, status: 200, headers: new Headers(entry) };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("drops the later copy when the CDN reports the same content", async () => {
  const same = { etag: '"17E7F4A58E028D34"', "content-length": "866344" };
  vi.stubGlobal("fetch", headStub({
    [COVER]: same,
    [BODY_COPY]: same,
    [SPECS]: { etag: '"E26644110B924"', "content-length": "1224440" },
  }));

  expect(await dropDuplicateImages([COVER, BODY_COPY, SPECS])).toEqual([COVER, SPECS]);
});

it("treats a weak validator as the same image", async () => {
  vi.stubGlobal("fetch", headStub({
    [COVER]: { etag: 'W/"abc"', "content-length": "10" },
    [BODY_COPY]: { etag: '"abc"', "content-length": "10" },
  }));

  expect(await dropDuplicateImages([COVER, BODY_COPY])).toEqual([COVER]);
});

it("keeps both when the same validator covers different lengths", async () => {
  vi.stubGlobal("fetch", headStub({
    [COVER]: { etag: '"abc"', "content-length": "10" },
    [BODY_COPY]: { etag: '"abc"', "content-length": "20" },
  }));

  expect(await dropDuplicateImages([COVER, BODY_COPY])).toEqual([COVER, BODY_COPY]);
});

it("keeps an image whose identity cannot be established", async () => {
  vi.stubGlobal("fetch", headStub({
    [COVER]: { "content-length": "10" }, // no ETag
    [BODY_COPY]: { "content-length": "10" },
    [SPECS]: new Error("connection reset"),
  }));

  expect(await dropDuplicateImages([COVER, BODY_COPY, SPECS])).toEqual([COVER, BODY_COPY, SPECS]);
});

it("keeps an image the server refuses to describe", async () => {
  vi.stubGlobal("fetch", headStub({ [COVER]: { etag: '"a"', "content-length": "1" } }));

  // BODY_COPY answers 404 to HEAD; it must survive rather than vanish.
  expect(await dropDuplicateImages([COVER, BODY_COPY])).toEqual([COVER, BODY_COPY]);
});

it("never probes a post that cannot have a duplicate", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);

  expect(await dropDuplicateImages([COVER])).toEqual([COVER]);
  expect(await dropDuplicateImages([])).toEqual([]);
  expect(await dropDuplicateImages(null)).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it("preserves the original order of the images it keeps", async () => {
  const extra = "https://cdn.example.com/fourth.png";
  vi.stubGlobal("fetch", headStub({
    [COVER]: { etag: '"a"', "content-length": "1" },
    [SPECS]: { etag: '"b"', "content-length": "2" },
    [BODY_COPY]: { etag: '"a"', "content-length": "1" },
    [extra]: { etag: '"c"', "content-length": "3" },
  }));

  expect(await dropDuplicateImages([COVER, SPECS, BODY_COPY, extra])).toEqual([COVER, SPECS, extra]);
});
