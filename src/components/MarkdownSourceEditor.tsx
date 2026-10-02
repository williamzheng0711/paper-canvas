import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  invertedEffects,
  isolateHistory,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  bracketMatching,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  ChangeSet,
  Compartment,
  EditorState,
  MapMode,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { offsetAtProgress } from "../editor/modeTransition";
import {
  findTextMatches,
  resolveActiveMatch,
  type SwitchableEditorHandle,
} from "../editor/search";
import { getMessages, type Language } from "../i18n";
import type { MarkdownSourceChanges } from "../editor/markdownAssetReferences";

type Props = {
  language: Language;
  value: string;
  valueRevision: number;
  externalChanges?: MarkdownSourceChanges;
  onChange: (value: string) => void;
  onReady?: () => void;
};

type SourceSnapshot = {
  value: string;
  normalized: string;
  crlfOffsets: number[];
};

function sourceSnapshot(value: string): SourceSnapshot {
  const crlfOffsets: number[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] === "\r" && value[index + 1] === "\n")
      crlfOffsets.push(index);
  }
  return {
    value,
    normalized: value.replace(/\r\n?/g, "\n"),
    crlfOffsets,
  };
}

function boundedOffset(length: number, offset: number): number {
  return Math.min(
    length,
    Math.max(0, Math.round(Number.isFinite(offset) ? offset : 0)),
  );
}

function lineEndingCount(
  snapshot: SourceSnapshot,
  offset: number,
  normalized: boolean,
): number {
  let from = 0;
  let to = snapshot.crlfOffsets.length;
  while (from < to) {
    const middle = (from + to) >>> 1;
    const position = snapshot.crlfOffsets[middle] - (normalized ? middle : 0);
    if (position < offset) from = middle + 1;
    else to = middle;
  }
  return from;
}

function editorOffset(snapshot: SourceSnapshot, sourceOffset: number): number {
  const offset = boundedOffset(snapshot.value.length, sourceOffset);
  return offset - lineEndingCount(snapshot, offset, false);
}

function rawOffset(snapshot: SourceSnapshot, normalizedOffset: number): number {
  const offset = boundedOffset(snapshot.normalized.length, normalizedOffset);
  return offset + lineEndingCount(snapshot, offset, true);
}

type SeparatorRecord = { anchor: number; offset: number; value: string };
type SeparatorMetadata = {
  lineEnding: string;
  separators: ReadonlyMap<number, string>;
};

function sourceSeparators(snapshot: SourceSnapshot): SeparatorMetadata {
  const separators = new Map<number, string>();
  let extra = 0;
  for (const match of snapshot.value.matchAll(/\r\n|\r|\n/g)) {
    separators.set(match.index - extra, match[0]);
    if (match[0] === "\r\n") extra += 1;
  }
  return {
    lineEnding: separators.values().next().value ?? "\n",
    separators,
  };
}

const replaceSeparators = StateEffect.define<SeparatorMetadata>();
const restoreSeparators = StateEffect.define<readonly SeparatorRecord[]>({
  map: (records, changes) =>
    records.map((record) => ({
      ...record,
      anchor: changes.mapPos(record.anchor, -1),
    })),
});

const separatorMetadata = StateField.define<SeparatorMetadata>({
  create: (state) => sourceSeparators(sourceSnapshot(state.doc.toString())),
  update: (current, transaction) => {
    if (!transaction.docChanged && transaction.effects.length === 0)
      return current;
    let next = current;
    if (transaction.docChanged) {
      const separators = new Map<number, string>();
      for (const [previous, value] of current.separators) {
        const position = transaction.changes.mapPos(
          previous,
          1,
          MapMode.TrackAfter,
        );
        if (position !== null) separators.set(position, value);
      }
      transaction.changes.iterChanges((_from, _to, fromB, _toB, inserted) => {
        const text = inserted.toString();
        for (
          let index = text.indexOf("\n");
          index >= 0;
          index = text.indexOf("\n", index + 1)
        )
          separators.set(fromB + index, current.lineEnding);
      });
      next = { ...current, separators };
    }
    for (const effect of transaction.effects) {
      if (effect.is(replaceSeparators)) next = effect.value;
      if (effect.is(restoreSeparators)) {
        const separators = new Map(next.separators);
        for (const record of effect.value) {
          const position =
            transaction.changes.mapPos(record.anchor, -1) + record.offset;
          if (transaction.newDoc.sliceString(position, position + 1) === "\n")
            separators.set(position, record.value);
        }
        next = { ...next, separators };
      }
    }
    return next;
  },
});

