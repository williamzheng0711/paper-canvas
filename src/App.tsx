import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { JSONContent } from '@tiptap/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CanvasEditor, type InsertAction } from './components/CanvasEditor';
import { MarkdownSourceEditor } from './components/MarkdownSourceEditor';
import { documentsEqual } from './editor/documentSync';
import { collectOutline, documentToMarkdown, markdownToDocument } from './editor/markdown';
import { maximumFontSize, minimumFontSize, normalizeFontSize } from './lib/fontSize';
import {
  chooseMarkdownFile,
  clearDraft,
  documentToPortableMarkdown,
  exportMarkdownFile,
  loadDraft,
  loadPreferences,
  loadRecent,
  newEditorFile,
  openMarkdownFile,
  openRecent,
  renameEditorFile,
  saveEditorFile,
  saveDraft,
  savePreferences,
  type AppPreferences,
  type EditorFile,
  type RecentFile,
} from './lib/files';

type SaveStatus = 'saved' | 'saving' | 'draft' | 'error' | 'unsaved';

const actions: Array<{ action: InsertAction; label: string }> = [
  { action: 'heading', label: '標題' },
  { action: 'bulletList', label: '項目清單' },
  { action: 'orderedList', label: '編號清單' },
  { action: 'taskList', label: '待辦' },
  { action: 'quote', label: '引用' },
  { action: 'code', label: '程式碼' },
  { action: 'table', label: '表格' },
  { action: 'image', label: '圖片' },
  { action: 'inlineFormula', label: '行內公式' },
  { action: 'blockFormula', label: '區塊公式' },
];

function documentMetrics(document: JSONContent): { characters: number; words: number } {
  const walk = (node: JSONContent): string =>
    `${node.text ?? ''}${(node.content ?? []).map(walk).join('')}`;
  const text = walk(document).trim();
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const nonCjkWords = text
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return { characters: [...text].length, words: cjk + nonCjkWords };
}

function statusLabel(status: SaveStatus): string {
  return {
    saved: '已儲存',
    saving: '正在儲存…',
    draft: '草稿已自動保存',
    error: '儲存失敗',
    unsaved: '未儲存變更',
  }[status];
}

