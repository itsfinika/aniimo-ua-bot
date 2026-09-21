/**
 * XML feed parsing.
 *
 * The Python collectors used `defusedxml`, whose whole job was to forbid DTDs
 * and entity expansion on untrusted feeds (billion-laughs, external entities).
 * fast-xml-parser has no such switch, so the same guarantee is provided by
 * rejecting any document that declares a DOCTYPE or an ENTITY before parsing —
 * exactly what `defusedxml.ElementTree` raises `DefusedXmlException` for.
 *
 * Namespace prefixes are stripped (`yt:videoId` -> `videoId`), which matches the
 * Python code's intent: it looked elements up by namespace URI, and every feed
 * involved declares one fixed prefix per namespace.
 */

import { XMLParser } from "fast-xml-parser";

export class XmlParseError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "XmlParseError";
  }
}

const DOCTYPE_RE = /<!DOCTYPE|<!ENTITY/i;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  textNodeName: "#text",
  alwaysCreateTextNode: true,
});

export function parseXml(xmlText) {
  const text = String(xmlText ?? "");
  if (DOCTYPE_RE.test(text)) {
    throw new XmlParseError("DTDs and entity declarations are not allowed in feeds");
  }
  try {
    return parser.parse(text);
  } catch (error) {
    throw new XmlParseError(error?.message ?? "Invalid XML", { cause: error });
  }
}

/** Normalise fast-xml-parser's "one element vs. an array" output to an array. */
export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Every child element named `name` (namespace prefix already stripped). */
export function children(node, name) {
  if (node === undefined || node === null || typeof node !== "object") return [];
  return asArray(node[name]);
}

/** The first child element named `name`, or null. */
export function child(node, name) {
  const found = children(node, name);
  return found.length ? found[0] : null;
}

/** An element's text content — the analogue of `Element.text` / `findtext`. */
export function nodeText(node) {
  if (node === undefined || node === null) return "";
  if (typeof node === "string") return node;
  const text = node["#text"];
  return text === undefined || text === null ? "" : String(text);
}

/** `element.findtext(name)`. */
export function findText(node, name) {
  const found = child(node, name);
  return found === null ? "" : nodeText(found);
}

/** `element.get(name)` — an attribute value, or null. */
export function attr(node, name) {
  if (node === undefined || node === null || typeof node !== "object") return null;
  const value = node[`@_${name}`];
  return value === undefined || value === null ? null : String(value);
}
