import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { findTextMatches, resolveActiveMatch, type SearchableEditorHandle } from '../editor/search';
import { getMessages, type Language } from '../i18n';

type Props = {
  language: Language;
  value: string;
  onChange: (value: string) => void;
};

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--markdown-heading)', fontWeight: '700' },
  {
    tag: [tags.keyword, tags.controlKeyword],
    color: 'var(--markdown-keyword)',
    fontWeight: '600',
  },
  {
    tag: [tags.string, tags.special(tags.string)],
    color: 'var(--markdown-string)',
  },
  {
    tag: [tags.comment, tags.meta],
    color: 'var(--markdown-comment)',
    fontStyle: 'italic',
  },
  {
    tag: [tags.url, tags.link],
    color: 'var(--markdown-link)',
    textDecoration: 'underline',
  },
  {
    tag: [tags.emphasis, tags.strong],
    color: 'var(--markdown-emphasis)',
    fontWeight: '700',
  },
  { tag: [tags.monospace, tags.literal], color: 'var(--markdown-code)' },
  { tag: tags.punctuation, color: 'var(--markdown-punctuation)' },
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
                ? 'cm-document-search-match cm-document-search-match--active'
                : 'cm-document-search-match',
          }).range(match.from, match.to),
        ),
      );
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** A controlled CodeMirror surface for editable, syntax-coloured Markdown. */
export const MarkdownSourceEditor = forwardRef<SearchableEditorHandle, Props>(function MarkdownSourceEditor(
  { language, value, onChange },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const contentAttributes = useRef(new Compartment()).current;
  const initialValue = useRef(value);
  const onChangeRef = useRef(onChange);
  const currentSearch = useRef({ query: '', active: -1 });
  onChangeRef.current = onChange;

  useEffect(() => {
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
              'aria-label': getMessages().markdownSource,
              spellcheck: 'false',
            }),
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
      parent: host.current,
    });
    view.current = editor;
    return () => {
      if (view.current === editor) view.current = null;
      editor.destroy();
    };
  }, [contentAttributes]);

  useEffect(() => {
    view.current?.dispatch({
      effects: contentAttributes.reconfigure(
        EditorView.contentAttributes.of({
          'aria-label': getMessages(language).markdownSource,
          spellcheck: 'false',
        }),
      ),
    });
  }, [contentAttributes, language]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    const { anchor, head } = editor.state.selection.main;
    editor.dispatch({
      changes: { from: 0, to: current.length, insert: value },
      selection: {
        anchor: Math.min(anchor, value.length),
        head: Math.min(head, value.length),
      },
    });
  }, [value]);

  useImperativeHandle(
    ref,
    () => ({
      search: (query, direction) => {
        const editor = view.current;
        if (!editor) return { current: 0, total: 0 };
        const matches = findTextMatches(editor.state.doc.toString(), query);
        const active = resolveActiveMatch(
          matches,
          query,
          direction,
          currentSearch.current.query,
          currentSearch.current.active,
          editor.state.selection.main.from,
        );
        currentSearch.current = { query, active };
        const effects: StateEffect<unknown>[] = [setSearchDecorations.of({ matches, active })];
        if (active >= 0) {
          effects.push(EditorView.scrollIntoView(matches[active].from, { y: 'center' }));
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
        currentSearch.current = { query: '', active: -1 };
        view.current?.dispatch({
          effects: setSearchDecorations.of({ matches: [], active: -1 }),
        });
      },
      focus: () => view.current?.focus(),
      getSelectedText: () => {
        const editor = view.current;
        if (!editor) return '';
        const { from, to } = editor.state.selection.main;
        return editor.state.sliceDoc(from, to);
      },
    }),
    [],
  );

  return <div ref={host} className="markdown-source-editor" />;
});
