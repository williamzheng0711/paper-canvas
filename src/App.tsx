import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { JSONContent } from '@tiptap/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CanvasEditor } from './components/CanvasEditor';
import { CommentsPanel } from './components/CommentsPanel';
import { MarkdownSourceEditor } from './components/MarkdownSourceEditor';
import {
  cloneComments,
  createMarkdownComment,
  parseMarkdownComments,
  relocateMarkdownComments,
  serializeMarkdownWithComments,
  type CommentPlacement,
  type MarkdownComment,
} from './editor/comments';
import { documentsEqual } from './editor/documentSync';
import { canvasDocumentSupported } from './editor/canvasCapacity';
import { htmlPreviewText } from './editor/HtmlPreview';
import { markdownToDocument } from './editor/markdown';
import { collectOutlineResult } from './editor/outline';
import { imagePathSourceChanges, mapImagePathComments, renameMarkdownImageAssets } from './editor/markdownAssetReferences';
import { captureViewport, restoreViewport, type ViewportSnapshot } from './editor/modeTransition';
import type { SearchDirection, SearchResult, SwitchableEditorHandle } from './editor/search';
import { markdownToDocumentWithSelection, type DocumentSelectionAnchor } from './editor/selectionMapping';
import { getMessages, setCurrentLanguage, type Language } from './i18n';
import { maximumFontSize, minimumFontSize, normalizeFontSize } from './lib/fontSize';
import { maximumLineSpacing, minimumLineSpacing, normalizeLineSpacing } from './lib/lineSpacing';
import { waitForRenderedImages } from './lib/renderedImages';
import {
  allowDocumentImageFiles,
  chooseMarkdownFile,
  clearDraft,
  confirmDiscardChanges,
  documentToPortableMarkdown,
  exportMarkdownFile,
  exportPdfFile,
  flushSettings,
  fileAssetSourcePath,
  FileRenameRecoveryError,
  hideRecentFile,
  hydrateDocumentAssets,
  loadDraft,
  loadPreferences,
  loadRecent,
  newEditorFile,
  openMarkdownFile,
  openRecent,
  rebaseEditorFileAssets,
  removeRecentFile,
  revealFileInFolder,
  renameEditorFile,
  renameDocumentAssetReferences,
  saveEditorFile,
  saveDraft,
  savePreferences,
  validateDocumentUnicode,
  type AppPreferences,
  type EditorFile,
  type RecentFile,
} from './lib/files';

type SaveStatus = 'saved' | 'saving' | 'draft' | 'error' | 'unsaved';
type RecentContextMenu = { item: RecentFile; x: number; y: number };
type CanvasContextMenu = { placement: CommentPlacement; x: number; y: number };
type EditorMode = 'canvas' | 'source';
type SemanticModeSelection =
  { kind: 'markdown'; offset: number } | { kind: 'document'; anchor: DocumentSelectionAnchor };
type PendingModeTransition = {
  target: EditorMode;
  viewport: ViewportSnapshot;
  selectionProgress: number;
  semanticSelection?: SemanticModeSelection;
  selectionViewportOffset?: number;
  restoreFocus: boolean;
};

const emptyComments: readonly MarkdownComment[] = [];

