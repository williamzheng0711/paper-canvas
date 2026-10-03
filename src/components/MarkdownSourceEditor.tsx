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
  StateEffect,
  StateField,
  Transaction,
  Text,
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
import {
  imagePathSourceChanges,
  rebaseMarkdownImageAssets,
  renameMarkdownImageAssets,
  type MarkdownSourceChanges,
} from "../editor/markdownAssetReferences";
import { boundedSourceSyntax } from "../editor/sourceSyntax";

type Props = {
  language: Language;
  value: string;
  valueRevision: number;
  externalChanges?: MarkdownSourceChanges;
  assetSourcePath?: string;
  assetSourceOperation?: "rebase" | "rename";
  assetSourceTransition?: { oldPath: string; newPath: string; operation: "rebase" | "rename" };
  onError?: (message: string) => void;
  onChange: (value: string) => void;
  onReady?: () => void;
};

const restoreImageOrigin = StateEffect.define<{ path: string; revision: number }>();

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

type SeparatorRecord = { anchor: number; offset: number; value: string; affinity?: -1 | 1 };
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
      anchor: changes.mapPos(record.anchor, record.affinity ?? -1),
    })),
});

function separateAdjacentNewlines(separators: Map<number, string>) {
  const repairs: { position: number; value: string }[] = [];
  for (const [position, value] of separators) {
    if (value === "\n" && separators.get(position - 1) === "\r") {
      // Two logical breaks must not serialize as one CRLF after an edit joins
      // them. Retain the CR and extend the following LF to its own CRLF.
      repairs.push({ position, value });
      separators.set(position, "\r\n");
    }
  }
  return repairs;
}

const separatorMappings = new WeakMap<Transaction, {
  separators: Map<number, string>;
  repairs: { position: number; value: string }[];
}>();

function mappedSeparators(transaction: Transaction) {
  const cached = separatorMappings.get(transaction);
  if (cached) return cached;
  const current = transaction.startState.field(separatorMetadata);
  const separators = new Map<number, string>();
  const previousSeparators = [...current.separators].sort(([left], [right]) => left - right);
  let separatorIndex = 0;
  // Walk unchanged ranges once, including large selections with many edits.
  transaction.changes.iterGaps((from, mappedFrom, length) => {
    while (separatorIndex < previousSeparators.length && previousSeparators[separatorIndex][0] < from) separatorIndex += 1;
    while (separatorIndex < previousSeparators.length && previousSeparators[separatorIndex][0] < from + length) {
      const [position, value] = previousSeparators[separatorIndex++];
      separators.set(mappedFrom + position - from, value);
    }
  });
  transaction.changes.iterChanges((_from, _to, fromB, _toB, inserted) => {
    const text = inserted.toString();
    for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) separators.set(fromB + index, current.lineEnding);
  });
  const mapped = { separators, repairs: separateAdjacentNewlines(separators) };
  separatorMappings.set(transaction, mapped);
  return mapped;
}

const separatorMetadata = StateField.define<SeparatorMetadata>({
  create: (state) => sourceSeparators(sourceSnapshot(state.doc.toString())),
  update: (current, transaction) => {
    if (!transaction.docChanged && transaction.effects.length === 0)
      return current;
    let next = current;
    if (transaction.docChanged) {
      next = { ...current, separators: mappedSeparators(transaction).separators };
    }
    for (const effect of transaction.effects) {
      if (effect.is(replaceSeparators)) next = effect.value;
      if (effect.is(restoreSeparators)) {
        const separators = new Map(next.separators);
        for (const record of effect.value) {
          const position =
            transaction.changes.mapPos(record.anchor, record.affinity ?? -1) + record.offset;
          if (transaction.newDoc.sliceString(position, position + 1) === "\n")
            separators.set(position, record.value);
        }
        next = { ...next, separators };
      }
    }
    if (next !== current) separateAdjacentNewlines(next.separators as Map<number, string>);
    return next;
  },
});

