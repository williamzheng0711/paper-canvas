import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
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
  return { value, normalized: value.replace(/\r\n?/g, "\n"), crlfOffsets };
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
                const nextValue = update.state.doc.toString();
                rawSource.current = sourceSnapshot(nextValue);
                onChangeRef.current(nextValue);
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
      applyingExternalValue.current = true;
      try {
        editor.dispatch({
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
