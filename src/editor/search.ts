import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { htmlPreviewText } from "./HtmlPreview";
import type {
  DocumentSelectionAnchor,
  MarkdownSelection,
} from "./selectionMapping";

export type SearchDirection = "reset" | "next" | "previous" | "refresh";

export type SearchMatch = {
  from: number;
  to: number;
};

export type SearchResult = {
  current: number;
  total: number;
};

export type SearchableEditorHandle = {
  search: (query: string, direction: SearchDirection) => SearchResult;
  clearSearch: () => void;
  focus: () => void;
  getSelectedText: () => string;
};

export type ContextMenuAction = "cut" | "copy" | "paste" | "selectAll";

export type SwitchableEditorHandle = SearchableEditorHandle & {
  /** Canvas-only: read the current document without publishing a change. */
  getDocument?: () => JSONContent | undefined;
  getSelectionProgress: () => number;
  getSelectionViewportOffset: () => number | undefined;
  setSelectionProgress: (progress: number) => void;
  /** Canvas-only: serialize the document with its exact caret location. */
  getMarkdownSelection?: () => MarkdownSelection | undefined;
  /** Markdown-only: return the current UTF-16 source offset. */
  getMarkdownOffset?: () => number | undefined;
  /** Markdown-only: restore an exact UTF-16 source offset. */
  setMarkdownOffset?: (offset: number) => boolean;
  /** Restore a UTF-16 Markdown range, or a caret when `from === to`. */
  setMarkdownSelection?: (range: { from: number; to: number }) => boolean;
  /** Canvas-only: restore a parsed structural/text anchor. */
  setDocumentSelection?: (anchor: DocumentSelectionAnchor) => boolean;
  /** Execute a basic editor action from the custom canvas context menu. */
  runContextAction?: (action: ContextMenuAction) => void;
  /** Flush any deferred canvas-to-Markdown comment position synchronization. */
  flushCommentMapping?: () => void;
  /** Wait for image reads and insertions before serializing a mode transition. */
  waitForPendingImages?: () => Promise<void> | undefined;
  isFocused: () => boolean;
  requestMeasure: () => void;
};

type DocumentSearchState = {
  query: string;
  matches: SearchMatch[];
  active: number;
  decorations: DecorationSet;
};

type SearchMeta = Pick<DocumentSearchState, "query" | "matches" | "active">;

export const documentSearchPluginKey = new PluginKey<DocumentSearchState>(
  "documentSearch",
);

/** Find non-overlapping, case-insensitive matches using string offsets. */
export function findTextMatches(text: string, query: string): SearchMatch[] {
  if (!query) return [];
  const matches: SearchMatch[] = [];
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escapedQuery, "giu");
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    matches.push({ from: match.index, to: match.index + match[0].length });
  }

  return matches;
}

type TextSpan = {
  from: number;
  to: number;
  textFrom: number;
  textTo: number;
  atom: boolean;
};
type TextSegment = { text: string; spans: TextSpan[] };

// ProseMirror nodes are immutable: edits create a new identity, while search
// navigation reuses the sanitized text for unchanged HTML atoms.
const htmlTextCache = new WeakMap<ProseMirrorNode, string>();

function readableHtml(node: ProseMirrorNode): string {
  let text = htmlTextCache.get(node);
  if (text === undefined) {
    text = htmlPreviewText(
      String(node.attrs.source ?? ""),
      node.isInline ? "inline" : "block",
      { preserveEdges: node.isInline },
    );
    htmlTextCache.set(node, text);
  }
  return text;
}

