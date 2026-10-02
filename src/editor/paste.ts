import DOMPurify from "dompurify";
import type { JSONContent } from "@tiptap/core";
import { Slice } from "@tiptap/pm/model";
import { AllSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  displayFormulaAfterTextInsertion,
  formulaFromClipboard,
} from "./formulaInput";
import { markdownToDocument } from "./markdown";

function containsFormula(node: JSONContent): boolean {
  return (
    node.type === "inlineFormula" ||
    node.type === "blockFormula" ||
    (node.content ?? []).some(containsFormula)
  );
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
  view.dispatch(transaction.scrollIntoView());
  return true;
}

/** Insert standalone TeX, including source pasted into prewritten delimiters. */
export function insertPastedFormula(view: EditorView, text: string): boolean {
  const formula = formulaFromClipboard(text);
  const { selection, schema } = view.state;
  const $from = selection.$from;
  const $to = selection.$to;
  if ($from.sameParent($to) && $from.parent.type.name === "paragraph") {
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
  const sanitized = DOMPurify.sanitize(html, {
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
      "data-footnote-reference",
      "data-footnote-definition",
      "data-footnote-identifier",
      "data-footnote-label",
      "class",
      "colspan",
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
    ],
    ALLOW_DATA_ATTR: false,
  });
  if (!sanitized.includes("data-papercanvas-task-marker")) return sanitized;
  const template = document.createElement("template");
  template.innerHTML = sanitized;
  // Rich-table source carries a readable checkbox for HTML previews. Native
  // task nodes already render their own checkbox when that source is pasted.
  template.content
    .querySelectorAll(
      'li[data-type="taskItem"][data-checked] span[data-papercanvas-task-marker]',
    )
    .forEach((marker) => marker.remove());
  return template.innerHTML;
}
