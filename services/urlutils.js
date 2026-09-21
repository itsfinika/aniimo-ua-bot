/**
 * URL helpers with Python's `urllib.parse` semantics.
 *
 * The security checks throughout this project (SSRF guards on media downloads,
 * the source-link allowlist, the Bluesky PDS pin) were written against
 * `urlsplit`, which never raises and reports an empty scheme/netloc for junk
 * input. The WHATWG `URL` constructor throws instead, and normalises as it
 * parses — so replacing one with the other would turn "this string is not a
 * usable URL, reject it" into an exception on some paths and an over-permissive
 * accept on others. These functions keep the original meaning.
 */

const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/**
 * Python `urllib.parse.urlsplit`. Never throws; unparseable input simply yields
 * empty components.
 *
 * @returns {{scheme: string, netloc: string, hostname: string, port: string,
 *            path: string, query: string, fragment: string}}
 */
export function urlsplit(value) {
  let rest = String(value ?? "");
  let scheme = "";

  const schemeMatch = SCHEME_RE.exec(rest);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    rest = rest.slice(schemeMatch[0].length);
  }

  let fragment = "";
  const hashIndex = rest.indexOf("#");
  if (hashIndex !== -1) {
    fragment = rest.slice(hashIndex + 1);
    rest = rest.slice(0, hashIndex);
  }

  let query = "";
  const queryIndex = rest.indexOf("?");
  if (queryIndex !== -1) {
    query = rest.slice(queryIndex + 1);
    rest = rest.slice(0, queryIndex);
  }

  let netloc = "";
  if (rest.startsWith("//")) {
    const afterSlashes = rest.slice(2);
    const endIndex = afterSlashes.search(/[/?#]/);
    if (endIndex === -1) {
      netloc = afterSlashes;
      rest = "";
    } else {
      netloc = afterSlashes.slice(0, endIndex);
      rest = afterSlashes.slice(endIndex);
    }
  }

  const { hostname, port } = splitHostPort(netloc);
  return { scheme, netloc, hostname, port, path: rest, query, fragment };
}

/** Python's `SplitResult.hostname` / `.port`: userinfo and port removed, lowercased. */
function splitHostPort(netloc) {
  let host = netloc;
  const atIndex = host.lastIndexOf("@");
  if (atIndex !== -1) {
    host = host.slice(atIndex + 1);
  }

  let port = "";
  if (host.startsWith("[")) {
    const closing = host.indexOf("]");
    if (closing !== -1) {
      const afterBracket = host.slice(closing + 1);
      if (afterBracket.startsWith(":")) port = afterBracket.slice(1);
      host = host.slice(1, closing);
    }
  } else {
    const colonIndex = host.lastIndexOf(":");
    if (colonIndex !== -1) {
      port = host.slice(colonIndex + 1);
      host = host.slice(0, colonIndex);
    }
  }

  return { hostname: host.toLowerCase(), port };
}

/**
 * Python `urllib.parse.urljoin`. Returns the resolved absolute URL, or the raw
 * value when it cannot be resolved against the base (callers then reject it via
 * the scheme/netloc checks, exactly as they did before).
 */
export function urljoin(base, value) {
  const text = String(value ?? "");
  try {
    return new URL(text, String(base ?? "")).href;
  } catch {
    return text;
  }
}

/** Python `urllib.parse.urldefrag` — the URL without its `#fragment`. */
export function urldefrag(value) {
  const text = String(value ?? "");
  const index = text.indexOf("#");
  return index === -1 ? text : text.slice(0, index);
}

/**
 * The shared "is this an http(s) URL with a host" predicate that the publisher,
 * the post footer and the fan-art digest each spelled out separately. All three
 * used identical `scheme in {http, https} and netloc` logic.
 */
export function isSafeHttpUrl(value) {
  const parsed = urlsplit(String(value ?? "").trim());
  return (parsed.scheme === "http" || parsed.scheme === "https") && Boolean(parsed.netloc);
}

/** Python `urllib.parse.quote` with the default safe set (`/`). */
export function quoteUrlPath(value) {
  return encodeURIComponent(String(value ?? "")).replace(/%2F/g, "/");
}

/** Python `urllib.parse.quote(value, safe="")` — every reserved character escaped. */
export function quoteAll(value) {
  return encodeURIComponent(String(value ?? "")).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Rebuild `https://host` from a split result, dropping userinfo, port and path. */
export function httpsOriginOf(parsed) {
  return `https://${parsed.hostname}`;
}