function collectTextSegments(document: ProseMirrorNode): TextSegment[] {
  const segments: TextSegment[] = [];

  function append(
    segment: TextSegment,
    text: string,
    node: ProseMirrorNode,
    from: number,
  ): void {
    if (!text) return;
    const textFrom = segment.text.length;
    segment.text += text;
    segment.spans.push({
      from,
      to: from + node.nodeSize,
      textFrom,
      textTo: segment.text.length,
      atom: !node.isText,
    });
  }

  document.descendants((node, position) => {
    if (node.type.name === "htmlPreview") {
      const segment: TextSegment = { text: "", spans: [] };
      append(segment, readableHtml(node), node, position);
      if (segment.text) segments.push(segment);
      return false;
    }
    if (!node.isTextblock) return;

    let segment: TextSegment = { text: "", spans: [] };
    node.forEach((child, offset) => {
      const from = position + 1 + offset;
      if (child.isText) {
        append(segment, child.text ?? "", child, from);
      } else if (child.type.name === "inlineHtmlPreview") {
        append(segment, readableHtml(child), child, from);
      } else if (child.type.name === "hardBreak") {
        append(segment, "\n", child, from);
      } else {
        // Formulas and other visible atoms cannot disappear from a matched
        // phrase. A hidden HTML comment, handled above, adds no visible text.
        if (segment.text) segments.push(segment);
        segment = { text: "", spans: [] };
      }
    });
    if (segment.text) segments.push(segment);
    return false;
  });

  return segments;
}

export function findDocumentMatches(
  document: ProseMirrorNode,
  query: string,
): SearchMatch[] {
  if (!query) return [];
  return collectTextSegments(document).flatMap((segment) => {
    let firstIndex = 0;
    let lastIndex = 0;
    return findTextMatches(segment.text, query).map((match) => {
      // A preview may contain many characters in one ProseMirror atom. Project
      // each edge separately so a phrase can span editable text and a preview,
      // while a match wholly inside a preview selects only that atom.
      while (segment.spans[firstIndex].textTo <= match.from) firstIndex += 1;
      lastIndex = Math.max(firstIndex, lastIndex);
      while (segment.spans[lastIndex].textTo < match.to) lastIndex += 1;
      const first = segment.spans[firstIndex];
      const last = segment.spans[lastIndex];
      return {
        from: first.atom
          ? first.from
          : first.from + match.from - first.textFrom,
        to: last.atom ? last.to : last.from + match.to - last.textFrom,
      };
    });
  });
}

function buildDecorations(
  document: ProseMirrorNode,
  matches: SearchMatch[],
  active: number,
): DecorationSet {
  const ranges = new Map<string, { match: SearchMatch; active: boolean }>();
  matches.forEach((match, index) => {
    const key = `${match.from}:${match.to}`;
    const previous = ranges.get(key);
    ranges.set(key, {
      match,
      active: index === active || Boolean(previous?.active),
    });
  });
  return DecorationSet.create(
    document,
    Array.from(ranges.values(), ({ match, active: isActive }) => {
      const attributes = {
        class: isActive
          ? "document-search-match document-search-match--active"
          : "document-search-match",
      };
      return document.nodeAt(match.from)?.type.name === "htmlPreview"
        ? Decoration.node(match.from, match.to, attributes)
        : Decoration.inline(match.from, match.to, attributes);
    }),
  );
}

function closestMatch(matches: SearchMatch[], position: number): number {
  if (matches.length === 0) return -1;
  const following = matches.findIndex(
    (match) => match.from >= position || match.to > position,
  );
  return following >= 0 ? following : 0;
}

export function resolveActiveMatch(
  matches: SearchMatch[],
  query: string,
  direction: SearchDirection,
  previousQuery: string,
  previousActive: number,
  position: number,
): number {
  if (matches.length === 0) return -1;
  if (
    query === previousQuery &&
    previousActive >= 0 &&
    previousActive < matches.length
  ) {
    if (direction === "next") return (previousActive + 1) % matches.length;
    if (direction === "previous")
      return (previousActive - 1 + matches.length) % matches.length;
    if (direction === "refresh" && matches[previousActive].from === position)
      return previousActive;
  }

  const closest = closestMatch(matches, position);
  if (direction !== "previous") return closest;
  if (matches[closest]?.from < position) return closest;
  return (closest - 1 + matches.length) % matches.length;
}

