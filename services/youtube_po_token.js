/**
 * Mint a WebPO ("Proof of Origin") token for the InnerTube session.
 *
 * YouTube answers a plain download from a datacenter IP with "Video is login
 * required" on every client — the exact failure the production logs show, while
 * the same video downloads fine from a home connection. A PO token is what the
 * real web player sends to prove the request comes from a genuine client, and it
 * reopens the WEB/MWEB download path from a server IP.
 *
 * Minting one means running Google's BotGuard VM, which is obfuscated
 * third-party JavaScript that expects a browser. It runs inside a jsdom window —
 * a separate `node:vm` realm with no `process`, no `require` and no `fetch` — so
 * it has nothing of the bot's to reach: not the Telegram token, not the
 * database. Only strings and byte arrays cross the boundary.
 *
 * Everything here degrades to null: a failed mint means the caller downloads
 * without a token, exactly as before.
 */

import { getLogger } from "./logger.js";
import { errorText } from "./pyutils.js";

const logger = getLogger("services.youtube_po_token");

// The request key YouTube's own web player uses for BotGuard attestation.
const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
// BotGuard is deliberately slow; well under this, but a hang must not wedge the
// scheduler tick that is waiting for a draft.
const MINT_TIMEOUT_MS = 60 * 1000;

/**
 * Return `{ poToken, visitorData }` for `visitorData`, or null when the token
 * cannot be minted (missing dependency, network failure, BotGuard refusal).
 */
export async function mintPoToken(visitorData) {
  if (!visitorData || !String(visitorData).trim()) {
    logger.info("No visitor data for the InnerTube session; skipping the PO token.");
    return null;
  }

  try {
    return await withTimeout(mint(String(visitorData)), MINT_TIMEOUT_MS);
  } catch (error) {
    logger.warning(`Could not mint a YouTube PO token (${errorText(error)}); downloading without one.`);
    return null;
  }
}

async function mint(visitorData) {
  const [{ JSDOM }, { BotGuardClient, getChallenge }, { base64ToU8, buildURL, u8ToBase64, GOOG_API_KEY, USER_AGENT }] =
    await Promise.all([import("jsdom"), import("bgutils-js/botguard"), import("bgutils-js/utils")]);

  const challenge = await getChallenge({ requestKey: REQUEST_KEY, fetchFunction: (...args) => fetch(...args) });
  const interpreterJavascript = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!interpreterJavascript || !challenge.globalName || !challenge.program) {
    throw new Error("BotGuard challenge is missing its interpreter, global name or program");
  }

  // `runScripts: "outside-only"` gives the window its own realm and an `eval`
  // that runs code INSIDE it, without letting page content script itself.
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.youtube.com/",
    referrer: "https://www.youtube.com/",
    userAgent: USER_AGENT,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });

  try {
    dom.window.eval(interpreterJavascript);
    if (!dom.window[challenge.globalName]) {
      throw new Error("BotGuard interpreter did not install its VM");
    }

    const client = await BotGuardClient.create({
      program: challenge.program,
      globalName: challenge.globalName,
      globalObject: dom.window,
    });

    const webPoSignalOutput = [];
    const botguardResponse = await client.snapshot({ webPoSignalOutput });
    const integrityToken = await requestIntegrityToken(botguardResponse, { buildURL, GOOG_API_KEY, USER_AGENT });

    const poToken = await mintToken(dom.window, webPoSignalOutput, integrityToken, visitorData, {
      base64ToU8,
      u8ToBase64,
    });
    logger.info("Minted a YouTube PO token for this session.");
    return { poToken, visitorData };
  } finally {
    dom.window.close();
  }
}

async function requestIntegrityToken(botguardResponse, { buildURL, GOOG_API_KEY, USER_AGENT }) {
  const response = await fetch(buildURL("GenerateIT", true), {
    method: "POST",
    headers: {
      "content-type": "application/json+protobuf",
      "x-goog-api-key": GOOG_API_KEY,
      "x-user-agent": "grpc-web-javascript/0.1",
      "user-agent": USER_AGENT,
    },
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!response.ok) {
    throw new Error(`integrity token request failed with HTTP ${response.status}`);
  }

  const [integrityToken] = await response.json();
  if (!integrityToken) {
    throw new Error("integrity token response carried no token");
  }
  return integrityToken;
}

/**
 * Run the minter BotGuard handed back.
 *
 * Its arguments are built with the WINDOW's `Uint8Array` / `TextEncoder` and its
 * result is copied back into ours: a typed array from another realm fails the
 * `instanceof` checks on both sides, which is what silently breaks the
 * library's own minter helper here.
 */
async function mintToken(window, webPoSignalOutput, integrityToken, visitorData, { base64ToU8, u8ToBase64 }) {
  const getMinter = webPoSignalOutput[0];
  if (typeof getMinter !== "function") {
    throw new Error("BotGuard returned no minter function");
  }

  const integrityBytes = base64ToU8(integrityToken);
  const windowBytes = new window.Uint8Array(integrityBytes.length);
  windowBytes.set(integrityBytes);

  const mintCallback = await getMinter(windowBytes);
  if (typeof mintCallback !== "function") {
    throw new Error("BotGuard did not accept the integrity token");
  }

  const minted = await mintCallback(new window.TextEncoder().encode(visitorData));
  if (!minted || typeof minted.length !== "number") {
    throw new Error("BotGuard minted no token");
  }

  return u8ToBase64(Uint8Array.from(minted), true);
}

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