function waitForCanvasRender(): Promise<void> {
  return new Promise((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
  );
}

function ToolbarIcon({ name }: { name: 'sidebar' | 'search' | 'comments' | 'more' | 'theme' }) {
  const paths = {
    sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    comments: <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    theme: <><circle cx="12" cy="12" r="9" /><path d="M12 3v18a9 9 0 0 0 0-18Z" fill="currentColor" stroke="none" /></>,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function documentMetrics(document: JSONContent): {
  characters: number;
  words: number;
} {
  const characterParts: string[] = [];
  const wordParts: string[] = [];
  const walk = (node: JSONContent): void => {
    const html = node.type === 'htmlPreview' || node.type === 'inlineHtmlPreview';
    const inline = node.type === 'inlineHtmlPreview';
    const rawSource = node.type === 'unsupportedMarkdown';
    const content = html
      ? htmlPreviewText(String(node.attrs?.source ?? ''), inline ? 'inline' : 'block', { preserveEdges: inline })
      : rawSource ? String(node.attrs?.source ?? '')
      : node.text ?? '';
    characterParts.push(rawSource ? content.replace(/[\r\n]/g, '') : html ? content.replace(/\n/g, '') : content);
    wordParts.push(content);
    node.content?.forEach(walk);
    if (['paragraph', 'heading', 'codeBlock', 'hardBreak', 'htmlPreview'].includes(node.type ?? '')) wordParts.push('\n');
  };
  walk(document);
  let characters = 0;
  for (const character of characterParts.join('').trim()) {
    if (character) characters += 1;
  }
  const text = wordParts.join('').trim();
  let words = 0;
  let inWord = false;
  for (const character of text) {
    const code = character.charCodeAt(0);
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) {
      words += 1;
      inWord = false;
    } else if (/\s/.test(character)) inWord = false;
    else if (!inWord) {
      words += 1;
      inWord = true;
    }
  }
  return { characters, words };
}

function documentStateFromMarkdown(
  markdown: string,
  path?: string,
  parsedDocument?: JSONContent,
): {
  document: JSONContent;
  comments: MarkdownComment[];
  warning?: string;
} {
  const parsed = parseMarkdownComments(markdown);
  const document = hydrateDocumentAssets(parsedDocument ?? markdownToDocument(parsed.body), path);
  return {
    document,
    comments: parsed.comments.length > 0
      ? relocateMarkdownComments(parsed.comments, parsed.body, documentToPortableMarkdown(document))
      : [],
    ...(parsed.status === 'invalid' || parsed.status === 'unknown-version'
      ? { warning: getMessages().commentDataWarning }
      : {}),
  };
}

export default function App() {
  const [file, setFile] = useState<EditorFile>(newEditorFile);
  const canvasSupported = useMemo(() => canvasDocumentSupported(file.document, file.comments), [file.document, file.comments]);
  const [documentId, setDocumentId] = useState(0);
  const [editRevision, setEditRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [message, setMessage] = useState(() => getMessages().localOnly);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [sidebarTab, setSidebarTab] = useState<'outline' | 'recent'>('outline');
  const [recentContextMenu, setRecentContextMenu] = useState<RecentContextMenu | null>(null);
  const [canvasContextMenu, setCanvasContextMenu] = useState<CanvasContextMenu | null>(null);
  const [outlineTarget, setOutlineTarget] = useState<{
    index: number;
    request: number;
  }>();
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceEditorSession, setSourceEditorSession] = useState<number>();
  const [modeTransitioning, setModeTransitioning] = useState(false);
  const [renameRequest, setRenameRequest] = useState<{ name: string; session: number } | null>(null);
  const [rawMarkdownRevision, setRawMarkdownRevision] = useState(0);
  const rawMarkdownChangesRef = useRef<ReturnType<typeof imagePathSourceChanges>>(undefined);
  const sourceAssetOperationRef = useRef<'rebase' | 'rename'>('rebase');
  const sourceAssetTransitionRef = useRef<{ oldPath: string; newPath: string; operation: 'rename' }>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult>({
    current: 0,
    total: 0,
  });
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [newCommentTarget, setNewCommentTarget] = useState<CommentPlacement | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | undefined>();
  const [pdfExporting, setPdfExporting] = useState(false);
  const [preferences, setPreferences] = useState<AppPreferences>({
    theme: 'light',
    font: 'system',
    fontSize: 15,
    lineSpacing: 1.62,
    sidebarOpen: true,
    recentFilesExpanded: true,
    language: 'zh-Hant',
  });
  const text = getMessages(preferences.language);
  const [fontSizeInput, setFontSizeInput] = useState('15');
  const [lineSpacingInput, setLineSpacingInput] = useState('1.62');
  const pendingSave = useRef<Promise<boolean> | undefined>(undefined);
  const pendingSaveSession = useRef<number | undefined>(undefined);
  const fileOperationQueue = useRef<Promise<void>>(Promise.resolve());
  const preferencesLoaded = useRef(false);
  const skipInitialPreferenceSave = useRef(false);
  const preferencesRef = useRef(preferences);
  const fileRef = useRef(file);
  const dirtyRef = useRef(dirty);
  const editRevisionRef = useRef(editRevision);
  const documentSessionRef = useRef(0);
  const persistedDraft = useRef<{ session: number; revision: number } | undefined>(undefined);
  const sourceModeRef = useRef(sourceMode);
  const rawMarkdownRef = useRef('');
  const openedByOperatingSystem = useRef(false);
  const startupRef = useRef<{
    request: Promise<[PromiseSettledResult<RecentFile[]>, PromiseSettledResult<AppPreferences>, PromiseSettledResult<EditorFile | null>]>;
    session: number;
    revision: number;
    applied: boolean;
  } | undefined>(undefined);
  const recentExternalOpen = useRef(new Map<string, number>());
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const documentActionsMenu = useRef<HTMLDetailsElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const readingSettingsMenu = useRef<HTMLDetailsElement>(null);
  const sidebarTabs = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const canvasSearch = useRef<SwitchableEditorHandle>(null);
  const markdownSearch = useRef<SwitchableEditorHandle>(null);
  const canvasArea = useRef<HTMLElement>(null);
  const pendingModeTransition = useRef<PendingModeTransition | undefined>(undefined);
  const pendingSourceModeWait = useRef<{ session: number } | undefined>(undefined);
  const modeTransitionFrame = useRef<number | undefined>(undefined);
  const sourceCommentSyncTimerRef = useRef<number | undefined>(undefined);
  const revisionSyncTimerRef = useRef<number | undefined>(undefined);
  const outlineRequest = useRef(0);
  const openRequest = useRef(0);
  const pdfExportingRef = useRef(false);
  const commentHistory = useRef<{
    undo: MarkdownComment[][];
    redo: MarkdownComment[][];
  }>({ undo: [], redo: [] });
  fileRef.current = file;
  dirtyRef.current = dirty;
  sourceModeRef.current = sourceMode;
  preferencesRef.current = preferences;

  const closeToolbarMenus = useCallback(() => {
    setRenameRequest(null);
    if (documentActionsMenu.current) documentActionsMenu.current.open = false;
    if (readingSettingsMenu.current) readingSettingsMenu.current.open = false;
    if (exportMenu.current) exportMenu.current.open = false;
  }, []);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      for (const menu of [documentActionsMenu.current, readingSettingsMenu.current]) {
        if (menu?.open && !menu.contains(event.target)) {
          menu.open = false;
          if (menu === documentActionsMenu.current) setRenameRequest(null);
          if (menu === documentActionsMenu.current && exportMenu.current) exportMenu.current.open = false;
        }
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const openMenu = [documentActionsMenu.current, readingSettingsMenu.current].find((menu) => menu?.open);
      if (!openMenu) return;
      event.preventDefault();
      event.stopPropagation();
      closeToolbarMenus();
      openMenu.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeToolbarMenus]);

  useEffect(() => {
    if (!renameRequest) return;
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [renameRequest]);

  const setExternalRawMarkdown = useCallback((value: string, imagePaths?: {
    oldPath: string;
    newPath: string;
    operation?: 'rebase' | 'rename';
  }) => {
    rawMarkdownChangesRef.current = imagePaths
      ? imagePathSourceChanges(rawMarkdownRef.current, value, imagePaths.oldPath, imagePaths.newPath, imagePaths.operation)
      : undefined;
    rawMarkdownRef.current = value;
    setRawMarkdownRevision((revision) => revision + 1);
  }, []);

  const advanceRevision = useCallback(() => {
    const nextRevision = editRevisionRef.current + 1;
    editRevisionRef.current = nextRevision;
    if (revisionSyncTimerRef.current !== undefined) return;
    revisionSyncTimerRef.current = window.setTimeout(() => {
      revisionSyncTimerRef.current = undefined;
      setEditRevision(editRevisionRef.current);
    }, 100);
  }, []);

  const markEdited = useCallback(() => {
    advanceRevision();
    dirtyRef.current = true;
    setDirty(true);
    setSaveStatus('unsaved');
  }, [advanceRevision]);

  const flushCanvasChanges = useCallback(() => {
    // Formula composition can hold visible text before the canvas is dirty.
    // CanvasEditor publishes only pending input/document/comment changes.
    canvasSearch.current?.flushCommentMapping?.();
  }, []);

  const clearSourceCommentSync = useCallback(() => {
    if (sourceCommentSyncTimerRef.current !== undefined) {
      window.clearTimeout(sourceCommentSyncTimerRef.current);
      sourceCommentSyncTimerRef.current = undefined;
    }
  }, []);

  const syncSourceComments = useCallback(() => {
    clearSourceCommentSync();
    const markdown = rawMarkdownRef.current;
    const parsed = parseMarkdownComments(markdown);
    if (parsed.status !== 'valid' && parsed.status !== 'none') return;
    const nextComments =
      parsed.status === 'valid' ? documentStateFromMarkdown(markdown, fileAssetSourcePath(fileRef.current)).comments : [];
    if (JSON.stringify(fileRef.current.comments ?? []) === JSON.stringify(nextComments)) return;
    const nextFile = {
      ...fileRef.current,
      comments: nextComments,
      commentWarning: undefined,
    };
    fileRef.current = nextFile;
    setFile(nextFile);
  }, [clearSourceCommentSync]);

  const scheduleSourceCommentSync = useCallback(() => {
    clearSourceCommentSync();
    sourceCommentSyncTimerRef.current = window.setTimeout(syncSourceComments, 400);
  }, [clearSourceCommentSync, syncSourceComments]);

  const comments = file.comments ?? emptyComments;
  const setComments = useCallback(
    (nextComments: readonly MarkdownComment[], options: { recordHistory?: boolean; markEdited?: boolean } = {}) => {
      const currentRawComments = sourceModeRef.current ? parseMarkdownComments(rawMarkdownRef.current) : undefined;
      const sourceState = sourceModeRef.current
        ? documentStateFromMarkdown(rawMarkdownRef.current, fileAssetSourcePath(fileRef.current))
        : undefined;
      const currentComments = sourceState?.comments ?? fileRef.current.comments ?? [];
      const next = cloneComments(nextComments.map((comment) => {
        const relocated = sourceState?.comments.find((item) => item.id === comment.id);
        return relocated ? { ...relocated, content: comment.content } : comment;
      }));
      if (JSON.stringify(currentComments) === JSON.stringify(next)) return;
      if (options.recordHistory !== false) {
        commentHistory.current.undo.push(cloneComments(currentComments));
        commentHistory.current.redo = [];
      }
      const nextFile = {
        ...fileRef.current,
        ...(sourceState ? { document: sourceState.document } : {}),
        comments: next,
        sourceMarkdown: undefined,
      };
      if (sourceState && !documentsEqual(fileRef.current.document, sourceState.document)) setDocumentId((id) => id + 1);
      fileRef.current = nextFile;
      setFile(nextFile);
      if (sourceModeRef.current) {
        clearSourceCommentSync();
        const parsed = currentRawComments ?? parseMarkdownComments(rawMarkdownRef.current);
        const body = parsed.status === 'valid' ? parsed.body : rawMarkdownRef.current;
        const rawComments = relocateMarkdownComments(next, documentToPortableMarkdown(nextFile.document), body);
        const nextMarkdown = serializeMarkdownWithComments(body, rawComments);
        setExternalRawMarkdown(nextMarkdown);
      } else if (!canvasDocumentSupported(nextFile.document, next)) {
        const markdown = documentToPortableMarkdown(nextFile.document, next);
        setExternalRawMarkdown(markdown);
        sourceModeRef.current = true;
        setSourceEditorSession(documentSessionRef.current);
        setSourceMode(true);
        setMessage(getMessages().canvasViewLimited);
      }
      if (options.markEdited !== false) markEdited();
    },
    [clearSourceCommentSync, markEdited, setExternalRawMarkdown],
  );

  useEffect(
    () => () => {
      clearSourceCommentSync();
      if (revisionSyncTimerRef.current !== undefined) window.clearTimeout(revisionSyncTimerRef.current);
    },
    [clearSourceCommentSync],
  );

  const undoComment = useCallback(() => {
    const previous = commentHistory.current.undo.pop();
    if (!previous) return;
    commentHistory.current.redo.push(cloneComments(fileRef.current.comments ?? []));
    setComments(previous, { recordHistory: false });
  }, [setComments]);

  const redoComment = useCallback(() => {
    const next = commentHistory.current.redo.pop();
    if (!next) return;
    commentHistory.current.undo.push(cloneComments(fileRef.current.comments ?? []));
    setComments(next, { recordHistory: false });
  }, [setComments]);

  const resetCommentHistory = useCallback(() => {
    commentHistory.current = { undo: [], redo: [] };
  }, []);

  const createComment = useCallback(
    (content: string, placement: CommentPlacement) => {
      if (!content.trim()) return;
      if (!sourceModeRef.current) flushCanvasChanges();
      const body = documentToPortableMarkdown(fileRef.current.document);
      const comment = createMarkdownComment(body, placement.target, content, placement.excerpt);
      setComments([...(fileRef.current.comments ?? []), comment]);
      setNewCommentTarget(null);
      setActiveCommentId(comment.id);
      setCommentsPanelOpen(true);
    },
    [flushCanvasChanges, setComments],
  );

  const updateComment = useCallback(
    (id: string, content: string) => {
      if (!content.trim()) return;
      setComments(
        (fileRef.current.comments ?? []).map((comment) => (comment.id === id ? { ...comment, content } : comment)),
      );
    },
    [setComments],
  );

  const deleteComment = useCallback(
    (id: string) => {
      setComments((fileRef.current.comments ?? []).filter((comment) => comment.id !== id));
      if (activeCommentId === id) setActiveCommentId(undefined);
    },
    [activeCommentId, setComments],
  );

  const locateComment = useCallback((comment: MarkdownComment) => {
    setActiveCommentId(comment.id);
    let located = comment;
    if (sourceModeRef.current) {
      const parsed = parseMarkdownComments(rawMarkdownRef.current);
      located = relocateMarkdownComments(parsed.comments, parsed.body, parsed.body)
        .find((item) => item.id === comment.id) ?? relocateMarkdownComments(
          [comment], documentToPortableMarkdown(fileRef.current.document), parsed.body,
        )[0];
    }
    const range =
      located.target.kind === 'position'
        ? { from: located.target.offset, to: located.target.offset }
        : { from: located.target.from, to: located.target.to };
    const editor = sourceModeRef.current ? markdownSearch.current : canvasSearch.current;
    editor?.setMarkdownSelection?.(range);
  }, []);

  const handleCommentMarkerClick = useCallback((id: string) => {
    setActiveCommentId(id);
    setCommentsPanelOpen(true);
    requestAnimationFrame(() => {
      Array.from(document.querySelectorAll<HTMLElement>('[data-comment-card]'))
        .find((element) => element.dataset.commentCard === id)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  useEffect(() => {
    if (!startupRef.current) {
      startupRef.current = {
        request: Promise.allSettled([loadRecent(), loadPreferences(), loadDraft()]),
        session: documentSessionRef.current,
        revision: editRevisionRef.current,
        applied: false,
      };
    }
    const startup = startupRef.current;
    if (startup.applied) return;
    let active = true;
    void startup.request
      .then(([recentResult, preferencesResult, draftResult]) => {
        if (!active || startup.applied) return;
        startup.applied = true;
        const documentUntouched =
          documentSessionRef.current === startup.session && editRevisionRef.current === startup.revision;
        const loadedRecent = recentResult.status === 'fulfilled' ? recentResult.value : [];
        const loadedPreferences = preferencesResult.status === 'fulfilled' ? preferencesResult.value : { ...preferencesRef.current };
        const draft = draftResult.status === 'fulfilled' ? draftResult.value : null;
        const failed = [recentResult, preferencesResult, draftResult].find((result) => result.status === 'rejected');
        const startupError = failed?.status === 'rejected'
          ? failed.reason instanceof Error ? failed.reason.message : getMessages(loadedPreferences.language).loadSettingsFailed
          : undefined;
        setCurrentLanguage(loadedPreferences.language);
        document.documentElement.lang = loadedPreferences.language;
        const loadedText = getMessages(loadedPreferences.language);
        if (!openedByOperatingSystem.current) setRecent(loadedRecent);
        preferencesLoaded.current = true;
        // A failed settings read must not immediately overwrite the existing
        // settings with defaults. Later explicit changes can still be saved.
        skipInitialPreferenceSave.current = preferencesResult.status === 'rejected';
        setPreferences(loadedPreferences);
        setFontSizeInput(String(loadedPreferences.fontSize));
        setLineSpacingInput(String(loadedPreferences.lineSpacing));
        if (draft && documentUntouched && !openedByOperatingSystem.current) {
          const normalizedDraft = { ...draft, comments: draft.comments ?? [] };
          fileRef.current = normalizedDraft;
          setFile(normalizedDraft);
          setDocumentId((id) => id + 1);
          documentSessionRef.current += 1;
          const largeDocument = !canvasDocumentSupported(normalizedDraft.document, normalizedDraft.comments);
          if (sourceModeRef.current || largeDocument) {
            setSourceEditorSession(documentSessionRef.current);
            setExternalRawMarkdown(normalizedDraft.sourceMarkdown ?? documentToPortableMarkdown(normalizedDraft.document, normalizedDraft.comments));
            sourceModeRef.current = true;
            setSourceMode(true);
            setSourceOutline(collectOutlineResult(normalizedDraft.document));
          }
          advanceRevision();
          persistedDraft.current = { session: documentSessionRef.current, revision: editRevisionRef.current };
          setCommentsPanelOpen(normalizedDraft.comments.length > 0);
          dirtyRef.current = true;
          setDirty(true);
          setSaveStatus('draft');
          const recoveredMessage = largeDocument ? loadedText.canvasViewLimited : loadedText.restoredDraft;
          setMessage(normalizedDraft.commentWarning ?? (startupError ? `${recoveredMessage} ${startupError}` : recoveredMessage));
        } else if (documentUntouched && !openedByOperatingSystem.current) {
          setMessage(startupError ?? loadedText.localOnly);
        }
      })
      .catch((error: unknown) => {
        if (!active || startup.applied) return;
        startup.applied = true;
        setMessage(error instanceof Error ? error.message : getMessages().loadSettingsFailed);
      });
    return () => { active = false; };
  }, [advanceRevision, setExternalRawMarkdown]);

  useEffect(() => {
    if (!preferencesLoaded.current) return;
    if (skipInitialPreferenceSave.current) {
      skipInitialPreferenceSave.current = false;
      return;
    }
    let active = true;
    void savePreferences(preferences).catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : getMessages().loadSettingsFailed);
    });
    return () => { active = false; };
  }, [preferences]);

  useEffect(() => {
    setCurrentLanguage(preferences.language);
    document.documentElement.lang = preferences.language;
  }, [preferences.language]);

  useEffect(() => {
    if (!recentContextMenu) return;
    const close = () => setRecentContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [recentContextMenu]);

  useEffect(() => {
    if (!canvasContextMenu) return;
    const close = () => setCanvasContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [canvasContextMenu]);

  useEffect(() => {
    const title = `${dirty ? '● ' : ''}${file.name} — PaperCanvas`;
    document.title = title;
    if (isTauri()) {
      void getCurrentWebviewWindow().setTitle(title).catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : getMessages().loadSettingsFailed);
      });
    }
  }, [dirty, file.name]);

  const loadFile = useCallback(
    (nextFile: EditorFile) => {
      pendingModeTransition.current = undefined;
      if (modeTransitionFrame.current !== undefined) cancelAnimationFrame(modeTransitionFrame.current);
      modeTransitionFrame.current = undefined;
      setModeTransitioning(false);
      clearSourceCommentSync();
      const normalizedFile = { ...nextFile, comments: nextFile.comments ?? [] };
      const largeDocument = !canvasDocumentSupported(normalizedFile.document, normalizedFile.comments);
      if (largeDocument) normalizedFile.sourceMarkdown ??= documentToPortableMarkdown(normalizedFile.document, normalizedFile.comments);
      fileRef.current = normalizedFile;
      setFile(normalizedFile);
      const recentPanel = sidebarTabs.current?.parentElement?.querySelector('#recent-panel');
      if (recentPanel?.contains(document.activeElement)) {
        sidebarTabs.current?.querySelector<HTMLButtonElement>('[aria-controls="outline-panel"]')?.focus();
      }
      setSidebarTab('outline');
      closeToolbarMenus();
      setDocumentId((id) => id + 1);
      documentSessionRef.current += 1;
      const session = documentSessionRef.current;
      void clearDraft().catch((error: unknown) => {
        if (documentSessionRef.current === session) setMessage(error instanceof Error ? error.message : getMessages().loadSettingsFailed);
      });
      advanceRevision();
      resetCommentHistory();
      dirtyRef.current = false;
      setDirty(false);
      setSaveStatus('saved');
      sourceModeRef.current = largeDocument;
      setSourceEditorSession(largeDocument ? session : undefined);
      setSourceMode(largeDocument);
      if (largeDocument) {
        setExternalRawMarkdown(normalizedFile.sourceMarkdown!);
        setSourceOutline(collectOutlineResult(normalizedFile.document));
      }
      setOutlineTarget(undefined);
      setNewCommentTarget(null);
      setActiveCommentId(undefined);
      setCommentsPanelOpen(normalizedFile.comments.length > 0);
      setMessage(normalizedFile.commentWarning ?? (largeDocument ? getMessages().canvasViewLimited : getMessages().openedFile(normalizedFile.name)));
    },
    [advanceRevision, clearSourceCommentSync, closeToolbarMenus, resetCommentHistory, setExternalRawMarkdown],
  );

  const replaceWithOpenedFile = useCallback(
    async (nextFile: EditorFile) => {
      const request = openRequest.current;
      const session = documentSessionRef.current;
      if (!sourceModeRef.current) flushCanvasChanges();
      if (
        dirtyRef.current &&
        !(await confirmDiscardChanges(getMessages().confirmDiscardAndOpen))
      ) {
        return false;
      }
      if (request !== openRequest.current || session !== documentSessionRef.current) return false;
      loadFile(nextFile);
      setRecent(await loadRecent());
      return true;
    },
    [flushCanvasChanges, loadFile],
  );

  const openExternalMarkdownFiles = useCallback(
    async (paths: string[]) => {
      const path = paths.find(Boolean);
      if (!path) return;
      const now = Date.now();
      if (now - (recentExternalOpen.current.get(path) ?? 0) < 2_000) return;
      recentExternalOpen.current.set(path, now);
      const request = ++openRequest.current;
      // A file open from Finder/Explorer takes precedence over a recovered
      // unnamed draft if both asynchronous startup paths complete together.
      openedByOperatingSystem.current = true;

      try {
        const nextFile = await openMarkdownFile(path);
        if (request !== openRequest.current) return;
        const replaced = await replaceWithOpenedFile(nextFile);
        if (replaced) setRecent(await loadRecent());
      } catch (error) {
        if (request === openRequest.current) {
          setMessage(error instanceof Error ? error.message : getMessages().externalOpenFailed);
        }
      }
    },
    [replaceWithOpenedFile],
  );

  const queueFileOperation = useCallback((operation: () => Promise<void>) => {
    const result = fileOperationQueue.current.then(operation);
    fileOperationQueue.current = result.catch(() => undefined);
    return result;
  }, []);

  const saveCurrent = useCallback((forceSaveAs = false): Promise<boolean> => {
    const saveSession = documentSessionRef.current;
    if (!forceSaveAs && pendingSave.current && pendingSaveSession.current === saveSession) return pendingSave.current;
    if (sourceModeRef.current) clearSourceCommentSync();
    setSaveStatus('saving');
    let succeeded = false;
    const operation = queueFileOperation(async () => {
      try {
        let shouldSaveAs = forceSaveAs;
        while (documentSessionRef.current === saveSession) {
          if (!sourceModeRef.current) {
            const pendingImages = canvasSearch.current?.waitForPendingImages?.();
            if (pendingImages) await pendingImages;
          }
          if (documentSessionRef.current !== saveSession) return;
          if (!sourceModeRef.current) flushCanvasChanges();
          const revision = editRevisionRef.current;
          const editingSource = sourceModeRef.current;
          const sourceState = editingSource
            ? documentStateFromMarkdown(rawMarkdownRef.current, fileAssetSourcePath(fileRef.current))
            : undefined;
          const candidate = editingSource
            ? {
                ...fileRef.current,
                document: sourceState!.document,
                comments: sourceState!.comments,
                sourceMarkdown: rawMarkdownRef.current,
              }
            : fileRef.current;
          const assetSourcePath = fileAssetSourcePath(candidate);
          const saved = editingSource
            ? await saveEditorFile(candidate, shouldSaveAs, rawMarkdownRef.current)
            : await saveEditorFile(candidate, shouldSaveAs);
          shouldSaveAs = false;

          if (documentSessionRef.current !== saveSession) return;
          if (!sourceModeRef.current) flushCanvasChanges();
          if (editRevisionRef.current !== revision) {
            // Keep edits made during the write. Save As must also resolve their
            // image paths from the original directory before adopting its path.
            const liveFile = fileRef.current;
            let latest: EditorFile = {
              ...fileRef.current,
              path: saved.path,
              name: saved.name,
            };
            if (assetSourcePath && saved.path && assetSourcePath !== saved.path) {
              const current = sourceModeRef.current
                ? { ...liveFile, ...documentStateFromMarkdown(rawMarkdownRef.current, assetSourcePath), sourceMarkdown: rawMarkdownRef.current }
                : liveFile;
              latest = rebaseEditorFileAssets(current, assetSourcePath, saved.path);
              if (sourceModeRef.current && latest.sourceMarkdown !== undefined && latest.sourceMarkdown !== rawMarkdownRef.current) {
                setExternalRawMarkdown(latest.sourceMarkdown, { oldPath: assetSourcePath, newPath: saved.path });
              }
              if (!documentsEqual(liveFile.document, latest.document)) setDocumentId((id) => id + 1);
            }
            latest.diskSourceMarkdown = saved.diskSourceMarkdown;
            sourceAssetOperationRef.current = 'rebase';
            sourceAssetTransitionRef.current = undefined;
            fileRef.current = latest;
            setFile(latest);
            setSaveStatus('saving');
            continue;
          }

          // In Markdown mode the visible source can be newer than the hidden
          // canvas. Compare against the document currently held by the canvas,
          // not only against the parsed save candidate, so it is refreshed before
          // the next mode switch.
          const canvasDocumentChanged = !documentsEqual(fileRef.current.document, saved.document);
          sourceAssetOperationRef.current = 'rebase';
          sourceAssetTransitionRef.current = undefined;
          fileRef.current = saved;
          setFile(saved);
          if (canvasDocumentChanged) {
            setDocumentId((id) => id + 1);
          }
          // Save As rebases relative image paths. Publish that exact saved source
          // through the editor's external update without creating a user edit.
          if (assetSourcePath !== saved.path && sourceModeRef.current && saved.sourceMarkdown !== undefined && saved.sourceMarkdown !== rawMarkdownRef.current) {
            setExternalRawMarkdown(saved.sourceMarkdown, assetSourcePath && saved.path
              ? { oldPath: assetSourcePath, newPath: saved.path }
              : undefined);
          }
          dirtyRef.current = false;
          setDirty(false);
          setSaveStatus('saved');
          setMessage(getMessages().savedFile(saved.name));
          try {
            await clearDraft();
            const recentFiles = await loadRecent();
            if (documentSessionRef.current !== saveSession) return;
            setRecent(recentFiles);
          } catch (error) {
            // The document write has committed. Settings failure must not
            // misreport that write or skip newer typing waiting to be saved.
            if (documentSessionRef.current === saveSession) setMessage(error instanceof Error ? error.message : getMessages().loadSettingsFailed);
          }
          if (documentSessionRef.current !== saveSession) return;
          // Edits can arrive while updating recovery/recent-file metadata too.
          // A coalesced autosave must still write that newer revision.
          if (editRevisionRef.current !== revision) {
            setSaveStatus('saving');
            continue;
          }
          succeeded = true;
          return;
        }
      } catch (error) {
        if (documentSessionRef.current === saveSession) {
          const cancelled = error instanceof DOMException && error.name === 'AbortError';
          let failure = error instanceof Error ? error.message : getMessages().saveFailed;
          if (!cancelled && dirtyRef.current) {
            try {
              // A failed document write still needs independent recovery. Keep
              // taking snapshots if typing continues during the recovery write.
              while (documentSessionRef.current === saveSession) {
                if (!sourceModeRef.current) {
                  await canvasSearch.current?.waitForPendingImages?.();
                  if (documentSessionRef.current !== saveSession) return;
                  flushCanvasChanges();
                }
                const revision = editRevisionRef.current;
                const draft = sourceModeRef.current
                  ? { ...fileRef.current, sourceMarkdown: rawMarkdownRef.current }
                  : fileRef.current;
                await saveDraft(draft);
                if (documentSessionRef.current !== saveSession) return;
                if (editRevisionRef.current !== revision) continue;
                persistedDraft.current = { session: saveSession, revision };
                break;
              }
            } catch (recoveryError) {
              failure += `\n${recoveryError instanceof Error ? recoveryError.message : getMessages().autosaveFailed}`;
            }
          }
          if (documentSessionRef.current !== saveSession) return;
          setSaveStatus(cancelled ? (dirtyRef.current ? 'unsaved' : 'saved') : 'error');
          setMessage(cancelled ? getMessages().saveCancelled : failure);
        }
      }
    });
    const outcome = operation.then(() => succeeded);
    pendingSave.current = outcome;
    pendingSaveSession.current = saveSession;
    void outcome.finally(() => {
      if (pendingSave.current === outcome) {
        pendingSave.current = undefined;
        pendingSaveSession.current = undefined;
      }
    });
    return outcome;
  }, [clearSourceCommentSync, flushCanvasChanges, queueFileOperation, setExternalRawMarkdown]);

  useEffect(() => {
    const preventUnsavedUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !pendingSave.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    if (!isTauri()) {
      window.addEventListener('beforeunload', preventUnsavedUnload);
      return () => window.removeEventListener('beforeunload', preventUnsavedUnload);
    }

    let active = true;
    let closing = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const nativeWindow = getCurrentWebviewWindow();
      unlisten = await nativeWindow.onCloseRequested(async (event) => {
        event.preventDefault();
        if (closing || !active) return;
        closing = true;
        const session = documentSessionRef.current;
        try {
          // Finish the current document and recovery/settings writes before
          // destroying the window, including typing inside the autosave delay.
          while (active && documentSessionRef.current === session) {
            const pendingImages = canvasSearch.current?.waitForPendingImages?.();
            if (pendingImages) await pendingImages;
            if (!active || documentSessionRef.current !== session) return;
            if (!sourceModeRef.current) flushCanvasChanges();
            const revision = editRevisionRef.current;
            if (fileRef.current.path || (pendingSave.current && pendingSaveSession.current === session)) {
              if ((dirtyRef.current || pendingSave.current) && !(await saveCurrent())) return;
            } else if (dirtyRef.current && (persistedDraft.current?.session !== session || persistedDraft.current.revision !== revision)) {
              clearSourceCommentSync();
              const draft = sourceModeRef.current
                ? { ...fileRef.current, ...documentStateFromMarkdown(rawMarkdownRef.current, fileAssetSourcePath(fileRef.current)), sourceMarkdown: rawMarkdownRef.current }
                : fileRef.current;
              await saveDraft(draft);
              if (documentSessionRef.current === session && editRevisionRef.current === revision) {
                persistedDraft.current = { session, revision };
              }
            }
            await flushSettings();
            if (!active || documentSessionRef.current !== session) return;
            if (editRevisionRef.current !== revision) continue;
            await nativeWindow.destroy();
            return;
          }
        } catch (error) {
          if (active && documentSessionRef.current === session) {
            setSaveStatus('error');
            setMessage(error instanceof Error ? error.message : getMessages().saveFailed);
          }
        } finally {
          closing = false;
        }
      });
      if (!active) unlisten();
    })().catch((error: unknown) => {
      if (active) setMessage(error instanceof Error ? error.message : getMessages().saveFailed);
    });
    return () => { active = false; unlisten?.(); };
  }, [clearSourceCommentSync, flushCanvasChanges, saveCurrent]);

  useEffect(() => {
    if (!dirty) return;
    const session = documentSessionRef.current;
    const timer = window.setTimeout(() => {
      if (fileRef.current.path) {
        void saveCurrent();
        return;
      }
      if (sourceModeRef.current) clearSourceCommentSync();
      else flushCanvasChanges();
      const revision = editRevisionRef.current;
      // A recovered draft is already durable. Keep its original record until
      // an actual edit, including any damaged metadata retained for recovery.
      if (persistedDraft.current?.session === session && persistedDraft.current.revision === revision) return;
      const draft = sourceModeRef.current
        ? {
            ...fileRef.current,
            ...documentStateFromMarkdown(rawMarkdownRef.current, fileAssetSourcePath(fileRef.current)),
            sourceMarkdown: rawMarkdownRef.current,
          }
        : fileRef.current;
      void saveDraft(draft)
        .then(() => {
          if (documentSessionRef.current === session && editRevisionRef.current === revision) {
            persistedDraft.current = { session, revision };
            setSaveStatus('draft');
          }
        })
        .catch((error: unknown) => {
          if (documentSessionRef.current === session && editRevisionRef.current === revision) {
            setSaveStatus('error');
            setMessage(error instanceof Error ? error.message : getMessages().autosaveFailed);
          }
        });
    }, 850);
    return () => window.clearTimeout(timer);
  }, [clearSourceCommentSync, dirty, editRevision, flushCanvasChanges, saveCurrent]);

  const openFile = useCallback(async () => {
    const request = ++openRequest.current;
    try {
      const nextFile = await chooseMarkdownFile();
      if (request !== openRequest.current) return;
      if (nextFile) await replaceWithOpenedFile(nextFile);
    } catch (error) {
      if (request === openRequest.current) {
        setMessage(error instanceof Error ? error.message : getMessages().openFailed);
      }
    }
  }, [replaceWithOpenedFile]);

  const openRecentFile = useCallback(
    async (item: RecentFile) => {
      setRecentContextMenu(null);
      const request = ++openRequest.current;
      try {
        const nextFile = await openRecent(item);
        if (request !== openRequest.current) return;
        if (!nextFile) {
          const missingMessage = getMessages().missingRecentFile(item.name);
          setRecent((current) => current.filter((recentItem) => recentItem.path !== item.path));
          window.alert(missingMessage);
          try {
            const recentFiles = await removeRecentFile(item.path);
            if (request !== openRequest.current) return;
            setRecent(recentFiles);
            setMessage(missingMessage);
          } catch {
            if (request === openRequest.current) {
              setMessage(`${missingMessage} ${getMessages().removeMissingRecentFailed}`);
            }
          }
          return;
        }
        await replaceWithOpenedFile(nextFile);
      } catch (error) {
        if (request === openRequest.current) {
          setMessage(error instanceof Error ? error.message : getMessages().recentOpenFailed);
        }
      }
    },
    [replaceWithOpenedFile],
  );

  const revealRecentFile = useCallback(async (item: RecentFile) => {
    setRecentContextMenu(null);
    try {
      await revealFileInFolder(item.path);
      setMessage(getMessages().revealedFile(item.name));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : getMessages().revealFailed);
    }
  }, []);

  const hideRecent = useCallback(async (item: RecentFile) => {
    setRecentContextMenu(null);
    try {
      setRecent(await hideRecentFile(item.path));
      setMessage(getMessages().hiddenRecentFile(item.name));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : getMessages().hideRecentFailed);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        unlisten = await listen<string[]>('opened', (event) => {
          void openExternalMarkdownFiles(event.payload);
        });
        if (!active) {
          unlisten();
          return;
        }
        const paths = await invoke<string[]>('take_opened_files');
        if (active) await openExternalMarkdownFiles(paths);
      } catch (error) {
        if (active) {
          setMessage(error instanceof Error ? error.message : getMessages().systemOpenFailed);
        }
      }
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [openExternalMarkdownFiles]);

  const newFile = useCallback(async () => {
    const request = ++openRequest.current;
    const session = documentSessionRef.current;
    try {
      if (!sourceModeRef.current) flushCanvasChanges();
      if (dirtyRef.current && !(await confirmDiscardChanges(getMessages().confirmDiscardAndNew))) return;
      if (request !== openRequest.current || session !== documentSessionRef.current) return;
      loadFile(newEditorFile());
    } catch (error) {
      if (request === openRequest.current && session === documentSessionRef.current) setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [flushCanvasChanges, loadFile]);

  const renameFile = useCallback(async (nextName: string, session: number) => {
    if (!nextName.trim() || documentSessionRef.current !== session) return;
    const precedingSave = pendingSaveSession.current === session ? pendingSave.current : undefined;
    await queueFileOperation(async () => {
      if (documentSessionRef.current !== session) return;
      // The write must finish before the old path is moved. A failed write leaves
      // the save error visible and cancels this rename rather than moving partial
      // source; subsequent saves are queued behind a successful rename.
      if (precedingSave && !(await precedingSave)) return;
      try {
        if (sourceModeRef.current) clearSourceCommentSync();
        else flushCanvasChanges();
        const currentFile = fileRef.current;
        const candidate = sourceModeRef.current
          ? { ...currentFile, ...documentStateFromMarkdown(rawMarkdownRef.current, fileAssetSourcePath(currentFile)), sourceMarkdown: rawMarkdownRef.current }
          : currentFile;
        const renamed = await renameEditorFile(candidate, nextName);
        if (documentSessionRef.current !== session) return;
        // Typing can still be waiting for CanvasEditor's debounce while the
        // filesystem rename is in flight. Publish it before refreshing node views.
        if (!sourceModeRef.current) flushCanvasChanges();
        const liveFile = fileRef.current;
        const rewriteAssets = (markdown: string) => currentFile.path && renamed.path
          ? renameMarkdownImageAssets(markdown, currentFile.path, renamed.path)
          : markdown;
        const sourceMarkdown = sourceModeRef.current
          ? rewriteAssets(rawMarkdownRef.current)
          : liveFile.sourceMarkdown === undefined ? undefined : rewriteAssets(liveFile.sourceMarkdown);
        const sourceState = sourceModeRef.current
          ? documentStateFromMarkdown(sourceMarkdown!, renamed.path)
          : undefined;
        const document = sourceState?.document ?? (currentFile.path && renamed.path
          ? hydrateDocumentAssets(renameDocumentAssetReferences(liveFile.document, currentFile.path, renamed.path), renamed.path)
          : liveFile.document);
        const documentChanged = !documentsEqual(liveFile.document, document);
        const comments = sourceState?.comments ?? (documentChanged && (liveFile.comments?.length ?? 0) > 0 && currentFile.path && renamed.path
          ? mapImagePathComments(liveFile.comments!, documentToPortableMarkdown(liveFile.document), documentToPortableMarkdown(document), currentFile.path, renamed.path, 'rename')
          : liveFile.comments);
        const nextFile = {
          ...liveFile,
          path: renamed.path,
          name: renamed.name,
          diskSourceMarkdown: renamed.diskSourceMarkdown,
          document,
          comments,
          sourceMarkdown,
          ...(sourceState ? { commentWarning: sourceState.warning } : {}),
        };
        if (sourceModeRef.current && sourceMarkdown !== rawMarkdownRef.current) {
          setExternalRawMarkdown(sourceMarkdown!, currentFile.path && renamed.path
            ? { oldPath: currentFile.path, newPath: renamed.path, operation: 'rename' }
            : undefined);
        }
        sourceAssetOperationRef.current = 'rename';
        sourceAssetTransitionRef.current = undefined;
        fileRef.current = nextFile;
        setFile(nextFile);
        if (documentChanged) setDocumentId((id) => id + 1);
        // An unnamed document's filename lives only in its recovery draft.
        // Reschedule that draft even when its content was already autosaved.
        if (!currentFile.path && nextFile.name !== currentFile.name) markEdited();
        setMessage(getMessages().renamedFile(renamed.name));
        setRecent(await loadRecent());
      } catch (error) {
        if (documentSessionRef.current !== session) return;
        if (error instanceof FileRenameRecoveryError) {
          if (sourceModeRef.current) clearSourceCommentSync();
          else flushCanvasChanges();
          const liveFile = fileRef.current;
          const latest = sourceModeRef.current
            ? { ...liveFile, ...documentStateFromMarkdown(rawMarkdownRef.current, fileAssetSourcePath(liveFile)), sourceMarkdown: rawMarkdownRef.current }
            : liveFile;
          const recovered = error.recover(latest);
          sourceAssetOperationRef.current = error.assetsRenamed ? 'rename' : 'rebase';
          sourceAssetTransitionRef.current = error.assetsRenamed
            ? { oldPath: error.originalPath, newPath: error.targetPath, operation: 'rename' }
            : undefined;
          if (sourceModeRef.current && recovered.sourceMarkdown !== rawMarkdownRef.current) {
            setExternalRawMarkdown(recovered.sourceMarkdown!, error.assetsRenamed
              ? { oldPath: error.originalPath, newPath: error.targetPath, operation: 'rename' }
              : undefined);
          }
          fileRef.current = recovered;
          setFile(recovered);
          if (!documentsEqual(liveFile.document, recovered.document)) setDocumentId((id) => id + 1);
          // The source write failed while companion assets remained at their
          // new name. Save the repaired references at the surviving file path.
          if (error.assetsRenamed) markEdited();
          await loadRecent().then(setRecent, () => undefined);
        }
        if (documentSessionRef.current === session) setMessage(error instanceof Error ? error.message : getMessages().renameFailed);
      }
    });
  }, [clearSourceCommentSync, flushCanvasChanges, markEdited, queueFileOperation, setExternalRawMarkdown]);

  const activeSearchEditor = useCallback(
    () => (sourceModeRef.current ? markdownSearch.current : canvasSearch.current),
    [],
  );

  const runSearch = useCallback(
    (query: string, direction: SearchDirection) => {
      const result = activeSearchEditor()?.search(query, direction) ?? {
        current: 0,
        total: 0,
      };
      setSearchResult(result);
    },
    [activeSearchEditor],
  );

  const openSearch = useCallback(() => {
    if (searchOpen) {
      searchInput.current?.focus();
      searchInput.current?.select();
      return;
    }
    const selectedText = activeSearchEditor()?.getSelectedText() ?? '';
    const selectedQuery =
      selectedText.trim() && selectedText.length <= 200 && !/[\r\n]/.test(selectedText) ? selectedText : '';
    if (selectedQuery) setSearchQuery(selectedQuery);
    setSearchOpen(true);
  }, [activeSearchEditor, searchOpen]);

  const closeSearch = useCallback(() => {
    const editor = activeSearchEditor();
    editor?.clearSearch();
    setSearchOpen(false);
    setSearchResult({ current: 0, total: 0 });
    editor?.focus();
  }, [activeSearchEditor]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInput.current?.focus();
    searchInput.current?.select();
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    // Background updates refresh highlights/counts without stealing the caret.
    runSearch(searchQuery, 'refresh');
  }, [documentId, editRevision, preferences.language, runSearch, searchOpen, searchQuery, sourceMode]);

  useEffect(() => {
    if (!searchOpen) return;
    runSearch(searchQuery, 'reset');
  }, [runSearch, searchOpen, searchQuery]);

  const restoreModeTransition = useCallback((target: EditorMode) => {
    const pending = pendingModeTransition.current;
    const viewport = canvasArea.current;
    const editor = target === 'source' ? markdownSearch.current : canvasSearch.current;
    if (!pending || pending.target !== target || !viewport || !editor) return false;

    if (modeTransitionFrame.current !== undefined) cancelAnimationFrame(modeTransitionFrame.current);
    const semanticRestored =
      pending.semanticSelection?.kind === 'markdown'
        ? (editor.setMarkdownOffset?.(pending.semanticSelection.offset) ?? false)
        : pending.semanticSelection?.kind === 'document'
          ? (editor.setDocumentSelection?.(pending.semanticSelection.anchor) ?? false)
          : false;
    if (!semanticRestored) editor.setSelectionProgress(pending.selectionProgress);
    editor.requestMeasure();
    if (pending.restoreFocus) editor.focus();
    restoreViewport(viewport, pending.viewport);

    let remainingPasses = 2;
    const settle = () => {
      if (pendingModeTransition.current !== pending) return;
      editor.requestMeasure();
      const selectionOffset = editor.getSelectionViewportOffset();
      if (pending.selectionViewportOffset !== undefined && selectionOffset !== undefined) {
        const maximumScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        viewport.scrollTop = Math.min(
          maximumScroll,
          Math.max(0, viewport.scrollTop + selectionOffset - pending.selectionViewportOffset),
        );
      } else {
        restoreViewport(viewport, pending.viewport);
      }
      remainingPasses -= 1;
      if (remainingPasses > 0) {
        modeTransitionFrame.current = requestAnimationFrame(settle);
        return;
      }
      pendingModeTransition.current = undefined;
      modeTransitionFrame.current = undefined;
      setModeTransitioning(false);
    };
    modeTransitionFrame.current = requestAnimationFrame(settle);
    return true;
  }, []);

  const canvasReady = useCallback(() => restoreModeTransition('canvas'), [restoreModeTransition]);
  const sourceReady = useCallback(() => restoreModeTransition('source'), [restoreModeTransition]);

  useLayoutEffect(() => {
    restoreModeTransition(sourceMode ? 'source' : 'canvas');
  }, [documentId, restoreModeTransition, sourceMode]);

  useEffect(
    () => () => {
      if (modeTransitionFrame.current !== undefined) cancelAnimationFrame(modeTransitionFrame.current);
    },
    [],
  );

  const beginModeTransition = (target: EditorMode, semanticSelection?: SemanticModeSelection) => {
    const viewport = canvasArea.current;
    const editor = sourceModeRef.current ? markdownSearch.current : canvasSearch.current;
    if (!viewport) return;
    const snapshot = captureViewport(viewport);
    const editorFocused = editor?.isFocused() ?? false;
    const selectionViewportOffset = editorFocused ? editor?.getSelectionViewportOffset() : undefined;
    const selectionVisible =
      selectionViewportOffset !== undefined &&
      selectionViewportOffset >= 0 &&
      selectionViewportOffset <= viewport.clientHeight;
    pendingModeTransition.current = {
      target,
      viewport: snapshot,
      selectionProgress: selectionVisible ? (editor?.getSelectionProgress() ?? snapshot.progress) : snapshot.progress,
      semanticSelection: selectionVisible ? semanticSelection : undefined,
      selectionViewportOffset: selectionVisible ? selectionViewportOffset : undefined,
      restoreFocus: editorFocused,
    };
    setModeTransitioning(true);
  };

  const visibleEditorSelection = () => {
    const editor = sourceModeRef.current ? markdownSearch.current : canvasSearch.current;
    if (!editor?.isFocused()) return false;
    const offset = editor.getSelectionViewportOffset();
    return offset !== undefined && offset >= 0 && offset <= (canvasArea.current?.clientHeight ?? 0);
  };

  const toggleSourceMode = async () => {
    if (!sourceModeRef.current) {
      const session = documentSessionRef.current;
      if (pendingSourceModeWait.current?.session === session) return;
      const pendingImages = canvasSearch.current?.waitForPendingImages?.();
      if (pendingImages) {
        const waiting = { session };
        pendingSourceModeWait.current = waiting;
        try {
          // A pending image must reach the canvas before we serialize source.
          // Otherwise it would arrive in the hidden canvas and disappear when
          // the unchanged Markdown is parsed on the next reading-mode switch.
          await pendingImages;
        } catch (error) {
          if (documentSessionRef.current === session) {
            setMessage(error instanceof Error ? error.message : getMessages().imageReadFailed);
          }
          return;
        } finally {
          if (pendingSourceModeWait.current === waiting) pendingSourceModeWait.current = undefined;
        }
        if (documentSessionRef.current !== session || sourceModeRef.current) return;
      }
      flushCanvasChanges();
      const mappedSelection = visibleEditorSelection() ? canvasSearch.current?.getMarkdownSelection?.() : undefined;
      const currentFile = fileRef.current;
      const markdown = currentFile.sourceMarkdown ?? serializeMarkdownWithComments(
        mappedSelection?.markdown ?? documentToPortableMarkdown(currentFile.document),
        currentFile.comments ?? [],
      );
      const selectionMatchesSource = mappedSelection &&
        parseMarkdownComments(markdown).body === mappedSelection.markdown;
      beginModeTransition('source', selectionMatchesSource ? { kind: 'markdown', offset: mappedSelection.offset } : undefined);
      const nextFile = { ...currentFile, sourceMarkdown: markdown };
      fileRef.current = nextFile;
      setFile(nextFile);
      setExternalRawMarkdown(markdown);
      setSourceOutline(collectOutlineResult(currentFile.document));
      sourceModeRef.current = true;
      setSourceEditorSession(documentSessionRef.current);
      setSourceMode(true);
      return;
    }
    try {
      clearSourceCommentSync();
      const session = documentSessionRef.current;
      let currentFile: EditorFile;
      let markdown: string;
      let assetPath: string | undefined;
      let unselectedState: ReturnType<typeof documentStateFromMarkdown>;
      do {
        currentFile = fileRef.current;
        markdown = rawMarkdownRef.current;
        assetPath = fileAssetSourcePath(currentFile);
        unselectedState = currentFile.sourceMarkdown === markdown
          ? { document: currentFile.document, comments: currentFile.comments ?? [], warning: currentFile.commentWarning }
          : documentStateFromMarkdown(markdown, assetPath);
        if (!canvasDocumentSupported(unselectedState.document, unselectedState.comments)) {
          setMessage(getMessages().canvasViewLimited);
          return;
        }
        // Newly typed image references need their exact local files allowed
        // before the preview requests them, including after a failed save.
        await allowDocumentImageFiles({ ...currentFile, document: unselectedState.document });
        if (documentSessionRef.current !== session || !sourceModeRef.current) return;
      } while (fileRef.current !== currentFile || markdown !== rawMarkdownRef.current || assetPath !== fileAssetSourcePath(fileRef.current));
      const parsedSelection = visibleEditorSelection()
        ? markdownToDocumentWithSelection(rawMarkdownRef.current, markdownSearch.current?.getMarkdownOffset?.())
        : undefined;
      const sourceState = parsedSelection?.document
        ? documentStateFromMarkdown(rawMarkdownRef.current, fileAssetSourcePath(currentFile), parsedSelection.document)
        : unselectedState;
      const nextDocument = sourceState.document;
      const nextComments = sourceState.comments;
      beginModeTransition(
        'canvas',
        parsedSelection?.anchor ? { kind: 'document', anchor: parsedSelection.anchor } : undefined,
      );
      const commentsChanged = JSON.stringify(currentFile.comments ?? []) !== JSON.stringify(nextComments);
      const documentChanged = !documentsEqual(currentFile.document, nextDocument);
      if (documentChanged || commentsChanged || currentFile.sourceMarkdown !== rawMarkdownRef.current) {
        const nextFile = {
          ...currentFile,
          document: nextDocument,
          comments: nextComments,
          sourceMarkdown: rawMarkdownRef.current,
          ...(sourceState.warning ? { commentWarning: sourceState.warning } : { commentWarning: undefined }),
        };
        fileRef.current = nextFile;
        setFile(nextFile);
        if (documentChanged) setDocumentId((id) => id + 1);
      }
      resetCommentHistory();
      sourceModeRef.current = false;
      setSourceMode(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : getMessages().markdownParseFailed);
    }
  };

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape' && searchOpen) {
        event.preventDefault();
        closeSearch();
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        openSearch();
        return;
      }
      if (key === 's' && event.shiftKey) {
        event.preventDefault();
        void saveCurrent(true);
        return;
      }
      if (key === 's') {
        event.preventDefault();
        void saveCurrent();
      }
      if (key === 'o') {
        event.preventDefault();
        void openFile();
      }
      if (key === 'n') {
        event.preventDefault();
        newFile();
      }
    };
    window.addEventListener('keydown', shortcuts);
    return () => window.removeEventListener('keydown', shortcuts);
  }, [closeSearch, newFile, openFile, openSearch, saveCurrent, searchOpen]);

  const canvasOutline = useMemo(() => collectOutlineResult(file.document), [file.document]);
  const [sourceOutline, setSourceOutline] = useState(canvasOutline);
  const outlineResult = sourceMode ? sourceOutline : canvasOutline;
  const outline = outlineResult.headings;
  const [metrics, setMetrics] = useState(() => documentMetrics(file.document));

  const metricsTimerRef = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    if (metricsTimerRef.current !== undefined) window.clearTimeout(metricsTimerRef.current);
    metricsTimerRef.current = undefined;
    setMetrics(documentMetrics(fileRef.current.document));
  }, [documentId]);

  useEffect(() => {
    // Sample the current editor on a bounded interval even when document/comment
    // publication is still waiting for a pause in continuous typing.
    if (metricsTimerRef.current !== undefined) return;
    metricsTimerRef.current = window.setTimeout(() => {
      metricsTimerRef.current = undefined;
      const currentDocument = sourceModeRef.current
        ? fileRef.current.sourceMarkdown === rawMarkdownRef.current
          ? fileRef.current.document
          : markdownToDocument(parseMarkdownComments(rawMarkdownRef.current).body)
        : canvasSearch.current?.getDocument?.() ?? fileRef.current.document;
      const next = documentMetrics(currentDocument);
      if (sourceModeRef.current) setSourceOutline(collectOutlineResult(currentDocument));
      setMetrics((current) =>
        current.characters === next.characters && current.words === next.words ? current : next,
      );
    }, 250);
  }, [editRevision, file.document, sourceMode, rawMarkdownRevision]);

  useEffect(
    () => () => {
      if (metricsTimerRef.current !== undefined) window.clearTimeout(metricsTimerRef.current);
    },
    [],
  );

  const commitFontSize = (value: string) => {
    const fontSize = normalizeFontSize(value, preferences.fontSize);
    setFontSizeInput(String(fontSize));
    setPreferences((current) => ({ ...current, fontSize }));
  };

  const commitLineSpacing = (value: string) => {
    const lineSpacing = normalizeLineSpacing(value, preferences.lineSpacing);
    setLineSpacingInput(String(lineSpacing));
    setPreferences((current) => ({ ...current, lineSpacing }));
  };

  const closeExportMenu = () => exportMenu.current?.removeAttribute('open');

  const jumpToOutline = async (index: number) => {
    if (sourceMode) {
      const session = documentSessionRef.current;
      await toggleSourceMode();
      if (documentSessionRef.current !== session || sourceModeRef.current) return;
    }
    outlineRequest.current += 1;
    setOutlineTarget({ index, request: outlineRequest.current });
  };

  const exportMarkdown = useCallback(async () => {
    const exportSession = documentSessionRef.current;
    closeExportMenu();
    try {
      if (!sourceModeRef.current) {
        const pendingImages = canvasSearch.current?.waitForPendingImages?.();
        if (pendingImages) await pendingImages;
      }
      if (documentSessionRef.current !== exportSession) return;
      if (!sourceModeRef.current) flushCanvasChanges();
      if (!sourceModeRef.current && fileRef.current.sourceMarkdown === undefined) {
        validateDocumentUnicode(fileRef.current.document);
      }
      const markdown = sourceModeRef.current
        ? rawMarkdownRef.current
        : fileRef.current.sourceMarkdown ?? documentToPortableMarkdown(fileRef.current.document, fileRef.current.comments ?? []);
      const exportedName = await exportMarkdownFile(markdown, fileRef.current.name, fileAssetSourcePath(fileRef.current));
      if (exportedName && documentSessionRef.current === exportSession) setMessage(getMessages().exportedFile(exportedName));
    } catch (error) {
      if (documentSessionRef.current === exportSession) setMessage(error instanceof Error ? error.message : getMessages().markdownExportFailed);
    }
  }, [flushCanvasChanges]);

  const exportPdf = useCallback(async () => {
    if (pdfExportingRef.current) return;
    const exportSession = documentSessionRef.current;
    pdfExportingRef.current = true;
    setPdfExporting(true);
    closeExportMenu();
    setMessage(getMessages().pdfExporting);
    try {
      let renderedRevision: number;
      let renderedAssetPath: string | undefined;
      while (true) {
        if (!sourceModeRef.current) {
          const pendingImages = canvasSearch.current?.waitForPendingImages?.();
          if (pendingImages) {
            await pendingImages;
            if (documentSessionRef.current !== exportSession) return;
            flushCanvasChanges();
            // Let newly inserted images reach the canvas before capture.
            await waitForCanvasRender();
          }
        }
        if (documentSessionRef.current !== exportSession) return;
        renderedRevision = editRevisionRef.current;
        renderedAssetPath = fileAssetSourcePath(fileRef.current);
        // Source remains editable during rendering and image decoding, so
        // repeat preparation if writing changes while either wait is pending.
        if (sourceModeRef.current) {
          const sourceFile = fileRef.current;
          const sourceMarkdown = rawMarkdownRef.current;
          const sourceState = documentStateFromMarkdown(sourceMarkdown, renderedAssetPath);
          if (!canvasDocumentSupported(sourceState.document, sourceState.comments)) throw new Error(getMessages().canvasViewLimited);
          const nextFile = {
            ...sourceFile,
            document: sourceState.document,
            comments: sourceState.comments,
            sourceMarkdown,
            ...(sourceState.warning ? { commentWarning: sourceState.warning } : { commentWarning: undefined }),
          };
          await allowDocumentImageFiles(nextFile);
          if (documentSessionRef.current !== exportSession) return;
          if (editRevisionRef.current !== renderedRevision || fileRef.current !== sourceFile || !sourceModeRef.current) continue;
          fileRef.current = nextFile;
          setFile(nextFile);
          setDocumentId((id) => id + 1);
          await waitForCanvasRender();
        }
        if (documentSessionRef.current !== exportSession) return;
        if (canvasArea.current) {
          const renderedImages = waitForRenderedImages(canvasArea.current);
          if (renderedImages) await renderedImages;
        }
        if (documentSessionRef.current !== exportSession) return;
        // Blurring can commit live formula/IME input. Include that writing in
        // the same stability check instead of capturing the previous render.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        if (!sourceModeRef.current) flushCanvasChanges();
        if (editRevisionRef.current === renderedRevision && fileAssetSourcePath(fileRef.current) === renderedAssetPath) break;
      }
      const result = await exportPdfFile(fileRef.current.name, () =>
        documentSessionRef.current === exportSession && editRevisionRef.current === renderedRevision &&
        fileAssetSourcePath(fileRef.current) === renderedAssetPath,
      );
      if (documentSessionRef.current !== exportSession) return;
      if (result.type === 'saved') {
        setMessage(getMessages().exportedFile(result.name));
      } else if (result.type === 'print') {
        setMessage(getMessages().pdfInstruction);
      }
    } catch (error) {
      if (documentSessionRef.current === exportSession) setMessage(error instanceof Error ? error.message : getMessages().pdfExportFailed);
    } finally {
      pdfExportingRef.current = false;
      setPdfExporting(false);
    }
  }, [flushCanvasChanges]);

  const handleCanvasContextMenu = useCallback((placement: CommentPlacement, coordinates: { x: number; y: number }) => {
    const menuWidth = 190;
    const menuHeight = 176;
    setCanvasContextMenu({
      placement,
      x: Math.max(8, Math.min(coordinates.x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(coordinates.y, window.innerHeight - menuHeight - 8)),
    });
  }, []);

  const openCommentComposer = (placement?: CommentPlacement) => {
    const nextTarget = placement ?? canvasContextMenu?.placement;
    if (!nextTarget) return;
    setCanvasContextMenu(null);
    setNewCommentTarget(nextTarget);
    setActiveCommentId(undefined);
    setCommentsPanelOpen(true);
  };

  const runCanvasContextAction = (action: 'cut' | 'copy' | 'paste' | 'selectAll') => {
    canvasSearch.current?.runContextAction?.(action);
    setCanvasContextMenu(null);
  };

  const closeCommentsPanel = useCallback(() => {
    setCommentsPanelOpen(false);
    setNewCommentTarget(null);
  }, []);

  const cancelNewComment = useCallback(() => setNewCommentTarget(null), []);

  return (
    <main className={`app-shell compact-layout theme-${preferences.theme} font-${preferences.font}`} lang={preferences.language}>
      <header className="topbar">
        <button
          className="icon-button"
          type="button"
          aria-label={text.showSidebar}
          aria-pressed={preferences.sidebarOpen}
          title={text.showSidebar}
          onClick={() => setPreferences((p) => ({ ...p, sidebarOpen: !p.sidebarOpen }))}
        >
          <ToolbarIcon name="sidebar" />
        </button>
        <div className="document-name" title={file.path ?? text.unsavedLocation}>
          {dirty && <span className="dirty-dot">●</span>}
          {file.name}
        </div>
        <div className="view-switch" role="group" aria-label={text.documentView}>
          <button
            type="button"
            className={!sourceMode ? 'is-active' : ''}
            aria-label={text.backToCanvas}
            aria-pressed={!sourceMode}
            onPointerDown={(event) => { if (event.button === 0) event.preventDefault(); }}
            onClick={() => { if (sourceMode) void toggleSourceMode(); }}
          >
            {text.canvas}
          </button>
          <button
            type="button"
            className={sourceMode ? 'source-mode-button is-active' : 'source-mode-button'}
            aria-label={text.showMarkdownSource}
            aria-pressed={sourceMode}
            onPointerDown={(event) => { if (event.button === 0) event.preventDefault(); }}
            onClick={() => { if (!sourceMode) void toggleSourceMode(); }}
          >
            Markdown
          </button>
        </div>
        <div className="toolbar-actions">
          <button
            className="icon-button search-button"
            type="button"
            aria-keyshortcuts="Meta+F Control+F"
            aria-label={text.findDocument}
            title={text.findShortcut}
            onClick={openSearch}
          >
            <ToolbarIcon name="search" />
          </button>
          <button
            className={commentsPanelOpen ? 'icon-button comments-toggle is-active' : 'icon-button comments-toggle'}
            type="button"
            aria-pressed={commentsPanelOpen}
            aria-label={commentsPanelOpen ? text.closeComments : text.openComments}
            title={text.commentsCount(comments.length)}
            onClick={() => setCommentsPanelOpen((open) => !open)}
          >
            <ToolbarIcon name="comments" />
            {comments.length > 0 && <span className="comments-toggle__count">{comments.length}</span>}
          </button>
          <details
            ref={readingSettingsMenu}
            className="toolbar-menu reading-settings"
            onToggle={(event) => {
              if (event.currentTarget.open && documentActionsMenu.current) documentActionsMenu.current.open = false;
            }}
          >
            <summary className="icon-button" role="button" aria-label={text.readingSettings} title={text.readingSettings}>Aa</summary>
            <div className="toolbar-popover typography-popover" aria-label={text.readingSettings}>
        <label className="compact-control">
          {text.font}{' '}
          <select
            value={preferences.font}
            onChange={(event) =>
              setPreferences((p) => ({
                ...p,
                font: event.target.value as AppPreferences['font'],
              }))
            }
          >
            <option value="system">{text.fontSystem}</option>
            <option value="serif">{text.fontSerif}</option>
            <option value="mono">{text.fontMono}</option>
          </select>
        </label>
        <label className="compact-control">
          {text.size}
          <input
            aria-label={text.fontSize}
            type="number"
            min={minimumFontSize}
            max={maximumFontSize}
            value={fontSizeInput}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setFontSizeInput(event.target.value)}
            onBlur={(event) => commitFontSize(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                const original = String(preferences.fontSize);
                event.currentTarget.value = original;
                setFontSizeInput(original);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <label className="compact-control">
          {text.lineSpacing}
          <input
            aria-label={text.lineSpacing}
            type="number"
            min={minimumLineSpacing}
            max={maximumLineSpacing}
            step="0.01"
            value={lineSpacingInput}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setLineSpacingInput(event.target.value)}
            onBlur={(event) => commitLineSpacing(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                const original = String(preferences.lineSpacing);
                event.currentTarget.value = original;
                setLineSpacingInput(original);
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <label className="compact-control language-control">
          {text.language}
          <select
            aria-label={text.language}
            value={preferences.language}
            onChange={(event) => {
              const language = event.target.value as Language;
              setCurrentLanguage(language);
              document.documentElement.lang = language;
              setPreferences((current) => ({ ...current, language }));
              setMessage(getMessages(language).localOnly);
            }}
          >
            <option value="en">{text.languageOptions.en}</option>
            <option value="zh-Hans">{text.languageOptions['zh-Hans']}</option>
            <option value="zh-Hant">{text.languageOptions['zh-Hant']}</option>
          </select>
        </label>
        <button
          className="theme-control"
          title={text.toggleTheme}
          aria-label={text.toggleTheme}
          onClick={() =>
            setPreferences((p) => ({
              ...p,
              theme: p.theme === 'light' ? 'dark' : 'light',
            }))
          }
        >
          <ToolbarIcon name="theme" />
          <span>{text.toggleTheme}</span>
        </button>
            </div>
          </details>
          <details
            ref={documentActionsMenu}
            className="toolbar-menu document-actions"
            onToggle={(event) => {
              if (event.currentTarget.open && readingSettingsMenu.current) readingSettingsMenu.current.open = false;
              if (!event.currentTarget.open && exportMenu.current) exportMenu.current.open = false;
              if (!event.currentTarget.open) setRenameRequest(null);
            }}
          >
            <summary className="icon-button" role="button" aria-label={text.fileActions} title={text.fileActions}><ToolbarIcon name="more" /></summary>
            <nav className="toolbar-popover document-actions-popover file-actions" aria-label={text.fileActions}>
              <button onClick={() => { closeToolbarMenus(); newFile(); }}>{text.new}</button>
              <button onClick={() => { closeToolbarMenus(); void openFile(); }}>{text.open}</button>
              <button onClick={() => { closeToolbarMenus(); void saveCurrent(); }}>{text.save}</button>
              <button onClick={() => { closeToolbarMenus(); void saveCurrent(true); }}>{text.saveAs}</button>
              {renameRequest ? (
                <form className="rename-form" aria-label={text.rename} onSubmit={(event) => {
                  event.preventDefault();
                  const name = renameInput.current?.value.trim();
                  if (!name) return;
                  const session = renameRequest.session;
                  closeToolbarMenus();
                  void renameFile(name, session);
                }}>
                  <label>
                    {text.newFilenamePrompt}
                    <input ref={renameInput} name="filename" defaultValue={renameRequest.name} required autoComplete="off" />
                  </label>
                  <div className="rename-form-actions">
                    <button type="button" onClick={() => {
                      closeToolbarMenus();
                      documentActionsMenu.current?.querySelector<HTMLElement>('summary')?.focus();
                    }}>{text.commentCancel}</button>
                    <button type="submit">{text.rename}</button>
                  </div>
                </form>
              ) : (
                <button onClick={() => setRenameRequest({ name: fileRef.current.name, session: documentSessionRef.current })}>{text.rename}</button>
              )}
              <details ref={exportMenu} className="export-menu">
                <summary>{text.export}</summary>
                <div className="export-options" role="menu" aria-label={text.chooseExportFormat}>
                  <button role="menuitem" onClick={() => { closeToolbarMenus(); void exportMarkdown(); }}>Markdown (.md)</button>
                  <button role="menuitem" aria-busy={pdfExporting} disabled={pdfExporting} onClick={() => { closeToolbarMenus(); void exportPdf(); }}>PDF (.pdf)</button>
                </div>
              </details>
            </nav>
          </details>
        </div>
      </header>
      {searchOpen && (
        <form
          className="document-search"
          role="search"
          aria-label={text.findDocument}
          onSubmit={(event) => {
            event.preventDefault();
            runSearch(searchQuery, 'next');
          }}
        >
          <input
            ref={searchInput}
            type="search"
            value={searchQuery}
            aria-label={text.findDocument}
            placeholder={text.findPlaceholder}
            autoComplete="off"
            spellCheck="false"
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                runSearch(searchQuery, event.shiftKey ? 'previous' : 'next');
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              }
            }}
          />
          <span className="document-search__result" aria-live="polite" aria-atomic="true">
            {!searchQuery
              ? text.findTypeToSearch
              : searchResult.total === 0
                ? text.findNoResults
                : text.findResults(searchResult.current, searchResult.total)}
          </span>
          <button
            type="button"
            aria-label={text.findPrevious}
            title={text.findPrevious}
            disabled={searchResult.total === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runSearch(searchQuery, 'previous')}
          >
            ‹
          </button>
          <button
            type="button"
            aria-label={text.findNext}
            title={text.findNext}
            disabled={searchResult.total === 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runSearch(searchQuery, 'next')}
          >
            ›
          </button>
          <button type="button" aria-label={text.closeFind} title={text.closeFind} onClick={closeSearch}>
            ×
          </button>
          {searchResult.highlightsLimited && (
            <p className="document-search__note" role="status">{text.findHighlightsLimited}</p>
          )}
        </form>
      )}
      <section className="workspace">
        {preferences.sidebarOpen && (
          <aside className="sidebar" aria-label={text.documentNavigation}>
            <div
              ref={sidebarTabs}
              className="sidebar-tabs"
              role="tablist"
              aria-label={text.documentNavigation}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const nextTab = event.key === 'Home' ? 'outline' : event.key === 'End' ? 'recent' : sidebarTab === 'outline' ? 'recent' : 'outline';
                setSidebarTab(nextTab);
                sidebarTabs.current?.querySelector<HTMLButtonElement>(`[aria-controls="${nextTab}-panel"]`)?.focus();
              }}
            >
              <button type="button" id="outline-tab" role="tab" aria-label={text.outline} aria-selected={sidebarTab === 'outline'} aria-controls="outline-panel" tabIndex={sidebarTab === 'outline' ? 0 : -1} onClick={() => setSidebarTab('outline')}>{text.outline}</button>
              <button type="button" id="recent-tab" role="tab" aria-label={text.recentFiles} aria-selected={sidebarTab === 'recent'} aria-controls="recent-panel" tabIndex={sidebarTab === 'recent' ? 0 : -1} onClick={() => setSidebarTab('recent')}>{text.recentTab}</button>
            </div>
            <div className="sidebar-content">
              <section id="outline-panel" role="tabpanel" aria-labelledby="outline-tab" hidden={sidebarTab !== 'outline'}>
                {outlineResult.limited && <p className="outline-empty" role="status">{text.outlineLimited}</p>}
                {outline.length === 0 ? (
                  <p className="muted">{text.noHeadings}</p>
                ) : (
                  <ol className="outline-list">
                    {outline.map((item, index) => (
                      <li key={`${item.text}-${index}`} style={{ paddingInlineStart: `${Math.min(item.level - 1, 3) * 10}px` }}>
                        <button type="button" title={item.text} aria-current={(outlineTarget?.index ?? 0) === index ? 'location' : undefined} onClick={() => jumpToOutline(index)}>{item.text}</button>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <section id="recent-panel" role="tabpanel" aria-labelledby="recent-tab" hidden={sidebarTab !== 'recent'}>
                {recent.length === 0 ? (
                  <p className="muted">{text.noRecentFiles}</p>
                ) : (
                  <ul className="recent-list">
                    {recent.map((item) => (
                      <li key={item.path}>
                        <button
                          className={item.path === file.path ? 'is-active' : undefined}
                          title={item.path}
                          onClick={() => void openRecentFile(item)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            const menuWidth = 196;
                            const menuHeight = 116;
                            setRecentContextMenu({
                              item,
                              x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
                              y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
                            });
                          }}
                        >
                          {item.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </aside>
        )}
        <section
          ref={canvasArea}
          className={modeTransitioning ? 'canvas-area is-switching-mode' : 'canvas-area'}
          aria-busy={modeTransitioning || undefined}
          style={
            {
              '--editor-size': `${preferences.fontSize}px`,
              '--editor-line-height': preferences.lineSpacing,
            } as React.CSSProperties
          }
        >
          <div className="editor-mode-pane editor-mode-pane--canvas" hidden={sourceMode}>
            {canvasSupported && <CanvasEditor
              key={documentSessionRef.current}
              ref={canvasSearch}
              language={preferences.language}
              documentId={documentId}
              documentPath={file.path}
              initialDocument={file.document}
              comments={comments}
              outlineTarget={outlineTarget}
              onReady={canvasReady}
              onLinkError={setMessage}
              onCapacityError={setMessage}
              onEdit={markEdited}
              onCommentRequest={handleCanvasContextMenu}
              onCommentClick={handleCommentMarkerClick}
              canUndoComment={commentHistory.current.undo.length > 0}
              canRedoComment={commentHistory.current.redo.length > 0}
              onUndoComment={undoComment}
              onRedoComment={redoComment}
              onChange={(document, mappedComments) => {
                if (mappedComments) resetCommentHistory();
                const nextFile = {
                  ...fileRef.current,
                  document,
                  sourceMarkdown: undefined,
                  ...(mappedComments ? { comments: mappedComments } : {}),
                };
                fileRef.current = nextFile;
                setFile(nextFile);
                markEdited();
              }}
            />}
          </div>
          {sourceEditorSession === documentSessionRef.current && (
            <div className="editor-mode-pane editor-mode-pane--source" hidden={!sourceMode}>
              <MarkdownSourceEditor
                key={documentSessionRef.current}
                ref={markdownSearch}
                language={preferences.language}
                value={rawMarkdownRef.current}
                valueRevision={rawMarkdownRevision}
                externalChanges={rawMarkdownChangesRef.current}
                assetSourcePath={fileAssetSourcePath(file)}
                assetSourceOperation={sourceAssetOperationRef.current}
                assetSourceTransition={sourceAssetTransitionRef.current}
                onError={setMessage}
                onReady={sourceReady}
                onChange={(value) => {
                  rawMarkdownRef.current = value;
                  markEdited();
                  scheduleSourceCommentSync();
                }}
              />
            </div>
          )}
        </section>
        {commentsPanelOpen && (
          <CommentsPanel
            key={documentSessionRef.current}
            language={preferences.language}
            comments={comments}
            newTarget={newCommentTarget}
            activeCommentId={activeCommentId}
            onClose={closeCommentsPanel}
            onCreate={createComment}
            onCancelNew={cancelNewComment}
            onUpdate={updateComment}
            onDelete={deleteComment}
            onLocate={locateComment}
          />
        )}
      </section>
      {recentContextMenu && (
        <div
          className="recent-context-menu"
          role="menu"
          aria-label={text.recentFileActions(recentContextMenu.item.name)}
          style={{ left: recentContextMenu.x, top: recentContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button role="menuitem" onClick={() => void openRecentFile(recentContextMenu.item)}>
            {text.recentContextOpen}
          </button>
          <button role="menuitem" onClick={() => void revealRecentFile(recentContextMenu.item)}>
            {text.showInFolder}
          </button>
          <button role="menuitem" onClick={() => void hideRecent(recentContextMenu.item)}>
            {text.hideFromRecent}
          </button>
        </div>
      )}
      {canvasContextMenu && (
        <div
          className="canvas-context-menu"
          role="menu"
          aria-label={text.commentNew}
          style={{ left: canvasContextMenu.x, top: canvasContextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button role="menuitem" className="canvas-context-menu__primary" onClick={() => openCommentComposer()}>
            {text.commentNew}
          </button>
          <div className="canvas-context-menu__separator" />
          <button role="menuitem" onClick={() => runCanvasContextAction('cut')}>
            {text.commentCut}
          </button>
          <button role="menuitem" onClick={() => runCanvasContextAction('copy')}>
            {text.commentCopy}
          </button>
          <button role="menuitem" onClick={() => runCanvasContextAction('paste')}>
            {text.commentPaste}
          </button>
          <button role="menuitem" onClick={() => runCanvasContextAction('selectAll')}>
            {text.commentSelectAll}
          </button>
        </div>
      )}
      <footer className="statusbar">
        <span className={`save-status save-status--${saveStatus}`}>{text.saveStatus[saveStatus]}</span>
        <span>{text.metrics(metrics.words, metrics.characters)}</span>
        <span className="status-message" title={message}>{message}</span>
        <span>{text.localFirst}</span>
      </footer>
    </main>
  );
}