function createDocumentSearchPlugin(): Plugin<DocumentSearchState> {
  return new Plugin<DocumentSearchState>({
    key: documentSearchPluginKey,
    state: {
      init: () => ({
        query: "",
        matches: [],
        active: -1,
        decorations: DecorationSet.empty,
      }),
      apply: (transaction, current) => {
        const meta = transaction.getMeta(documentSearchPluginKey) as
          SearchMeta | undefined;
        if (meta) {
          return {
            ...meta,
            decorations: buildDecorations(
              transaction.doc,
              meta.matches,
              meta.active,
            ),
          };
        }
        if (!transaction.docChanged || !current.query) return current;

        const matches = findDocumentMatches(transaction.doc, current.query);
        const previousMatch = current.matches[current.active];
        const previousPosition =
          previousMatch?.from ?? transaction.selection.from;
        const mappedPosition = transaction.mapping.map(previousPosition);
        let active = closestMatch(matches, mappedPosition);
        if (previousMatch) {
          const mappedEnd = transaction.mapping.map(previousMatch.to, -1);
          const occurrence = current.matches
            .slice(0, current.active)
            .filter(
              (match) =>
                match.from === previousMatch.from &&
                match.to === previousMatch.to,
            ).length;
          const matchingIndices = matches.flatMap((match, index) =>
            match.from === mappedPosition && match.to === mappedEnd
              ? [index]
              : [],
          );
          active =
            matchingIndices[Math.min(occurrence, matchingIndices.length - 1)] ??
            active;
        }
        return {
          query: current.query,
          matches,
          active,
          decorations: buildDecorations(transaction.doc, matches, active),
        };
      },
    },
    props: {
      decorations: (state) =>
        documentSearchPluginKey.getState(state)?.decorations ??
        DecorationSet.empty,
    },
  });
}

export const DocumentSearch = Extension.create({
  name: "documentSearch",
  addProseMirrorPlugins() {
    return [createDocumentSearchPlugin()];
  },
});

export function searchDocument(
  editor: Editor,
  query: string,
  direction: SearchDirection,
): SearchResult {
  const previous = documentSearchPluginKey.getState(editor.state);
  const matches = findDocumentMatches(editor.state.doc, query);
  const active = resolveActiveMatch(
    matches,
    query,
    direction,
    previous?.query ?? "",
    previous?.active ?? -1,
    editor.state.selection.from,
  );
  let transaction = editor.state.tr.setMeta(documentSearchPluginKey, {
    query,
    matches,
    active,
  } satisfies SearchMeta);

  if (active >= 0 && direction !== "refresh") {
    const match = matches[active];
    const selection =
      transaction.doc.nodeAt(match.from)?.type.name === "htmlPreview"
        ? NodeSelection.create(transaction.doc, match.from)
        : TextSelection.create(transaction.doc, match.from, match.to);
    transaction = transaction.setSelection(selection).scrollIntoView();
  }
  editor.view.dispatch(transaction);

  if (active >= 0 && direction !== "refresh") {
    editor.view.dom
      .querySelector<HTMLElement>(".document-search-match--active")
      ?.scrollIntoView?.({ block: "center", inline: "nearest" });
  }

  return { current: active + 1, total: matches.length };
}

export function clearDocumentSearch(editor: Editor): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(documentSearchPluginKey, {
      query: "",
      matches: [],
      active: -1,
    } satisfies SearchMeta),
  );
}

export function getSelectedDocumentText(editor: Editor): string {
  const { from, to, empty } = editor.state.selection;
  return empty
    ? ""
    : editor.state.doc.textBetween(from, to, "\n", (node) => {
        if (["htmlPreview", "inlineHtmlPreview"].includes(node.type.name))
          return readableHtml(node);
        return node.type.name === "hardBreak" ? "\n" : "";
      });
}
