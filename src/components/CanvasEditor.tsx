import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { Editor, JSONContent } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { Selection, TextSelection, type SelectionBookmark } from '@tiptap/pm/state';
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
import { focusedFormulaSelection, focusFormulaSource, updateFormulaLabels } from '../editor/Formula';
import { MarkdownTyping } from '../editor/markdownTyping';
import { QuoteTyping } from '../editor/quoteTyping';
import { IndentedListInput } from '../editor/indentedListInput';
import { TaskListInput } from '../editor/taskListInput';
import { updateFootnoteLabels } from '../editor/Footnote';
import { canvasNodesAndMarks } from '../editor/canvasSchema';
import { replaceDocumentPreservingSelection } from '../editor/documentSync';
import { documentToMarkdown } from '../editor/markdown';
import { insertPastedFormula, insertPastedMarkdown, sanitizePastedHtml } from '../editor/paste';
import { activateDocumentLink, documentLinkTarget } from '../editor/linkNavigation';
import { scrollToOutlineHeading } from '../editor/outline';
import {
  markdownSelectionFromMarkedDocument,
  positionFromMarkdownOffset,
  positionFromDocumentAnchor,
  selectionMarker,
} from '../editor/selectionMapping';
import { updateUnsupportedMarkdownLabels } from '../editor/UnsupportedMarkdown';
import {
  clearDocumentSearch,
  DocumentSearch,
  getSelectedDocumentText,
  searchDocument,
  type ContextMenuAction,
  type SwitchableEditorHandle,
} from '../editor/search';
import { getMessages, type Language } from '../i18n';

type Props = {
  language: Language;
  documentId: number;
  documentPath?: string;
  initialDocument: JSONContent;
  comments?: readonly MarkdownComment[];
  outlineTarget?: { index: number; request: number };
  onChange: (document: JSONContent, comments?: MarkdownComment[]) => void;
  onEdit?: () => void;
  onCommentRequest?: (placement: CommentPlacement, coordinates: { x: number; y: number }) => void;
  onCommentClick?: (id: string) => void;
  onLinkError?: (message: string) => void;
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
    reader.onerror = () => reject(reader.error ?? new Error(getMessages().imageReadFailed));
    reader.onabort = () => reject(new Error(getMessages().imageReadFailed));
    reader.readAsDataURL(file);
  });
}

type ImageInsertionTarget =
  | { kind: 'paste'; selection: SelectionBookmark; content: Slice }
  | { kind: 'drop'; position: number };

type PendingImageInsertion = {
  documentId: number;
  target: ImageInsertionTarget;
  completion?: Promise<void>;
  error?: Error;
};

