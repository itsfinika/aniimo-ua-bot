/**
 * Re-render a Telegram message as HTML — aiogram's `Message.html_text`.
 *
 * The mod-log entries are sent with `parse_mode="HTML"` and carry clickable
 * `tg://user?id=…` mentions. When a moderator taps an inline action the bot
 * appends a line to that entry, and to do so it must resend the WHOLE text. The
 * API hands the text back as plain characters plus an entity list, so without
 * this reconstruction every previous mention in the log would silently flatten
 * into unformatted text on the first button press.
 *
 * Offsets and lengths from Telegram are counted in UTF-16 code units, which is
 * exactly how JavaScript indexes strings — no conversion is needed (Python had
 * to convert, since its strings are code points).
 */

import { htmlEscape } from "./pyutils.js";

/** The message text (or caption) rendered back into Telegram-flavoured HTML. */
export function messageHtmlText(message) {
  const text = message?.text ?? message?.caption ?? "";
  const entities = message?.entities ?? message?.caption_entities ?? [];
  return entitiesToHtml(text, entities);
}

export function entitiesToHtml(text, entities) {
  if (!entities || !entities.length) {
    return htmlEscape(text);
  }

  // Sort so that outer entities open first and, at equal offsets, the longer one
  // wraps the shorter — the nesting Telegram itself guarantees.
  const sorted = [...entities].sort((left, right) => left.offset - right.offset || right.length - left.length);
  return renderRange(text, sorted, 0, text.length, 0).html;
}

function renderRange(text, entities, start, end, index) {
  let html = "";
  let cursor = start;
  let position = index;

  while (position < entities.length) {
    const entity = entities[position];
    if (entity.offset >= end) {
      break;
    }
    if (entity.offset < cursor) {
      // Overlapping or already-consumed entity; skip it rather than corrupt the
      // output (Telegram does not emit these, but a malformed update might).
      position += 1;
      continue;
    }

    html += htmlEscape(text.slice(cursor, entity.offset));
    const entityEnd = Math.min(entity.offset + entity.length, end);
    const inner = renderRange(text, entities, entity.offset, entityEnd, position + 1);
    html += wrap(entity, inner.html);
    cursor = entityEnd;
    position = inner.index;
  }

  html += htmlEscape(text.slice(cursor, end));
  return { html, index: position };
}

function wrap(entity, inner) {
  switch (entity.type) {
    case "bold":
      return `<b>${inner}</b>`;
    case "italic":
      return `<i>${inner}</i>`;
    case "underline":
      return `<u>${inner}</u>`;
    case "strikethrough":
      return `<s>${inner}</s>`;
    case "spoiler":
      return `<tg-spoiler>${inner}</tg-spoiler>`;
    case "code":
      return `<code>${inner}</code>`;
    case "pre":
      return entity.language
        ? `<pre><code class="language-${htmlEscape(entity.language, true)}">${inner}</code></pre>`
        : `<pre>${inner}</pre>`;
    case "text_link":
      return `<a href="${htmlEscape(entity.url ?? "", true)}">${inner}</a>`;
    case "text_mention":
      return `<a href="tg://user?id=${entity.user?.id}">${inner}</a>`;
    case "custom_emoji":
      return `<tg-emoji emoji-id="${htmlEscape(entity.custom_emoji_id ?? "", true)}">${inner}</tg-emoji>`;
    case "blockquote":
      return `<blockquote>${inner}</blockquote>`;
    case "expandable_blockquote":
      return `<blockquote expandable>${inner}</blockquote>`;
    default:
      // url / mention / hashtag / bot_command and friends need no markup: they
      // are recognised from the plain text by Telegram itself.
      return inner;
  }
}

/** aiogram's `User.full_name`. */
export function fullName(user) {
  if (!user) return "";
  return user.last_name ? `${user.first_name} ${user.last_name}` : (user.first_name ?? "");
}