function deletedSeparators(transaction: Transaction): SeparatorRecord[] {
  if (!transaction.docChanged) return [];
  const records: SeparatorRecord[] = [];
  const previous = transaction.startState.field(separatorMetadata);
  transaction.changes.iterChangedRanges((from, to, anchor) => {
    // Indenting many selected lines creates thousands of small edits. None
    // delete a separator, so avoid scanning the whole separator map per line.
    if (!transaction.startState.doc.sliceString(from, to).includes("\n"))
      return;
    for (const [position, value] of previous.separators) {
      if (position >= from && position < to && value !== previous.lineEnding)
        records.push({ anchor, offset: position - from, value });
    }
  });
  for (const { position, value } of mappedSeparators(transaction).repairs) {
    const previousPosition = transaction.changes.invertedDesc.mapPos(position, 1);
    if (previous.separators.get(previousPosition) === value) {
      records.push({ anchor: position, offset: 0, value, affinity: 1 });
    }
  }
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
  nextDocument: Text,
  restore = false,
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
  const next = sourceSnapshot(parts.join(""));
  if (!restore && next.normalized.length === nextDocument.length) return next;
  return sourceSnapshot(nextDocument.toString().replace(/\n/g, (_newline, index: number) =>
    metadata.separators.get(index) ?? metadata.lineEnding,
  ));
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
    previous.assetSourcePath === next.assetSourcePath &&
    previous.assetSourceOperation === next.assetSourceOperation &&
    previous.assetSourceTransition === next.assetSourceTransition &&
    previous.onReady === next.onReady
  );
}

