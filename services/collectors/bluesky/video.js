/**
 * Resolve a Bluesky video post to a direct MP4 URL.
 *
 * A video embed exposes only an HLS playlist (m3u8) — which would need ffmpeg to
 * mux into a Telegram-playable MP4. The ORIGINAL uploaded MP4, however, is a blob
 * on the author's PDS, fetchable via `com.atproto.sync.getBlob`. We resolve the
 * author's PDS from the DID document (plc.directory) and build that getBlob URL,
 * so the video can be downloaded as a plain MP4 — no ffmpeg, no HLS.
 */

import { getLogger } from "../../logger.js";
import { errorText, rstrip } from "../../pyutils.js";
import { quoteAll, urlsplit } from "../../urlutils.js";

const logger = getLogger("services.collectors.bluesky.video");

export const PLC_DIRECTORY_URL = "https://plc.directory";
export const GETBLOB_PATH = "/xrpc/com.atproto.sync.getBlob";
export const REQUEST_TIMEOUT_SECONDS = 20.0;
const PDS_SERVICE_TYPE = "AtprotoPersonalDataServer";

// Only did:plc is resolvable via plc.directory; did:web resolution differs and is
// not supported (the post then falls back to a text post).
const DID_PLC_RE = /^did:plc:[a-z2-7]{20,}$/;

// The PDS host comes from the DID document, which is attacker-influenceable. It is
// therefore constrained to Bluesky's own PDS domains (the followed actor is
// bsky-hosted on *.host.bsky.network) so a tampered serviceEndpoint can never point
// the downloader at an internal host — an SSRF guard the IP-literal block alone
// can't provide (a hostname can resolve to an internal IP). An actor on a custom
// PDS simply falls back to a text post.
const ALLOWED_PDS_HOSTS = new Set(["bsky.social"]);
const ALLOWED_PDS_HOST_SUFFIXES = [".bsky.network"];

/**
 * The getBlob MP4 URL for (did, cid), or null when the DID is not a resolvable
 * did:plc, the PDS cannot be found, or the endpoint is unsafe.
 */
export async function resolveVideoBlobUrl(did, cid) {
  if (!DID_PLC_RE.test(did || "")) {
    logger.info(`Bluesky video: unsupported/invalid DID ${JSON.stringify(did)}`);
    return null;
  }
  if (!cid) {
    return null;
  }

  const document = await fetchDidDocument(did);
  if (document === null) {
    return null;
  }

  const pds = pdsEndpoint(document);
  if (pds === null) {
    logger.info(`Bluesky video: no PDS endpoint in DID document for ${did}`);
    return null;
  }

  return `${rstrip(pds, "/")}${GETBLOB_PATH}?did=${quoteAll(did)}&cid=${quoteAll(cid)}`;
}

async function fetchDidDocument(did) {
  try {
    const response = await fetch(`${PLC_DIRECTORY_URL}/${quoteAll(did)}`, {
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_SECONDS * 1000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const document = await response.json();
    return document !== null && typeof document === "object" && !Array.isArray(document) ? document : null;
  } catch (error) {
    logger.warning(`Bluesky video: failed to resolve DID ${did}: ${errorText(error)}`);
    return null;
  }
}

/** Exported for the unit tests, which cover the SSRF guard on its own. */
export function pdsEndpoint(document) {
  for (const service of document.service ?? []) {
    if (service === null || typeof service !== "object" || Array.isArray(service)) {
      continue;
    }
    if (service.type !== PDS_SERVICE_TYPE) {
      continue;
    }
    const base = normalizedPdsBase(String(service.serviceEndpoint ?? "").trim());
    if (base) {
      return base;
    }
  }
  return null;
}

/**
 * A safe `https://host` base for a Bluesky PDS endpoint, or null.
 *
 * Accepts only https endpoints on an allowlisted Bluesky PDS host, and rebuilds
 * the base from the bare host alone — dropping any userinfo, port, path, query or
 * fragment so a crafted serviceEndpoint can neither retarget the getBlob request
 * (e.g. `https://x.bsky.network@127.0.0.1/`) nor corrupt its path.
 */
function normalizedPdsBase(endpoint) {
  const parsed = urlsplit(endpoint);
  if (parsed.scheme !== "https" || !parsed.hostname) {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_PDS_HOSTS.has(host) && !ALLOWED_PDS_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return null;
  }
  return `https://${host}`;
}