export default function App() {
  const [file, setFile] = useState<EditorFile>(newEditorFile);
  const [documentId, setDocumentId] = useState(0);
  const [editRevision, setEditRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [message, setMessage] = useState('所有內容僅保留在本機。');
  const [recent, setRecent] = useState<RecentFile[]>([]);
  const [sourceMode, setSourceMode] = useState(false);
  const [rawMarkdown, setRawMarkdown] = useState('');
  const [preferences, setPreferences] = useState<AppPreferences>({
    theme: 'light',
    font: 'system',
    fontSize: 18,
    sidebarOpen: true,
  });
  const [fontSizeInput, setFontSizeInput] = useState('18');
  const [insert, setInsert] = useState<(action: InsertAction) => void>(() => () => undefined);
  const saving = useRef(false);
  const fileRef = useRef(file);
  const dirtyRef = useRef(dirty);
  const editRevisionRef = useRef(editRevision);
  const documentSessionRef = useRef(0);
  const sourceModeRef = useRef(sourceMode);
  const rawMarkdownRef = useRef(rawMarkdown);
  const openedByOperatingSystem = useRef(false);
  const recentExternalOpen = useRef(new Map<string, number>());
  const exportMenu = useRef<HTMLDetailsElement>(null);
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

  const handleEditorReady = useCallback((nextInsert: (action: InsertAction) => void) => {
    // React treats a function passed directly to a state setter as an updater.
    // Wrap it so the editor action is stored, not run with the previous action.
    setInsert(() => nextInsert);
  }, []);

  useEffect(() => {
    void Promise.all([loadRecent(), loadPreferences(), loadDraft()])
      .then(([loadedRecent, loadedPreferences, draft]) => {
        if (!openedByOperatingSystem.current) setRecent(loadedRecent);
        setPreferences(loadedPreferences);
        setFontSizeInput(String(loadedPreferences.fontSize));
        if (draft && !openedByOperatingSystem.current) {
          fileRef.current = draft;
          setFile(draft);
          setDocumentId((id) => id + 1);
          documentSessionRef.current += 1;
          advanceRevision();
          dirtyRef.current = true;
          setDirty(true);
          setSaveStatus('draft');
          setMessage('已還原尚未指定位置的本機草稿。');
        }
      })
      .catch((error: unknown) =>
        setMessage(error instanceof Error ? error.message : '無法載入本機設定。'),
      );
  }, [advanceRevision]);

  useEffect(() => {
    void savePreferences(preferences);
  }, [preferences]);

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
      setMessage(`已開啟 ${nextFile.name}`);
    },
    [advanceRevision],
  );

  const replaceWithOpenedFile = useCallback(
    async (nextFile: EditorFile) => {
      if (
        dirtyRef.current &&
        fileRef.current.path !== nextFile.path &&
        !window.confirm('目前文件尚未儲存。要放棄變更並開啟另一份文件嗎？')
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
        setMessage(error instanceof Error ? error.message : '無法開啟外部文件。');
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
          ? { ...fileRef.current, document: markdownToDocument(rawMarkdownRef.current) }
          : fileRef.current;
        const saved = await saveEditorFile(candidate, shouldSaveAs);
        shouldSaveAs = false;

        if (documentSessionRef.current !== saveSession) return;
        if (editRevisionRef.current !== revision) {
          // Keep edits made while the asynchronous write was in flight. If
          // this was Save As, carry the new path into the next save pass.
          const latest = { ...fileRef.current, path: saved.path, name: saved.name };
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
        setMessage(`已儲存 ${saved.name}`);
        await clearDraft();
        setRecent(await loadRecent());
        return;
      }
    } catch (error) {
      if (documentSessionRef.current === saveSession) {
        setSaveStatus('error');
        setMessage(error instanceof Error ? error.message : '儲存失敗。');
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
        ? { ...fileRef.current, document: markdownToDocument(rawMarkdownRef.current) }
        : fileRef.current;
      void saveDraft(draft)
        .then(() => {
          if (documentSessionRef.current === session && editRevisionRef.current === revision) {
            setSaveStatus('draft');
          }
        })
        .catch((error: unknown) => {
          setSaveStatus('error');
          setMessage(error instanceof Error ? error.message : '無法自動保存草稿。');
        });
    }, 850);
    return () => window.clearTimeout(timer);
  }, [dirty, editRevision, saveCurrent]);

  const openFile = useCallback(async () => {
    try {
      const nextFile = await chooseMarkdownFile();
      if (nextFile) await replaceWithOpenedFile(nextFile);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '無法開啟文件。');
    }
  }, [replaceWithOpenedFile]);

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
          setMessage(error instanceof Error ? error.message : '無法接收系統開啟文件事件。');
        }
      }
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [openExternalMarkdownFiles]);

  const newFile = useCallback(() => {
    if (dirty && !window.confirm('目前文件尚未儲存。要放棄變更並建立新文件嗎？')) return;
    void clearDraft();
    loadFile(newEditorFile());
  }, [dirty, loadFile]);

  const renameFile = useCallback(async () => {
    const nextName = window.prompt('新檔名', fileRef.current.name);
    if (!nextName) return;
    try {
      const renamed = await renameEditorFile(fileRef.current, nextName);
      setFile(renamed);
      setMessage(`已重新命名為 ${renamed.name}`);
      setRecent(await loadRecent());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '重新命名失敗。');
    }
  }, []);

  const toggleSourceMode = () => {
    if (!sourceMode) {
      const markdown = documentToMarkdown(file.document);
      rawMarkdownRef.current = markdown;
      setRawMarkdown(markdown);
      sourceModeRef.current = true;
      setSourceMode(true);
      return;
    }
    try {
      const nextDocument = markdownToDocument(rawMarkdown);
      const nextFile = { ...fileRef.current, document: nextDocument };
      fileRef.current = nextFile;
      setFile(nextFile);
      setDocumentId((id) => id + 1);
      markEdited();
      sourceModeRef.current = false;
      setSourceMode(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Markdown 無法解析。');
    }
  };

  useEffect(() => {
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
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
  }, [newFile, openFile, saveCurrent]);

  const outline = useMemo(() => collectOutline(file.document), [file.document]);
  const metrics = useMemo(() => documentMetrics(file.document), [file.document]);

  const commitFontSize = () => {
    const fontSize = normalizeFontSize(fontSizeInput, preferences.fontSize);
    setFontSizeInput(String(fontSize));
    setPreferences((current) => ({ ...current, fontSize }));
  };

  const closeExportMenu = () => exportMenu.current?.removeAttribute('open');

  const exportMarkdown = useCallback(async () => {
    closeExportMenu();
    try {
      const markdown = sourceModeRef.current
        ? rawMarkdownRef.current
        : documentToPortableMarkdown(fileRef.current.document);
      const exportedName = await exportMarkdownFile(markdown, fileRef.current.name);
      if (exportedName) setMessage(`已導出 ${exportedName}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Markdown 導出失敗。');
    }
  }, []);

  const exportPdf = useCallback(async () => {
    closeExportMenu();
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
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
      setMessage('請在系統列印對話框選擇「儲存為 PDF」。');
      // Tauri replaces window.print() with an asynchronous native command on
      // macOS. Await it so capability or native print failures reach this
      // handler instead of becoming an unhandled rejected promise.
      await Promise.resolve(window.print());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'PDF 導出失敗。');
    }
  }, []);

  return (
    <main className={`app-shell theme-${preferences.theme} font-${preferences.font}`}>
      <header className="topbar">
        <button
          className="icon-button"
          title="顯示／隱藏側欄"
          onClick={() => setPreferences((p) => ({ ...p, sidebarOpen: !p.sidebarOpen }))}
        >
          ☰
        </button>
        <div className="document-name" title={file.path ?? '尚未儲存'}>
          {dirty && <span className="dirty-dot">●</span>}
          {file.name}
        </div>
        <nav className="file-actions" aria-label="文件操作">
          <button onClick={newFile}>新增</button>
          <button onClick={() => void openFile()}>開啟</button>
          <button onClick={() => void saveCurrent()}>儲存</button>
          <button onClick={() => void saveCurrent(true)}>另存</button>
          <button onClick={() => void renameFile()}>重新命名</button>
          <details ref={exportMenu} className="export-menu">
            <summary>導出</summary>
            <div className="export-options" role="menu" aria-label="選擇導出格式">
              <button role="menuitem" onClick={() => void exportMarkdown()}>
                Markdown (.md)
              </button>
              <button role="menuitem" onClick={() => void exportPdf()}>
                PDF (.pdf)
              </button>
            </div>
          </details>
        </nav>
        <div className="topbar-spacer" />
        <label className="compact-control">
          字體{' '}
          <select
            value={preferences.font}
            onChange={(event) =>
              setPreferences((p) => ({ ...p, font: event.target.value as AppPreferences['font'] }))
            }
          >
            <option value="system">系統</option>
            <option value="serif">襯線</option>
            <option value="mono">等寬</option>
          </select>
        </label>
        <label className="compact-control">
          大小
          <input
            aria-label="字級"
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
        <button
          className="icon-button"
          title="切換淺色／深色"
          onClick={() =>
            setPreferences((p) => ({ ...p, theme: p.theme === 'light' ? 'dark' : 'light' }))
          }
        >
          {preferences.theme === 'light' ? '◐' : '◑'}
        </button>
      </header>
      <div className="toolbar" aria-label="插入內容">
        {actions.map(({ action, label }) => (
          <button key={action} onClick={() => insert(action)}>
            {label}
          </button>
        ))}
        <span className="toolbar-separator" />
        <button className={sourceMode ? 'is-active' : ''} onClick={toggleSourceMode}>
          {sourceMode ? '返回畫布' : '顯示原始 Markdown'}
        </button>
      </div>
      <section className="workspace">
        {preferences.sidebarOpen && (
          <aside className="sidebar">
            <section>
              <div className="sidebar-heading">最近文件</div>
              {recent.length === 0 ? (
                <p className="muted">尚未有最近文件</p>
              ) : (
                <ul className="recent-list">
                  {recent.map((item) => (
                    <li key={item.path}>
                      <button
                        title={item.path}
                        onClick={() =>
                          void openRecent(item)
                            .then(loadFile)
                            .catch((error: unknown) =>
                              setMessage(
                                error instanceof Error ? error.message : '無法開啟最近文件。',
                              ),
                            )
                        }
                      >
                        {item.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section>
              <div className="sidebar-heading">大綱</div>
              {outline.length === 0 ? (
                <p className="muted">文件尚無標題</p>
              ) : (
                <ol className="outline-list">
                  {outline.map((item, index) => (
                    <li
                      key={`${item.text}-${index}`}
                      style={{ paddingInlineStart: `${(item.level - 1) * 12}px` }}
                    >
                      {item.text}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </aside>
        )}
        <section
          className="canvas-area"
          style={{ '--editor-size': `${preferences.fontSize}px` } as React.CSSProperties}
        >
          {sourceMode ? (
            <MarkdownSourceEditor
              value={rawMarkdown}
              onChange={(value) => {
                rawMarkdownRef.current = value;
                setRawMarkdown(value);
                markEdited();
              }}
            />
          ) : (
            <CanvasEditor
              documentId={documentId}
              initialDocument={file.document}
              onChange={(document) => {
                setFile((current) => {
                  const nextFile = { ...current, document };
                  fileRef.current = nextFile;
                  return nextFile;
                });
                markEdited();
              }}
              onReady={handleEditorReady}
            />
          )}
        </section>
      </section>
      <footer className="statusbar">
        <span className={`save-status save-status--${saveStatus}`}>{statusLabel(saveStatus)}</span>
        <span>
          {metrics.words.toLocaleString()} 詞 · {metrics.characters.toLocaleString()} 字元
        </span>
        <span className="status-message">{message}</span>
        <span>本機優先 · 不傳送內容到網絡</span>
      </footer>
    </main>
  );
}
