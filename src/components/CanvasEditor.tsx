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
import type { Editor, JSONContent } from '@tiptap/core';
import { Selection, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  commentContext,
  markdownFingerprint,
  type CommentPlacement,
  type CommentTarget,
  type MarkdownComment,
} from '../editor/comments';
import {
  commentDecorationsPluginKey,
  createCommentDecorationsExtension,
  type CanvasCommentPosition,
} from '../editor/commentDecorations';
import { BlockFormula, InlineFormula } from '../editor/Formula';
import { HtmlPreview, InlineHtmlPreview } from '../editor/HtmlPreview';
import { replaceDocumentPreservingSelection } from '../editor/documentSync';
import { documentToMarkdown } from '../editor/markdown';
import { insertPastedFormula, insertPastedMarkdown, sanitizePastedHtml } from '../editor/paste';
import { PaperImage } from '../editor/PaperImage';
import { scrollToOutlineHeading } from '../editor/outline';
import {
  markdownSelectionFromMarkedDocument,
  positionFromMarkdownOffset,
  positionFromDocumentAnchor,
  selectionMarker,
} from '../editor/selectionMapping';
import { UnsupportedMarkdown } from '../editor/UnsupportedMarkdown';
import {
  clearDocumentSearch,
  DocumentSearch,
  getSelectedDocumentText,
  searchDocument,
  type ContextMenuAction,
  type SwitchableEditorHandle,
} from '../editor/search';
import { getMessages, type Language } from '../i18n';

const lowlight = createLowlight(common);