function deletedSeparators(transaction: Transaction): SeparatorRecord[] {
  if (!transaction.docChanged) return [];
  const records: SeparatorRecord[] = [];
  const previous = transaction.startState.field(separatorMetadata);
  transaction.changes.iterChangedRanges((from, to, anchor) => {
    for (const [position, value] of previous.separators) {
      if (position >= from && position < to && value !== previous.lineEnding)
        records.push({ anchor, offset: position - from, value });
    }
  });
  return records;
}

// Native history maps each live deletion anchor through external edits. Relative
// offsets restore only exceptional separator bytes, never old source or URLs.
const separatorHistory = [
  invertedEffects.of((transaction) => {
    const records = deletedSeparators(transaction);
    return records.length ? [restoreSeparators.of(records)] : [];
  }),
  // Keep each restoration anchor tied to one native change set. Ordinary typing
  // and deletions of the established separator retain normal history grouping.
  EditorState.transactionExtender.of((transaction) =>
    deletedSeparators(transaction).length
      ? { annotations: isolateHistory.of("full") }
      : null,
  ),
];

function applySourceChanges(
  snapshot: SourceSnapshot,
  changes: ChangeSet,
  metadata: SeparatorMetadata,
): SourceSnapshot {
  const parts: string[] = [];
  let cursor = 0;
  changes.iterChanges((from, to, fromB, _toB, inserted) => {
    const rawFrom = rawOffset(snapshot, from);
    const rawTo = rawOffset(snapshot, to);
    parts.push(
      snapshot.value.slice(cursor, rawFrom),
      inserted
        .toString()
        .replace(
          /\n/g,
          (_newline, index: number) =>
            metadata.separators.get(fromB + index) ?? metadata.lineEnding,
        ),
    );
    cursor = rawTo;
  });
  parts.push(snapshot.value.slice(cursor));
  return sourceSnapshot(parts.join(""));
}

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--markdown-heading)", fontWeight: "700" },
  {
    tag: [tags.keyword, tags.controlKeyword],
    color: "var(--markdown-keyword)",
    fontWeight: "600",
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: "var(--markdown-string)",
  },
  {
    tag: [tags.comment, tags.meta],
    color: "var(--markdown-comment)",
    fontStyle: "italic",
  },
  {
    tag: [tags.url, tags.link],
    color: "var(--markdown-link)",
    textDecoration: "underline",
  },
  {
    tag: [tags.emphasis, tags.strong],
    color: "var(--markdown-emphasis)",
    fontWeight: "700",
  },
  { tag: [tags.monospace, tags.literal], color: "var(--markdown-code)" },
  { tag: tags.punctuation, color: "var(--markdown-punctuation)" },
]);

const setSearchDecorations = StateEffect.define<{
  matches: ReturnType<typeof findTextMatches>;
  active: number;
}>();