/** A controlled CodeMirror surface for editable, syntax-coloured Markdown. */
export const MarkdownSourceEditor = memo(
  forwardRef<SwitchableEditorHandle, Props>(function MarkdownSourceEditor(
    { language, value, valueRevision, externalChanges, assetSourcePath, assetSourceOperation = "rebase", assetSourceTransition, onError, onChange, onReady },
    ref,
  ) {
    const host = useRef<HTMLDivElement>(null);
    const view = useRef<EditorView | null>(null);
    const contentAttributes = useRef(new Compartment()).current;
    const createSourceState =
      useRef<
        (
          snapshot: SourceSnapshot,
          selection?: { anchor: number; head: number },
        ) => EditorState
      >(undefined);
    const languageRef = useRef(language);
    languageRef.current = language;
    const rawSource = useRef<SourceSnapshot>(sourceSnapshot(value));
    const onChangeRef = useRef(onChange);
    const onReadyRef = useRef(onReady);
    const onErrorRef = useRef(onError);
    const assetSourcePathRef = useRef(assetSourcePath);
    const assetTransitions = useRef<Array<{ oldPath: string; newPath: string; operation: "rebase" | "rename" }>>([]);
    const appliedAssetTransition = useRef<typeof assetSourceTransition>(undefined);
    const applyingExternalValue = useRef(false);
    const currentSearch = useRef<{
      query: string;
      active: number;
      document?: EditorState["doc"];
      matches?: ReturnType<typeof findTextMatches>;
    }>({ query: "", active: -1 });
    onChangeRef.current = onChange;
    onReadyRef.current = onReady;
    onErrorRef.current = onError;

    useLayoutEffect(() => {
      if (!host.current) return;
      createSourceState.current = (snapshot, selection) => {
        const document = Text.of(snapshot.normalized.split("\n"));
        return EditorState.create({
          doc: document,
          selection,
          extensions: [
            lineNumbers(),
            history(),
            separatorMetadata.init(() => sourceSeparators(snapshot)),
            separatorHistory,
            invertedEffects.of((transaction) => transaction.docChanged && assetSourcePathRef.current
              ? [restoreImageOrigin.of({ path: assetSourcePathRef.current, revision: assetTransitions.current.length })] : []),
            bracketMatching(),
            highlightActiveLine(),
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            boundedSourceSyntax(document, [
              markdown(),
              syntaxHighlighting(markdownHighlightStyle),
            ]),
            searchDecorations,
            EditorView.lineWrapping,
            contentAttributes.of(
              EditorView.contentAttributes.of({
                "aria-label": getMessages(languageRef.current).markdownSource,
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
                  update.state.doc,
                  update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(restoreSeparators))),
                );
                rawSource.current = next;
                onChangeRef.current(next.value);
              }
            }),
          ],
        });
      };
      const editor = new EditorView({
        state: createSourceState.current(rawSource.current),
        parent: host.current,
        dispatchTransactions(transactions, target) {
          const updates: Transaction[] = [];
          try {
            for (const transaction of transactions) {
              updates.push(transaction);
              const origin = transaction.effects.find((effect) => effect.is(restoreImageOrigin))?.value;
              const destination = assetSourcePathRef.current;
              if (!origin || !destination || origin.revision === assetTransitions.current.length || !transaction.docChanged) continue;
              const restored: Array<{ from: number; to: number }> = [];
              transaction.changes.iterChanges((_from, _to, from, to) => {
                if (to > from) restored.push({ from, to });
              });
              let rewritten = transaction;
              for (const transition of assetTransitions.current.slice(origin.revision)) {
                const source = rewritten.newDoc.toString();
                const rebased = transition.operation === "rename"
                  ? renameMarkdownImageAssets(source, transition.oldPath, transition.newPath)
                  : rebaseMarkdownImageAssets(source, transition.oldPath, transition.newPath);
                const imageChanges = imagePathSourceChanges(source, rebased, transition.oldPath, transition.newPath, transition.operation)?.changes ?? [];
                const changes = imageChanges.filter((change) => restored.some((range) =>
                  change.from >= range.from && change.to <= range.to));
                if (!changes.length) continue;
                const repair = ChangeSet.of(changes.map(({ from, to, value: insert }) => ({ from, to, insert })), source.length);
                for (const range of restored) {
                  range.from = repair.mapPos(range.from, -1);
                  range.to = repair.mapPos(range.to, 1);
                }
                // Compose the rewrite into the original history transaction.
                // A separate non-history insertion would fall outside the redo
                // deletion's boundary and leave part of the URL behind.
                rewritten = transaction.startState.update(rewritten, {
                  changes: repair,
                  sequential: true,
                  filter: false,
                });
              }
              updates[updates.length - 1] = rewritten;
            }
          } catch (error) {
            // A failed path rewrite must leave both the document and history
            // untouched, so the user can retry without losing the undo step.
            onErrorRef.current?.(error instanceof Error ? error.message : String(error));
            return;
          }
          target.update(updates);
        },
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

    useLayoutEffect(() => {
      const previous = assetSourcePathRef.current;
      const explicitTransition = assetSourceTransition && assetSourceTransition !== appliedAssetTransition.current;
      appliedAssetTransition.current = assetSourceTransition;
      if (previous === assetSourcePath && !explicitTransition) return;
      // Companion-folder rollback can fail even after the Markdown file was
      // restored to its original path. Its asset transition is independent.
      if (explicitTransition) assetTransitions.current.push({ ...assetSourceTransition });
      else if (previous && assetSourcePath) assetTransitions.current.push({ oldPath: previous, newPath: assetSourcePath, operation: assetSourceOperation });
      assetSourcePathRef.current = assetSourcePath;
      view.current?.dispatch({ annotations: [isolateHistory.of("full"), Transaction.addToHistory.of(false)] });
    }, [assetSourcePath, assetSourceOperation, assetSourceTransition]);

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
      if (!changes) {
        // A full external snapshot has no trustworthy mapping for old undo
        // steps or separator-restoration effects. Start fresh in this view.
        rawSource.current = nextSnapshot;
        currentSearch.current = { query: "", active: -1 };
        editor.setState(
          createSourceState.current!(nextSnapshot, {
            anchor: Math.min(anchor, nextSnapshot.normalized.length),
            head: Math.min(head, nextSnapshot.normalized.length),
          }),
        );
        return;
      }
      // A path rebase belongs to the same document, even when its original
      // first separator was deleted and the remaining first style differs.
      metadata.lineEnding = editor.state.field(separatorMetadata).lineEnding;
      applyingExternalValue.current = true;
      try {
        editor.dispatch({
          effects: replaceSeparators.of(metadata),
          changes,
          // External path rewrites map existing undo steps without creating a
          // new history event of their own.
          annotations: Transaction.addToHistory.of(false),
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
