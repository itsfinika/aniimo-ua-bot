/**
 * The community footer must survive an edit exactly once.
 *
 * The editable copy of a part used to be rendered with formatPartForModeration,
 * i.e. WITH the footer. Saving stores the visible text of that message back as
 * `part.text`, so the footer was stored as if an admin had typed it — and the
 * next render appended another one. Each subsequent edit stacked one more:
 * 2 footers after the first save, 3 after the second, 4 after the third.
 *
 * Every other consumer of `part.text` already treats it as the bare body:
 * validatePartText renders it before measuring, and publishing renders it again.
 * The editable copy was the only place that broke that invariant.
 */

import { expect, it } from "vitest";

import {
  formatCommunityFooter,
  formatPostHtml,
  stripRenderedCommunityFooter,
} from "../services/post_footer.js";

const FOOTER = formatCommunityFooter();
const render = (text) =>
  formatPostHtml(text, { source_url: "", allow_source_link: false, include_community_footer: true });
const countFooters = (text) => (text.match(/Запропонувати новину/g) || []).length;

it("renders exactly one footer", () => {
  expect(countFooters(render("Патч 5.5 вже доступний."))).toBe(1);
});

it("strips a footer an admin saved back verbatim", () => {
  const shown = render("Патч 5.5 вже доступний.").replace(/<[^>]+>/g, "");
  expect(countFooters(shown)).toBe(1);
  expect(stripRenderedCommunityFooter(shown)).toBe("Патч 5.5 вже доступний.");
});

it("peels off several stacked footers, healing an already-corrupted draft", () => {
  // What repeated edits left in the database before the fix.
  const corrupted = `Патч 5.5 вже доступний.\n\n${FOOTER}\n\n${FOOTER}\n\n${FOOTER}`;
  expect(stripRenderedCommunityFooter(corrupted)).toBe("Патч 5.5 вже доступний.");
});

it("leaves a body that never had a footer untouched", () => {
  expect(stripRenderedCommunityFooter("Звичайний текст поста.")).toBe("Звичайний текст поста.");
  expect(stripRenderedCommunityFooter("")).toBe("");
});

it("does not strip a footer that is not at the end", () => {
  // Only a trailing block is the appended footer; anything else is body text
  // the admin deliberately wrote, and silently deleting it would lose content.
  const body = `${FOOTER}\n\nсправжній текст`;
  expect(stripRenderedCommunityFooter(body)).toBe(body);
});

it("keeps the footer count at one across repeated edit-and-save cycles", () => {
  // The exact loop that used to compound: show the body, admin saves it back,
  // store it, render for publication.
  let stored = "Патч 5.5 вже доступний.";
  for (let edit = 1; edit <= 3; edit += 1) {
    const editable = stripRenderedCommunityFooter(stored); // what the draft now shows
    stored = stripRenderedCommunityFooter(editable.trim()); // what saving stores
    expect(countFooters(render(stored))).toBe(1);
  }
  expect(stored).toBe("Патч 5.5 вже доступний.");
});
