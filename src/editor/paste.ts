import DOMPurify from "dompurify";
import { isMarkActive, type JSONContent } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { AllSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  displayFormulaAfterTextInsertion,
  formulaFromClipboard,
} from "./formulaInput";
import { markdownToDocument } from "./markdown";
import { applyTableColumnWidths } from "./PaperTable";

function containsFormula(node: JSONContent): boolean {
  return (
    node.type === "inlineFormula" ||
    node.type === "blockFormula" ||
    (node.content ?? []).some(containsFormula)
  );
}

function pastingIntoCode(view: EditorView): boolean {
  const { selection, schema } = view.state;
  const { $from } = selection;
  if ($from.parent.type.spec.code) return true;
  const code = schema.marks.code;
  return Boolean(code && $from.parent.isTextblock && isMarkActive(view.state, code));
}

/** Parse mixed plain-text Markdown only when it contains explicit math. */
export function markdownDocumentFromClipboard(
  text: string,
): JSONContent | null {
  if (!text.trim()) return null;
  const document = markdownToDocument(text);
  return containsFormula(document) ? document : null;
}

/** Insert mixed Markdown/math as a structural slice instead of one formula. */
export function insertPastedMarkdown(view: EditorView, text: string): boolean {
  if (pastingIntoCode(view)) return false;
  const document = markdownDocumentFromClipboard(text);
  if (!document) return false;
  const parsed = view.state.schema.nodeFromJSON(document);
  const transaction =
    view.state.selection instanceof AllSelection
      ? view.state.tr.replaceWith(
          0,
          view.state.doc.content.size,
          parsed.content,
        )
      : view.state.tr.replaceSelection(Slice.maxOpen(parsed.content));
  view.dispatch(
    transaction.setMeta("skipTypingNormalization", true).scrollIntoView(),
  );
  return true;
}

/** Insert standalone TeX, including source pasted into prewritten delimiters. */
export function insertPastedFormula(view: EditorView, text: string): boolean {
  if (pastingIntoCode(view)) return false;
  const formula = formulaFromClipboard(text);
  const { selection, schema } = view.state;
  const $from = selection.$from;
  const $to = selection.$to;
  let plainParagraph = $from.parent.type.name === "paragraph";
  $from.parent.forEach((child) => { if (!child.isText) plainParagraph = false; });
  if ($from.sameParent($to) && plainParagraph) {
    const insertedText = formula?.latex ?? text;
    const parsed = displayFormulaAfterTextInsertion({
      parentText: $from.parent.textContent,
      from: $from.parentOffset,
      to: $to.parentOffset,
      insertedText,
    });
    const codeMark = schema.marks.code;
    const blockFormula = schema.nodes.blockFormula;
    if (
      parsed &&
      blockFormula &&
      !(
        codeMark &&
        $from.parent.rangeHasMark(0, $from.parent.content.size, codeMark)
      )
    ) {
      view.dispatch(
        view.state.tr
          .replaceWith(
            $from.before(),
            $from.after(),
            blockFormula.create({
              latex: parsed.latex,
              autoEdit: true,
              sourceCaret: parsed.caret,
            }),
          )
          .setMeta("skipTypingNormalization", true)
          .scrollIntoView(),
      );
      return true;
    }
  }

  if (!formula) return false;
  const formulaNode =
    schema.nodes[formula.kind === "block" ? "blockFormula" : "inlineFormula"];
  if (!formulaNode) return false;
  view.dispatch(
    view.state.tr
      .replaceSelectionWith(
        formulaNode.create({
          latex: formula.latex,
          autoEdit: formula.sourceCaret !== undefined,
          sourceCaret: formula.sourceCaret ?? null,
        }),
      )
      .setMeta("skipTypingNormalization", true)
      .scrollIntoView(),
  );
  return true;
}

/**
 * Keep the HTML path deliberately small. ProseMirror will turn this into its
 * own document model afterwards, so neither executable markup nor arbitrary
 * browser attributes need to survive a paste.
 */
export function sanitizePastedHtml(html: string): string {
  // Templates parse clipboard markup without loading its images or executing
  // it. Keep local file images through the existing inert origin channel;
  // DOMPurify continues rejecting file: in ordinary src/href attributes.
  let input: string | DocumentFragment = html;
  if (/file:\/\//i.test(html)) {
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
      if (image.hasAttribute('data-image-original-src')) return;
      const source = image.getAttribute('src') ?? '';
      if (!/^file:\/\//i.test(source)) return;
      try {
        const url = new URL(source);
        if (url.protocol === 'file:') {
          image.setAttribute('data-image-original-src', source);
        }
      } catch { /* Leave malformed URLs to the existing sanitizer. */ }
    });
    // Import the inert nodes directly so a second HTML parse cannot normalize
    // encoded carriage returns in formula source attributes.
    input = template.content;
  }
  const sanitized = DOMPurify.sanitize(input, {
    ALLOWED_TAGS: [
      "p",
      "div",
      "span",
      "sup",
      "sub",
      "br",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "del",
      "code",
      "pre",
      "a",
      "ul",
      "ol",
      "li",
      "blockquote",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "table",
      "colgroup",
      "col",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "img",
    ],
    ALLOWED_ATTR: [
      "href",
      "src",
      "alt",
      "title",
      // Inert document metadata preserves list numbering, checkboxes, rich
      // tables, image sizes and native footnotes during editor-to-editor copy.
      "start",
      "data-type",
      "data-checked",
      "data-papercanvas-task-marker",
      "data-image-original-src",
      "data-footnote-reference",
      "data-footnote-definition",
      "data-footnote-identifier",
      "data-footnote-label",
      "data-markdown-meta",
      "class",
      "colspan",
      "colwidth",
      "rowspan",
      "align",
      "width",
      "height",
      // Formula nodes use inert source attributes during editor-to-editor copy.
      // KaTeX still renders them with `trust: false` after ProseMirror parses
      // the sanitized element back into a formula node.
      "latex",
      "data-formula-kind",
      "data-latex",
      "data-latex-json",
    ],
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ["data-image-original-src", "data-markdown-meta"],
    RETURN_DOM_FRAGMENT: true,
  });
  const template = document.createElement("template");
  template.content.append(sanitized);
  applyTableColumnWidths(template.content);
  // Preserve formula source before another HTML serialization/parsing pass
  // normalizes the line endings of raw source attributes.
  template.content
    .querySelectorAll<HTMLElement>("[data-formula-kind]")
    .forEach((formula) => {
      if (formula.hasAttribute("data-latex-json")) return;
      const source =
        formula.getAttribute("latex") ?? formula.getAttribute("data-latex");
      if (source !== null)
        formula.setAttribute("data-latex-json", JSON.stringify(source));
    });
  // Rich-table source carries a readable checkbox for HTML previews. Native
  // task nodes already render their own checkbox when that source is pasted.
  template.content
    .querySelectorAll(
      'li[data-type="taskItem"][data-checked] span[data-papercanvas-task-marker]',
    )
    .forEach((marker) => marker.remove());
  return template.innerHTML;
}
