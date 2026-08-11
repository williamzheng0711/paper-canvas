import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { JSONContent } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { BlockFormula, InlineFormula } from '../editor/Formula';
import { replaceDocumentPreservingSelection } from '../editor/documentSync';
import { insertPastedFormula, insertPastedMarkdown, sanitizePastedHtml } from '../editor/paste';
import { PaperImage } from '../editor/PaperImage';
import { scrollToOutlineHeading } from '../editor/outline';
import {
  markdownSelectionFromMarkedDocument,
  positionFromDocumentAnchor,
  selectionMarker,
} from '../editor/selectionMapping';
import { UnsupportedMarkdown } from '../editor/UnsupportedMarkdown';
import {
  clearDocumentSearch,
  DocumentSearch,
  getSelectedDocumentText,
  searchDocument,
  type SwitchableEditorHandle,
} from '../editor/search';
import { getMessages, type Language } from '../i18n';

const lowlight = createLowlight(common);

type Props = {
  language: Language;
  documentId: number;
  initialDocument: JSONContent;
  outlineTarget?: { index: number; request: number };
  onChange: (document: JSONContent) => void;
  onReady?: () => void;
};

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function insertImage(view: EditorView, src: string, alt = '', position?: number): void {
  const imageNode = view.state.schema.nodes.image;
  if (!imageNode) return;
  const image = imageNode.create({ src, alt });
  const transaction =
    position === undefined
      ? view.state.tr.replaceSelectionWith(image)
      : view.state.tr.replaceRangeWith(position, position, image);
  view.dispatch(transaction.scrollIntoView());
  view.focus();
}

export const CanvasEditor = forwardRef<SwitchableEditorHandle, Props>(function CanvasEditor(
  { language, documentId, initialDocument, outlineTarget, onChange, onReady },
  ref,
) {
  const text = getMessages(language);
  const initialDocumentRef = useRef(initialDocument);
  initialDocumentRef.current = initialDocument;
  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ codeBlock: false, link: false }),
        CodeBlockLowlight.configure({ lowlight }),
        Link.configure({
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
        }),
        PaperImage.configure({
          allowBase64: true,
          resize: {
            enabled: true,
            directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
            minWidth: 80,
            minHeight: 60,
            // Tiptap locks the ratio temporarily while Shift is pressed, which
            // matches desktop-document editors without forcing it by default.
            alwaysPreserveAspectRatio: false,
          },
        }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder: text.canvasPlaceholder }),
        InlineFormula,
        BlockFormula,
        UnsupportedMarkdown,
        DocumentSearch,
      ],
      content: initialDocument,
      // Formula React node views are created during editor initialization. Delay
      // the first render until this component is mounted so Tiptap does not call
      // React flushSync while React itself is reconciling the canvas.
      immediatelyRender: false,
      editorProps: {
        attributes: { class: 'paper-editor ProseMirror', spellcheck: 'true' },
        transformPastedHTML: sanitizePastedHtml,
        handlePaste: (view, event) => {
          const image = Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith('image/'));
          if (image) {
            void readImage(image).then((src) => insertImage(view, src, image.name));
            return true;
          }
          const plainText = event.clipboardData?.getData('text/plain') ?? '';
          if (insertPastedFormula(view, plainText)) {
            view.focus();
            return true;
          }
          // Preserve rich HTML through ProseMirror's sanitized HTML path. For
          // plain text, parse mixed Markdown/math as one structural slice so a
          // citation command cannot collapse several paragraphs into one node.
          if (!event.clipboardData?.getData('text/html') && insertPastedMarkdown(view, plainText)) {
            view.focus();
            return true;
          }
          return false;
        },
        handleDrop: (view, event) => {
          // Tauri's native file-drop interceptor is disabled in tauri.conf.json
          // so desktop image files reach this standard DataTransfer handler.
          const image = Array.from(event.dataTransfer?.files ?? []).find((file) => file.type.startsWith('image/'));
          if (!image) return false;
          const position = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          })?.pos;
          void readImage(image).then((src) => insertImage(view, src, image.name, position));
          return true;
        },
      },
      onUpdate: ({ editor: currentEditor }) => onChange(currentEditor.getJSON()),
    },
    [language],
  );

  useLayoutEffect(() => {
    if (!editor) return;
    replaceDocumentPreservingSelection(editor, initialDocumentRef.current);
  }, [documentId, editor]);

  useEffect(() => {
    if (editor) onReady?.();
  }, [editor, onReady]);

  useEffect(() => {
    if (!editor || !outlineTarget) return;
    scrollToOutlineHeading(editor.view.dom, outlineTarget.index);
  }, [editor, outlineTarget]);

  useImperativeHandle(
    ref,
    () => ({
      search: (query, direction) => (editor ? searchDocument(editor, query, direction) : { current: 0, total: 0 }),
      clearSearch: () => {
        if (editor) clearDocumentSearch(editor);
      },
      focus: () => editor?.view.focus(),
      getSelectedText: () => (editor ? getSelectedDocumentText(editor) : ''),
      getSelectionProgress: () => {
        if (!editor) return 0;
        const documentSize = Math.max(1, editor.state.doc.content.size);
        return editor.state.selection.head / documentSize;
      },
      getSelectionViewportOffset: () => {
        if (!editor) return undefined;
        const viewport = editor.view.dom.closest<HTMLElement>('.canvas-area');
        if (!viewport) return undefined;
        const coordinates = editor.view.coordsAtPos(editor.state.selection.head);
        return coordinates.top - viewport.getBoundingClientRect().top;
      },
      setSelectionProgress: (progress) => {
        if (!editor) return;
        const documentSize = editor.state.doc.content.size;
        const position = Math.round(Math.min(1, Math.max(0, progress)) * documentSize);
        const selection = Selection.near(editor.state.doc.resolve(position));
        editor.view.dispatch(editor.state.tr.setSelection(selection));
      },
      getMarkdownSelection: () => {
        if (!editor) return undefined;
        try {
          const position = editor.state.selection.head;
          const markedDocument = editor.state.tr.insertText(selectionMarker, position, position).doc.toJSON();
          return markdownSelectionFromMarkedDocument(editor.getJSON(), markedDocument);
        } catch {
          return undefined;
        }
      },
      setDocumentSelection: (anchor) => {
        if (!editor) return false;
        const resolved = positionFromDocumentAnchor(editor.state.doc, anchor);
        if (!resolved) return false;
        const selection = Selection.near(editor.state.doc.resolve(resolved.position), resolved.affinity);
        editor.view.dispatch(editor.state.tr.setSelection(selection));
        return true;
      },
      isFocused: () => editor?.view.hasFocus() ?? false,
      requestMeasure: () => undefined,
    }),
    [editor],
  );

  return <EditorContent editor={editor} />;
});
