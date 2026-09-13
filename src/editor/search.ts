import { Extension, type Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { DocumentSelectionAnchor, MarkdownSelection } from './selectionMapping';

export type SearchDirection = 'reset' | 'next' | 'previous';

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

export type ContextMenuAction = 'cut' | 'copy' | 'paste' | 'selectAll';

export type SwitchableEditorHandle = SearchableEditorHandle & {
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
  isFocused: () => boolean;
  requestMeasure: () => void;
};

type DocumentSearchState = {
  query: string;
  matches: SearchMatch[];
  active: number;
  decorations: DecorationSet;
};

type SearchMeta = Pick<DocumentSearchState, 'query' | 'matches' | 'active'>;

export const documentSearchPluginKey = new PluginKey<DocumentSearchState>('documentSearch');

/** Find non-overlapping, case-insensitive matches using string offsets. */
export function findTextMatches(text: string, query: string): SearchMatch[] {
  if (!query) return [];
  const matches: SearchMatch[] = [];
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(escapedQuery, 'giu');
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    matches.push({ from: match.index, to: match.index + match[0].length });
  }

  return matches;
}

function collectTextSegments(document: ProseMirrorNode): Array<{ from: number; text: string }> {
  const segments: Array<{ from: number; text: string }> = [];

  document.descendants((node, position) => {
    if (!node.isText || !node.text) return;
    const previous = segments.at(-1);
    if (previous && previous.from + previous.text.length === position) {
      previous.text += node.text;
      return;
    }
    segments.push({ from: position, text: node.text });
  });

  return segments;
}

export function findDocumentMatches(document: ProseMirrorNode, query: string): SearchMatch[] {
  return collectTextSegments(document).flatMap((segment) =>
    findTextMatches(segment.text, query).map((match) => ({
      from: segment.from + match.from,
      to: segment.from + match.to,
    })),
  );
}

function buildDecorations(document: ProseMirrorNode, matches: SearchMatch[], active: number): DecorationSet {
  return DecorationSet.create(
    document,
    matches.map((match, index) =>
      Decoration.inline(match.from, match.to, {
        class: index === active ? 'document-search-match document-search-match--active' : 'document-search-match',
      }),
    ),
  );
}

function closestMatch(matches: SearchMatch[], position: number): number {
  if (matches.length === 0) return -1;
  const following = matches.findIndex((match) => match.from >= position || match.to > position);
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
  if (query === previousQuery && previousActive >= 0 && previousActive < matches.length) {
    if (direction === 'next') return (previousActive + 1) % matches.length;
    if (direction === 'previous') return (previousActive - 1 + matches.length) % matches.length;
  }

  const closest = closestMatch(matches, position);
  if (direction !== 'previous') return closest;
  if (matches[closest]?.from < position) return closest;
  return (closest - 1 + matches.length) % matches.length;
}

function createDocumentSearchPlugin(): Plugin<DocumentSearchState> {
  return new Plugin<DocumentSearchState>({
    key: documentSearchPluginKey,
    state: {
      init: () => ({
        query: '',
        matches: [],
        active: -1,
        decorations: DecorationSet.empty,
      }),
      apply: (transaction, current) => {
        const meta = transaction.getMeta(documentSearchPluginKey) as SearchMeta | undefined;
        if (meta) {
          return {
            ...meta,
            decorations: buildDecorations(transaction.doc, meta.matches, meta.active),
          };
        }
        if (!transaction.docChanged || !current.query) return current;

        const matches = findDocumentMatches(transaction.doc, current.query);
        const previousPosition = current.matches[current.active]?.from ?? transaction.selection.from;
        const mappedPosition = transaction.mapping.map(previousPosition);
        const active = closestMatch(matches, mappedPosition);
        return {
          query: current.query,
          matches,
          active,
          decorations: buildDecorations(transaction.doc, matches, active),
        };
      },
    },
    props: {
      decorations: (state) => documentSearchPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
  });
}

export const DocumentSearch = Extension.create({
  name: 'documentSearch',
  addProseMirrorPlugins() {
    return [createDocumentSearchPlugin()];
  },
});

export function searchDocument(editor: Editor, query: string, direction: SearchDirection): SearchResult {
  const previous = documentSearchPluginKey.getState(editor.state);
  const matches = findDocumentMatches(editor.state.doc, query);
  const active = resolveActiveMatch(
    matches,
    query,
    direction,
    previous?.query ?? '',
    previous?.active ?? -1,
    editor.state.selection.from,
  );
  let transaction = editor.state.tr.setMeta(documentSearchPluginKey, {
    query,
    matches,
    active,
  } satisfies SearchMeta);

  if (active >= 0) {
    const match = matches[active];
    transaction = transaction
      .setSelection(TextSelection.create(transaction.doc, match.from, match.to))
      .scrollIntoView();
  }
  editor.view.dispatch(transaction);

  if (active >= 0) {
    editor.view.dom
      .querySelector<HTMLElement>('.document-search-match--active')
      ?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  }

  return { current: active + 1, total: matches.length };
}

export function clearDocumentSearch(editor: Editor): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(documentSearchPluginKey, {
      query: '',
      matches: [],
      active: -1,
    } satisfies SearchMeta),
  );
}

export function getSelectedDocumentText(editor: Editor): string {
  const { from, to, empty } = editor.state.selection;
  return empty ? '' : editor.state.doc.textBetween(from, to, ' ');
}
