/**
 * HTML parsing helpers on top of cheerio, shaped like the BeautifulSoup calls
 * the collectors were written against.
 *
 * The one behaviour worth spelling out is {@link getText}: BeautifulSoup's
 * `get_text(" ", strip=True)` strips EACH text node and joins the survivors with
 * a single space. cheerio's `.text()` concatenates raw text instead, which glues
 * adjacent block elements together ("Patch notesRead more") and keeps the
 * newlines and indentation of the source markup. Article bodies and card titles
 * are parsed with the former in mind, so it is reproduced here.
 */

import * as cheerio from "cheerio";

export function loadHtml(html) {
  return cheerio.load(html);
}

/** BeautifulSoup's `get_text(" ", strip=True)`. */
export function getText(selection) {
  const parts = [];
  selection.each((_index, element) => {
    collectText(element, parts);
  });
  return parts.join(" ");
}

function collectText(node, out) {
  if (node.type === "text") {
    const text = String(node.data ?? "").trim();
    if (text) {
      out.push(text);
    }
    return;
  }
  for (const child of node.children ?? []) {
    collectText(child, out);
  }
}

/** `soup.select_one(selector)` — the first match, or null. */
export function selectOne($, selector, scope = null) {
  const found = scope ? scope.find(selector).first() : $(selector).first();
  return found.length ? found : null;
}
