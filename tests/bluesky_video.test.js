/** Tests for resolving a Bluesky video post to its direct getBlob MP4 URL. */

import { afterEach, expect, it, vi } from "vitest";

import { pdsEndpoint, resolveVideoBlobUrl } from "../services/collectors/bluesky/video.js";

const DID = "did:plc:cbw6e4uggzgly7vfnde4rrac";
const CID = "bafkreieyoi3vyluyzrqqzctywn2we7zwdpl6nkpcd5hz43tuprkgy6odke";

afterEach(() => {
  vi.unstubAllGlobals();
});

function pdsDoc(endpoint) {
  return { service: [{ type: "AtprotoPersonalDataServer", serviceEndpoint: endpoint }] };
}

function stubDidDocument(document) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => document,
  }));
}

it("returns null for an unsupported or invalid DID", async () => {
  // did:web is not resolvable via plc.directory; garbage is rejected outright.
  expect(await resolveVideoBlobUrl("did:web:example.com", CID)).toBeNull();
  expect(await resolveVideoBlobUrl("garbage", CID)).toBeNull();
});

it("returns null for an empty CID", async () => {
  expect(await resolveVideoBlobUrl(DID, "")).toBeNull();
});

it("extracts the PDS endpoint", () => {
  expect(pdsEndpoint(pdsDoc("https://pds.host.bsky.network"))).toBe("https://pds.host.bsky.network");
  // Non-https endpoints and wrong service types are rejected; empty docs yield null.
  expect(pdsEndpoint(pdsDoc("http://pds.host.bsky.network"))).toBeNull();
  expect(pdsEndpoint({ service: [{ type: "Other", serviceEndpoint: "https://x.bsky.network" }] })).toBeNull();
  expect(pdsEndpoint({})).toBeNull();
});

it("rejects non-Bluesky PDS hosts", () => {
  // SSRF guard: the PDS host comes from the (attacker-influenceable) DID document,
  // so only Bluesky's own PDS domains are accepted — a hostname that could resolve
  // to an internal IP is refused outright.
  expect(pdsEndpoint(pdsDoc("https://attacker.example"))).toBeNull();
  expect(pdsEndpoint(pdsDoc("https://internal.host"))).toBeNull();
  // A look-alike suffix must not slip through.
  expect(pdsEndpoint(pdsDoc("https://evil-bsky.network.attacker.com"))).toBeNull();
});

it("strips path, userinfo and port from the PDS endpoint", () => {
  // A path/query must not corrupt the getBlob request target...
  expect(pdsEndpoint(pdsDoc("https://x.bsky.network/foo?a=b"))).toBe("https://x.bsky.network");
  // ...and userinfo smuggling (real host after @) is rejected, not honoured.
  expect(pdsEndpoint(pdsDoc("https://x.bsky.network@127.0.0.1/"))).toBeNull();
});

it("builds the getBlob URL", async () => {
  stubDidDocument(pdsDoc("https://polypore.host.bsky.network"));

  const url = await resolveVideoBlobUrl(DID, CID);

  expect(url).toBe(
    `https://polypore.host.bsky.network/xrpc/com.atproto.sync.getBlob` +
      `?did=${encodeURIComponent(DID)}&cid=${encodeURIComponent(CID)}`,
  );
});

it("returns null when the DID document has no usable PDS", async () => {
  stubDidDocument({ service: [] });
  expect(await resolveVideoBlobUrl(DID, CID)).toBeNull();
});

it("returns null when the directory request fails", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("network down");
  });
  expect(await resolveVideoBlobUrl(DID, CID)).toBeNull();
});
