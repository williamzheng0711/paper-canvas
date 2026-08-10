import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { JSONContent } from '@tiptap/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CanvasEditor } from './components/CanvasEditor';
import { MarkdownSourceEditor } from './components/MarkdownSourceEditor';
import { documentsEqual } from './editor/documentSync';
import { collectOutline, documentToMarkdown, markdownToDocument } from './editor/markdown';
import { captureViewport, restoreViewport, type ViewportSnapshot } from './editor/modeTransition';
import type { SearchDirection, SearchResult, SwitchableEditorHandle } from './editor/search';
import { markdownToDocumentWithSelection, type DocumentSelectionAnchor } from './editor/selectionMapping';
import { getMessages, setCurrentLanguage, type Language } from './i18n';
import { maximumFontSize, minimumFontSize, normalizeFontSize } from './lib/fontSize';
import { maximumLineSpacing, minimumLineSpacing, normalizeLineSpacing } from './lib/lineSpacing';
import {
  chooseMarkdownFile,
  clearDraft,
  documentToPortableMarkdown,
  exportMarkdownFile,
  exportPdfFile,
  hideRecentFile,
  loadDraft,
  loadPreferences,
  loadRecent,
  newEditorFile,
  openMarkdownFile,
  openRecent,
  removeRecentFile,
  revealFileInFolder,
  renameEditorFile,
  saveEditorFile,
  saveDraft,
  savePreferences,
  type AppPreferences,
  type EditorFile,
  type RecentFile,
} from './lib/files';

type SaveStatus = 'saved' | 'saving' | 'draft' | 'error' | 'unsaved';
type RecentContextMenu = { item: RecentFile; x: number; y: number };
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

function documentMetrics(document: JSONContent): {
  characters: number;
  words: number;
} {
  const walk = (node: JSONContent): string => `${node.text ?? ''}${(node.content ?? []).map(walk).join('')}`;
  const text = walk(document).trim();
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const nonCjkWords = text
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return { characters: [...text].length, words: cjk + nonCjkWords };
}