type Props = {
  language: Language;
  documentId: number;
  initialDocument: JSONContent;
  comments?: readonly MarkdownComment[];
  outlineTarget?: { index: number; request: number };
  onChange: (document: JSONContent, comments?: MarkdownComment[]) => void;
  onCommentRequest?: (placement: CommentPlacement, coordinates: { x: number; y: number }) => void;
  onCommentClick?: (id: string) => void;
  canUndoComment?: boolean;
  canRedoComment?: boolean;
  onUndoComment?: () => void;
  onRedoComment?: () => void;
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

function markdownOffsetAtPosition(editor: Editor, position: number): number | undefined {
  const bounded = Math.min(Math.max(0, Math.round(position)), editor.state.doc.content.size);
  try {
    const markedDocument = editor.state.tr.insertText(selectionMarker, bounded, bounded).doc.toJSON();
    return markdownSelectionFromMarkedDocument(editor.getJSON(), markedDocument)?.offset;
  } catch {
    return undefined;
  }
}

function canvasPositionsForComments(
  editor: Editor,
  markdown: string,
  comments: readonly MarkdownComment[],
): CanvasCommentPosition[] {
  const orderedComments = comments
    .map((comment, index) => ({ comment, index }))
    .sort((left, right) => {
      const leftOffset =
        left.comment.target.kind === 'position' ? left.comment.target.offset : left.comment.target.from;
      const rightOffset =
        right.comment.target.kind === 'position' ? right.comment.target.offset : right.comment.target.from;
      return leftOffset - rightOffset || left.index - right.index;
    });

  return orderedComments.map(({ comment }, index) => {
    const fromOffset = comment.target.kind === 'position' ? comment.target.offset : comment.target.from;
    const toOffset = comment.target.kind === 'position' ? fromOffset : comment.target.to;
    const from =
      positionFromMarkdownOffset(editor.state.doc, markdown, fromOffset)?.position ?? editor.state.selection.head;
    const to = positionFromMarkdownOffset(editor.state.doc, markdown, toOffset)?.position ?? from;
    return {
      id: comment.id,
      kind: comment.target.kind,
      from: Math.min(from, to),
      to: Math.max(from, to),
      status: comment.status,
      number: index + 1,
    };
  });
}

function sameCanvasPositions(left: CanvasCommentPosition[], right: CanvasCommentPosition[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function mappedCommentsFromCanvas(editor: Editor, comments: readonly MarkdownComment[]): MarkdownComment[] {
  const markdown = documentToMarkdown(editor.getJSON());
  const positions = commentDecorationsPluginKey.getState(editor.state)?.positions ?? [];
  return comments.map((comment) => {
    const position = positions.find((candidate) => candidate.id === comment.id);
    if (!position) return comment;
    const from = markdownOffsetAtPosition(editor, position.from);
    const to = markdownOffsetAtPosition(editor, position.to);
    if (from === undefined || to === undefined) return comment;
    const target: CommentTarget =
      comment.target.kind === 'position'
        ? { kind: 'position', offset: from }
        : { kind: 'range', from: Math.min(from, to), to: Math.max(from, to) };
    const context = commentContext(markdown, target);
    const excerpt =
      comment.target.kind === 'range' && position.from < position.to
        ? editor.state.doc.textBetween(position.from, position.to, '\n') || comment.excerpt
        : comment.excerpt;
    return {
      ...comment,
      target,
      excerpt,
      contextBefore: context.before,
      contextAfter: context.after,
      anchorText: context.anchorText,
      bodyFingerprint: markdownFingerprint(markdown),
      status: position.status,
    };
  });
}

function contextMenuPlacement(
  editor: Editor,
  event: MouseEvent,
  preservedSelection?: { from: number; to: number },
): CommentPlacement {
  const clickedPosition =
    editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? editor.state.selection.head;
  const selection = preservedSelection ?? editor.state.selection;
  const selectedRange =
    selection.from !== selection.to && clickedPosition >= selection.from && clickedPosition <= selection.to;
  const fromPosition = selectedRange ? selection.from : clickedPosition;
  const toPosition = selectedRange ? selection.to : clickedPosition;
  const from = markdownOffsetAtPosition(editor, fromPosition) ?? 0;
  const to = markdownOffsetAtPosition(editor, toPosition) ?? from;
  if (!selectedRange) return { target: { kind: 'position', offset: from } };
  return {
    target: { kind: 'range', from: Math.min(from, to), to: Math.max(from, to) },
    excerpt: editor.state.doc.textBetween(fromPosition, toPosition, '\n'),
  };
}

export const CanvasEditor = forwardRef<SwitchableEditorHandle, Props>(function CanvasEditor(
  {
    language,
    documentId,
    initialDocument,
    comments = [],
    outlineTarget,
    onChange,
    onCommentRequest,
    onCommentClick,
    canUndoComment = false,
    canRedoComment = false,
    onUndoComment,
    onRedoComment,
    onReady,
  },
  ref,
) {
  const text = getMessages(language);
  const initialDocumentRef = useRef(initialDocument);
  initialDocumentRef.current = initialDocument;
  const commentsRef = useRef<readonly MarkdownComment[]>(comments);
  const onChangeRef = useRef(onChange);
  const onCommentRequestRef = useRef(onCommentRequest);
  const onCommentClickRef = useRef(onCommentClick);
  const canUndoCommentRef = useRef(canUndoComment);
  const canRedoCommentRef = useRef(canRedoComment);
  const onUndoCommentRef = useRef(onUndoComment);
  const onRedoCommentRef = useRef(onRedoComment);
  commentsRef.current = comments;
  onChangeRef.current = onChange;
  onCommentRequestRef.current = onCommentRequest;
  onCommentClickRef.current = onCommentClick;
  canUndoCommentRef.current = canUndoComment;
  canRedoCommentRef.current = canRedoComment;
  onUndoCommentRef.current = onUndoComment;
  onRedoCommentRef.current = onRedoComment;
  const markerClickRef = useRef<((id: string) => void) | undefined>(undefined);
  markerClickRef.current = (id) => onCommentClickRef.current?.(id);
  const editorRef = useRef<Editor | null>(null);
  const contextSelectionRef = useRef<{ from: number; to: number } | undefined>(undefined);
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
        HtmlPreview,
        InlineHtmlPreview,
        UnsupportedMarkdown,
        createCommentDecorationsExtension(markerClickRef),
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
        handleDOMEvents: {
          mousedown: (view, event) => {
            if (event instanceof MouseEvent && event.button === 2 && !view.state.selection.empty) {
              contextSelectionRef.current = {
                from: view.state.selection.from,
                to: view.state.selection.to,
              };
            } else if (event instanceof MouseEvent && event.button !== 2) {
              contextSelectionRef.current = undefined;
            }
            return false;
          },
          contextmenu: (_view, event) => {
            if (!(event instanceof MouseEvent)) return false;
            event.preventDefault();
            const currentEditor = editorRef.current;
            if (!currentEditor) return true;
            const placement = contextMenuPlacement(currentEditor, event, contextSelectionRef.current);
            if (placement.target.kind !== 'range') contextSelectionRef.current = undefined;
            onCommentRequestRef.current?.(placement, {
              x: event.clientX,
              y: event.clientY,
            });
            return true;
          },
          keydown: (_view, event) => {
            if (!(event instanceof KeyboardEvent)) return false;
            if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
            const key = event.key.toLowerCase();
            if (key === 'z' && event.shiftKey && canRedoCommentRef.current) {
              event.preventDefault();
              onRedoCommentRef.current?.();
              return true;
            }
            if (key === 'z' && !event.shiftKey && canUndoCommentRef.current) {
              event.preventDefault();
              onUndoCommentRef.current?.();
              return true;
            }
            if (key === 'y' && canRedoCommentRef.current) {
              event.preventDefault();
              onRedoCommentRef.current?.();
              return true;
            }
            return false;
          },
        },
      },
      onUpdate: ({ editor: currentEditor }) => {
        const currentComments = commentsRef.current;
        onChangeRef.current(
          currentEditor.getJSON(),
          currentComments.length > 0 ? mappedCommentsFromCanvas(currentEditor, currentComments) : undefined,
        );
      },
    },
    [language],
  );
  editorRef.current = editor;

  useLayoutEffect(() => {
    if (!editor) return;
    replaceDocumentPreservingSelection(editor, initialDocumentRef.current);
  }, [documentId, editor]);

  useEffect(() => {
    if (!editor) return;
    const markdown = documentToMarkdown(editor.getJSON());
    const positions = canvasPositionsForComments(editor, markdown, commentsRef.current);
    const current = commentDecorationsPluginKey.getState(editor.state)?.positions ?? [];
    if (sameCanvasPositions(current, positions)) return;
    editor.view.dispatch(editor.state.tr.setMeta(commentDecorationsPluginKey, positions));
  }, [comments, documentId, editor]);

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
      setMarkdownSelection: (range) => {
        if (!editor) return false;
        const markdown = documentToMarkdown(editor.getJSON());
        const from = positionFromMarkdownOffset(editor.state.doc, markdown, range.from)?.position;
        const to = positionFromMarkdownOffset(editor.state.doc, markdown, range.to)?.position;
        if (from === undefined || to === undefined) return false;
        const start = Math.min(from, to);
        const end = Math.max(from, to);
        const selection =
          start === end
            ? Selection.near(editor.state.doc.resolve(start))
            : TextSelection.create(editor.state.doc, start, end);
        editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
        editor.view.focus();
        return true;
      },
      runContextAction: (action: ContextMenuAction) => {
        if (!editor) return;
        const preservedSelection = contextSelectionRef.current;
        if (preservedSelection) {
          editor.view.dispatch(
            editor.state.tr.setSelection(
              TextSelection.create(editor.state.doc, preservedSelection.from, preservedSelection.to),
            ),
          );
        }
        editor.view.focus();
        if (action === 'selectAll') {
          editor.commands.selectAll();
          contextSelectionRef.current = undefined;
          return;
        }
        document.execCommand(action);
        contextSelectionRef.current = undefined;
      },
      isFocused: () => editor?.view.hasFocus() ?? false,
      requestMeasure: () => undefined,
    }),
    [editor],
  );

  return <EditorContent editor={editor} />;
});
