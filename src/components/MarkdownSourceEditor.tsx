import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, bracketMatching, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

type Props = {
  value: string;
  onChange: (value: string) => void;
};

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--markdown-heading)', fontWeight: '700' },
  { tag: [tags.keyword, tags.controlKeyword], color: 'var(--markdown-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--markdown-string)' },
  { tag: [tags.comment, tags.meta], color: 'var(--markdown-comment)', fontStyle: 'italic' },
  { tag: [tags.url, tags.link], color: 'var(--markdown-link)', textDecoration: 'underline' },
  { tag: [tags.emphasis, tags.strong], color: 'var(--markdown-emphasis)', fontWeight: '700' },
  { tag: [tags.monospace, tags.literal], color: 'var(--markdown-code)' },
  { tag: tags.punctuation, color: 'var(--markdown-punctuation)' },
]);

/** A controlled CodeMirror surface for editable, syntax-coloured Markdown. */
export function MarkdownSourceEditor({ value, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const initialValue = useRef(value);
  const onChangeRef = useRef(onChange);
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
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': '原始 Markdown',
            spellcheck: 'false',
          }),
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
  }, []);

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

  return <div ref={host} className="markdown-source-editor" />;
}
