import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { useEffect, useRef } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { BlockFormula, InlineFormula } from '../editor/Formula';
import { formulaFromClipboard } from '../editor/formulaInput';
import { sanitizePastedHtml } from '../editor/paste';
import { PaperImage } from '../editor/PaperImage';
import { UnsupportedMarkdown } from '../editor/UnsupportedMarkdown';

const lowlight = createLowlight(common);

export type InsertAction =
  | 'heading'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'quote'
  | 'code'
  | 'table'
  | 'image'
  | 'inlineFormula'
  | 'blockFormula';

type Props = {
  documentId: number;
  initialDocument: JSONContent;
  onChange: (document: JSONContent) => void;
  onReady: (insert: (action: InsertAction) => void) => void;
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

export function CanvasEditor({ documentId, initialDocument, onChange, onReady }: Props) {
  const initialDocumentRef = useRef(initialDocument);
  const imageInputRef = useRef<HTMLInputElement>(null);
  initialDocumentRef.current = initialDocument;
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false, link: false }),
      CodeBlockLowlight.configure({ lowlight }),
      Link.configure({ openOnClick: false, autolink: true, defaultProtocol: 'https' }),
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
      Placeholder.configure({ placeholder: '開始寫作；輸入 / 或使用上方工具列插入內容。' }),
      InlineFormula,
      BlockFormula,
      UnsupportedMarkdown,
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
        const image = Array.from(event.clipboardData?.files ?? []).find((file) =>
          file.type.startsWith('image/'),
        );
        if (image) {
          void readImage(image).then((src) => insertImage(view, src, image.name));
          return true;
        }
        const formula = formulaFromClipboard(event.clipboardData?.getData('text/plain') ?? '');
        if (!formula) return false;
        const formulaNode =
          view.state.schema.nodes[formula.kind === 'block' ? 'blockFormula' : 'inlineFormula'];
        if (!formulaNode) return false;
        view.dispatch(
          view.state.tr
            .replaceSelectionWith(formulaNode.create({ latex: formula.latex }))
            .scrollIntoView(),
        );
        view.focus();
        return true;
      },
      handleDrop: (view, event) => {
        const image = Array.from(event.dataTransfer?.files ?? []).find((file) =>
          file.type.startsWith('image/'),
        );
        if (!image) return false;
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        void readImage(image).then((src) => insertImage(view, src, image.name, position));
        return true;
      },
    },
    onUpdate: ({ editor: currentEditor }) => onChange(currentEditor.getJSON()),
  });

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(initialDocumentRef.current, { emitUpdate: false });
  }, [documentId, editor]);

  useEffect(() => {
    if (!editor) return;
    onReady((action) => {
      const chain = editor.chain().focus();
      switch (action) {
        case 'heading':
          return void chain.toggleHeading({ level: 2 }).run();
        case 'bulletList':
          return void chain.toggleBulletList().run();
        case 'orderedList':
          return void chain.toggleOrderedList().run();
        case 'taskList':
          return void chain.toggleTaskList().run();
        case 'quote':
          return void chain.toggleBlockquote().run();
        case 'code':
          return void chain.toggleCodeBlock().run();
        case 'table':
          return void chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        case 'image':
          imageInputRef.current?.click();
          return;
        case 'inlineFormula':
          return void chain.insertContent({ type: 'inlineFormula', attrs: { latex: '' } }).run();
        case 'blockFormula':
          return void chain.insertContent({ type: 'blockFormula', attrs: { latex: '' } }).run();
      }
    });
  }, [editor, onReady]);

  return (
    <>
      <EditorContent editor={editor} />
      <input
        ref={imageInputRef}
        className="image-file-input"
        type="file"
        accept="image/*"
        aria-label="選擇要插入的圖片"
        onChange={(event) => {
          const [image] = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          if (!image || !editor) return;
          void readImage(image).then((src) =>
            editor.chain().focus().setImage({ src, alt: image.name }).run(),
          );
        }}
      />
    </>
  );
}