const searchDecorations = StateField.define({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    for (const effect of transaction.effects) {
      if (!effect.is(setSearchDecorations)) continue;
      return Decoration.set(
        effect.value.matches.map((match, index) =>
          Decoration.mark({
            class:
              index === effect.value.active
                ? "cm-document-search-match cm-document-search-match--active"
                : "cm-document-search-match",
          }).range(match.from, match.to),
        ),
      );
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function sameSourceProps(previous: Props, next: Props): boolean {
  // CodeMirror owns the live source while typing. valueRevision changes only
  // when React supplies an external replacement that must be dispatched.
  return (
    previous.language === next.language &&
    previous.valueRevision === next.valueRevision &&
    previous.onReady === next.onReady
  );
}

/** A controlled CodeMirror surface for editable, syntax-coloured Markdown. */
export const MarkdownSourceEditor = memo(
  forwardRef<SwitchableEditorHandle, Props>(function MarkdownSourceEditor(
    { language, value, valueRevision, externalChanges, onChange, onReady },
    ref,
  ) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const contentAttributes = useRef(new Compartment()).current;
    const initialValue = useRef(value);
    const rawSource = useRef<SourceSnapshot>(sourceSnapshot(value));
    const onChangeRef = useRef(onChange);
    const onReadyRef = useRef(onReady);
    const applyingExternalValue = useRef(false);
    const currentSearch = useRef<{
      query: string;
      active: number;
      document?: EditorState["doc"];
      matches?: ReturnType<typeof findTextMatches>;
    }>({ query: "", active: -1 });
    onChangeRef.current = onChange;
    onReadyRef.current = onReady;

    useLayoutEffect(() => {
      if (!host.current) return;
      const editor = new EditorView({
        state: EditorState.create({
          doc: initialValue.current,
          extensions: [
            lineNumbers(),
            history(),
            separatorMetadata.init(() => sourceSeparators(rawSource.current)),
            separatorHistory,
            bracketMatching(),
            highlightActiveLine(),
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            markdown(),
            syntaxHighlighting(markdownHighlightStyle),
            searchDecorations,
            EditorView.lineWrapping,
            contentAttributes.of(
              EditorView.contentAttributes.of({
                "aria-label": getMessages().markdownSource,
                spellcheck: "false",
              }),
            ),
            EditorView.updateListener.of((update) => {
              if (update.docChanged && !applyingExternalValue.current) {
                // CodeMirror normalizes its line separators. Apply only edited
                // ranges to the raw file so untouched CRLF/LF/CR bytes survive.
                const next = applySourceChanges(
                  rawSource.current,
                  update.changes,
                  update.state.field(separatorMetadata),
                );
                rawSource.current = next;
                onChangeRef.current(next.value);
              }
            }),
          ],
        }),
        parent: host.current,
      });
      view.current = editor;
      queueMicrotask(() => {
        if (view.current === editor) onReadyRef.current?.();
      });
      return () => {
        if (view.current === editor) view.current = null;
        editor.destroy();
      };
    }, [contentAttributes]);

    useEffect(() => {
      view.current?.dispatch({
        effects: contentAttributes.reconfigure(
          EditorView.contentAttributes.of({
            "aria-label": getMessages(language).markdownSource,
            spellcheck: "false",
          }),
        ),
      });
    }, [contentAttributes, language]);

    useEffect(() => {
      const editor = view.current;
      if (!editor) return;
      const current = editor.state.doc.toString();
      const nextSnapshot = sourceSnapshot(value);
      if (current === nextSnapshot.normalized) {
        if (value !== rawSource.current.value)
          editor.dispatch({
            effects: replaceSeparators.of(sourceSeparators(nextSnapshot)),
            annotations: Transaction.addToHistory.of(false),
          });
        rawSource.current = nextSnapshot;
        return;
      }
      const { anchor, head } = editor.state.selection.main;
      let changes: ChangeSet | undefined;
      const previousSnapshot = externalChanges
        ? sourceSnapshot(externalChanges.previousValue)
        : undefined;
      if (externalChanges && previousSnapshot?.normalized === current) {
        try {
          const candidate = ChangeSet.of(
            externalChanges.changes.map(({ from, to, value: insert }) => {
              if (
                !Number.isInteger(from) ||
                !Number.isInteger(to) ||
                from < 0 ||
                to < from ||
                to > previousSnapshot.value.length
              )
                throw new RangeError("Invalid source edit range");
              return {
                from: editorOffset(previousSnapshot, from),
                to: editorOffset(previousSnapshot, to),
                insert: insert.replace(/\r\n?/g, "\n"),
              };
            }),
            current.length,
          );
          // Ignore a stale or incomplete edit map rather than applying part of an
          // external replacement. Valid image-path edits map the caret naturally.
          if (
            candidate.apply(editor.state.doc).toString() ===
            nextSnapshot.normalized
          )
            changes = candidate;
        } catch {
          // Invalid ranges fall back to the existing complete snapshot update.
        }
      }
      const metadata = sourceSeparators(nextSnapshot);
      if (changes)
        // A path rebase belongs to the same document, even when its original
        // first separator was deleted and the remaining first style differs.
        metadata.lineEnding = editor.state.field(separatorMetadata).lineEnding;
      applyingExternalValue.current = true;
      try {
        editor.dispatch({
          effects: replaceSeparators.of(metadata),
          changes: changes ?? {
            from: 0,
            to: current.length,
            insert: nextSnapshot.normalized,
          },
          // Loading another file or applying an external snapshot must never make
          // Undo resurrect the old file in the new document.
          annotations: Transaction.addToHistory.of(false),
          ...(changes
            ? {}
            : {
                selection: {
                  anchor: Math.min(anchor, nextSnapshot.normalized.length),
                  head: Math.min(head, nextSnapshot.normalized.length),
                },
              }),
        });
      } finally {
        applyingExternalValue.current = false;
      }
      rawSource.current = nextSnapshot;
    }, [value, valueRevision, externalChanges]);

    useImperativeHandle(
      ref,
      () => ({
        search: (query, direction) => {
          const editor = view.current;
          if (!editor) return { current: 0, total: 0 };
          const previous = currentSearch.current;
          const matches =
            previous.query === query &&
            previous.document === editor.state.doc &&
            previous.matches
              ? previous.matches
              : findTextMatches(editor.state.doc.toString(), query);
          const active = resolveActiveMatch(
            matches,
            query,
            direction,
            currentSearch.current.query,
            currentSearch.current.active,
            editor.state.selection.main.from,
          );
          currentSearch.current = {
            query,
            active,
            document: editor.state.doc,
            matches,
          };
          const effects: StateEffect<unknown>[] = [
            setSearchDecorations.of({ matches, active }),
          ];
          if (active >= 0 && direction !== "refresh") {
            effects.push(
              EditorView.scrollIntoView(matches[active].from, { y: "center" }),
            );
            editor.dispatch({
              selection: {
                anchor: matches[active].from,
                head: matches[active].to,
              },
              effects,
            });
          } else {
            editor.dispatch({ effects });
          }
          return { current: active + 1, total: matches.length };
        },
        clearSearch: () => {
          currentSearch.current = { query: "", active: -1 };
          view.current?.dispatch({
            effects: setSearchDecorations.of({ matches: [], active: -1 }),
          });
        },
        focus: () => view.current?.focus(),
        getSelectedText: () => {
          const editor = view.current;
          if (!editor) return "";
          const { from, to } = editor.state.selection.main;
          return editor.state.sliceDoc(from, to);
        },
        getSelectionProgress: () => {
          const editor = view.current;
          if (!editor) return 0;
          const documentLength = Math.max(1, editor.state.doc.length);
          return editor.state.selection.main.head / documentLength;
        },
        getSelectionViewportOffset: () => {
          const editor = view.current;
          const viewport = host.current?.closest<HTMLElement>(".canvas-area");
          if (!editor || !viewport) return undefined;
          const coordinates = editor.coordsAtPos(
            editor.state.selection.main.head,
          );
          return coordinates
            ? coordinates.top - viewport.getBoundingClientRect().top
            : undefined;
        },
        setSelectionProgress: (progress) => {
          const editor = view.current;
          if (!editor) return;
          editor.dispatch({
            selection: {
              anchor: offsetAtProgress(editor.state.doc.length, progress),
            },
          });
        },
        getMarkdownOffset: () => {
          const editor = view.current;
          return editor
            ? rawOffset(rawSource.current, editor.state.selection.main.head)
            : undefined;
        },
        setMarkdownOffset: (offset) => {
          const editor = view.current;
          if (!editor) return false;
          const position = editorOffset(rawSource.current, offset);
          editor.dispatch({ selection: { anchor: position } });
          return true;
        },
        setMarkdownSelection: (range) => {
          const editor = view.current;
          if (!editor) return false;
          const from = editorOffset(rawSource.current, range.from);
          const to = editorOffset(
            rawSource.current,
            Number.isFinite(range.to) ? range.to : range.from,
          );
          editor.dispatch({
            selection: { anchor: from, head: to },
            effects: EditorView.scrollIntoView(from, { y: "center" }),
          });
          editor.focus();
          return true;
        },
        isFocused: () => view.current?.hasFocus ?? false,
        requestMeasure: () => view.current?.requestMeasure(),
      }),
      [],
    );

    return <div ref={host} className="markdown-source-editor" />;
  }),
  sameSourceProps,
);