export default function App() {
  const [file, setFile] = useState<EditorFile>(newEditorFile);
  const [documentId, setDocumentId] = useState(0);
  const [editRevision, setEditRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [message, setMessage] = useState(() => getMessages().localOnly);
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [recentContextMenu, setRecentContextMenu] = useState<RecentContextMenu | null>(null);
  const [outlineTarget, setOutlineTarget] = useState<{
    index: number;
    request: number;
  }>();
  const [sourceMode, setSourceMode] = useState(false);
  const [modeTransitioning, setModeTransitioning] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult>({
    current: 0,
    total: 0,
  });
  const [pdfExporting, setPdfExporting] = useState(false);
  const [preferences, setPreferences] = useState<AppPreferences>({
    theme: 'light',
    font: 'system',
    fontSize: 18,
    lineSpacing: 1.78,
    sidebarOpen: true,
    recentFilesExpanded: true,
    language: 'zh-Hant',
  });
  const text = getMessages(preferences.language);
  const [fontSizeInput, setFontSizeInput] = useState('18');
  const [lineSpacingInput, setLineSpacingInput] = useState('1.78');
  const saving = useRef(false);
  const preferencesLoaded = useRef(false);
  const fileRef = useRef(file);
  const dirtyRef = useRef(dirty);
  const editRevisionRef = useRef(editRevision);
  const documentSessionRef = useRef(0);
  const sourceModeRef = useRef(sourceMode);
  const rawMarkdownRef = useRef(rawMarkdown);
  const openedByOperatingSystem = useRef(false);
  const recentExternalOpen = useRef(new Map<string, number>());
  const exportMenu = useRef<HTMLDetailsElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const canvasSearch = useRef<SwitchableEditorHandle>(null);
  const markdownSearch = useRef<SwitchableEditorHandle>(null);
  const canvasArea = useRef<HTMLElement>(null);
  const pendingModeTransition = useRef<PendingModeTransition | undefined>(undefined);
  const modeTransitionFrame = useRef<number | undefined>(undefined);
  const outlineRequest = useRef(0);
  const pdfExportingRef = useRef(false);
  fileRef.current = file;
  dirtyRef.current = dirty;
  sourceModeRef.current = sourceMode;
  rawMarkdownRef.current = rawMarkdown;

  const advanceRevision = useCallback(() => {
    const nextRevision = editRevisionRef.current + 1;
    editRevisionRef.current = nextRevision;
    setEditRevision(nextRevision);
  }, []);

  const markEdited = useCallback(() => {
    advanceRevision();
    dirtyRef.current = true;
    setDirty(true);
    setSaveStatus('unsaved');
  }, [advanceRevision]);

  useEffect(() => {
    void Promise.all([loadRecent(), loadPreferences(), loadDraft()])
      .then(([loadedRecent, loadedPreferences, draft]) => {
        setCurrentLanguage(loadedPreferences.language);
        document.documentElement.lang = loadedPreferences.language;
        const loadedText = getMessages(loadedPreferences.language);
        if (!openedByOperatingSystem.current) setRecent(loadedRecent);
        preferencesLoaded.current = true;
        setPreferences(loadedPreferences);
        setFontSizeInput(String(loadedPreferences.fontSize));
        setLineSpacingInput(String(loadedPreferences.lineSpacing));
        if (draft && !openedByOperatingSystem.current) {
          fileRef.current = draft;
          setFile(draft);
          setDocumentId((id) => id + 1);
          documentSessionRef.current += 1;
          advanceRevision();
          dirtyRef.current = true;
          setDirty(true);
          setSaveStatus('draft');
          setMessage(loadedText.restoredDraft);
        } else {
          setMessage(loadedText.localOnly);
        }
      })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : getMessages().loadSettingsFailed));
  }, [advanceRevision]);

  useEffect(() => {
    if (!preferencesLoaded.current) return;
    void savePreferences(preferences);
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
    const title = `${dirty ? '● ' : ''}${file.name} — PaperCanvas`;
    document.title = title;
    if (isTauri()) {
      void import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) =>
        getCurrentWebviewWindow().setTitle(title),
      );
    }
  }, [dirty, file.name]);

  const loadFile = useCallback(
    (nextFile: EditorFile) => {
      if (nextFile.path) void clearDraft();
      fileRef.current = nextFile;
      setFile(nextFile);
      setDocumentId((id) => id + 1);
      documentSessionRef.current += 1;
      advanceRevision();
      dirtyRef.current = false;
      setDirty(false);
      setSaveStatus('saved');
      sourceModeRef.current = false;
      setSourceMode(false);
      setMessage(getMessages().openedFile(nextFile.name));
    },
    [advanceRevision],
  );

  const replaceWithOpenedFile = useCallback(
    async (nextFile: EditorFile) => {
      if (
        dirtyRef.current &&
        fileRef.current.path !== nextFile.path &&
        !window.confirm(getMessages().confirmDiscardAndOpen)
      ) {
        return false;
      }
      loadFile(nextFile);
      setRecent(await loadRecent());
      return true;
    },
    [loadFile],
  );

  const openExternalMarkdownFiles = useCallback(
    async (paths: string[]) => {
      const path = paths.find(Boolean);
      if (!path) return;
      const now = Date.now();
      if (now - (recentExternalOpen.current.get(path) ?? 0) < 2_000) return;
      recentExternalOpen.current.set(path, now);
      // A file open from Finder/Explorer takes precedence over a recovered
      // unnamed draft if both asynchronous startup paths complete together.
      openedByOperatingSystem.current = true;

      try {
        const nextFile = await openMarkdownFile(path);
        const replaced = await replaceWithOpenedFile(nextFile);
        if (replaced) setRecent(await loadRecent());
      } catch (error) {
        setMessage(error instanceof Error ? error.message : getMessages().externalOpenFailed);
      }
    },
    [replaceWithOpenedFile],
  );

  const saveCurrent = useCallback(async (forceSaveAs = false) => {
    if (saving.current) return;
    saving.current = true;
    setSaveStatus('saving');
    const saveSession = documentSessionRef.current;
    try {
      let shouldSaveAs = forceSaveAs;
      while (documentSessionRef.current === saveSession) {
        const revision = editRevisionRef.current;
        const editingSource = sourceModeRef.current;
        const candidate = editingSource
          ? {
              ...fileRef.current,
              document: markdownToDocument(rawMarkdownRef.current),
            }
          : fileRef.current;
        const saved = await saveEditorFile(candidate, shouldSaveAs);
        shouldSaveAs = false;

        if (documentSessionRef.current !== saveSession) return;
        if (editRevisionRef.current !== revision) {
          // Keep edits made while the asynchronous write was in flight. If
          // this was Save As, carry the new path into the next save pass.
          const latest = {
            ...fileRef.current,
            path: saved.path,
            name: saved.name,
          };
          fileRef.current = latest;
          setFile(latest);
          setSaveStatus('saving');
          continue;
        }

        const savedDocumentChanged = !documentsEqual(candidate.document, saved.document);
        fileRef.current = saved;
        setFile(saved);
        if (savedDocumentChanged && !sourceModeRef.current) {
          setDocumentId((id) => id + 1);
        }
        if (sourceModeRef.current) {
          const normalizedMarkdown = documentToMarkdown(saved.document);
          rawMarkdownRef.current = normalizedMarkdown;
          setRawMarkdown(normalizedMarkdown);
        }
        dirtyRef.current = false;
        setDirty(false);
        setSaveStatus('saved');
        setMessage(getMessages().savedFile(saved.name));
        await clearDraft();
        setRecent(await loadRecent());
        return;
      }
    } catch (error) {
      if (documentSessionRef.current === saveSession) {
        setSaveStatus('error');
        setMessage(error instanceof Error ? error.message : getMessages().saveFailed);
      }
    } finally {
      saving.current = false;
    }
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const revision = editRevisionRef.current;
    const session = documentSessionRef.current;
    const timer = window.setTimeout(() => {
      if (fileRef.current.path) {
        void saveCurrent();
        return;
      }
      const draft = sourceModeRef.current
        ? {
            ...fileRef.current,
            document: markdownToDocument(rawMarkdownRef.current),
          }
        : fileRef.current;
      void saveDraft(draft)
        .then(() => {
          if (documentSessionRef.current === session && editRevisionRef.current === revision) {
            setSaveStatus('draft');
          }
        })
        .catch((error: unknown) => {
          setSaveStatus('error');
          setMessage(error instanceof Error ? error.message : getMessages().autosaveFailed);
        });
    }, 850);
    return () => window.clearTimeout(timer);
  }, [dirty, editRevision, saveCurrent]);

  const openFile = useCallback(async () => {
    try {
      const nextFile = await chooseMarkdownFile();
      if (nextFile) await replaceWithOpenedFile(nextFile);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : getMessages().openFailed);
    }
  }, [replaceWithOpenedFile]);

  const openRecentFile = useCallback(
    async (item: RecentFile) => {
      setRecentContextMenu(null);
      try {
        const nextFile = await openRecent(item);
        if (!nextFile) {
          const missingMessage = getMessages().missingRecentFile(item.name);
          setRecent((current) => current.filter((recentItem) => recentItem.path !== item.path));
          window.alert(missingMessage);
          try {
            setRecent(await removeRecentFile(item.path));
            setMessage(missingMessage);
          } catch {
            setMessage(`${missingMessage} ${getMessages().removeMissingRecentFailed}`);
          }
          return;
        }
        await replaceWithOpenedFile(nextFile);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : getMessages().recentOpenFailed);
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

  const newFile = useCallback(() => {
    if (dirty && !window.confirm(getMessages().confirmDiscardAndNew)) return;
    void clearDraft();
    loadFile(newEditorFile());
  }, [dirty, loadFile]);

  const renameFile = useCallback(async () => {
    const nextName = window.prompt(getMessages().newFilenamePrompt, fileRef.current.name);
    if (!nextName) return;
    try {
      const renamed = await renameEditorFile(fileRef.current, nextName);
      setFile(renamed);
      setMessage(getMessages().renamedFile(renamed.name));
      setRecent(await loadRecent());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : getMessages().renameFailed);
    }
  }, []);

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
    runSearch(searchQuery, 'reset');
  }, [documentId, editRevision, preferences.language, runSearch, searchOpen, searchQuery, sourceMode]);

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

  const toggleSourceMode = () => {
    if (!sourceMode) {
      const mappedSelection = canvasSearch.current?.getMarkdownSelection?.();
      const markdown = mappedSelection?.markdown ?? documentToMarkdown(fileRef.current.document);
      beginModeTransition('source', mappedSelection ? { kind: 'markdown', offset: mappedSelection.offset } : undefined);
      rawMarkdownRef.current = markdown;
      setRawMarkdown(markdown);
      sourceModeRef.current = true;
      setSourceMode(true);
      return;
    }
    try {
      const parsedSelection = markdownToDocumentWithSelection(
        rawMarkdownRef.current,
        markdownSearch.current?.getMarkdownOffset?.(),
      );
      const nextDocument = parsedSelection.document;
      const currentFile = fileRef.current;
      beginModeTransition(
        'canvas',
        parsedSelection.anchor ? { kind: 'document', anchor: parsedSelection.anchor } : undefined,
      );
      if (!documentsEqual(currentFile.document, nextDocument)) {
        const nextFile = { ...currentFile, document: nextDocument };
        fileRef.current = nextFile;
        setFile(nextFile);
        setDocumentId((id) => id + 1);
      }
      sourceModeRef.current = false;
      setSourceMode(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : getMessages().markdownParseFailed);
    }
  };

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
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

  const outline = useMemo(() => collectOutline(file.document), [file.document]);
  const metrics = useMemo(() => documentMetrics(file.document), [file.document]);

  const commitFontSize = () => {
    const fontSize = normalizeFontSize(fontSizeInput, preferences.fontSize);
    setFontSizeInput(String(fontSize));
    setPreferences((current) => ({ ...current, fontSize }));
  };

  const commitLineSpacing = () => {
    const lineSpacing = normalizeLineSpacing(lineSpacingInput, preferences.lineSpacing);
    setLineSpacingInput(String(lineSpacing));
    setPreferences((current) => ({ ...current, lineSpacing }));
  };

  const closeExportMenu = () => exportMenu.current?.removeAttribute('open');

  const jumpToOutline = (index: number) => {
    if (sourceMode) {
      try {
        const nextDocument = markdownToDocument(rawMarkdownRef.current);
        const nextFile = { ...fileRef.current, document: nextDocument };
        fileRef.current = nextFile;
        setFile(nextFile);
        setDocumentId((id) => id + 1);
        markEdited();
        sourceModeRef.current = false;
        setSourceMode(false);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : getMessages().markdownParseFailed);
        return;
      }
    }
    outlineRequest.current += 1;
    setOutlineTarget({ index, request: outlineRequest.current });
  };

  const exportMarkdown = useCallback(async () => {
    closeExportMenu();
    try {
      const markdown = sourceModeRef.current
        ? rawMarkdownRef.current
        : documentToPortableMarkdown(fileRef.current.document);
      const exportedName = await exportMarkdownFile(markdown, fileRef.current.name);
      if (exportedName) setMessage(getMessages().exportedFile(exportedName));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : getMessages().markdownExportFailed);
    }
  }, []);

  const exportPdf = useCallback(async () => {
    if (pdfExportingRef.current) return;
    pdfExportingRef.current = true;
    setPdfExporting(true);
    closeExportMenu();
    setMessage(getMessages().pdfExporting);
    try {
      // PDF should always contain the rendered document, even if the author is
      // currently editing its Markdown source.
      if (sourceModeRef.current) {
        const nextDocument = markdownToDocument(rawMarkdownRef.current);
        const nextFile = { ...fileRef.current, document: nextDocument };
        fileRef.current = nextFile;
        setFile(nextFile);
        setDocumentId((id) => id + 1);
        sourceModeRef.current = false;
        setSourceMode(false);
        await new Promise<void>((resolve) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
        );
      }
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const result = await exportPdfFile(fileRef.current.name);
      if (result.type === 'saved') {
        setMessage(getMessages().exportedFile(result.name));
      } else if (result.type === 'print') {
        setMessage(getMessages().pdfInstruction);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : getMessages().pdfExportFailed);
    } finally {
      pdfExportingRef.current = false;
      setPdfExporting(false);
    }
  }, []);

  return (
    <main className={`app-shell theme-${preferences.theme} font-${preferences.font}`} lang={preferences.language}>
      <header className="topbar">
        <button
          className="icon-button"
          title={text.showSidebar}
          onClick={() => setPreferences((p) => ({ ...p, sidebarOpen: !p.sidebarOpen }))}
        >
          ☰
        </button>
        <div className="document-name" title={file.path ?? text.unsavedLocation}>
          {dirty && <span className="dirty-dot">●</span>}
          {file.name}
        </div>
        <nav className="file-actions" aria-label={text.fileActions}>
          <button onClick={newFile}>{text.new}</button>
          <button onClick={() => void openFile()}>{text.open}</button>
          <button onClick={() => void saveCurrent()}>{text.save}</button>
          <button onClick={() => void saveCurrent(true)}>{text.saveAs}</button>
          <button onClick={() => void renameFile()}>{text.rename}</button>
          <details ref={exportMenu} className="export-menu">
            <summary>{text.export}</summary>
            <div className="export-options" role="menu" aria-label={text.chooseExportFormat}>
              <button role="menuitem" onClick={() => void exportMarkdown()}>
                Markdown (.md)
              </button>
              <button role="menuitem" aria-busy={pdfExporting} disabled={pdfExporting} onClick={() => void exportPdf()}>
                PDF (.pdf)
              </button>
            </div>
          </details>
          <button
            className={sourceMode ? 'source-mode-button is-active' : 'source-mode-button'}
            onPointerDown={(event) => {
              if (event.button === 0) event.preventDefault();
            }}
            onClick={toggleSourceMode}
          >
            {sourceMode ? text.backToCanvas : text.showMarkdownSource}
          </button>
        </nav>
        <button
          className="icon-button search-button"
          type="button"
          aria-keyshortcuts="Meta+F Control+F"
          aria-label={text.findDocument}
          title={text.findShortcut}
          onClick={openSearch}
        >
          ⌕
        </button>
        <div className="topbar-spacer" />
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
            onBlur={commitFontSize}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setFontSizeInput(String(preferences.fontSize));
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
            onBlur={commitLineSpacing}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setLineSpacingInput(String(preferences.lineSpacing));
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
          className="icon-button"
          title={text.toggleTheme}
          onClick={() =>
            setPreferences((p) => ({
              ...p,
              theme: p.theme === 'light' ? 'dark' : 'light',
            }))
          }
        >
          {preferences.theme === 'light' ? '◐' : '◑'}
        </button>
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
        </form>
      )}
      <section className="workspace">
        {preferences.sidebarOpen && (
          <aside className="sidebar">
            <section className={preferences.recentFilesExpanded ? '' : 'recent-section--collapsed'}>
              <button
                type="button"
                className="sidebar-heading sidebar-section-toggle"
                aria-expanded={preferences.recentFilesExpanded}
                aria-controls="recent-files-panel"
                title={preferences.recentFilesExpanded ? text.collapseRecentFiles : text.expandRecentFiles}
                onClick={() =>
                  setPreferences((current) => ({
                    ...current,
                    recentFilesExpanded: !current.recentFilesExpanded,
                  }))
                }
              >
                <span className="sidebar-section-chevron" aria-hidden="true">
                  {preferences.recentFilesExpanded ? '▾' : '▸'}
                </span>
                {text.recentFiles}
              </button>
              {preferences.recentFilesExpanded && (
                <div id="recent-files-panel">
                  {recent.length === 0 ? (
                    <p className="muted">{text.noRecentFiles}</p>
                  ) : (
                    <ul className="recent-list">
                      {recent.map((item) => (
                        <li key={item.path}>
                          <button
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
                </div>
              )}
            </section>
            <section>
              <div className="sidebar-heading">{text.outline}</div>
              {outline.length === 0 ? (
                <p className="muted">{text.noHeadings}</p>
              ) : (
                <ol className="outline-list">
                  {outline.map((item, index) => (
                    <li
                      key={`${item.text}-${index}`}
                      style={{
                        paddingInlineStart: `${(item.level - 1) * 12}px`,
                      }}
                    >
                      <button type="button" title={item.text} onClick={() => jumpToOutline(index)}>
                        {item.text}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>
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
            <CanvasEditor
              ref={canvasSearch}
              language={preferences.language}
              documentId={documentId}
              initialDocument={file.document}
              outlineTarget={outlineTarget}
              onReady={canvasReady}
              onChange={(document) => {
                setFile((current) => {
                  const nextFile = { ...current, document };
                  fileRef.current = nextFile;
                  return nextFile;
                });
                markEdited();
              }}
            />
          </div>
          {sourceMode && (
            <div className="editor-mode-pane editor-mode-pane--source">
              <MarkdownSourceEditor
                ref={markdownSearch}
                language={preferences.language}
                value={rawMarkdown}
                onReady={sourceReady}
                onChange={(value) => {
                  rawMarkdownRef.current = value;
                  setRawMarkdown(value);
                  markEdited();
                }}
              />
            </div>
          )}
        </section>
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
      <footer className="statusbar">
        <span className={`save-status save-status--${saveStatus}`}>{text.saveStatus[saveStatus]}</span>
        <span>{text.metrics(metrics.words, metrics.characters)}</span>
        <span className="status-message">{message}</span>
        <span>{text.localFirst}</span>
      </footer>
    </main>
  );
}