function insertImages(view: EditorView, images: readonly { src: string; alt: string }[], target: ImageInsertionTarget): void {
  const imageNode = view.state.schema.nodes.image;
  if (!imageNode) return;
  const content = new Slice(Fragment.fromArray(images.map(({ src, alt }) => imageNode.create({ src, alt }))), 0, 0);
  const currentSelection = view.state.selection.getBookmark();
  let pasteSelection: Selection | undefined;
  if (target.kind === 'paste') {
    pasteSelection = target.selection.resolve(view.state.doc);
    if (!view.state.doc.slice(pasteSelection.from, pasteSelection.to).eq(target.content)) {
      // Intervening edits to a selected range belong to the user. Insert after
      // that range instead of replacing newly typed or modified content.
      pasteSelection = Selection.near(view.state.doc.resolve(pasteSelection.to), -1);
    }
  }
  const transaction =
    target.kind === 'paste'
      ? view.state.tr.setSelection(pasteSelection!).replaceSelection(content)
      : view.state.tr.replaceRange(target.position, target.position, content);
  transaction.setSelection(currentSelection.map(transaction.mapping).resolve(transaction.doc));
  const restoreFocus = view.hasFocus();
  view.dispatch(transaction.scrollIntoView());
  if (restoreFocus) view.focus();
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

function markdownOffsetsAtPositions(
  editor: Editor,
  markdown: string,
  positions: readonly number[],
): Map<number, number | undefined> {
  const bounded = [...new Set(positions.map((position) => Math.min(Math.max(0, Math.round(position)), editor.state.doc.content.size)))];
  if (bounded.length === 0) return new Map();

  const markerByPosition = new Map<number, string>();
  bounded.forEach((position, index) => {
    markerByPosition.set(position, `\uE100\uE101${index.toString(36)}\uE102`);
  });

  try {
    const markedTransaction = [...bounded].sort((left, right) => right - left).reduce(
      (transaction, position) => transaction.insertText(markerByPosition.get(position)!, position, position),
      editor.state.tr,
    );
    const markedMarkdown = documentToMarkdown(markedTransaction.doc.toJSON());
    const matches = [...markerByPosition.entries()].map(([position, marker]) => ({
      position,
      marker,
      index: markedMarkdown.indexOf(marker),
    }));
    if (matches.some((match) => match.index < 0)) throw new Error('Comment marker was not serialized');
    const cleanMarkdown = matches.reduce((value, match) => value.replaceAll(match.marker, ''), markedMarkdown);
    if (cleanMarkdown !== markdown) throw new Error('Comment marker changed Markdown output');

    const offsets = new Map<number, number | undefined>();
    let removedLength = 0;
    matches
      .sort((left, right) => left.index - right.index)
      .forEach((match) => {
        offsets.set(match.position, match.index - removedLength);
        removedLength += match.marker.length;
      });
    return offsets;
  } catch {
    return new Map(bounded.map((position) => [position, markdownOffsetAtPosition(editor, position)]));
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

  const positionCache = new Map<number, number | undefined>();
  const resolvePosition = (offset: number): number | undefined => {
    if (!positionCache.has(offset)) {
      positionCache.set(offset, positionFromMarkdownOffset(editor.state.doc, markdown, offset)?.position);
    }
    return positionCache.get(offset);
  };

  return orderedComments.map(({ comment }, index) => {
    const fromOffset = comment.target.kind === 'position' ? comment.target.offset : comment.target.from;
    const toOffset = comment.target.kind === 'position' ? fromOffset : comment.target.to;
    const from = resolvePosition(fromOffset) ?? editor.state.selection.head;
    const to = resolvePosition(toOffset) ?? from;
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

function commentDecorationSignature(comments: readonly MarkdownComment[]): string {
  return JSON.stringify(
    comments.map((comment) => ({
      id: comment.id,
      target: comment.target,
      status: comment.status,
    })),
  );
}

function mappedCommentsFromCanvas(editor: Editor, comments: readonly MarkdownComment[]): MarkdownComment[] {
  const markdown = documentToMarkdown(editor.getJSON());
  const bodyFingerprint = markdownFingerprint(markdown);
  const positions = commentDecorationsPluginKey.getState(editor.state)?.positions ?? [];
  const positionsById = new Map(positions.map((position) => [position.id, position]));
  const offsetByPosition = markdownOffsetsAtPositions(
    editor,
    markdown,
    positions.flatMap((position) => [position.from, position.to]),
  );
  return comments.map((comment) => {
    const position = positionsById.get(comment.id);
    if (!position) return comment;
    const from = offsetByPosition.get(position.from);
    const to = offsetByPosition.get(position.to);
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
      bodyFingerprint,
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

function sameCanvasProps(previous: Props, next: Props): boolean {
  // The live Tiptap instance owns the document while the user types. The
  // documentId prop is the explicit signal for an external document replacement;
  // ignoring the per-keystroke snapshot avoids re-rendering the whole canvas.
  return (
    previous.language === next.language &&
    previous.documentId === next.documentId &&
    previous.documentPath === next.documentPath &&
    previous.comments === next.comments &&
    previous.onEdit === next.onEdit &&
    previous.outlineTarget === next.outlineTarget &&
    previous.onCommentRequest === next.onCommentRequest &&
    previous.onCommentClick === next.onCommentClick &&
    previous.onLinkError === next.onLinkError &&
    previous.canUndoComment === next.canUndoComment &&
    previous.canRedoComment === next.canRedoComment &&
    previous.onUndoComment === next.onUndoComment &&
    previous.onRedoComment === next.onRedoComment &&
    previous.onReady === next.onReady
  );
}

export const CanvasEditor = memo(
  forwardRef<SwitchableEditorHandle, Props>(function CanvasEditor(
  {
    language,
    documentId,
    documentPath,
    initialDocument,
    comments = [],
    outlineTarget,
    onChange,
    onEdit,
    onCommentRequest,
    onCommentClick,
    onLinkError,
    canUndoComment = false,
    canRedoComment = false,
    onUndoComment,
    onRedoComment,
    onReady,
  },
  ref,
) {
  const text = getMessages(language);
  const textRef = useRef(text);
  textRef.current = text;
  // Keep the live immutable document across editor recreation. Parent snapshots
  // may lag behind typing while the debounced change notification is pending.
  const documentSnapshot = useRef<{
    id: number;
    initial: JSONContent;
    live?: Editor['state']['doc'];
    selection?: SelectionBookmark;
    commentPositions?: CanvasCommentPosition[];
    commentSignature?: string;
  }>({
    id: documentId,
    initial: initialDocument,
  });
  if (documentSnapshot.current.id !== documentId) {
    documentSnapshot.current = { id: documentId, initial: initialDocument };
  }
  const appliedDocument = useRef<{ id: number; editor: Editor } | undefined>(undefined);
  const commentsRef = useRef<readonly MarkdownComment[]>(comments);
  const onChangeRef = useRef(onChange);
  const documentPathRef = useRef(documentPath);
  documentPathRef.current = documentPath;
  const getDocumentPath = useCallback(() => documentPathRef.current, []);
  const onEditRef = useRef(onEdit);
  const onCommentRequestRef = useRef(onCommentRequest);
  const onCommentClickRef = useRef(onCommentClick);
  const onLinkErrorRef = useRef(onLinkError);
  const canUndoCommentRef = useRef(canUndoComment);
  const canRedoCommentRef = useRef(canRedoComment);
  const onUndoCommentRef = useRef(onUndoComment);
  const onRedoCommentRef = useRef(onRedoComment);
  commentsRef.current = comments;
  onChangeRef.current = onChange;
  onEditRef.current = onEdit;
  onCommentRequestRef.current = onCommentRequest;
  onCommentClickRef.current = onCommentClick;
  onLinkErrorRef.current = onLinkError;
  canUndoCommentRef.current = canUndoComment;
  canRedoCommentRef.current = canRedoComment;
  onUndoCommentRef.current = onUndoComment;
  onRedoCommentRef.current = onRedoComment;
  const markerClickRef = useRef<((id: string) => void) | undefined>(undefined);
  markerClickRef.current = (id) => onCommentClickRef.current?.(id);
  const editorRef = useRef<Editor | null>(null);
  const contextSelectionRef = useRef<{ from: number; to: number } | undefined>(undefined);
  const commentSyncTimerRef = useRef<number | undefined>(undefined);
  const componentMountedRef = useRef(false);
  const pendingChangeRef = useRef(false);
  const lastMappedCommentsRef = useRef<readonly MarkdownComment[] | undefined>(undefined);
  const decorationSignatureRef = useRef<string | undefined>(undefined);
  const decorationDocumentIdRef = useRef<number | undefined>(undefined);
  const pendingImagesRef = useRef(new Set<PendingImageInsertion>());

  const flushCommentMapping = useCallback(() => {
    if (commentSyncTimerRef.current !== undefined) {
      window.clearTimeout(commentSyncTimerRef.current);
      commentSyncTimerRef.current = undefined;
    }
    const currentEditor = editorRef.current;
    const currentComments = commentsRef.current;
    if (!currentEditor || !pendingChangeRef.current) return;
    pendingChangeRef.current = false;
    const document = currentEditor.getJSON();
    if (currentComments.length === 0) {
      onChangeRef.current(document);
      return;
    }
    const mappedComments = mappedCommentsFromCanvas(currentEditor, currentComments);
    const commentsChanged = JSON.stringify(mappedComments) !== JSON.stringify(currentComments);
    if (commentsChanged) lastMappedCommentsRef.current = mappedComments;
    onChangeRef.current(
      document,
      commentsChanged ? mappedComments : undefined,
    );
  }, []);

  const scheduleCommentMapping = useCallback((currentEditor: Editor) => {
    if (commentSyncTimerRef.current !== undefined) window.clearTimeout(commentSyncTimerRef.current);
    commentSyncTimerRef.current = window.setTimeout(() => {
      commentSyncTimerRef.current = undefined;
      if (editorRef.current !== currentEditor) return;
      flushCommentMapping();
    }, 400);
  }, [flushCommentMapping]);

  const readAndInsertImages = useCallback((images: readonly File[], position?: number) => {
    const originatingEditor = editorRef.current;
    if (!originatingEditor) return;
    const originatingDocumentId = documentSnapshot.current.id;
    const insertion: PendingImageInsertion = {
      documentId: originatingDocumentId,
      target: position === undefined
        ? {
            kind: 'paste',
            selection: originatingEditor.state.selection.getBookmark(),
            content: originatingEditor.state.doc.slice(originatingEditor.state.selection.from, originatingEditor.state.selection.to),
          }
        : { kind: 'drop', position },
    };
    const previousInsertion = [...pendingImagesRef.current].filter((pending) => pending.documentId === originatingDocumentId).at(-1)?.completion;
    pendingImagesRef.current.add(insertion);
    const currentView = () => {
      const currentEditor = editorRef.current;
      return componentMountedRef.current && currentEditor && !currentEditor.isDestroyed && documentSnapshot.current.id === originatingDocumentId
        ? currentEditor.view : undefined;
    };
    insertion.completion = Promise.all(images.map(async (image) => ({ src: await readImage(image), alt: image.name }))).then(async (readImages) => {
      // Reading is concurrent, but consecutive pastes retain the user's order.
      await previousInsertion;
      const view = currentView();
      if (view) insertImages(view, readImages, insertion.target);
    }).catch((error: unknown) => {
      // Keep the completion handled when no save or mode switch is awaiting
      // it, but let an active waiter cancel rather than report success.
      insertion.error = error instanceof Error ? error : new Error(getMessages().imageReadFailed);
      if (currentView()) onLinkErrorRef.current?.(insertion.error.message);
    }).finally(() => { pendingImagesRef.current.delete(insertion); });
  }, []);

  const editor = useEditor(
    {
      extensions: [
        ...canvasNodesAndMarks(() => textRef.current, getDocumentPath),
        TaskListInput,
        Placeholder.configure({ placeholder: () => textRef.current.canvasPlaceholder }),
        MarkdownTyping,
        QuoteTyping,
        IndentedListInput,
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
        handleClick: (view, _position, event) => {
          if (event.button !== 0 || event.shiftKey || event.altKey) return false;
          const link = event.target instanceof Element ? event.target.closest<HTMLElement>('a[href], [data-image-link]') : null;
          const href = link?.getAttribute('href') ?? link?.getAttribute('data-image-link');
          if (!link || !view.dom.contains(link) || !href) return false;
          event.preventDefault();
          if (!documentLinkTarget(href)) {
            onLinkErrorRef.current?.(getMessages().documentLinkUnavailable);
            return true;
          }
          void activateDocumentLink(view.dom, href).then((activated) => {
            if (!activated) onLinkErrorRef.current?.(getMessages(language).documentLinkUnavailable);
          }).catch((error: unknown) => {
            onLinkErrorRef.current?.(error instanceof Error ? error.message : String(error));
          });
          return true;
        },
        handlePaste: (view, event) => {
          const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'));
          if (images.length) {
            readAndInsertImages(images);
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
          const images = Array.from(event.dataTransfer?.files ?? []).filter((file) => file.type.startsWith('image/'));
          if (!images.length) return false;
          const position = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          })?.pos;
          readAndInsertImages(images, position);
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
            if (event.isComposing || event.keyCode === 229) return false;
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
      onTransaction: ({ editor: currentEditor, transaction }) => {
        // Recreating the editor restores the same document with a complete
        // replacement transaction. Only map through edits to the active editor.
        if (!transaction.docChanged || appliedDocument.current?.editor !== currentEditor ||
          appliedDocument.current.id !== documentSnapshot.current.id) return;
        for (const insertion of pendingImagesRef.current) {
          if (insertion.documentId !== documentSnapshot.current.id) continue;
          insertion.target = insertion.target.kind === 'paste'
            ? { ...insertion.target, selection: insertion.target.selection.map(transaction.mapping) }
            : { kind: 'drop', position: transaction.mapping.map(insertion.target.position) };
        }
      },
      onUpdate: ({ editor: currentEditor }) => {
        documentSnapshot.current.live = currentEditor.state.doc;
        documentSnapshot.current.selection = currentEditor.state.selection.getBookmark();
        documentSnapshot.current.commentPositions = commentDecorationsPluginKey.getState(currentEditor.state)?.positions;
        documentSnapshot.current.commentSignature = commentDecorationSignature(commentsRef.current);
        pendingChangeRef.current = true;
        onEditRef.current?.();
        scheduleCommentMapping(currentEditor);
      },
      onSelectionUpdate: ({ editor: currentEditor }) => {
        documentSnapshot.current.selection = currentEditor.state.selection.getBookmark();
      },
    },
    [],
  );
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    // Locale changes update labels in place. Recreating the editor discards its
    // undo/redo history and can interrupt an active input composition.
    updateFootnoteLabels(editor.view, {
      referenceLabel: textRef.current.footnoteReferenceLabel,
      backlinkLabel: textRef.current.footnoteBacklinkLabel,
    });
    updateFormulaLabels(editor.view, language);
    updateUnsupportedMarkdownLabels(editor.view, textRef.current.unsupportedMarkdownTitle);
    editor.view.dispatch(editor.state.tr.setSelection(editor.state.selection).setMeta('skipTrailingNode', true));
  }, [editor, language]);

  useLayoutEffect(() => {
    if (!editor || (appliedDocument.current?.id === documentId && appliedDocument.current.editor === editor)) return;
    const snapshot = documentSnapshot.current;
    const preservedSelection = snapshot.selection;
    const replacingDocument = appliedDocument.current?.id !== undefined && appliedDocument.current.id !== documentId;
    if (commentSyncTimerRef.current !== undefined) {
      window.clearTimeout(commentSyncTimerRef.current);
      commentSyncTimerRef.current = undefined;
    }
    if (replacingDocument) pendingChangeRef.current = false;
    decorationSignatureRef.current = undefined;
    decorationDocumentIdRef.current = undefined;
    lastMappedCommentsRef.current = undefined;
    // useEditor already constructed its first document from the initial props.
    // Replacing it again rebuilds every node view and layout during file open.
    if (snapshot.live || appliedDocument.current || editor.options.content !== snapshot.initial) {
      replaceDocumentPreservingSelection(editor, snapshot.live?.toJSON() ?? snapshot.initial);
    }
    if (preservedSelection) {
      editor.view.dispatch(editor.state.tr.setSelection(preservedSelection.resolve(editor.state.doc)));
    }
    snapshot.live = editor.state.doc;
    snapshot.selection = editor.state.selection.getBookmark();
    // A language change recreates the editor. Keep positions already mapped by
    // pending typing rather than anchoring comments against the older snapshot.
    if (snapshot.commentPositions && snapshot.commentSignature === commentDecorationSignature(commentsRef.current)) {
      editor.view.dispatch(editor.state.tr.setMeta(commentDecorationsPluginKey, snapshot.commentPositions));
      decorationSignatureRef.current = snapshot.commentSignature;
      decorationDocumentIdRef.current = documentId;
    }
    appliedDocument.current = { id: documentId, editor };
    if (pendingChangeRef.current) scheduleCommentMapping(editor);
  }, [documentId, editor, scheduleCommentMapping]);

  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
      if (commentSyncTimerRef.current !== undefined) window.clearTimeout(commentSyncTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!editor) return;
    const signature = commentDecorationSignature(comments);
    if (lastMappedCommentsRef.current === comments) {
      lastMappedCommentsRef.current = undefined;
      decorationSignatureRef.current = signature;
      decorationDocumentIdRef.current = documentId;
      return;
    }
    if (decorationSignatureRef.current === signature && decorationDocumentIdRef.current === documentId) return;
    const positions = commentsRef.current.length > 0
      ? canvasPositionsForComments(editor, documentToMarkdown(editor.getJSON()), commentsRef.current)
      : [];
    const current = commentDecorationsPluginKey.getState(editor.state)?.positions ?? [];
    if (sameCanvasPositions(current, positions)) {
      decorationSignatureRef.current = signature;
      decorationDocumentIdRef.current = documentId;
      return;
    }
    editor.view.dispatch(editor.state.tr.setMeta(commentDecorationsPluginKey, positions));
    decorationSignatureRef.current = signature;
    decorationDocumentIdRef.current = documentId;
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
      focus: () => {
        if (editor && !focusedFormulaSelection(editor.view)) editor.view.focus();
      },
      getSelectedText: () => (editor ? getSelectedDocumentText(editor) : ''),
      getDocument: () => editor?.getJSON() ?? documentSnapshot.current.initial,
      getSelectionProgress: () => {
        if (!editor) return 0;
        const documentSize = Math.max(1, editor.state.doc.content.size);
        return editor.state.selection.head / documentSize;
      },
      getSelectionViewportOffset: () => {
        if (!editor) return undefined;
        const viewport = editor.view.dom.closest<HTMLElement>('.canvas-area');
        if (!viewport) return undefined;
        const coordinates = focusedFormulaSelection(editor.view) ?? editor.view.coordsAtPos(editor.state.selection.head);
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
          const formula = focusedFormulaSelection(editor.view);
          const position = formula?.position ?? editor.state.selection.head;
          const transaction = editor.state.tr;
          if (formula) {
            const node = editor.state.doc.nodeAt(position)!;
            const latex = String(node.attrs.latex ?? '');
            transaction.setNodeMarkup(position, undefined, {
              ...node.attrs,
              latex: latex.slice(0, formula.offset) + selectionMarker + latex.slice(formula.offset),
            });
          } else transaction.insertText(selectionMarker, position, position);
          const markedDocument = transaction.doc.toJSON();
          return markdownSelectionFromMarkedDocument(editor.getJSON(), markedDocument);
        } catch {
          return undefined;
        }
      },
      setDocumentSelection: (anchor) => {
        if (!editor) return false;
        const resolved = positionFromDocumentAnchor(editor.state.doc, anchor);
        if (!resolved) return false;
        if (anchor.kind === 'formula') return focusFormulaSource(editor.view, resolved.position, anchor.offset);
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
      flushCommentMapping,
      waitForPendingImages: () => {
        const originatingDocumentId = documentSnapshot.current.id;
        const pending = () => [...pendingImagesRef.current].filter((insertion) => insertion.documentId === originatingDocumentId);
        if (pending().length === 0) return undefined;
        return (async () => {
          while (documentSnapshot.current.id === originatingDocumentId) {
            const insertions = pending();
            if (insertions.length === 0) return;
            await Promise.all(insertions.map((insertion) => insertion.completion));
            if (!componentMountedRef.current || documentSnapshot.current.id !== originatingDocumentId) return;
            const failed = insertions.find((insertion) => insertion.error);
            if (failed?.error) throw failed.error;
          }
        })();
      },
      isFocused: () => editor ? editor.view.hasFocus() || Boolean(focusedFormulaSelection(editor.view)) : false,
      requestMeasure: () => undefined,
    }),
    [editor, flushCommentMapping],
  );

    return <EditorContent editor={editor} />;
  }),
  sameCanvasProps,
);
