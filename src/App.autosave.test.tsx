import type { JSONContent } from '@tiptap/core';
import { act, StrictMode, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { createMarkdownComment, parseMarkdownComments, relocateMarkdownComments, serializeMarkdownWithComments, type CommentPlacement, type MarkdownComment } from './editor/comments';
import { documentToMarkdown, markdownToDocument } from './editor/markdown';
import type { SearchResult, SwitchableEditorHandle } from './editor/search';
import type { EditorFile } from './lib/files';
import type * as FileLibrary from './lib/files';
import { FileRenameRecoveryError, rebaseEditorFileAssets } from './lib/files';
import { getMessages } from './i18n';

type CanvasProps = {
  documentId: number;
  initialDocument: JSONContent;
  comments: readonly MarkdownComment[];
  outlineTarget?: { index: number; request: number };
  onChange: (document: JSONContent) => void;
  onEdit?: () => void;
  canUndoComment?: boolean;
  canRedoComment?: boolean;
  onUndoComment?: () => void;
  onRedoComment?: () => void;
  onCommentRequest?: (placement: CommentPlacement, coordinates: { x: number; y: number }) => void;
};

type SourceProps = {
  value: string;
  valueRevision: number;
  assetSourcePath?: string;
  assetSourceOperation?: 'rebase' | 'rename';
  assetSourceTransition?: { oldPath: string; newPath: string; operation: 'rebase' | 'rename' };
  onChange: (value: string) => void;
};

const harness = vi.hoisted(() => ({
  canvasProps: null as CanvasProps | null,
  sourceProps: null as SourceProps | null,
  canvasMounts: 0,
  canvasUnmounts: 0,
  sourceMounts: 0,
  sourceUnmounts: 0,
  searchHandle: {
    search: vi.fn<(query: string, direction: 'reset' | 'next' | 'previous' | 'refresh') => SearchResult>(
      () => ({ current: 0, total: 0 }),
    ),
    clearSearch: vi.fn(),
    focus: vi.fn(),
    getSelectedText: vi.fn(() => ''),
    getSelectionProgress: vi.fn(() => 0.5),
    getSelectionViewportOffset: vi.fn<() => number | undefined>(() => undefined),
    setSelectionProgress: vi.fn(),
    getMarkdownSelection: vi.fn<() => { markdown: string; offset: number } | undefined>(() => undefined),
    getMarkdownOffset: vi.fn<() => number | undefined>(() => undefined),
    setMarkdownOffset: vi.fn(() => true),
    setMarkdownSelection: vi.fn(),
    setDocumentSelection: vi.fn(() => true),
    isFocused: vi.fn(() => false),
    requestMeasure: vi.fn(),
    flushCommentMapping: vi.fn(),
    waitForPendingImages: vi.fn<() => Promise<void> | undefined>(() => undefined),
    getDocument: vi.fn<() => JSONContent | undefined>(() => undefined),
  },
}));

const files = vi.hoisted(() => ({
  allowDocumentImageFiles: vi.fn<(file: EditorFile) => Promise<void>>(async () => undefined),
  chooseMarkdownFile: vi.fn(async () => null as { name: string; document: JSONContent; path?: string } | null),
  clearDraft: vi.fn(async () => undefined),
  exportMarkdownFile: vi.fn(async () => 'research.md'),
  exportPdfFile: vi.fn<typeof FileLibrary.exportPdfFile>(async () => ({
    type: 'saved' as const,
    name: 'research.pdf',
  })),
  flushSettings: vi.fn<() => Promise<void>>(async () => undefined),
  loadDraft: vi.fn(),
  loadPreferences: vi.fn<() => Promise<FileLibrary.AppPreferences>>(async () => ({
    theme: 'light' as const,
    font: 'system' as const,
    fontSize: 18,
    lineSpacing: 1.78,
    sidebarOpen: true,
    recentFilesExpanded: true,
    language: 'zh-Hant' as const,
  })),
  hideRecentFile: vi.fn(async () => []),
  loadRecent: vi.fn(async () => [{ path: '/tmp/recent.md', name: 'recent.md' }]),
  openRecent: vi.fn(async (): Promise<EditorFile | null> => ({
    path: '/tmp/recent.md',
    name: 'recent.md',
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
  })),
  removeRecentFile: vi.fn(async () => []),
  revealFileInFolder: vi.fn(async () => undefined),
  renameEditorFile: vi.fn(async (file: EditorFile): Promise<EditorFile> => ({ ...file, name: 'renamed.md', path: '/tmp/renamed.md' })),
  saveEditorFile: vi.fn(),
  saveDraft: vi.fn<typeof FileLibrary.saveDraft>(async () => undefined),
  savePreferences: vi.fn<(preferences: FileLibrary.AppPreferences) => Promise<void>>(async () => undefined),
}));

const native = vi.hoisted(() => ({
  enabled: false,
  onCloseRequested: vi.fn(),
  destroy: vi.fn(async () => undefined),
  setTitle: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => native.enabled,
  invoke: vi.fn(async () => []),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => native }));
vi.mock('./components/CanvasEditor', () => ({
  CanvasEditor: (
    props: CanvasProps & {
      ref?: React.Ref<SwitchableEditorHandle>;
      onReady?: () => void;
    },
  ) => {
    const { onReady } = props;
    harness.canvasProps = props;
    if (typeof props.ref === 'function') props.ref(harness.searchHandle);
    if (props.ref && typeof props.ref === 'object') props.ref.current = harness.searchHandle;
    useEffect(() => {
      harness.canvasMounts += 1;
      onReady?.();
      return () => {
        harness.canvasUnmounts += 1;
      };
    }, [onReady]);
    return null;
  },
}));
vi.mock('./components/MarkdownSourceEditor', () => ({
  MarkdownSourceEditor: (
    props: SourceProps & { ref?: React.Ref<SwitchableEditorHandle>; onReady?: () => void },
  ) => {
    const { onReady } = props;
    harness.sourceProps = props;
    if (typeof props.ref === 'function') props.ref(harness.searchHandle);
    if (props.ref && typeof props.ref === 'object') props.ref.current = harness.searchHandle;
    useEffect(() => {
      harness.sourceMounts += 1;
      return () => { harness.sourceUnmounts += 1; };
    }, []);
    useEffect(() => {
      onReady?.();
    }, [onReady]);
    return null;
  },
}));
vi.mock('./lib/files', async (importOriginal) => {
  const actual = await importOriginal<typeof FileLibrary>();
  return {
  allowDocumentImageFiles: files.allowDocumentImageFiles,
  chooseMarkdownFile: files.chooseMarkdownFile,
  clearDraft: files.clearDraft,
  confirmDiscardChanges: actual.confirmDiscardChanges,
  documentToPortableMarkdown: (document: JSONContent, comments: readonly MarkdownComment[] = []) => {
    return serializeMarkdownWithComments(documentToMarkdown(document), comments);
  },
  exportMarkdownFile: files.exportMarkdownFile,
  exportPdfFile: files.exportPdfFile,
  flushSettings: files.flushSettings,
  FileRenameRecoveryError: actual.FileRenameRecoveryError,
  fileAssetSourcePath: actual.fileAssetSourcePath,
  hideRecentFile: files.hideRecentFile,
  hydrateDocumentAssets: (document: JSONContent) => structuredClone(document),
  loadDraft: files.loadDraft,
  loadPreferences: files.loadPreferences,
  loadRecent: files.loadRecent,
  newEditorFile: () => ({
    name: 'Untitled.md',
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
  }),
  openMarkdownFile: vi.fn(),
  openRecent: files.openRecent,
  rebaseEditorFileAssets: actual.rebaseEditorFileAssets,
  removeRecentFile: files.removeRecentFile,
  revealFileInFolder: files.revealFileInFolder,
  renameEditorFile: files.renameEditorFile,
  renameDocumentAssetReferences: actual.renameDocumentAssetReferences,
  saveDraft: files.saveDraft,
  saveEditorFile: files.saveEditorFile,
  savePreferences: files.savePreferences,
  validateDocumentUnicode: actual.validateDocumentUnicode,
  };
});

const savedDocument: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '原始內容' }] }],
};

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('App autosave cursor stability', () => {
  let root: Root;
  let host: HTMLDivElement;

  function namedButton(name: string, scope: ParentNode = host): HTMLButtonElement {
    const button = Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name,
    );
    if (!button) throw new Error(`Expected an accessible button named ${name}`);
    return button;
  }

  function revealDetails(selector: string): HTMLDetailsElement {
    const details = host.querySelector<HTMLDetailsElement>(selector);
    if (!details) throw new Error(`Expected ${selector} disclosure`);
    if (!details.open) details.querySelector<HTMLElement>(':scope > summary')?.click();
    expect(details.open).toBe(true);
    return details;
  }

  function documentAction(name: string): HTMLButtonElement {
    const details = revealDetails('details.document-actions');
    const navigation = details.querySelector<HTMLElement>('nav[aria-label]');
    if (!navigation) throw new Error('Expected document actions navigation');
    return namedButton(name, navigation);
  }

  async function startNative(draft?: EditorFile) {
    await act(async () => root.unmount());
    native.enabled = true;
    if (draft) files.loadDraft.mockResolvedValueOnce(draft);
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    const handler = native.onCloseRequested.mock.calls.at(-1)?.[0] as
      ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
    if (!handler) throw new Error('Expected the native close handler');
    return handler;
  }

  async function submitRename(name = 'renamed.md'): Promise<void> {
    await act(async () => { documentAction(getMessages().rename).click(); await flushEffects(); });
    const input = host.querySelector<HTMLInputElement>('.rename-form input[name="filename"]');
    if (!input?.form) throw new Error('Expected the filename form');
    input.value = name;
    await act(async () => {
      input.form?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
      await flushEffects();
    });
  }

  function exportAction(name: string): HTMLButtonElement {
    revealDetails('details.document-actions');
    const menu = revealDetails('details.export-menu').querySelector<HTMLElement>('[role="menu"]');
    if (!menu) throw new Error('Expected export format menu');
    return namedButton(name, menu);
  }

  function readingModeButton(mode: 'canvas' | 'source'): HTMLButtonElement {
    const text = getMessages();
    return namedButton(mode === 'canvas' ? text.backToCanvas : text.showMarkdownSource);
  }

  function toggleReadingModeButton(): HTMLButtonElement {
    const canvasHidden = host.querySelector('.editor-mode-pane--canvas')?.hasAttribute('hidden');
    return readingModeButton(canvasHidden ? 'canvas' : 'source');
  }

  async function showNavigationTab(name: string): Promise<void> {
    const tab = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (candidate) => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name,
    );
    if (!tab) throw new Error(`Expected navigation tab ${name}`);
    await act(async () => {
      if (tab.getAttribute('aria-selected') !== 'true') tab.click();
      await flushEffects();
    });
    expect(tab.getAttribute('aria-selected')).toBe('true');
  }

  async function recentFileButton(): Promise<HTMLButtonElement> {
    await showNavigationTab(getMessages().recentFiles);
    const button = host.querySelector<HTMLButtonElement>('.recent-list button');
    if (!button) throw new Error('Expected an accessible recent file');
    expect(button.closest('[hidden]')).toBeNull();
    return button;
  }

  beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
  afterAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false }));

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    native.enabled = false;
    native.onCloseRequested.mockResolvedValue(() => undefined);
    files.flushSettings.mockReset().mockResolvedValue(undefined);
    harness.canvasProps = null;
    harness.sourceProps = null;
    harness.canvasMounts = 0;
    harness.canvasUnmounts = 0;
    harness.sourceMounts = 0;
    harness.sourceUnmounts = 0;
    let activeSearchResult = 0;
    harness.searchHandle.search.mockImplementation((query, direction) => {
      if (!query) return { current: 0, total: 0 };
      if (direction === 'next') activeSearchResult = (activeSearchResult % 3) + 1;
      else if (direction === 'previous') activeSearchResult = ((activeSearchResult + 1) % 3) + 1;
      else activeSearchResult = 1;
      return { current: activeSearchResult, total: 3 };
    });
    harness.searchHandle.getSelectedText.mockReturnValue('');
    harness.searchHandle.getDocument.mockReturnValue(undefined);
    harness.searchHandle.flushCommentMapping.mockReset();
    harness.searchHandle.waitForPendingImages.mockReset().mockReturnValue(undefined);
    harness.searchHandle.getSelectionProgress.mockReturnValue(0.5);
    harness.searchHandle.getSelectionViewportOffset.mockReturnValue(undefined);
    harness.searchHandle.getMarkdownSelection.mockReturnValue(undefined);
    harness.searchHandle.getMarkdownOffset.mockReturnValue(undefined);
    harness.searchHandle.setMarkdownOffset.mockReturnValue(true);
    harness.searchHandle.setDocumentSelection.mockReturnValue(true);
    harness.searchHandle.isFocused.mockReturnValue(false);
    files.loadDraft.mockResolvedValue({
      path: '/tmp/research.md',
      name: 'research.md',
      document: structuredClone(savedDocument),
    });
    files.saveEditorFile.mockImplementation(async (file) => structuredClone(file));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<App />);
      await flushEffects();
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('loads startup data once through StrictMode effect replay', async () => {
    await act(async () => root.unmount());
    files.loadDraft.mockClear();
    files.loadPreferences.mockClear();
    files.loadRecent.mockClear();
    root = createRoot(host);
    await act(async () => {
      root.render(<StrictMode><App /></StrictMode>);
      await flushEffects();
    });
    expect(files.loadDraft).toHaveBeenCalledOnce();
    expect(files.loadPreferences).toHaveBeenCalledOnce();
    expect(files.loadRecent).toHaveBeenCalledOnce();
    expect(harness.canvasProps?.initialDocument).toEqual(savedDocument);
  });

  it('keeps a visible source pane when a late startup draft replaces the document session', async () => {
    await act(async () => root.unmount());
    let restore!: (draft: EditorFile) => void;
    files.loadDraft.mockImplementationOnce(() => new Promise<EditorFile>((resolve) => { restore = resolve; }));
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    await act(async () => { readingModeButton('source').click(); await flushEffects(); });
    const sourceMarkdown = '# Restored\r\n\r\nExact bytes\n';
    await act(async () => { restore({ name: 'Recovered.md', sourceMarkdown, document: markdownToDocument(sourceMarkdown) }); await flushEffects(); });
    expect(host.querySelector('.editor-mode-pane--source')?.hasAttribute('hidden')).toBe(false);
    expect(harness.sourceProps?.value).toBe(sourceMarkdown);
    expect(harness.sourceMounts).toBe(2);
    expect(harness.sourceUnmounts).toBe(1);
  });

  it.each(['history', 'preferences'] as const)('recovers available writing when startup %s is unavailable', async (unavailable) => {
    await act(async () => root.unmount());
    const failure = new Error(`${unavailable} unavailable`);
    if (unavailable === 'history') files.loadRecent.mockRejectedValueOnce(failure);
    else files.loadPreferences.mockRejectedValueOnce(failure);
    files.savePreferences.mockClear();
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    expect(harness.canvasProps?.initialDocument).toEqual(savedDocument);
    expect(host.querySelector('.status-message')?.textContent).toContain(failure.message);
    expect(host.querySelector('.dirty-dot')).not.toBeNull();
    if (unavailable === 'preferences') expect(files.savePreferences).not.toHaveBeenCalled();
  });

  it('shows a recovery warning while retaining available writing', async () => {
    await act(async () => root.unmount());
    files.loadDraft.mockResolvedValueOnce({ name: 'Recovered.md', document: savedDocument, comments: [], commentWarning: 'Damaged comments preserved for recovery' });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    expect(harness.canvasProps?.initialDocument).toEqual(savedDocument);
    expect(host.querySelector('.status-message')?.textContent).toBe('Damaged comments preserved for recovery');
  });

  it('opens an oversized recovery draft in source without mounting its large canvas or losing exact bytes', async () => {
    await act(async () => root.unmount());
    const sourceMarkdown = '\ufeff# Large recovery 中文\r\n\r\n' + 'Retained writing.\r\n\r\n'.repeat(5_100);
    const large = markdownToDocument(sourceMarkdown);
    files.loadDraft.mockResolvedValueOnce({ name: 'Large.md', document: large, sourceMarkdown });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    expect(harness.sourceProps?.value).toBe(sourceMarkdown);
    expect(harness.canvasProps?.initialDocument).not.toEqual(large);
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.status-message')?.textContent).toBe(getMessages().canvasViewLimited);
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    expect(harness.sourceProps?.value).toBe(sourceMarkdown);
    await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
    const [saved, forceDialog, sourceOverride] = files.saveEditorFile.mock.calls.at(-1)!;
    expect(saved.sourceMarkdown).toBe(sourceMarkdown);
    expect(saved.document).toEqual(large);
    expect(forceDialog).toBe(false);
    expect(sourceOverride).toBe(sourceMarkdown);
  });

  it('returns an oversized source document to canvas after its content is reduced', async () => {
    await act(async () => root.unmount());
    const sourceMarkdown = 'Retained writing.\n\n'.repeat(5_100);
    files.loadDraft.mockResolvedValueOnce({ name: 'Large.md', document: markdownToDocument(sourceMarkdown), sourceMarkdown });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    await act(async () => { harness.sourceProps?.onChange('# Smaller\r\n\r\nRetained writing.\r\n'); });
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    expect(readingModeButton('canvas').getAttribute('aria-pressed')).toBe('true');
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument('# Smaller\r\n\r\nRetained writing.\r\n'));
  });

  it('recovers excessive point comments in exact Source mode without dropping metadata', async () => {
    const body = 'Exact writing 中文 🧪\r\n';
    const base = createMarkdownComment(body, { kind: 'position', offset: 0 }, 'Note', '', 'base');
    const comments = Array.from({ length: 4_000 }, (_, index) => ({ ...base, id: `point-${index}` }));
    const sourceMarkdown = serializeMarkdownWithComments(body, comments);
    await act(async () => root.unmount());
    files.loadDraft.mockResolvedValueOnce({ name: 'Comments.md', document: markdownToDocument(body), comments, sourceMarkdown });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    expect(harness.sourceProps?.value).toBe(sourceMarkdown);
    expect(parseMarkdownComments(harness.sourceProps!.value).comments).toHaveLength(4_000);
    expect(host.querySelectorAll('.comment-card')).toHaveLength(100);
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    expect(harness.sourceProps?.value).toBe(sourceMarkdown);
    expect(host.querySelector('.status-message')?.textContent).toBe(getMessages().canvasViewLimited);
  });

  it('preserves a newly created point comment by switching to Source when its DOM crosses capacity', async () => {
    const body = 'x\n';
    const base = createMarkdownComment(body, { kind: 'position', offset: 0 }, 'Note', '', 'base');
    const comments = Array.from({ length: 3_332 }, (_, index) => ({ ...base, id: `point-${index}` }));
    await act(async () => root.unmount());
    files.loadDraft.mockResolvedValueOnce({ name: 'Comments.md', document: markdownToDocument(body), comments });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    expect(readingModeButton('canvas').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { harness.canvasProps?.onCommentRequest?.({ target: { kind: 'position', offset: 0 } }, { x: 0, y: 0 }); });
    await act(async () => namedButton(getMessages().commentNew).click());
    const input = host.querySelector<HTMLTextAreaElement>('.comment-composer textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Newest 中文 🧪 note');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.form!.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })));
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    const saved = parseMarkdownComments(harness.sourceProps!.value);
    expect(saved.body).toBe(body);
    expect(saved.comments).toHaveLength(3_333);
    expect(saved.comments.at(-1)?.content).toBe('Newest 中文 🧪 note');
    expect(saved.comments.slice(0, -1).map((comment) => comment.id)).toEqual(comments.map((comment) => comment.id));
  });

  it('shows a bounded outline notice while retaining the entire oversized source', async () => {
    const sourceMarkdown = Array.from({ length: 600 }, (_, index) => `# Heading ${index}\n\n${'x'.repeat(600)}\n\n`).join('');
    await act(async () => root.unmount());
    files.loadDraft.mockResolvedValueOnce({ name: 'Many headings.md', document: markdownToDocument(sourceMarkdown), sourceMarkdown });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); await vi.advanceTimersByTimeAsync(300); });
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelectorAll('.outline-list button')).toHaveLength(500);
    expect(host.querySelector('#outline-panel [role="status"]')?.textContent).toBe(getMessages().outlineLimited);
    expect(harness.sourceProps?.value).toBe(sourceMarkdown);
    expect(host.querySelector('.statusbar')?.textContent).toContain(getMessages().metrics(2_400, sourceMarkdown.replace(/[\r\n]/g, '').trim().length));
  });

  it('keeps a newly oversized source edit intact when canvas, outline, or PDF is requested', async () => {
    await act(async () => { readingModeButton('source').click(); await flushEffects(); });
    const sourceMarkdown = '# Large heading\r\n\r\n' + 'Retained writing.\r\n\r\n'.repeat(5_100);
    await act(async () => { harness.sourceProps?.onChange(sourceMarkdown); });
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    expect(harness.sourceProps?.value).toBe(sourceMarkdown);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); await flushEffects(); });
    const heading = Array.from(host.querySelectorAll<HTMLButtonElement>('.outline-list button'))
      .find((button) => button.textContent === 'Large heading');
    expect(heading).toBeDefined();
    await act(async () => { heading!.click(); await flushEffects(); });
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    await act(async () => { exportAction('PDF (.pdf)').click(); await flushEffects(); });
    expect(files.exportPdfFile).not.toHaveBeenCalled();
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    expect(harness.sourceProps?.value).toBe(sourceMarkdown);
    expect(host.querySelector('.status-message')?.textContent).toBe(getMessages().canvasViewLimited);
  });

  it('opens an oversized file directly in source while preserving the original bytes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const sourceMarkdown = '\ufeff# Opened large file\r\n\r\n' + 'Retained writing.\r\n\r\n'.repeat(5_100);
      files.openRecent.mockResolvedValueOnce({
        name: 'large.md', path: '/tmp/large.md', document: markdownToDocument(sourceMarkdown), sourceMarkdown,
      });
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
      expect(harness.sourceProps?.value).toBe(sourceMarkdown);
      expect(host.querySelector('.status-message')?.textContent).toBe(getMessages().canvasViewLimited);
      await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
      expect(files.saveEditorFile.mock.calls.at(-1)?.[2]).toBe(sourceMarkdown);
    } finally {
      confirm.mockRestore();
    }
  });

  it('retains an unread preferences file until the user explicitly changes a setting', async () => {
    await act(async () => root.unmount());
    files.loadPreferences.mockRejectedValueOnce(new Error('preferences unavailable'));
    files.savePreferences.mockClear();
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    expect(files.savePreferences).not.toHaveBeenCalled();
    const font = host.querySelector<HTMLSelectElement>('.typography-popover select');
    expect(font).not.toBeNull();
    await act(async () => {
      font!.value = 'mono';
      font!.dispatchEvent(new Event('change', { bubbles: true }));
      await flushEffects();
    });
    expect(files.savePreferences).toHaveBeenCalledWith(expect.objectContaining({ font: 'mono' }));
  });

  it('reports inaccessible recovery data while retaining successfully loaded preferences and history', async () => {
    await act(async () => root.unmount());
    files.loadDraft.mockRejectedValueOnce(new Error('Recovery data could not be read'));
    files.loadRecent.mockResolvedValueOnce([{ path: '/tmp/available.md', name: 'available.md' }]);
    files.loadPreferences.mockResolvedValueOnce({
      theme: 'light', font: 'mono', fontSize: 15, lineSpacing: 1.62,
      sidebarOpen: true, recentFilesExpanded: true, language: 'zh-Hant',
    });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    expect(host.querySelector('.status-message')?.textContent).toBe('Recovery data could not be read');
    expect(host.querySelector<HTMLSelectElement>('.typography-popover select')?.value).toBe('mono');
  });

  it('saves typing before the autosave delay when the native window closes', async () => {
    const close = await startNative();
    const latest = markdownToDocument('# Last keystroke 中文 🧪');
    await act(async () => { harness.canvasProps?.onChange(latest); });
    expect(files.saveEditorFile).not.toHaveBeenCalled();
    const preventDefault = vi.fn();
    await act(async () => { await close({ preventDefault }); });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(files.saveEditorFile).toHaveBeenCalledWith(expect.objectContaining({ document: latest }), false);
    expect(files.flushSettings).toHaveBeenCalled();
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it('writes the exact unnamed source draft and flushes disk settings before closing', async () => {
    const close = await startNative({ name: 'Unnamed.md', document: markdownToDocument('old') });
    await act(async () => { readingModeButton('source').click(); await flushEffects(); });
    const markdown = '# 最後\r\n\r\n<!-- retained -->\r\n';
    await act(async () => { harness.sourceProps?.onChange(markdown); });
    let finishFlush!: () => void;
    files.flushSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    let closing!: Promise<void>;
    await act(async () => { closing = close({ preventDefault: vi.fn() }); await flushEffects(); });
    expect(files.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ sourceMarkdown: markdown }));
    expect(native.destroy).not.toHaveBeenCalled();
    await act(async () => { finishFlush(); await closing; });
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it.each(['document', 'settings'] as const)('keeps the native window open after a failed %s close write', async (failure) => {
    const close = await startNative();
    await act(async () => { harness.canvasProps?.onChange(markdownToDocument('unsaved')); });
    if (failure === 'document') files.saveEditorFile.mockRejectedValueOnce(new Error('Disk full'));
    else files.flushSettings.mockRejectedValueOnce(new Error('Disk full'));
    await act(async () => { await close({ preventDefault: vi.fn() }); });
    expect(native.destroy).not.toHaveBeenCalled();
    expect(host.querySelector('.save-status')?.textContent).toBe(getMessages().saveStatus.error);
    expect(host.querySelector('.status-message')?.textContent).toContain('Disk full');
  });

  it('saves new typing that arrives while the native close flush is pending', async () => {
    const close = await startNative();
    let finishFlush!: () => void;
    files.flushSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    let closing!: Promise<void>;
    await act(async () => { closing = close({ preventDefault: vi.fn() }); await flushEffects(); });
    const latest = markdownToDocument('Typed during close');
    await act(async () => { harness.canvasProps?.onChange(latest); });
    await act(async () => { finishFlush(); await closing; });
    expect(files.saveEditorFile.mock.calls.at(-1)?.[0].document).toEqual(latest);
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it('coalesces repeated native close requests while a save is pending', async () => {
    const close = await startNative();
    let finishSave!: (file: EditorFile) => void;
    files.saveEditorFile.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    let closing!: Promise<void>;
    await act(async () => { closing = close({ preventDefault: vi.fn() }); await flushEffects(); });
    await act(async () => { await close({ preventDefault: vi.fn() }); });
    expect(files.saveEditorFile).toHaveBeenCalledOnce();
    await act(async () => { finishSave(files.saveEditorFile.mock.calls[0][0]); await closing; });
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it('does not close a replacement document while an older close save finishes', async () => {
    const close = await startNative();
    let finishFlush!: () => void;
    files.flushSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFlush = resolve; }));
    let closing!: Promise<void>;
    await act(async () => { closing = close({ preventDefault: vi.fn() }); await flushEffects(); });
    await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
    await act(async () => { finishFlush(); await closing; });
    expect(native.destroy).not.toHaveBeenCalled();
    expect(host.querySelector('.document-name')?.textContent).toBe('Untitled.md');
  });

  it('guards browser unload while edits are unsaved and releases it after saving', async () => {
    const beforeSave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(beforeSave);
    expect(beforeSave.defaultPrevented).toBe(true);
    await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
    const afterSave = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(afterSave);
    expect(afterSave.defaultPrevented).toBe(false);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('ignores document shortcuts during IME composition (%j)', async (composition) => {
    await act(async () => {
      for (const key of ['s', 'o', 'n', 'f']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, ...composition }));
      }
      await flushEffects();
    });
    expect(files.saveEditorFile).not.toHaveBeenCalled();
    expect(files.chooseMarkdownFile).not.toHaveBeenCalled();
    expect(host.querySelector('.document-search')).toBeNull();
    expect(host.querySelector('.document-name')?.textContent).toContain('research.md');
  });

  it('keeps document actions, reading settings, and navigation usable without dirtying the file', async () => {
    const actions = host.querySelector<HTMLDetailsElement>('details.document-actions');
    const settings = host.querySelector<HTMLDetailsElement>('details.reading-settings');
    expect(actions?.open).toBe(false);
    expect(settings?.open).toBe(false);

    await act(async () => {
      documentAction(getMessages().save).click();
      await flushEffects();
    });
    files.saveEditorFile.mockClear();
    files.saveDraft.mockClear();
    const initialDocumentId = harness.canvasProps?.documentId;
    expect(host.querySelector('.dirty-dot')).toBeNull();

    await act(async () => {
      if (actions?.open) actions.querySelector<HTMLElement>(':scope > summary')?.click();
      revealDetails('details.document-actions');
      revealDetails('details.reading-settings');
      exportAction('Markdown (.md)');
      exportAction('PDF (.pdf)');
      readingModeButton('canvas').click();
      await flushEffects();
    });
    const text = getMessages();
    const font = Array.from(settings?.querySelectorAll('label') ?? [])
      .find((label) => label.textContent?.trim().startsWith(text.font))
      ?.querySelector<HTMLSelectElement>('select');
    expect(Array.from(font?.options ?? []).map((option) => option.value)).toEqual(['system', 'serif', 'mono']);
    expect(settings?.querySelector(`input[aria-label="${text.fontSize}"]`)).not.toBeNull();
    expect(settings?.querySelector(`input[aria-label="${text.lineSpacing}"]`)).not.toBeNull();
    expect(settings?.querySelector(`select[aria-label="${text.language}"]`)).not.toBeNull();
    expect(readingModeButton('canvas').closest('[role="group"]')).not.toBeNull();
    expect(readingModeButton('canvas').getAttribute('aria-pressed')).toBe('true');
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('false');

    await showNavigationTab(text.recentFiles);
    await showNavigationTab(text.outline);
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); await flushEffects(); });
    expect(host.querySelector('.dirty-dot')).toBeNull();
    expect(harness.canvasProps?.documentId).toBe(initialDocumentId);
    expect(files.saveEditorFile).not.toHaveBeenCalled();
    expect(files.saveDraft).not.toHaveBeenCalled();
  });

  it('handles failed reading-settings persistence while keeping the current setting usable', async () => {
    await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
    files.savePreferences.mockRejectedValueOnce(new Error('Cannot save reading settings'));
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`button[aria-label="${getMessages().toggleTheme}"]`)!.click();
      await flushEffects();
    });
    expect(host.querySelector('.theme-dark')).not.toBeNull();
    expect(host.querySelector('.status-message')?.textContent).toBe('Cannot save reading settings');
    expect(host.querySelector('.dirty-dot')).toBeNull();
  });

  it('ignores a reading-settings error after a newer setting replaces it', async () => {
    let failOldSetting!: () => void;
    files.savePreferences.mockImplementationOnce(() => new Promise((_, reject) => { failOldSetting = () => reject(new Error('Stale setting failure')); }));
    const toggleTheme = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${getMessages().toggleTheme}"]`)!.click();
    await act(async () => { toggleTheme(); await flushEffects(); });
    await act(async () => { toggleTheme(); await flushEffects(); });
    await act(async () => { failOldSetting(); await flushEffects(); });
    expect(host.querySelector('.theme-light')).not.toBeNull();
    expect(host.querySelector('.status-message')?.textContent).not.toBe('Stale setting failure');
  });

  it.each(['new', 'open'] as const)('handles recovery-cleanup failure after %s without losing the chosen document', async (action) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    files.clearDraft.mockRejectedValueOnce(new Error('Cannot clear recovery data'));
    try {
      await act(async () => {
        if (action === 'new') documentAction(getMessages().new).click();
        else (await recentFileButton()).click();
        await flushEffects();
      });
      expect(host.querySelector('.document-name')?.textContent).toContain(action === 'new' ? 'Untitled.md' : 'recent.md');
      expect(host.querySelector('.status-message')?.textContent).toBe('Cannot clear recovery data');
      expect(host.querySelector('.dirty-dot')).toBeNull();
    } finally {
      confirm.mockRestore();
    }
  });

  it.each([
    { setting: 'fontSize' as const, input: 'fontSize' as const, typed: '22', original: '15' },
    { setting: 'lineSpacing' as const, input: 'lineSpacing' as const, typed: '2.2', original: '1.62' },
  ])('cancels uncommitted $setting changes with Escape', async ({ setting, input: inputName, typed, original }) => {
    await act(async () => root.unmount());
    files.loadPreferences.mockResolvedValueOnce({
      theme: 'light', font: 'system', fontSize: 15, lineSpacing: 1.62,
      sidebarOpen: true, recentFilesExpanded: true, language: 'zh-Hant',
    });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    const settings = revealDetails('details.reading-settings');
    const input = settings.querySelector<HTMLInputElement>(`input[aria-label="${getMessages()[inputName]}"]`);
    if (!input) throw new Error(`Expected ${setting} input`);
    const initiallyDirty = host.querySelector('.dirty-dot') !== null;
    files.savePreferences.mockClear();
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, typed);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.value).toBe(typed);
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await flushEffects();
    });
    expect(input.value).toBe(original);
    expect(host.querySelector<HTMLElement>('.canvas-area')?.style.getPropertyValue('--editor-size')).toBe('15px');
    expect(host.querySelector<HTMLElement>('.canvas-area')?.style.getPropertyValue('--editor-line-height')).toBe('1.62');
    expect(files.savePreferences.mock.calls.every(([preferences]) => preferences[setting] === Number(original))).toBe(true);
    expect(files.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 15, lineSpacing: 1.62 }));
    expect(host.querySelector('.dirty-dot') !== null).toBe(initiallyDirty);
  });

  it('closes the focused toolbar menu before the search panel on Escape', async () => {
    await act(async () => { namedButton(getMessages().findDocument).click(); await flushEffects(); });
    const settings = revealDetails('details.reading-settings');
    const summary = settings.querySelector<HTMLElement>(':scope > summary');
    if (!summary) throw new Error('Expected reading settings summary');
    summary.focus();
    harness.searchHandle.focus.mockClear();
    await act(async () => {
      summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await flushEffects();
    });
    expect(settings.open).toBe(false);
    expect(host.querySelector('.document-search')).not.toBeNull();
    expect(document.activeElement).toBe(summary);
    expect(harness.searchHandle.focus).not.toHaveBeenCalled();
  });

  it('closes the nested export menu when the document actions close outside', async () => {
    const actions = revealDetails('details.document-actions');
    const exports = revealDetails('details.export-menu');
    await act(async () => {
      host.querySelector('.canvas-area')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await flushEffects();
    });
    expect(actions.open).toBe(false);
    expect(exports.open).toBe(false);
    revealDetails('details.document-actions');
    expect(exports.open).toBe(false);
  });

  it.each(['input', 'pending input', 'new', 'open'] as const)('does not restore a late startup draft after %s', async (action) => {
    await act(async () => root.unmount());
    let resolveDraft!: (value: object) => void;
    files.loadDraft.mockImplementationOnce(() => new Promise(resolve => { resolveDraft = resolve; }));
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    const editedDocument = markdownToDocument('Fresh typing');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      if (action === 'input') {
        harness.canvasProps?.onEdit?.();
        harness.canvasProps?.onChange(editedDocument);
      } else if (action === 'pending input') {
        harness.canvasProps?.onEdit?.();
      } else if (action === 'new') {
        documentAction('新增')?.click();
      } else {
        files.chooseMarkdownFile.mockResolvedValueOnce({path: '/tmp/chosen.md', name: 'chosen.md', document: editedDocument});
        documentAction('開啟')?.click();
      }
      await flushEffects();
    });
    const currentDocumentId = harness.canvasProps?.documentId;
    await act(async () => {
      resolveDraft({ path: '/tmp/old.md', name: 'old.md', document: savedDocument });
      await flushEffects();
    });
    expect(harness.canvasProps?.documentId).toBe(currentDocumentId);
    expect(harness.canvasProps?.initialDocument).toEqual(action === 'input' || action === 'open' ? editedDocument : markdownToDocument(''));
    expect(host.querySelector('.document-name')?.textContent).toContain(action === 'open' ? 'chosen.md' : 'Untitled.md');
    expect(host.textContent).toContain('recent.md');
    confirm.mockRestore();
  });

  it('resets counters immediately when creating a new document', async () => {
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(host.querySelector('.statusbar')?.textContent).toContain('4 詞 · 4 字元');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const create = documentAction('新增');
    expect(create).toBeDefined();
    await act(async () => { create?.click(); await flushEffects(); });
    expect(host.querySelector('.statusbar')?.textContent).toContain('0 詞 · 0 字元');
    confirm.mockRestore();
  });

  it('updates counters during continuous canvas typing before deferred onChange', async () => {
    for (let index = 0; index < 8; index++) {
      await act(async () => {
        harness.searchHandle.getDocument.mockReturnValue(markdownToDocument('字'.repeat(index + 1)));
        harness.canvasProps?.onEdit?.();
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    expect(host.querySelector('.statusbar')?.textContent).toMatch(/[5-8] 詞 · [5-8] 字元/);
    expect(harness.canvasProps?.initialDocument).toEqual(savedDocument);
  });

  it('counts current Markdown source prose and separate list items', async () => {
    const showSource = readingModeButton('source');
    await act(async () => { showSource?.click(); });
    await act(async () => { harness.sourceProps?.onChange('- First\n- Second'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(host.querySelector('.statusbar')?.textContent).toContain('2 詞 · 11 字元');
  });

  it.each(['canvas', 'source'] as const)('includes visible HTML prose in %s word and character counters', async (mode) => {
    const source = 'Press <kbd>Command</kbd> to continue.\n\n<table><tr><td><p>A</p><p>B</p></td></tr></table>\n\n研究\n';
    await act(async () => {
      if (mode === 'source') {
        readingModeButton('source').click();
        await flushEffects();
        harness.sourceProps?.onChange(source);
      } else harness.canvasProps?.onChange(markdownToDocument(source));
      await vi.advanceTimersByTimeAsync(400);
      await flushEffects();
    });
    expect(host.querySelector('.statusbar')?.textContent).toContain('8 詞 · 30 字元');
  });

  it('does not reload an unchanged editor document after autosave', async () => {
    const initialDocumentId = harness.canvasProps?.documentId;
    const editedDocument: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '中間新增文字' }],
        },
      ],
    };

    await act(async () => harness.canvasProps?.onChange(editedDocument));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(850);
      await flushEffects();
    });

    expect(files.saveEditorFile).toHaveBeenCalledOnce();
    expect(harness.canvasProps?.documentId).toBe(initialDocumentId);
    expect(harness.canvasProps?.initialDocument).toEqual(editedDocument);
  });

  it('does not mark an unchanged canvas dirty when switching to Markdown mode', async () => {
    const sourceMarkdown = '\uFEFF# Exact  source\r\n\r\n| A | B |\r\n| - | - |\r\n| First | Last |\r\n';
    await act(async () => root.unmount());
    files.loadDraft.mockResolvedValueOnce({ path: '/tmp/research.md', name: 'research.md', sourceMarkdown, document: markdownToDocument(sourceMarkdown) });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    const save = documentAction('儲存');
    await act(async () => {
      save?.click();
      await flushEffects();
    });
    expect(files.saveEditorFile).toHaveBeenCalledOnce();
    files.saveEditorFile.mockClear();
    harness.searchHandle.flushCommentMapping.mockClear();
    // A clean real canvas does not publish an unchanged snapshot when flushed.
    harness.searchHandle.flushCommentMapping.mockImplementation(() => undefined);
    const showSource = readingModeButton('source');

    await act(async () => {
      showSource?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(850);
      await flushEffects();
    });

    expect(harness.searchHandle.flushCommentMapping).toHaveBeenCalledOnce();
    expect(harness.sourceProps?.value).toBe(sourceMarkdown);
    expect(files.saveEditorFile).not.toHaveBeenCalled();
  });

  it('publishes pending formula composition from a clean canvas before switching to source', async () => {
    await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
    expect(host.querySelector('.dirty-dot')).toBeNull();
    const composed = markdownToDocument('Value $\\theta$');
    harness.searchHandle.flushCommentMapping.mockImplementation(() => {
      harness.canvasProps?.onChange(composed);
    });
    await act(async () => { readingModeButton('source').click(); await flushEffects(); });
    expect(harness.sourceProps?.value).toBe(documentToMarkdown(composed));
    expect(host.querySelector('.dirty-dot')).not.toBeNull();
  });

  it.each(['new', 'open'] as const)('starts a fresh canvas session when %s replaces a document', async (action) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const mounts = harness.canvasMounts;
    const unmounts = harness.canvasUnmounts;
    const nextDocument = markdownToDocument('Second file');
    try {
      await act(async () => { harness.canvasProps?.onChange(markdownToDocument('First file edited')); });
      await act(async () => {
        if (action === 'open') files.chooseMarkdownFile.mockResolvedValueOnce({ path: '/tmp/second.md', name: 'second.md', document: nextDocument });
        documentAction(action === 'new' ? getMessages().new : getMessages().open).click();
        await flushEffects();
      });
      expect(harness.canvasMounts).toBe(mounts + 1);
      expect(harness.canvasUnmounts).toBe(unmounts + 1);
      expect(harness.canvasProps?.initialDocument).toEqual(action === 'new' ? markdownToDocument('') : nextDocument);
      expect(host.querySelector('.document-name')?.textContent).toContain(action === 'new' ? 'Untitled.md' : 'second.md');
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['new', 'open'] as const)('waits for an asynchronous discard answer before %s replaces a document', async (action) => {
    const original = markdownToDocument('Unsaved content');
    const replacement = markdownToDocument('Replacement file');
    let answer!: (value: boolean) => void;
    const confirm = vi.spyOn(window, 'confirm').mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }) as unknown as boolean);
    try {
      await act(async () => { harness.canvasProps?.onChange(original); });
      if (action === 'open') files.chooseMarkdownFile.mockResolvedValueOnce({ path: '/tmp/replacement.md', name: 'replacement.md', document: replacement });
      await act(async () => { documentAction(action === 'new' ? getMessages().new : getMessages().open).click(); await flushEffects(); });
      expect(confirm).toHaveBeenCalledOnce();
      expect(harness.canvasProps?.initialDocument).toEqual(original);
      await act(async () => { answer(false); await flushEffects(); });
      expect(harness.canvasProps?.initialDocument).toEqual(original);
      expect(host.querySelector('.document-name')?.textContent).toContain('research.md');
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['new', 'open'] as const)('replaces a document only after an asynchronous discard confirmation for %s', async (action) => {
    const replacement = markdownToDocument('Replacement file');
    let answer!: (value: boolean) => void;
    const confirm = vi.spyOn(window, 'confirm').mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }) as unknown as boolean);
    try {
      await act(async () => { harness.canvasProps?.onChange(markdownToDocument('Unsaved content')); });
      if (action === 'open') files.chooseMarkdownFile.mockResolvedValueOnce({ path: '/tmp/replacement.md', name: 'replacement.md', document: replacement });
      await act(async () => { documentAction(action === 'new' ? getMessages().new : getMessages().open).click(); await flushEffects(); });
      expect(host.querySelector('.document-name')?.textContent).toContain('research.md');
      await act(async () => { answer(true); await flushEffects(); });
      expect(harness.canvasProps?.initialDocument).toEqual(action === 'new' ? markdownToDocument('') : replacement);
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['new', 'open'] as const)('ignores a stale %s discard answer after a newer file action completes', async (action) => {
    let answer!: (value: boolean) => void;
    const confirm = vi.spyOn(window, 'confirm')
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }) as unknown as boolean)
      .mockReturnValue(true);
    try {
      await act(async () => { harness.canvasProps?.onChange(markdownToDocument('Unsaved content')); });
      if (action === 'open') files.chooseMarkdownFile.mockResolvedValueOnce({ path: '/tmp/stale.md', name: 'stale.md', document: markdownToDocument('Stale file') });
      await act(async () => { documentAction(action === 'new' ? getMessages().new : getMessages().open).click(); await flushEffects(); });
      await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
      const mounts = harness.canvasMounts;
      await act(async () => { answer(true); await flushEffects(); });
      expect(harness.canvasMounts).toBe(mounts);
      expect(host.querySelector('.document-name')?.textContent).toContain('Untitled.md');
      expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument(''));
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['new', 'open'] as const)('keeps unsaved content when the %s discard dialog fails', async (action) => {
    const original = markdownToDocument('Unsaved content');
    const confirm = vi.spyOn(window, 'confirm').mockImplementationOnce(() => Promise.reject(new Error('Dialog unavailable')) as unknown as boolean);
    try {
      await act(async () => { harness.canvasProps?.onChange(original); });
      if (action === 'open') files.chooseMarkdownFile.mockResolvedValueOnce({ path: '/tmp/replacement.md', name: 'replacement.md', document: markdownToDocument('Replacement') });
      await act(async () => { documentAction(action === 'new' ? getMessages().new : getMessages().open).click(); await flushEffects(); });
      expect(harness.canvasProps?.initialDocument).toEqual(original);
      expect(host.textContent).toContain('Dialog unavailable');
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['new', 'open'] as const)('checks pending clean-canvas writing before confirming %s', async (action) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = markdownToDocument('Saved $x$.\n');
    files.chooseMarkdownFile.mockResolvedValueOnce({ path: '/notes/saved.md', name: 'saved.md', document: original });
    try {
      await act(async () => { documentAction(getMessages().open).click(); await flushEffects(); });
      expect(host.querySelector('.dirty-dot')).toBeNull();
      confirm.mockClear().mockReturnValue(false);
      const pending = markdownToDocument('Saved $x + visible input$.\n');
      let unflushed = true;
      harness.searchHandle.flushCommentMapping.mockImplementation(() => {
        if (!unflushed) return;
        unflushed = false;
        harness.canvasProps?.onChange(pending);
      });
      if (action === 'open') files.chooseMarkdownFile.mockResolvedValueOnce({ path: '/notes/other.md', name: 'other.md', document: markdownToDocument('Other file.\n') });
      await act(async () => { documentAction(getMessages()[action]).click(); await flushEffects(); });
      expect(confirm).toHaveBeenCalledOnce();
      expect(host.querySelector('.document-name')?.textContent).toContain('saved.md');
      expect(harness.canvasProps?.initialDocument).toEqual(pending);
      expect(host.querySelector('.dirty-dot')).not.toBeNull();
    } finally { confirm.mockRestore(); }
  });

  it('keeps the canvas session mounted when edited source refreshes its document', async () => {
    const mounts = harness.canvasMounts;
    const unmounts = harness.canvasUnmounts;
    const previousDocumentId = harness.canvasProps?.documentId;
    const source = '# Updated source\n\nFresh body\n';
    await act(async () => { readingModeButton('source').click(); await flushEffects(); });
    await act(async () => { harness.sourceProps?.onChange(source); });
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    expect(harness.canvasProps?.documentId).toBe((previousDocumentId ?? 0) + 1);
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument(source));
    expect(harness.canvasMounts).toBe(mounts);
    expect(harness.canvasUnmounts).toBe(unmounts);
  });

  it('keeps the canvas mounted and does not reload an unchanged Markdown round trip', async () => {
    const initialDocumentId = harness.canvasProps?.documentId;
    const mounts = harness.canvasMounts;
    const unmounts = harness.canvasUnmounts;
    const showSource = readingModeButton('source');

    await act(async () => {
      showSource?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(host.querySelector('.editor-mode-pane--canvas')?.hasAttribute('hidden')).toBe(true);
    expect(harness.canvasMounts).toBe(mounts);
    expect(harness.canvasUnmounts).toBe(unmounts);

    const backToCanvas = readingModeButton('canvas');
    await act(async () => {
      backToCanvas?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(harness.canvasProps?.documentId).toBe(initialDocumentId);
    expect(host.querySelector('.editor-mode-pane--canvas')?.hasAttribute('hidden')).toBe(false);
    expect(harness.canvasMounts).toBe(mounts);
    expect(harness.canvasUnmounts).toBe(unmounts);
  });

  it('retains a lazily opened source editor during canvas visits and isolates new files', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      expect(harness.sourceMounts).toBe(0);
      expect(host.querySelector('.editor-mode-pane--source')).toBeNull();
      await act(async () => { readingModeButton('source').click(); await flushEffects(); });
      const source = '# Edited\r\n\r\nMixed\nend\r';
      await act(async () => { harness.sourceProps?.onChange(source); });
      await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
      expect(host.querySelector('.editor-mode-pane--source')?.hasAttribute('hidden')).toBe(true);
      expect(harness.sourceMounts).toBe(1);
      expect(harness.sourceUnmounts).toBe(0);
      await act(async () => { readingModeButton('source').click(); await flushEffects(); });
      expect(harness.sourceProps?.value).toBe(source);
      expect(harness.sourceMounts).toBe(1);
      await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
      const canvasSource = '# Changed on canvas\n';
      await act(async () => { harness.canvasProps?.onChange(markdownToDocument(canvasSource)); });
      await act(async () => { readingModeButton('source').click(); await flushEffects(); });
      expect(harness.sourceProps?.value).toBe(canvasSource);
      expect(harness.sourceMounts).toBe(1);

      const nextSource = '# Another file\r\n';
      files.openRecent.mockResolvedValueOnce({ path: '/tmp/another.md', name: 'another.md', sourceMarkdown: nextSource, document: markdownToDocument(nextSource) });
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      expect(host.querySelector('.editor-mode-pane--source')).toBeNull();
      expect(harness.sourceUnmounts).toBe(1);
      await act(async () => { readingModeButton('source').click(); await flushEffects(); });
      expect(harness.sourceMounts).toBe(2);
      expect(harness.sourceProps?.value).toBe(nextSource);
    } finally {
      confirm.mockRestore();
    }
  });

  it('waits for a pending canvas image before serializing Markdown and coalesces repeated mode clicks', async () => {
    let finishImage!: () => void;
    harness.searchHandle.waitForPendingImages.mockReturnValue(new Promise<void>((resolve) => { finishImage = resolve; }));
    const withImage = markdownToDocument('Original text\n\n![sample.png](data:image/png;base64,dGVzdA==)\n');
    await act(async () => {
      readingModeButton('source').click();
      readingModeButton('source').click();
      await flushEffects();
    });
    expect(harness.searchHandle.waitForPendingImages).toHaveBeenCalledOnce();
    expect(harness.sourceProps).toBeNull();
    expect(host.querySelector('.editor-mode-pane--canvas')?.hasAttribute('hidden')).toBe(false);
    await act(async () => {
      harness.canvasProps?.onChange(withImage);
      finishImage();
      await flushEffects();
    });
    expect(harness.sourceProps?.value).toBe(documentToMarkdown(withImage));
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    expect(harness.canvasProps?.initialDocument).toEqual(withImage);
  });

  it.each(['save', 'markdown', 'pdf'] as const)('waits for pending images before %s captures the document', async (action) => {
    let finishImage!: () => void;
    harness.searchHandle.waitForPendingImages.mockReturnValue(new Promise<void>((resolve) => { finishImage = resolve; }));
    const withImage = markdownToDocument('Original text\n\n![sample.png](data:image/png;base64,dGVzdA==)\n');
    await act(async () => {
      if (action === 'save') documentAction(getMessages().save).click();
      else exportAction(action === 'markdown' ? 'Markdown (.md)' : 'PDF (.pdf)').click();
      await flushEffects();
    });
    expect(files.saveEditorFile).not.toHaveBeenCalled();
    expect(files.exportMarkdownFile).not.toHaveBeenCalled();
    expect(files.exportPdfFile).not.toHaveBeenCalled();
    await act(async () => {
      harness.canvasProps?.onChange(withImage);
      finishImage();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });
    if (action === 'save') expect(files.saveEditorFile).toHaveBeenCalledWith(expect.objectContaining({ document: withImage }), false);
    else if (action === 'markdown') expect(files.exportMarkdownFile).toHaveBeenCalledWith(documentToMarkdown(withImage), 'research.md', '/tmp/research.md');
    else expect(files.exportPdfFile).toHaveBeenCalledWith('research.md', expect.any(Function));
  });

  it.each(['save', 'markdown', 'pdf'] as const)('cancels a waiting %s when another document replaces the canvas', async (action) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishImage!: () => void;
    harness.searchHandle.waitForPendingImages.mockReturnValue(new Promise<void>((resolve) => { finishImage = resolve; }));
    try {
      await act(async () => {
        if (action === 'save') documentAction(getMessages().save).click();
        else exportAction(action === 'markdown' ? 'Markdown (.md)' : 'PDF (.pdf)').click();
        await flushEffects();
      });
      await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
      await act(async () => { finishImage(); await flushEffects(); await vi.advanceTimersByTimeAsync(50); });
      expect(files.saveEditorFile).not.toHaveBeenCalled();
      expect(files.exportMarkdownFile).not.toHaveBeenCalled();
      expect(files.exportPdfFile).not.toHaveBeenCalled();
      expect(host.querySelector('.document-name')?.textContent).toBe('Untitled.md');
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['save', 'markdown', 'pdf'] as const)('keeps a failed image read visible and cancels %s', async (action) => {
    let failImage!: (error: Error) => void;
    harness.searchHandle.waitForPendingImages.mockReturnValue(new Promise<void>((_, reject) => { failImage = reject; }));
    await act(async () => {
      if (action === 'save') documentAction(getMessages().save).click();
      else exportAction(action === 'markdown' ? 'Markdown (.md)' : 'PDF (.pdf)').click();
      await flushEffects();
    });
    await act(async () => { failImage(new Error('Cannot read pasted image')); await flushEffects(); });
    expect(files.saveEditorFile).not.toHaveBeenCalled();
    expect(files.exportMarkdownFile).not.toHaveBeenCalled();
    expect(files.exportPdfFile).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Cannot read pasted image');
  });

  it.each([false, true])('waits for PDF image decoding and guards document replacement (replace=%s)', async (replace) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const image = document.createElement('img');
    image.src = 'data:image/png;base64,dGVzdA==';
    let finishDecode!: () => void;
    image.decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
    host.querySelector('.editor-mode-pane--canvas')!.append(image);
    try {
      await act(async () => { exportAction('PDF (.pdf)').click(); await flushEffects(); });
      expect(image.decode).toHaveBeenCalledOnce();
      expect(files.exportPdfFile).not.toHaveBeenCalled();
      if (replace) await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
      await act(async () => { finishDecode(); await flushEffects(); });
      if (replace) expect(files.exportPdfFile).not.toHaveBeenCalled();
      else expect(files.exportPdfFile).toHaveBeenCalledWith('research.md', expect.any(Function));
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['new', 'open'] as const)('drops a pending source-mode switch when %s replaces its document', async (replacement) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishImage!: () => void;
    harness.searchHandle.waitForPendingImages.mockReturnValue(new Promise<void>((resolve) => { finishImage = resolve; }));
    try {
      await act(async () => { readingModeButton('source').click(); await flushEffects(); });
      await act(async () => {
        if (replacement === 'new') documentAction(getMessages().new).click();
        else (await recentFileButton()).click();
        await flushEffects();
      });
      const documentId = harness.canvasProps?.documentId;
      const nextDocument = harness.canvasProps?.initialDocument;
      await act(async () => { finishImage(); await flushEffects(); });
      expect(harness.sourceProps).toBeNull();
      expect(host.querySelector('.editor-mode-pane--canvas')?.hasAttribute('hidden')).toBe(false);
      expect(harness.canvasProps?.documentId).toBe(documentId);
      expect(harness.canvasProps?.initialDocument).toEqual(nextDocument);
    } finally {
      confirm.mockRestore();
    }
  });

  it('preserves exact opened Markdown across reading switches and outline navigation without autosaving', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const sourceMarkdown = '# Title\n\nA  [reference][target] and `code`.\n\n## Details\n\nBody.\n\n[target]: https://example.com\n\n';
    const opened = {
      path: '/tmp/recent.md', name: 'recent.md',
      document: markdownToDocument(sourceMarkdown), sourceMarkdown,
    };
    files.openRecent.mockResolvedValueOnce(opened);
    await act(async () => {
      (await recentFileButton()).click();
      await flushEffects();
    });
    files.saveEditorFile.mockClear();
    const initialDocumentId = harness.canvasProps?.documentId;
    harness.searchHandle.getMarkdownSelection.mockClear();
    await showNavigationTab(getMessages().outline);
    for (let pass = 0; pass < 3; pass += 1) {
      await act(async () => {
        toggleReadingModeButton()?.click();
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(harness.sourceProps?.value).toBe(sourceMarkdown);
      await act(async () => {
        Array.from(host.querySelectorAll<HTMLButtonElement>('.outline-list button'))
          .find((button) => button.textContent === 'Details')?.click();
        await vi.advanceTimersByTimeAsync(900);
      });
      expect(host.querySelector('.dirty-dot')).toBeNull();
      expect(harness.canvasProps?.documentId).toBe(initialDocumentId);
    }
    expect(files.saveEditorFile).not.toHaveBeenCalled();
    expect(harness.searchHandle.getMarkdownSelection).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('updates source-mode outline headings before autosave and preserves edits across mode switches', async () => {
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const markdown = '# Updated\n\n## New section\n\nUnfinished * text  .\n\n';
    await act(async () => {
      harness.sourceProps?.onChange(markdown);
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(host.querySelector('.outline-list')?.textContent).toContain('New section');
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(harness.sourceProps?.value).toBe(markdown);
  });

  it('synchronizes source edits into the hidden canvas when saving in Markdown mode', async () => {
    const initialDocumentId = harness.canvasProps?.documentId;
    const showSource = readingModeButton('source');

    await act(async () => {
      showSource?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    const markdown = '# 新標題\n\n新增正文';
    await act(async () => {
      harness.sourceProps?.onChange(markdown);
      await flushEffects();
      await vi.advanceTimersByTimeAsync(850);
      await flushEffects();
    });

    expect(files.saveEditorFile).toHaveBeenCalledOnce();
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument(markdown));
    expect(harness.canvasProps?.documentId).toBe((initialDocumentId ?? 0) + 1);
  });

  it('preserves literal source and its revision during autosave', async () => {
    const showSource = readingModeButton('source');
    await act(async () => { showSource?.click(); await flushEffects(); await vi.advanceTimersByTimeAsync(50); });
    const revision = harness.sourceProps?.valueRevision;
    const markdown = 'plain_text with * unfinished syntax\n\n';
    await act(async () => {
      harness.sourceProps?.onChange(markdown);
      await vi.advanceTimersByTimeAsync(850);
      await flushEffects();
    });
    expect(harness.sourceProps?.valueRevision).toBe(revision);
    expect(harness.sourceProps?.value).toBe(markdown);
    expect(files.saveEditorFile).toHaveBeenCalledWith(expect.anything(), false, markdown);
  });

  it('refreshes an open search without navigating while editing', async () => {
    harness.searchHandle.getSelectedText.mockReturnValue('研究');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true })); });
    harness.searchHandle.search.mockClear();
    await act(async () => {
      harness.canvasProps?.onChange(savedDocument);
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(harness.searchHandle.search).toHaveBeenCalledWith('研究', 'refresh');
    expect(harness.searchHandle.search).not.toHaveBeenCalledWith('研究', 'reset');
  });

  it('defers source comment relocation until typing pauses', async () => {
    const showSource = readingModeButton('source');

    await act(async () => {
      showSource?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    const comment = createMarkdownComment('原始內容\n', { kind: 'range', from: 0, to: 4 }, '延遲同步測試', '原始內容');
    const markdown = serializeMarkdownWithComments('原始內容\n', [comment]);
    await act(async () => {
      harness.sourceProps?.onChange(markdown);
      await flushEffects();
    });

    expect(harness.canvasProps?.comments).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(399);
      await flushEffects();
    });
    expect(harness.canvasProps?.comments).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flushEffects();
    });
    expect(harness.canvasProps?.comments).toHaveLength(1);
  });

  it('uses document progress when an unfocused source-mode toggle has no visible caret', async () => {
    const viewport = host.querySelector<HTMLElement>('.canvas-area');
    if (!viewport) throw new Error('Expected the editor viewport');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 2_600 },
      scrollTop: { configurable: true, value: 1_000, writable: true },
    });
    harness.searchHandle.isFocused.mockReturnValue(false);
    harness.searchHandle.setSelectionProgress.mockClear();
    const showSource = readingModeButton('source');

    await act(async () => {
      showSource?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(harness.searchHandle.setSelectionProgress).toHaveBeenCalledWith(0.5);
    expect(harness.searchHandle.focus).not.toHaveBeenCalled();
  });

  it('carries a visible focused selection directly into Markdown mode', async () => {
    const viewport = host.querySelector<HTMLElement>('.canvas-area');
    if (!viewport) throw new Error('Expected the editor viewport');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 2_600 },
      scrollTop: { configurable: true, value: 1_000, writable: true },
    });
    harness.searchHandle.isFocused.mockReturnValue(true);
    harness.searchHandle.getSelectionProgress.mockReturnValue(0.42);
    harness.searchHandle.getSelectionViewportOffset.mockReturnValue(240);
    const showSource = readingModeButton('source');

    await act(async () => {
      showSource?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(harness.searchHandle.setSelectionProgress).toHaveBeenCalledWith(0.42);
    expect(harness.searchHandle.focus).toHaveBeenCalled();
    expect(host.querySelector('.editor-mode-pane--canvas')?.hasAttribute('hidden')).toBe(true);
  });

  it('maps the exact canvas caret into Markdown and back into the parsed text block', async () => {
    const viewport = host.querySelector<HTMLElement>('.canvas-area');
    if (!viewport) throw new Error('Expected the editor viewport');
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 2_600 },
      scrollTop: { configurable: true, value: 1_000, writable: true },
    });
    harness.searchHandle.isFocused.mockReturnValue(true);
    harness.searchHandle.getSelectionViewportOffset.mockReturnValue(240);
    harness.searchHandle.getMarkdownSelection.mockReturnValue({
      markdown: '原始內容\n',
      offset: 3,
    });
    const showSource = readingModeButton('source');

    await act(async () => {
      showSource?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(harness.searchHandle.setMarkdownOffset).toHaveBeenCalledWith(3);
    expect(harness.searchHandle.focus).toHaveBeenCalled();

    harness.searchHandle.setDocumentSelection.mockClear();
    harness.searchHandle.getMarkdownOffset.mockReturnValue(5);
    const backToCanvas = readingModeButton('canvas');
    await act(async () => {
      backToCanvas?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(harness.searchHandle.setDocumentSelection).toHaveBeenCalledWith({
      kind: 'text',
      path: [0],
      offset: 4,
    });
  });

  it('does not overwrite newer typing when an older save finishes later', async () => {
    let finishFirstSave: ((value: unknown) => void) | undefined;
    files.saveEditorFile
      .mockImplementationOnce(
        (file) =>
          new Promise((resolve) => {
            finishFirstSave = () => resolve(structuredClone(file));
          }),
      )
      .mockImplementation(async (file) => structuredClone(file));
    const firstEdit: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一版' }] }],
    };
    const newerEdit: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '第一版＋新輸入' }],
        },
      ],
    };

    await act(async () => harness.canvasProps?.onChange(firstEdit));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(850);
      await flushEffects();
    });
    await act(async () => harness.canvasProps?.onChange(newerEdit));
    await act(async () => {
      finishFirstSave?.(undefined);
      await flushEffects();
    });

    expect(files.saveEditorFile).toHaveBeenCalledTimes(2);
    expect(files.saveEditorFile.mock.calls[1]?.[0].document).toEqual(newerEdit);
    expect(harness.canvasProps?.initialDocument).toEqual(newerEdit);
  });

  it('queues the next document autosave while a previous document write is still pending', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishFirstSave!: () => void;
    files.saveEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise((resolve) => {
      finishFirstSave = () => resolve(structuredClone(candidate));
    }));
    const nextSource = '# Next document\n\n[Reference][site].\n\n[site]: https://example.com\n';
    files.openRecent.mockResolvedValueOnce({ path: '/tmp/next.md', name: 'next.md', sourceMarkdown: nextSource, document: markdownToDocument(nextSource) });
    const nextEdit = markdownToDocument('# Next document edited\n');
    try {
      await act(async () => { harness.canvasProps?.onChange(markdownToDocument('# First document edited\n')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(850); });
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      await act(async () => { harness.canvasProps?.onChange(nextEdit); });
      await act(async () => { await vi.advanceTimersByTimeAsync(850); });
      expect(files.saveEditorFile).toHaveBeenCalledOnce();
      await act(async () => { finishFirstSave(); await flushEffects(); });
      expect(files.saveEditorFile).toHaveBeenCalledTimes(2);
      expect(files.saveEditorFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/tmp/next.md', document: nextEdit, sourceMarkdown: undefined }), false);
      expect(harness.canvasProps?.initialDocument).toEqual(nextEdit);
      expect(host.querySelector('.document-name')?.textContent).toContain('next.md');
      expect(host.querySelector('.dirty-dot')).toBeNull();
    } finally {
      confirm.mockRestore();
    }
  });

  it('preserves an explicit Save As request while an ordinary save is pending', async () => {
    let finishFirstSave!: () => void;
    files.saveEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise((resolve) => {
      finishFirstSave = () => resolve(structuredClone(candidate));
    })).mockImplementation(async (candidate: EditorFile, forceSaveAs: boolean) => forceSaveAs
      ? { ...structuredClone(candidate), path: '/tmp/copy.md', name: 'copy.md' }
      : structuredClone(candidate));
    await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
    await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
    expect(files.saveEditorFile).toHaveBeenCalledOnce();
    await act(async () => { finishFirstSave(); await flushEffects(); });
    expect(files.saveEditorFile).toHaveBeenCalledTimes(2);
    expect(files.saveEditorFile.mock.calls[1]?.[1]).toBe(true);
    expect(host.querySelector('.document-name')?.textContent).toContain('copy.md');
  });

  it.each(['draft cleanup', 'recent metadata'] as const)('saves late source typing after asynchronous %s finishes', async (metadata) => {
    let finishMetadata!: () => void;
    if (metadata === 'draft cleanup') {
      files.clearDraft.mockImplementationOnce(() => new Promise((resolve) => { finishMetadata = () => resolve(undefined); }));
    } else {
      files.loadRecent.mockImplementationOnce(() => new Promise((resolve) => { finishMetadata = () => resolve([]); }));
    }
    await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
    const first = '# First\n\n[Reference][site].\n\n[site]: https://example.com\n';
    const latest = first.replace('# First', '# Latest') + '\nLiteral  unfinished * source.\n';
    await act(async () => { harness.sourceProps?.onChange(first); documentAction(getMessages().save).click(); await flushEffects(); });
    expect(files.saveEditorFile).toHaveBeenCalledOnce();
    await act(async () => { harness.sourceProps?.onChange(latest); });
    await act(async () => { await vi.advanceTimersByTimeAsync(850); });
    expect(files.saveEditorFile).toHaveBeenCalledOnce();
    await act(async () => { finishMetadata(); await flushEffects(); });
    expect(files.saveEditorFile).toHaveBeenCalledTimes(2);
    expect(files.saveEditorFile.mock.calls[1]?.[2]).toBe(latest);
    expect(harness.sourceProps?.value).toBe(latest);
    expect(host.querySelector('.dirty-dot')).toBeNull();
  });

  it.each(['draft cleanup', 'recent metadata'] as const)('retains successful Save As status when %s fails', async (metadata) => {
    const failure = new Error('Settings unavailable after document write');
    if (metadata === 'draft cleanup') files.clearDraft.mockRejectedValueOnce(failure);
    else files.loadRecent.mockRejectedValueOnce(failure);
    files.saveEditorFile.mockImplementationOnce(async (candidate: EditorFile) => ({ ...candidate, path: '/tmp/copy.md', name: 'copy.md' }));
    await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
    expect(host.querySelector('.document-name')?.textContent).toContain('copy.md');
    expect(host.querySelector('.save-status--saved')).not.toBeNull();
    expect(host.querySelector('.dirty-dot')).toBeNull();
    expect(host.querySelector('.status-message')?.textContent).toBe(failure.message);
  });

  it.each(['draft cleanup', 'recent metadata'] as const)('still saves late typing after %s rejects', async (metadata) => {
    let failMetadata!: () => void;
    const failing = () => new Promise<never>((_, reject) => { failMetadata = () => reject(new Error('Settings unavailable')); });
    if (metadata === 'draft cleanup') files.clearDraft.mockImplementationOnce(failing);
    else files.loadRecent.mockImplementationOnce(failing);
    await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { harness.sourceProps?.onChange('# First\n'); documentAction(getMessages().save).click(); await flushEffects(); });
    await act(async () => { harness.sourceProps?.onChange('# Latest typing\n'); failMetadata(); await flushEffects(); });
    expect(files.saveEditorFile).toHaveBeenCalledTimes(2);
    expect(files.saveEditorFile.mock.calls[1]?.[2]).toBe('# Latest typing\n');
    expect(host.querySelector('.dirty-dot')).toBeNull();
  });

  it('publishes rebased Save As source while preserving its other bytes and clean reading switches', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const originalPath = '/tmp/original/research.md';
      const targetPath = '/tmp/copy/research.md';
      const sourceMarkdown = '# Reading\r\n\r\nLiteral  `research.assets/` and ![Diagram][image].\r\n\r\n[image]: <./research.assets/a%20b.png> "Title"\r\n';
      const original: EditorFile = { path: originalPath, name: 'research.md', sourceMarkdown, document: markdownToDocument(sourceMarkdown) };
      files.openRecent.mockResolvedValueOnce(original);
      files.saveEditorFile.mockImplementationOnce(async (candidate: EditorFile) => rebaseEditorFileAssets(candidate, originalPath, targetPath));
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
      const revision = harness.sourceProps!.valueRevision;
      await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
      const expected = rebaseEditorFileAssets(original, originalPath, targetPath).sourceMarkdown;
      expect(harness.sourceProps?.value).toBe(expected);
      expect(expected).toContain('Literal  `research.assets/`');
      expect(harness.sourceProps?.valueRevision).toBe(revision + 1);
      expect(host.querySelector('.dirty-dot')).toBeNull();
      await act(async () => { readingModeButton('canvas').click(); await vi.advanceTimersByTimeAsync(50); });
      await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
      expect(harness.sourceProps?.value).toBe(expected);
      expect(files.saveEditorFile).toHaveBeenCalledOnce();
    } finally {
      confirm.mockRestore();
    }
  });

  it('publishes the Save As asset origin even after the sole image was deleted', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
    const oldPath = '/tmp/original/research.md';
    const newPath = '/tmp/copy/research.md';
    const sourceMarkdown = '![Image](images/a.png)\nBody';
    files.openRecent.mockResolvedValueOnce({ path: oldPath, name: 'research.md', sourceMarkdown, document: markdownToDocument(sourceMarkdown) });
    files.saveEditorFile.mockImplementationOnce(async (candidate: EditorFile) => rebaseEditorFileAssets(candidate, oldPath, newPath));
    await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
    await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
    expect(harness.sourceProps?.assetSourcePath).toBe(oldPath);
    await act(async () => { harness.sourceProps!.onChange('\nBody'); });
    const revision = harness.sourceProps!.valueRevision;
    await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
    expect(harness.sourceProps?.value).toBe('\nBody');
    expect(harness.sourceProps?.valueRevision).toBe(revision);
    expect(harness.sourceProps?.assetSourcePath).toBe(newPath);
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['source', 'canvas'] as const)('rebases latest %s edits exactly once when Save As finishes in a new directory', async (mode) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const originalPath = '/tmp/original/research.md';
      const targetPath = '/tmp/copy/research.md';
      const sourceMarkdown = '# First\n\n![Diagram](research.assets/a.png)\n';
      const latestSource = sourceMarkdown.replace('# First', '# Latest') + '\n![New image](./research.assets/b%20x.png)\n\nLiteral `research.assets/`.\n';
      const original: EditorFile = { path: originalPath, name: 'research.md', sourceMarkdown, document: markdownToDocument(sourceMarkdown) };
      files.openRecent.mockResolvedValueOnce(original);
      let finishSave!: () => void;
      files.saveEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise((resolve) => {
        finishSave = () => resolve(rebaseEditorFileAssets(candidate, originalPath, targetPath));
      }));
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      if (mode === 'source') await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
      const mounts = harness.canvasMounts;
      const unmounts = harness.canvasUnmounts;
      await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
      await act(async () => {
        if (mode === 'source') harness.sourceProps?.onChange(latestSource);
        else harness.canvasProps?.onChange(markdownToDocument(latestSource));
      });
      const revision = harness.sourceProps?.valueRevision ?? 0;
      await act(async () => { finishSave(); await flushEffects(); });
      const expected = rebaseEditorFileAssets({ ...original, sourceMarkdown: mode === 'source' ? latestSource : undefined, document: markdownToDocument(latestSource) }, originalPath, targetPath);
      expect(files.saveEditorFile).toHaveBeenCalledTimes(2);
      expect(files.saveEditorFile.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ path: targetPath, document: expected.document }));
      expect(harness.canvasProps?.initialDocument).toEqual(expected.document);
      if (mode === 'source') {
        expect(files.saveEditorFile.mock.calls[1]?.[2]).toBe(expected.sourceMarkdown);
        expect(harness.sourceProps?.value).toBe(expected.sourceMarkdown);
        expect(harness.sourceProps?.valueRevision).toBe(revision + 1);
      }
      expect(host.querySelector('.dirty-dot')).toBeNull();
      expect(harness.canvasMounts).toBe(mounts);
      expect(harness.canvasUnmounts).toBe(unmounts);
    } finally {
      confirm.mockRestore();
    }
  });

  it('flushes pending canvas typing before rebasing a completed Save As and retrying its write', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const originalPath = '/tmp/original/research.md';
    const targetPath = '/tmp/copy/research.md';
    const sourceMarkdown = '# First\n\n![Diagram](research.assets/a.png)\n';
    const latestSource = sourceMarkdown.replace('# First', '# Latest typing') + '\n![New image](./research.assets/b%20x.png)\n';
    const original: EditorFile = { path: originalPath, name: 'research.md', sourceMarkdown, document: markdownToDocument(sourceMarkdown) };
    files.openRecent.mockResolvedValueOnce(original);
    let finishSave!: () => void;
    files.saveEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise((resolve) => {
      finishSave = () => resolve(rebaseEditorFileAssets(candidate, originalPath, targetPath));
    }));
    try {
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
      let pending: JSONContent | undefined = markdownToDocument(latestSource);
      harness.searchHandle.flushCommentMapping.mockImplementation(() => {
        if (!pending) return;
        const document = pending;
        pending = undefined;
        harness.canvasProps?.onChange(document);
      });
      await act(async () => { harness.canvasProps?.onEdit?.(); });
      await act(async () => { finishSave(); await flushEffects(); });
      const expected = rebaseEditorFileAssets({ ...original, sourceMarkdown: undefined, document: markdownToDocument(latestSource) }, originalPath, targetPath);
      expect(pending).toBeUndefined();
      expect(files.saveEditorFile).toHaveBeenCalledTimes(2);
      expect(files.saveEditorFile.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ path: targetPath, document: expected.document, sourceMarkdown: undefined }));
      expect(harness.canvasProps?.initialDocument).toEqual(expected.document);
      expect(host.querySelector('.dirty-dot')).toBeNull();
    } finally {
      confirm.mockRestore();
    }
  });

  it('exports a Markdown copy without changing the active file', async () => {
    const button = exportAction('Markdown (.md)');

    await act(async () => {
      button?.click();
      await flushEffects();
    });

    expect(files.exportMarkdownFile).toHaveBeenCalledWith('原始內容\n', 'research.md', '/tmp/research.md');
    expect(host.querySelector('.document-name')?.textContent).toContain('research.md');
  });

  it('switches the full interface among all three languages and saves the preference', async () => {
    revealDetails('details.reading-settings');
    const language = host.querySelector<HTMLSelectElement>('select[aria-label="語言"]');

    const switchLanguage = async (value: string) => {
      await act(async () => {
        if (language) {
          language.value = value;
          language.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await flushEffects();
      });
    };

    expect(language).not.toBeNull();
    expect(Array.from(language?.options ?? []).map((option) => option.textContent)).toEqual([
      'English',
      '简体中文',
      '繁體中文',
    ]);

    await switchLanguage('zh-Hans');
    expect(documentAction('新建')).toBeDefined();
    expect(document.documentElement.lang).toBe('zh-Hans');

    await switchLanguage('en');
    expect(documentAction('New')).toBeDefined();
    expect(document.documentElement.lang).toBe('en');

    await switchLanguage('zh-Hant');
    expect(documentAction('新增')).toBeDefined();
    expect(document.documentElement.lang).toBe('zh-Hant');
    expect(files.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ language: 'zh-Hant' }));
  });

  it('opens document search with Command-F, navigates, and restores editor focus on Escape', async () => {
    harness.searchHandle.getSelectedText.mockReturnValue('研究');
    const shortcut = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => {
      window.dispatchEvent(shortcut);
      await flushEffects();
    });

    const input = host.querySelector<HTMLInputElement>('input[type="search"]');
    expect(shortcut.defaultPrevented).toBe(true);
    expect(input?.value).toBe('研究');
    expect(document.activeElement).toBe(input);
    expect(harness.searchHandle.search).toHaveBeenLastCalledWith('研究', 'reset');
    expect(host.querySelector('.document-search__result')?.textContent).toBe('1 / 3');

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(harness.searchHandle.search).toHaveBeenLastCalledWith('研究', 'next');
    expect(host.querySelector('.document-search__result')?.textContent).toBe('2 / 3');

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(harness.searchHandle.search).toHaveBeenLastCalledWith('研究', 'previous');
    expect(host.querySelector('.document-search__result')?.textContent).toBe('1 / 3');

    await act(async () => {
      input?.form?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
    });
    expect(harness.searchHandle.search).toHaveBeenLastCalledWith('研究', 'next');
    expect(host.querySelector('.document-search__result')?.textContent).toBe('2 / 3');

    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await flushEffects();
    });
    expect(host.querySelector('.document-search')).toBeNull();
    expect(harness.searchHandle.clearSearch).toHaveBeenCalledOnce();
    expect(harness.searchHandle.focus).toHaveBeenCalledOnce();
  });

  it('explains bounded highlights while preserving the complete search count and navigation', async () => {
    harness.searchHandle.getSelectedText.mockReturnValue('x');
    harness.searchHandle.search.mockReturnValue({ current: 1, total: 125_000, highlightsLimited: true });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));
      await flushEffects();
    });
    expect(host.querySelector('.document-search__result')?.textContent).toBe('1 / 125000');
    expect(host.querySelector('.document-search__note')?.textContent).toBe(getMessages().findHighlightsLimited);
    harness.searchHandle.search.mockReturnValue({ current: 125_000, total: 125_000, highlightsLimited: true });
    await act(async () => host.querySelector<HTMLInputElement>('input[type="search"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(harness.searchHandle.search).toHaveBeenLastCalledWith('x', 'next');
    expect(host.querySelector('.document-search__result')?.textContent).toBe('125000 / 125000');
    harness.searchHandle.search.mockReturnValue({ current: 1, total: 3 });
    await act(async () => host.querySelector<HTMLInputElement>('input[type="search"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(host.querySelector('.document-search__note')).toBeNull();
  });

  it('applies and persists an adjusted line spacing without marking the document dirty', async () => {
    revealDetails('details.reading-settings');
    const input = host.querySelector<HTMLInputElement>('input[aria-label="行距"]');
    const initialDirtyIndicator = host.querySelector('.document-name')?.textContent?.includes('●');

    expect(input).not.toBeNull();
    expect(host.querySelector<HTMLElement>('.canvas-area')?.style.getPropertyValue('--editor-line-height')).toBe(
      '1.78',
    );

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '2.2');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await flushEffects();
    });
    await act(async () => {
      input?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await flushEffects();
    });

    expect(host.querySelector<HTMLElement>('.canvas-area')?.style.getPropertyValue('--editor-line-height')).toBe('2.2');
    expect(files.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ lineSpacing: 2.2 }));
    expect(host.querySelector('.document-name')?.textContent?.includes('●')).toBe(initialDirtyIndicator);
  });

  it('exports PDF without switching the visible app into a print layout', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const button = exportAction('PDF (.pdf)');

    await act(async () => {
      button?.click();
      await flushEffects();
    });

    expect(files.exportPdfFile).toHaveBeenCalledWith('research.md', expect.any(Function));
    expect(print).not.toHaveBeenCalled();
    expect(document.documentElement.className).not.toContain('pdf-export');
    expect(host.querySelector('.status-message')?.textContent).toContain('research.pdf');
    print.mockRestore();
  });

  it.each(['saved', 'cancelled', 'failed'] as const)('retains the source view and current writing when PDF export is %s before autosave', async (outcome) => {
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const source = '# Changed\n\nLiteral  *unfinished text\n\n';
    await act(async () => { harness.sourceProps?.onChange(source); });
    const sourceMounts = harness.sourceMounts;
    if (outcome === 'cancelled') files.exportPdfFile.mockResolvedValueOnce({ type: 'cancelled' });
    else if (outcome === 'failed') files.exportPdfFile.mockRejectedValueOnce(new Error('Export failed'));
    await act(async () => {
      exportAction('PDF (.pdf)')?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    expect(harness.sourceMounts).toBe(sourceMounts);
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument(source));
    expect(harness.sourceProps?.value).toBe(source);
  });

  it('includes source edits made while PDF images are still decoding', async () => {
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const initial = '# Before image decode\n\n![image](fixture.svg)\n';
    const latest = '# Written during image decode\n\n![image](fixture.svg)\n';
    await act(async () => { harness.sourceProps?.onChange(initial); });
    let resolveDecode!: () => void;
    const decoded = new Promise<void>((resolve) => { resolveDecode = resolve; });
    const image = document.createElement('img');
    image.src = 'fixture.svg';
    image.decode = vi.fn(() => decoded);
    host.querySelector('.canvas-area')!.append(image);
    let captured: JSONContent | undefined;
    files.exportPdfFile.mockImplementationOnce(async () => {
      captured = structuredClone(harness.canvasProps?.initialDocument);
      return { type: 'saved', name: 'research.pdf' };
    });
    await act(async () => {
      exportAction('PDF (.pdf)')?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(image.decode).toHaveBeenCalledOnce();
    expect(files.exportPdfFile).not.toHaveBeenCalled();
    await act(async () => {
      harness.sourceProps?.onChange(latest);
      resolveDecode();
      await flushEffects();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(captured).toEqual(markdownToDocument(latest));
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    expect(harness.sourceProps?.value).toBe(latest);
  });

  it('refreshes newly typed images before showing canvas and retains typing during image authorization', async () => {
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
      harness.sourceProps?.onChange('![first](first.svg)\n');
    });
    let authorize!: () => void;
    files.allowDocumentImageFiles.mockImplementationOnce(() => new Promise<void>((resolve) => { authorize = resolve; }));
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    const latest = 'Latest writing.\n\n![second](second.svg)\n';
    await act(async () => { harness.sourceProps?.onChange(latest); authorize(); await flushEffects(); });
    expect(files.allowDocumentImageFiles).toHaveBeenLastCalledWith(expect.objectContaining({ document: markdownToDocument(latest) }));
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument(latest));
    expect(readingModeButton('canvas').getAttribute('aria-pressed')).toBe('true');
  });

  it('authorizes newly typed images before outline navigation and includes typing during the wait', async () => {
    await showNavigationTab(getMessages().outline);
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
      harness.sourceProps?.onChange('# Destination\n\n![first](first.svg)\n');
      await vi.advanceTimersByTimeAsync(300);
    });
    let authorize!: () => void;
    files.allowDocumentImageFiles.mockImplementationOnce(() => new Promise<void>((resolve) => { authorize = resolve; }));
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('.outline-list button'))
        .find((button) => button.textContent === 'Destination')?.click();
      await flushEffects();
    });
    expect(readingModeButton('source').getAttribute('aria-pressed')).toBe('true');
    const latest = '# Destination\n\nLatest writing.\n\n![second](second.svg)\n';
    await act(async () => { harness.sourceProps?.onChange(latest); authorize(); await flushEffects(); });
    expect(files.allowDocumentImageFiles).toHaveBeenLastCalledWith(expect.objectContaining({ document: markdownToDocument(latest) }));
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument(latest));
    expect(harness.canvasProps?.outlineTarget).toEqual({ index: 0, request: 1 });
  });

  it('retains a same-path save baseline when image authorization finishes after the save', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = 'Original writing.\n';
    files.openRecent.mockResolvedValueOnce({
      path: '/tmp/recent.md', name: 'recent.md', document: markdownToDocument(original),
      sourceMarkdown: original, diskSourceMarkdown: original,
    });
    await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
    const latest = 'Latest writing.\n\n![new](new.svg)\n';
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
      harness.sourceProps?.onChange(latest);
    });
    let authorize!: () => void;
    files.allowDocumentImageFiles.mockImplementationOnce(() => new Promise<void>((resolve) => { authorize = resolve; }));
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    files.saveEditorFile.mockImplementation(async (file) => ({ ...file, diskSourceMarkdown: file.sourceMarkdown }));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));
      await flushEffects();
    });
    await act(async () => { authorize(); await flushEffects(); });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }));
      await flushEffects();
    });
    expect(files.saveEditorFile).toHaveBeenLastCalledWith(expect.objectContaining({ diskSourceMarkdown: latest }), false);
    confirm.mockRestore();
  });

  it('does not restore an older source preview after a new document replaces pending image authorization', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    let authorize!: () => void;
    files.allowDocumentImageFiles.mockImplementationOnce(() => new Promise<void>((resolve) => { authorize = resolve; }));
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
    await act(async () => { authorize(); await flushEffects(); });
    expect(host.querySelector('.document-name')?.textContent).toContain('Untitled.md');
    expect(harness.canvasProps?.initialDocument).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
    confirm.mockRestore();
  });

  it('rejects a Canvas Markdown export before entities can hide invalid Unicode', async () => {
    const document: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: '\uD800', marks: [{ type: 'italic' }] },
      { type: 'text', text: 'b' },
    ] }] };
    await act(async () => { harness.canvasProps?.onChange(document); await flushEffects(); });
    await act(async () => { exportAction('Markdown (.md)').click(); await flushEffects(); });
    expect(files.exportMarkdownFile).not.toHaveBeenCalled();
    expect(host.querySelector('.status-message')?.textContent).toContain(getMessages().invalidMarkdownUnicode);
    expect(harness.canvasProps?.initialDocument).toEqual(document);
  });

  it('retains the committed Save As destination when PDF image authorization finishes later', async () => {
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
      harness.sourceProps?.onChange('Current writing.\n');
    });
    let authorize!: () => void;
    files.allowDocumentImageFiles.mockImplementationOnce(() => new Promise<void>((resolve) => { authorize = resolve; }));
    await act(async () => { exportAction('PDF (.pdf)').click(); await flushEffects(); });
    files.saveEditorFile.mockImplementationOnce(async (file) => ({ ...file, name: 'saved-copy.md', path: '/tmp/saved-copy.md' }));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, shiftKey: true, bubbles: true }));
      await flushEffects();
    });
    await act(async () => { authorize(); await flushEffects(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(files.exportPdfFile).toHaveBeenCalledWith('saved-copy.md', expect.any(Function));
    expect(host.querySelector('.document-name')?.textContent).toContain('saved-copy.md');
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument('Current writing.\n'));
  });

  it.each(['source', 'canvas'] as const)('invalidates PDF capture when %s writing changes while the native dialog is pending', async (mode) => {
    if (mode === 'source') {
      await act(async () => {
        toggleReadingModeButton()?.click();
        await vi.advanceTimersByTimeAsync(50);
      });
    }
    let finish!: () => void;
    files.exportPdfFile.mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve({ type: 'cancelled' });
    }));
    await act(async () => {
      exportAction('PDF (.pdf)').click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const isCurrentDocument = files.exportPdfFile.mock.calls[0][1]!;
    expect(isCurrentDocument()).toBe(true);
    await act(async () => {
      if (mode === 'source') harness.sourceProps?.onChange('Latest writing.');
      else harness.canvasProps?.onChange(markdownToDocument('Latest writing.'));
      await flushEffects();
    });
    expect(isCurrentDocument()).toBe(false);
    await act(async () => { finish(); await flushEffects(); });
  });

  it('prepares the committed formula revision when blurring before PDF capture', async () => {
    const latest = markdownToDocument('Formula $\\theta$.');
    const textarea = document.createElement('textarea');
    host.querySelector('.canvas-area')!.append(textarea);
    textarea.addEventListener('blur', () => { harness.canvasProps?.onChange(latest); }, { once: true });
    textarea.focus();
    let currentAtCapture: boolean | undefined;
    files.exportPdfFile.mockImplementationOnce(async (_name, isCurrentDocument) => {
      currentAtCapture = isCurrentDocument?.();
      return { type: 'saved', name: 'research.pdf' };
    });
    await act(async () => { exportAction('PDF (.pdf)').click(); await flushEffects(); });
    expect(currentAtCapture).toBe(true);
    expect(harness.canvasProps?.initialDocument).toEqual(latest);
    expect(harness.searchHandle.flushCommentMapping).toHaveBeenCalled();
  });

  it('stores the current source in an unnamed draft for exact startup recovery', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => {
      documentAction('新增')?.click();
    });
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const sourceMarkdown = '# Draft\n\nLiteral  [source][link].\n\n[link]: https://example.com\n\n';
    await act(async () => {
      harness.sourceProps?.onChange(sourceMarkdown);
      await flushEffects();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await flushEffects();
    });
    expect(files.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ sourceMarkdown }));
    confirm.mockRestore();
  });

  it('accepts a focused filename form when native prompt is unavailable and rejects blank names', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockImplementation(() => { throw new Error('Native prompt is unavailable'); });
    try {
      await act(async () => { documentAction(getMessages().rename).click(); await flushEffects(); });
      const input = host.querySelector<HTMLInputElement>('.rename-form input[name="filename"]')!;
      expect(input.value).toBe('research.md');
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
      input.value = '   ';
      await act(async () => { input.form?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })); await flushEffects(); });
      expect(files.renameEditorFile).not.toHaveBeenCalled();
      expect(host.querySelector('.rename-form')).not.toBeNull();
      input.value = '  custom.md  ';
      await act(async () => { input.form?.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true })); await flushEffects(); });
      expect(files.renameEditorFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/research.md' }), 'custom.md');
      expect(host.querySelector('.rename-form')).toBeNull();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      prompt.mockRestore();
    }
  });

  it.each(['cancel', 'escape'] as const)('dismisses the filename form with %s without renaming', async (action) => {
    await act(async () => { documentAction(getMessages().rename).click(); await flushEffects(); });
    const form = host.querySelector<HTMLFormElement>('.rename-form')!;
    const input = form.querySelector<HTMLInputElement>('input')!;
    input.value = 'discarded.md';
    await act(async () => {
      if (action === 'cancel') namedButton(getMessages().commentCancel, form).click();
      else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await flushEffects();
    });
    expect(host.querySelector('.rename-form')).toBeNull();
    expect(files.renameEditorFile).not.toHaveBeenCalled();
    expect(host.querySelector('.document-name')?.textContent).toContain('research.md');
    expect(document.activeElement).toBe(host.querySelector('details.document-actions > summary'));
  });

  it('cancels a submitted rename when another document replaces its queued session', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishSave!: () => void;
    files.saveEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise((resolve) => {
      finishSave = () => resolve(structuredClone(candidate));
    }));
    try {
      await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
      await submitRename();
      expect(files.renameEditorFile).not.toHaveBeenCalled();
      await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
      await act(async () => { finishSave(); await flushEffects(); });
      expect(files.renameEditorFile).not.toHaveBeenCalled();
      expect(host.querySelector('.document-name')?.textContent).toContain('Untitled.md');
    } finally {
      confirm.mockRestore();
    }
  });

  it.each([false, true])('persists an unnamed document rename after its existing draft has settled (edited=%s)', async (edited) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    files.renameEditorFile.mockImplementationOnce(async (candidate: EditorFile) => ({ ...candidate, name: 'renamed.md' }));
    try {
      await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
      if (edited) {
        await act(async () => { harness.canvasProps?.onChange(markdownToDocument('# Draft content\n')); });
        await act(async () => { await vi.advanceTimersByTimeAsync(100); await flushEffects(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(1000); await flushEffects(); });
        expect(files.saveDraft).toHaveBeenCalledOnce();
      }
      files.saveDraft.mockClear();
      await submitRename();
      expect(host.querySelector('.document-name')?.textContent).toContain('renamed.md');
      await act(async () => { await vi.advanceTimersByTimeAsync(100); await flushEffects(); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); await flushEffects(); });
      expect(files.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ name: 'renamed.md', path: undefined }));
      expect(files.saveEditorFile).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it('publishes a rename history context even when the current source has no image', async () => {
    await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { harness.sourceProps?.onChange('\nBody'); });
    const revision = harness.sourceProps!.valueRevision;
    await submitRename();
    expect(harness.sourceProps?.value).toBe('\nBody');
    expect(harness.sourceProps?.valueRevision).toBe(revision);
    expect(harness.sourceProps?.assetSourcePath).toBe('/tmp/renamed.md');
    expect(harness.sourceProps?.assetSourceOperation).toBe('rename');
  });

  it('updates live Markdown image paths when a source document is renamed', async () => {
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    const source = '# Notes\n\n![Diagram](research.assets/diagram.png)\n';
    await act(async () => { harness.sourceProps?.onChange(source); });
    await submitRename();
    expect(harness.sourceProps?.value).toBe(source.replace('research.assets/', 'renamed.assets/'));
    expect(host.querySelector('.document-name')?.textContent).toContain('renamed.md');
  });

  it('refreshes renamed canvas image references without marking an unedited file dirty', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const sourceMarkdown = '# Notes\n\n![Diagram](research.assets/diagram.png)\n';
    files.openRecent.mockResolvedValueOnce({
      path: '/tmp/research.md', name: 'research.md', sourceMarkdown,
      document: markdownToDocument(sourceMarkdown),
    });
    try {
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      const documentId = harness.canvasProps!.documentId;
      await submitRename();
      expect(harness.canvasProps?.documentId).toBe(documentId + 1);
      expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument(sourceMarkdown.replace('research.assets/', 'renamed.assets/')));
      expect(host.querySelector('.dirty-dot')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(files.saveEditorFile).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it('renames clean source and canvas image paths while preserving literal paths and reference syntax', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const sourceMarkdown = '# research.assets/\r\n\r\nLiteral `research.assets/` and [Download](research.assets/download.png).\r\n\r\n![Diagram][image]\r\n\r\n[image]: <./research%2Eassets/diagram.png> "research.assets/title"\r\n\r\n<div data-src="research.assets/literal.png"><img src="research.assets/html.png"></div>\r\n\r\n![Remote](https://example.com/research.assets/remote.png)\r\n';
    const expected = sourceMarkdown.replace('./research%2Eassets/diagram.png', './renamed.assets/diagram.png').replace('research.assets/html.png', 'renamed.assets/html.png');
    files.openRecent.mockResolvedValueOnce({
      path: '/tmp/research.md', name: 'research.md', sourceMarkdown,
      document: markdownToDocument(sourceMarkdown),
    });
    try {
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      await submitRename();
      expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument(expected));
      await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
      expect(harness.sourceProps?.value).toBe(expected);
      expect(host.querySelector('.dirty-dot')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(files.saveEditorFile).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
    }
  });

  it('flushes typing that is still pending when an asynchronous rename completes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let completeRename!: (file: EditorFile) => void;
    files.renameEditorFile.mockImplementationOnce(() => new Promise((resolve) => { completeRename = resolve; }));
    const sourceMarkdown = '# Original\n\n![Diagram](research.assets/diagram.png)\n';
    files.openRecent.mockResolvedValueOnce({
      path: '/tmp/research.md', name: 'research.md', sourceMarkdown,
      document: markdownToDocument(sourceMarkdown),
    });
    try {
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      const documentId = harness.canvasProps!.documentId;
      await submitRename();
      let pending: JSONContent | undefined = markdownToDocument(sourceMarkdown.replace('# Original', '# Latest typing'));
      harness.searchHandle.flushCommentMapping.mockImplementation(() => {
        if (!pending) return;
        const document = pending;
        pending = undefined;
        harness.canvasProps?.onChange(document);
      });
      await act(async () => { harness.canvasProps?.onEdit?.(); });
      await act(async () => {
        completeRename({ path: '/tmp/renamed.md', name: 'renamed.md', document: markdownToDocument(sourceMarkdown) });
        await flushEffects();
      });
      const expected = markdownToDocument(sourceMarkdown.replace('# Original', '# Latest typing').replace('research.assets/', 'renamed.assets/'));
      expect(harness.canvasProps?.initialDocument).toEqual(expected);
      expect(harness.canvasProps?.documentId).toBe(documentId + 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); await flushEffects(); });
      expect(files.saveEditorFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/renamed.md', document: expected }), false);
    } finally {
      confirm.mockRestore();
    }
  });

  it('waits for an in-flight save and latest source typing before renaming its final file path', async () => {
    let finishSave!: () => void;
    files.saveEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise((resolve) => {
      finishSave = () => resolve(structuredClone(candidate));
    }));
    await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
    const first = '# First\n\n![Diagram](research.assets/a.png)\n';
    const latest = first.replace('# First', '# Latest') + '\nLiteral `research.assets/`.\n';
    await act(async () => { harness.sourceProps?.onChange(first); documentAction(getMessages().save).click(); await flushEffects(); });
    await submitRename();
    expect(files.renameEditorFile).not.toHaveBeenCalled();
    await act(async () => { harness.sourceProps?.onChange(latest); });
    await act(async () => { finishSave(); await flushEffects(); });
    expect(files.saveEditorFile).toHaveBeenCalledTimes(2);
    expect(files.saveEditorFile.mock.calls[1]?.[2]).toBe(latest);
    expect(files.renameEditorFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/research.md', sourceMarkdown: latest }), 'renamed.md');
    expect(host.querySelector('.document-name')?.textContent).toContain('renamed.md');
    expect(harness.sourceProps?.value).toBe(latest.replace('research.assets/a.png', 'renamed.assets/a.png'));
    expect(host.querySelector('.dirty-dot')).toBeNull();
  });

  it.each([false, true])('queues Save (Save As=%s) behind rename and saves the latest source to the renamed path', async (forceSaveAs) => {
    let finishRename!: () => void;
    files.renameEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise((resolve) => {
      finishRename = () => resolve({ ...structuredClone(candidate), path: '/tmp/renamed.md', name: 'renamed.md' });
    }));
    await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
    const first = '# First\n\n![Diagram](research.assets/a.png)\n';
    const latest = first.replace('# First', '# Latest');
    await act(async () => { harness.sourceProps?.onChange(first); });
    await submitRename();
    await act(async () => { documentAction(forceSaveAs ? getMessages().saveAs : getMessages().save).click(); await flushEffects(); });
    expect(files.saveEditorFile).not.toHaveBeenCalled();
    await act(async () => { harness.sourceProps?.onChange(latest); finishRename(); await flushEffects(); });
    const expected = latest.replace('research.assets/a.png', 'renamed.assets/a.png');
    expect(files.saveEditorFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/renamed.md', sourceMarkdown: expected }), forceSaveAs, expected);
    expect(host.querySelector('.document-name')?.textContent).toContain('renamed.md');
    expect(harness.sourceProps?.value).toBe(expected);
  });

  it.each([false, true])('keeps cancellation distinct from a write error when typing during Save As=%s', async (editWhileDialogOpen) => {
    await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
    expect(host.querySelector('.dirty-dot')).toBeNull();
    let cancelSave!: () => void;
    files.saveEditorFile.mockImplementationOnce(() => new Promise((_, reject) => {
      cancelSave = () => reject(new DOMException(getMessages().saveCancelled, 'AbortError'));
    }));
    await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
    if (editWhileDialogOpen) {
      await act(async () => { harness.canvasProps?.onChange(markdownToDocument('Latest unsaved writing')); });
    }
    await act(async () => { cancelSave(); await flushEffects(); });
    expect(host.querySelector('.save-status')?.textContent).toBe(getMessages().saveStatus[editWhileDialogOpen ? 'unsaved' : 'saved']);
    expect(host.querySelector('.status-message')?.textContent).toBe(getMessages().saveCancelled);
    expect(host.querySelector('.document-name')?.textContent).toContain('research.md');
    expect(Boolean(host.querySelector('.dirty-dot'))).toBe(editWhileDialogOpen);
    if (editWhileDialogOpen) expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument('Latest unsaved writing'));
  });

  it('cancels a queued rename when its preceding save fails', async () => {
    let failSave!: () => void;
    files.saveEditorFile.mockImplementationOnce(() => new Promise((_, reject) => {
      failSave = () => reject(new Error('Write failed before rename'));
    }));
    await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
    await submitRename();
    expect(files.renameEditorFile).not.toHaveBeenCalled();
    await act(async () => { failSave(); await flushEffects(); });
    expect(files.renameEditorFile).not.toHaveBeenCalled();
    expect(host.querySelector('.document-name')?.textContent).toContain('research.md');
    expect(host.querySelector('.status-message')?.textContent).toBe('Write failed before rename');
  });

  it('renames the path selected by a pending Save As after it completes', async () => {
    let finishSave!: () => void;
    files.saveEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise((resolve) => {
      finishSave = () => resolve({ ...structuredClone(candidate), path: '/tmp/copy.md', name: 'copy.md' });
    }));
    await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
    await submitRename();
    expect(files.renameEditorFile).not.toHaveBeenCalled();
    await act(async () => { finishSave(); await flushEffects(); });
    expect(files.renameEditorFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/copy.md', name: 'copy.md' }), 'renamed.md');
    expect(host.querySelector('.document-name')?.textContent).toContain('renamed.md');
  });

  it('preserves latest source typing while refreshing renamed asset paths and the hidden canvas', async () => {
    let completeRename!: (file: EditorFile) => void;
    files.renameEditorFile.mockImplementationOnce(() => new Promise((resolve) => { completeRename = resolve; }));
    await act(async () => { toggleReadingModeButton()?.click(); await vi.advanceTimersByTimeAsync(50); });
    const initial = '# Notes\n\n![Diagram](research.assets/diagram.png)\n';
    await act(async () => { harness.sourceProps?.onChange(initial); });
    await submitRename();
    const revision = harness.sourceProps!.valueRevision;
    const latest = initial + '\nLatest unfinished * source  .\n';
    await act(async () => { harness.sourceProps?.onChange(latest); });
    await act(async () => {
      completeRename({ path: '/tmp/renamed.md', name: 'renamed.md', document: markdownToDocument(initial) });
      await flushEffects();
    });
    const rewritten = latest.replace('research.assets/', 'renamed.assets/');
    expect(harness.sourceProps?.value).toBe(rewritten);
    expect(harness.sourceProps?.valueRevision).toBe(revision + 1);
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument(rewritten));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); await flushEffects(); });
    expect(files.saveEditorFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/renamed.md', document: markdownToDocument(rewritten) }), false, rewritten);
  });

  it.each([
    { assetsRenamed: false, withImage: false },
    { assetsRenamed: true, withImage: false },
    { assetsRenamed: false, withImage: true },
    { assetsRenamed: true, withImage: true },
  ])('adopts a surviving rename path and preserves late source typing (assets moved=$assetsRenamed, image=$withImage)', async ({ assetsRenamed, withImage }) => {
    let rejectRename!: (error: Error) => void;
    files.renameEditorFile.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRename = reject; }));
    await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
    const initial = withImage ? '# Notes\r\n\r\n![Diagram](research.assets/diagram.png)\r\n' : '# Notes\r\n';
    await act(async () => { harness.sourceProps?.onChange(initial); });
    await submitRename();
    const latest = initial + '\r\nLatest unfinished * source.\r\n';
    await act(async () => { harness.sourceProps?.onChange(latest); });
    await act(async () => {
      rejectRename(new FileRenameRecoveryError(new Error('Source write failed'), '/tmp/research.md', '/tmp/renamed.md', '/tmp/renamed.md', assetsRenamed));
      await flushEffects();
    });
    const expected = assetsRenamed ? latest.replace('research.assets/', 'renamed.assets/') : latest;
    expect(host.querySelector('.document-name')?.textContent).toContain('renamed.md');
    expect(host.querySelector('.status-message')?.textContent).toBe('Source write failed');
    expect(harness.sourceProps?.value).toBe(expected);
    expect(harness.sourceProps?.assetSourcePath).toBe('/tmp/renamed.md');
    expect(harness.sourceProps?.assetSourceOperation).toBe(assetsRenamed ? 'rename' : 'rebase');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); await vi.advanceTimersByTimeAsync(1000); await flushEffects(); });
    expect(files.saveEditorFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/renamed.md', sourceMarkdown: expected }), false, expected);
    expect(files.saveEditorFile.mock.calls.every(([candidate]) => candidate.path !== '/tmp/research.md')).toBe(true);
  });

  it('publishes a companion-asset transition when rollback restores the original filename', async () => {
    let rejectRename!: (error: Error) => void;
    files.renameEditorFile.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRename = reject; }));
    await act(async () => { readingModeButton('source').click(); await vi.advanceTimersByTimeAsync(50); });
    await act(async () => { harness.sourceProps?.onChange('\r\nBody'); });
    const revision = harness.sourceProps!.valueRevision;
    await submitRename();
    await act(async () => {
      rejectRename(new FileRenameRecoveryError(new Error('Asset rollback failed'), '/tmp/research.md', '/tmp/renamed.md', '/tmp/research.md', true));
      await flushEffects();
    });
    expect(harness.sourceProps?.value).toBe('\r\nBody');
    expect(harness.sourceProps?.valueRevision).toBe(revision);
    expect(harness.sourceProps?.assetSourcePath).toBe('/tmp/research.md');
    expect(harness.sourceProps?.assetSourceTransition).toEqual({ oldPath: '/tmp/research.md', newPath: '/tmp/renamed.md', operation: 'rename' });
    expect(host.querySelector('.status-message')?.textContent).toBe('Asset rollback failed');
  });

  it('flushes late canvas typing when rename rollback cannot restore the original path', async () => {
    let rejectRename!: (error: Error) => void;
    files.renameEditorFile.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRename = reject; }));
    await submitRename();
    let pending: JSONContent | undefined = markdownToDocument('# Latest typing\n');
    harness.searchHandle.flushCommentMapping.mockImplementation(() => {
      if (!pending) return;
      const document = pending;
      pending = undefined;
      harness.canvasProps?.onChange(document);
    });
    await act(async () => { harness.canvasProps?.onEdit?.(); });
    await act(async () => {
      rejectRename(new FileRenameRecoveryError(new Error('Rename rollback collided'), '/tmp/research.md', '/tmp/renamed.md', '/tmp/renamed.md', false));
      await flushEffects();
    });
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument('# Latest typing\n'));
    expect(host.querySelector('.document-name')?.textContent).toContain('renamed.md');
    await act(async () => { await vi.advanceTimersByTimeAsync(100); await vi.advanceTimersByTimeAsync(1000); await flushEffects(); });
    expect(files.saveEditorFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/tmp/renamed.md', document: markdownToDocument('# Latest typing\n') }), false);
  });

  it('keeps the app interactive while preventing overlapping PDF exports', async () => {
    let completeExport: ((result: { type: 'saved'; name: string }) => void) | undefined;
    files.exportPdfFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeExport = resolve;
        }),
    );
    const button = exportAction('PDF (.pdf)');

    await act(async () => {
      button?.click();
      await flushEffects();
    });

    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('.status-message')?.textContent).toContain('正在導出 PDF');
    button?.click();
    expect(files.exportPdfFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      completeExport?.({ type: 'saved', name: 'research.pdf' });
      await flushEffects();
    });

    expect(button?.disabled).toBe(false);
    expect(host.querySelector('.status-message')?.textContent).toContain('research.pdf');
  });

  it.each(['new', 'open'] as const)('invalidates pending PDF capture after %s replaces the document', async (action) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let completeExport!: (result: { type: 'saved'; name: string }) => void;
    files.exportPdfFile.mockImplementationOnce(() => new Promise((resolve) => { completeExport = resolve; }));
    try {
      await act(async () => { exportAction('PDF (.pdf)').click(); await flushEffects(); });
      const isCurrentDocument = files.exportPdfFile.mock.calls[0]?.[1];
      expect(isCurrentDocument).toBeTypeOf('function');
      expect(isCurrentDocument?.()).toBe(true);
      await act(async () => {
        if (action === 'new') documentAction(getMessages().new).click();
        else {
          files.chooseMarkdownFile.mockResolvedValueOnce({ path: '/tmp/chosen.md', name: 'chosen.md', document: markdownToDocument('New document.') });
          documentAction(getMessages().open).click();
        }
        await flushEffects();
      });
      expect(isCurrentDocument?.()).toBe(false);
      await act(async () => { completeExport({ type: 'saved', name: 'research.pdf' }); await flushEffects(); });
      expect(host.querySelector('.document-name')?.textContent).toContain(action === 'new' ? 'Untitled.md' : 'chosen.md');
      expect(host.querySelector('.status-message')?.textContent).not.toContain('research.pdf');
    } finally {
      confirm.mockRestore();
    }
  });

  it('reports a rejected native PDF export command', async () => {
    files.exportPdfFile.mockRejectedValueOnce(new Error('原生 PDF 導出失敗'));
    const button = exportAction('PDF (.pdf)');

    await act(async () => {
      button?.click();
      await flushEffects();
    });

    expect(files.exportPdfFile).toHaveBeenCalledWith('research.md', expect.any(Function));
    expect(host.querySelector('.status-message')?.textContent).toContain('原生 PDF 導出失敗');
  });

  it('sends a document-order target to the canvas when an outline heading is clicked', async () => {
    await act(async () => {
      harness.canvasProps?.onChange({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: 'First heading' }],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
          {
            type: 'heading',
            attrs: { level: 3 },
            content: [{ type: 'text', text: 'Target heading' }],
          },
        ],
      });
      await flushEffects();
    });
    const target = Array.from(host.querySelectorAll<HTMLButtonElement>('.outline-list button')).find(
      (button) => button.textContent === 'Target heading',
    );

    await act(async () => target?.click());

    expect(harness.canvasProps?.outlineTarget).toEqual({
      index: 1,
      request: 1,
    });
  });

  it('moves focus to the visible Outline tab after opening a focused Recent item', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const recent = await recentFileButton();
    await act(async () => {
      recent.focus();
      recent.click();
      await flushEffects();
    });
    const outlineTab = host.querySelector<HTMLButtonElement>('#outline-tab');
    expect(host.querySelector('#recent-panel')?.hasAttribute('hidden')).toBe(true);
    expect(outlineTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(outlineTab);
    expect(document.activeElement?.closest('[hidden]')).toBeNull();
    confirm.mockRestore();
  });

  it('protects unsaved edits when reopening the same recent path', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const opened = {
      path: '/tmp/research.md', name: 'research.md',
      document: markdownToDocument('# On disk'),
    };
    files.openRecent.mockResolvedValueOnce(opened);
    await act(async () => {
      (await recentFileButton()).click();
      await flushEffects();
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(harness.canvasProps?.initialDocument).toEqual(savedDocument);
    confirm.mockRestore();
  });

  it.each([false, true])('locates and updates source comments while preserving their history (PDF export=%s)', async (exported) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const body = 'Read [the paper][p] then target.\n\n[p]: https://example.com/paper\n';
    const from = body.indexOf('target');
    const comment = createMarkdownComment(body, { kind: 'range', from, to: from + 6 }, 'Initial note', 'target');
    const document = markdownToDocument(body);
    const canonical = documentToMarkdown(document);
    const sourceMarkdown = serializeMarkdownWithComments(body, [comment]);
    files.openRecent.mockResolvedValueOnce({
      path: '/tmp/comments.md', name: 'comments.md', document, sourceMarkdown,
      comments: relocateMarkdownComments([comment], body, canonical),
    });
    await act(async () => {
      (await recentFileButton()).click();
      await flushEffects();
    });
    await act(async () => {
      toggleReadingModeButton()?.click();
      await vi.advanceTimersByTimeAsync(50);
    });
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('.comment-card button'))
        .find((button) => button.textContent === '定位原文')?.click();
    });
    expect(harness.searchHandle.setMarkdownSelection).toHaveBeenCalledWith({ from, to: from + 6 });
    expect(host.querySelector('.dirty-dot')).toBeNull();
    await act(async () => {
      Array.from(host.querySelectorAll<HTMLButtonElement>('.comment-card button'))
        .find((button) => button.textContent === '編輯')?.click();
    });
    const input = host.querySelector<HTMLTextAreaElement>('.comment-card__editor');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, 'Updated note');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.comment-card .comment-primary')?.click();
    });
    const parsed = parseMarkdownComments(harness.sourceProps?.value ?? '');
    expect(parsed.body).toBe(body);
    expect(parsed.comments[0]).toMatchObject({ content: 'Updated note', target: { kind: 'range', from, to: from + 6 } });
    if (exported) {
      await act(async () => {
        exportAction('PDF (.pdf)').click();
        await vi.advanceTimersByTimeAsync(50);
      });
    }
    expect(harness.canvasProps?.canUndoComment).toBe(true);
    await act(async () => { harness.canvasProps?.onUndoComment?.(); await flushEffects(); });
    expect(parseMarkdownComments(harness.sourceProps?.value ?? '').comments[0].content).toBe('Initial note');
    expect(harness.canvasProps?.canRedoComment).toBe(true);
    await act(async () => { harness.canvasProps?.onRedoComment?.(); await flushEffects(); });
    expect(parseMarkdownComments(harness.sourceProps?.value ?? '').comments[0].content).toBe('Updated note');
    confirm.mockRestore();
  });

  it.each(['picker', 'recent'] as const)('ignores a stale %s failure after a new document replaces the request', async (kind) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let rejectOpen!: (error: Error) => void;
    if (kind === 'picker') files.chooseMarkdownFile.mockImplementationOnce(() => new Promise((_, reject) => { rejectOpen = reject; }));
    else files.openRecent.mockImplementationOnce(() => new Promise((_, reject) => { rejectOpen = reject; }));
    try {
      await act(async () => {
        if (kind === 'picker') documentAction(getMessages().open).click();
        else (await recentFileButton()).click();
      });
      await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
      const status = host.querySelector('.status-message')?.textContent;
      const documentId = harness.canvasProps?.documentId;
      await act(async () => { rejectOpen(new Error('Stale read failed')); await flushEffects(); });
      expect(host.querySelector('.status-message')?.textContent).toBe(status);
      expect(host.querySelector('.document-name')?.textContent).toContain('Untitled.md');
      expect(harness.canvasProps?.documentId).toBe(documentId);
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['next file', 'newer draft'] as const)('ignores a stale draft save error after %s replaces the saved revision', async (replacement) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let rejectDraft!: (error: Error) => void;
    files.saveDraft.mockImplementationOnce(() => new Promise((_, reject) => { rejectDraft = reject; }));
    try {
      await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
      await act(async () => { harness.canvasProps?.onChange(markdownToDocument('# First draft\n')); });
      await act(async () => { await vi.advanceTimersByTimeAsync(850); });
      await act(async () => {
        if (replacement === 'next file') (await recentFileButton()).click();
        else harness.canvasProps?.onChange(markdownToDocument('# Latest draft\n'));
        await flushEffects();
      });
      const status = host.querySelector('.status-message')?.textContent;
      await act(async () => { rejectDraft(new Error('Stale draft failed')); await flushEffects(); });
      expect(host.querySelector('.status-message')?.textContent).toBe(status);
      expect(host.querySelector('.status-message')?.textContent).not.toContain('Stale draft failed');
    } finally {
      confirm.mockRestore();
    }
  });

  it('keeps the latest file request when an older open finishes later', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let finishOlder: (file: EditorFile) => void = () => undefined;
    files.openRecent.mockImplementationOnce(() => new Promise<EditorFile>((resolve) => { finishOlder = resolve; }));
    files.openRecent.mockResolvedValueOnce({
      path: '/tmp/latest.md', name: 'latest.md', document: markdownToDocument('# Latest'),
    });
    await act(async () => { (await recentFileButton()).click(); });
    await act(async () => {
      (await recentFileButton()).click();
      await flushEffects();
    });
    await act(async () => {
      finishOlder({ path: '/tmp/older.md', name: 'older.md', document: markdownToDocument('# Older') });
      await flushEffects();
    });
    expect(host.querySelector('.document-name')?.textContent).toBe('latest.md');
    expect(harness.canvasProps?.initialDocument).toEqual(markdownToDocument('# Latest'));
    confirm.mockRestore();
  });

  it('shows all recent-document actions on right click and reveals the selected file', async () => {
    const recent = await recentFileButton();
    await act(async () => {
      recent?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          button: 2,
          clientX: 70,
          clientY: 90,
        }),
      );
    });

    const actions = Array.from(host.querySelectorAll<HTMLButtonElement>('.recent-context-menu [role="menuitem"]'));
    expect(actions.map((button) => button.textContent)).toEqual(['打開', '在文件夾中顯示', '於列表中隱藏']);

    await act(async () => {
      actions[1]?.click();
      await flushEffects();
    });
    expect(files.revealFileInFolder).toHaveBeenCalledWith('/tmp/recent.md');
  });

  it('persists hiding a recent document and removes it from the sidebar', async () => {
    const recent = await recentFileButton();
    await act(async () => {
      recent?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
    });
    const hide = Array.from(host.querySelectorAll<HTMLButtonElement>('.recent-context-menu [role="menuitem"]')).find(
      (button) => button.textContent === '於列表中隱藏',
    );

    await act(async () => {
      hide?.click();
      await flushEffects();
    });

    expect(files.hideRecentFile).toHaveBeenCalledWith('/tmp/recent.md');
    expect(files.removeRecentFile).not.toHaveBeenCalled();
    expect(host.querySelector('.recent-list')).toBeNull();
    expect(host.textContent).toContain('尚未有最近文件');
  });

  it('alerts and removes a recent document that no longer exists', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    files.openRecent.mockResolvedValueOnce(null as never);
    const recent = await recentFileButton();

    await act(async () => {
      recent?.click();
      await flushEffects();
    });

    expect(alert).toHaveBeenCalledWith(
      '找不到「recent.md」。文件可能已被移動、重新命名或刪除，已自動從最近文件中移除。',
    );
    expect(files.removeRecentFile).toHaveBeenCalledWith('/tmp/recent.md');
    expect(files.hideRecentFile).not.toHaveBeenCalled();
    expect(host.querySelector('.recent-list')).toBeNull();
    expect(host.textContent).toContain('尚未有最近文件');
    alert.mockRestore();
  });

  it('keeps a recent document when opening fails for a reason other than a missing file', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    files.openRecent.mockRejectedValueOnce(new Error('沒有權限讀取文件'));
    const recent = await recentFileButton();

    await act(async () => {
      recent?.click();
      await flushEffects();
    });

    expect(alert).not.toHaveBeenCalled();
    expect(files.removeRecentFile).not.toHaveBeenCalled();
    expect(files.hideRecentFile).not.toHaveBeenCalled();
    expect(host.querySelector('.recent-list button')?.textContent).toBe('recent.md');
    expect(host.querySelector('.status-message')?.textContent).toContain('沒有權限讀取文件');
    alert.mockRestore();
  });

  it('defaults to Outline and exposes Recent through tabs without rewriting the legacy preference', async () => {
    const recentPanel = host.querySelector('.recent-list')?.closest<HTMLElement>('[role="tabpanel"]');
    expect(recentPanel?.hidden).toBe(true);
    await showNavigationTab(getMessages().recentFiles);
    expect(recentPanel?.hidden).toBe(false);
    expect(await recentFileButton()).toBeDefined();
    await showNavigationTab(getMessages().outline);
    expect(recentPanel?.hidden).toBe(true);
    expect(files.savePreferences).not.toHaveBeenCalledWith(expect.objectContaining({ recentFilesExpanded: false }));
  });

  it('retains an untouched recovered draft record through autosave delays and reading-mode switches', async () => {
    await act(async () => root.unmount());
    files.loadDraft.mockResolvedValueOnce({ name: 'Recovered.md', document: savedDocument, comments: [], commentWarning: 'Damaged comments kept on disk' });
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    await act(async () => { readingModeButton('source').click(); await flushEffects(); });
    await act(async () => { readingModeButton('canvas').click(); await flushEffects(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(files.saveDraft).not.toHaveBeenCalled();
    expect(host.querySelector('.dirty-dot')).not.toBeNull();
    expect(host.querySelector('.status-message')?.textContent).toBe('Damaged comments kept on disk');
  });

  it('closes an untouched recovered draft without replacing its retained recovery data', async () => {
    const close = await startNative({ name: 'Recovered.md', document: savedDocument, comments: [], commentWarning: 'Damaged comments kept on disk' });
    await act(async () => { await close({ preventDefault: vi.fn() }); });
    expect(files.saveDraft).not.toHaveBeenCalled();
    expect(files.flushSettings).toHaveBeenCalledOnce();
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it('does not repeat a successful draft autosave when closing the same revision', async () => {
    const close = await startNative({ name: 'Recovered.md', document: savedDocument });
    const latest = markdownToDocument('Edited after recovery');
    await act(async () => { harness.canvasProps?.onChange(latest); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(files.saveDraft).toHaveBeenCalledOnce();
    expect(files.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ document: latest }));
    await act(async () => { await close({ preventDefault: vi.fn() }); });
    expect(files.saveDraft).toHaveBeenCalledOnce();
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it('retries a failed draft autosave before closing the unchanged revision', async () => {
    const close = await startNative({ name: 'Recovered.md', document: savedDocument });
    files.saveDraft.mockRejectedValueOnce(new Error('Recovery disk full'));
    const latest = markdownToDocument('Must remain recoverable');
    await act(async () => { harness.canvasProps?.onChange(latest); });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(files.saveDraft).toHaveBeenCalledOnce();
    expect(host.querySelector('.save-status')?.textContent).toBe(getMessages().saveStatus.error);
    await act(async () => { await close({ preventDefault: vi.fn() }); });
    expect(files.saveDraft).toHaveBeenCalledTimes(2);
    expect(files.saveDraft.mock.calls.at(-1)?.[0].document).toEqual(latest);
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it('saves edits arriving while an unnamed close write is pending before destroying the window', async () => {
    const close = await startNative({ name: 'Recovered.md', document: savedDocument });
    let finishDraft!: () => void;
    files.saveDraft.mockImplementationOnce(() => new Promise<void>((resolve) => { finishDraft = resolve; }));
    await act(async () => { harness.canvasProps?.onChange(markdownToDocument('First edit')); });
    let closing!: Promise<void>;
    await act(async () => { closing = close({ preventDefault: vi.fn() }); await flushEffects(); });
    const latest = markdownToDocument('Late edit during close');
    await act(async () => { harness.canvasProps?.onChange(latest); });
    await act(async () => { finishDraft(); await closing; });
    expect(files.saveDraft).toHaveBeenCalledTimes(2);
    expect(files.saveDraft.mock.calls.at(-1)?.[0].document).toEqual(latest);
    expect(native.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    { source: false, saveAs: false },
    { source: true, saveAs: false },
    { source: false, saveAs: true },
    { source: true, saveAs: true },
  ])('adopts the committed disk baseline before saving typing that arrived mid-write ($source, $saveAs)', async ({ source, saveAs }) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const original = '# Original\r\n';
    const first = '# First revision\n';
    const second = '# Second revision\n';
    const destination = saveAs ? '/copies/shared.md' : '/tmp/recent.md';
    files.openRecent.mockResolvedValueOnce({ path: '/tmp/recent.md', name: 'recent.md', sourceMarkdown: original, diskSourceMarkdown: original, document: markdownToDocument(original) });
    try {
      await act(async () => { (await recentFileButton()).click(); await flushEffects(); });
      if (source) await act(async () => { readingModeButton('source').click(); await flushEffects(); });
      await act(async () => {
        if (source) harness.sourceProps?.onChange(first);
        else harness.canvasProps?.onChange(markdownToDocument(first));
      });
      let finishSave!: () => void;
      files.saveEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise<EditorFile>((resolve) => {
        finishSave = () => resolve({ ...candidate, path: destination, name: 'shared.md', sourceMarkdown: first, diskSourceMarkdown: first });
      }));
      await act(async () => { documentAction(saveAs ? getMessages().saveAs : getMessages().save).click(); await flushEffects(); });
      expect(files.saveEditorFile.mock.calls[0][0].diskSourceMarkdown).toBe(original);
      await act(async () => {
        if (source) harness.sourceProps?.onChange(second);
        else harness.canvasProps?.onChange(markdownToDocument(second));
      });
      await act(async () => { finishSave(); await flushEffects(); });
      const latest = files.saveEditorFile.mock.calls[1][0] as EditorFile;
      expect(latest.path).toBe(destination);
      expect(latest.diskSourceMarkdown).toBe(first);
      expect(documentToMarkdown(latest.document)).toBe(second);
      if (source) expect(latest.sourceMarkdown).toBe(second);
    } finally {
      confirm.mockRestore();
    }
  });

  it.each(['source', 'canvas'] as const)('backs up failed named %s writing independently while retaining the close error and dirty state', async (mode) => {
    const close = await startNative();
    const latest = '\uFEFF# Latest 中文\r\n\r\n![Diagram](images/a.svg)\r\n';
    if (mode === 'source') await act(async () => { readingModeButton('source').click(); await flushEffects(); });
    await act(async () => {
      if (mode === 'source') harness.sourceProps?.onChange(latest);
      else harness.canvasProps?.onChange(markdownToDocument(latest));
    });
    files.saveEditorFile.mockRejectedValueOnce(new Error('Document changed on disk'));
    await act(async () => { await close({ preventDefault: vi.fn() }); });
    expect(files.saveDraft).toHaveBeenCalledOnce();
    const backup = files.saveDraft.mock.calls[0][0];
    expect(backup.path).toBe('/tmp/research.md');
    if (mode === 'source') expect(backup.sourceMarkdown).toBe(latest);
    else expect(backup.document).toEqual(markdownToDocument(latest));
    expect(host.querySelector('.save-status')?.textContent).toBe(getMessages().saveStatus.error);
    expect(host.querySelector('.status-message')?.textContent).toBe('Document changed on disk');
    expect(host.querySelector('.dirty-dot')).not.toBeNull();
    expect(native.destroy).not.toHaveBeenCalled();
  });

  it('does not replace recovery data when a Save As dialog is cancelled', async () => {
    files.saveEditorFile.mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
    await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
    expect(files.saveDraft).not.toHaveBeenCalled();
    expect(host.querySelector('.save-status')?.textContent).toBe(getMessages().saveStatus.unsaved);
  });

  it.each(['source', 'canvas'] as const)('resnapshots %s typing that arrives during a failed-save recovery write', async (mode) => {
    if (mode === 'source') await act(async () => { readingModeButton('source').click(); await flushEffects(); });
    files.saveEditorFile.mockRejectedValueOnce(new Error('Read-only file'));
    let finishBackup!: () => void;
    files.saveDraft.mockImplementationOnce(() => new Promise<void>((resolve) => { finishBackup = resolve; }));
    await act(async () => {
      if (mode === 'source') harness.sourceProps?.onChange('# First\r\n');
      else harness.canvasProps?.onChange(markdownToDocument('# First\n'));
      documentAction(getMessages().save).click();
      await flushEffects();
    });
    expect(files.saveDraft).toHaveBeenCalledOnce();
    const latest = '# Latest during backup\r\n\r\nExact  spaces\r\n';
    await act(async () => {
      if (mode === 'source') harness.sourceProps?.onChange(latest);
      else harness.canvasProps?.onChange(markdownToDocument(latest));
      finishBackup();
      await flushEffects();
    });
    expect(files.saveDraft).toHaveBeenCalledTimes(2);
    const backup = files.saveDraft.mock.calls[1][0];
    if (mode === 'source') expect(backup.sourceMarkdown).toBe(latest);
    else expect(backup.document).toEqual(markdownToDocument(latest));
    expect(host.querySelector('.status-message')?.textContent).toBe('Read-only file');
    expect(host.querySelector('.dirty-dot')).not.toBeNull();
  });

  it.each([false, true])('ignores a stale named-save backup completion after a new document replaces its session (rejected=%s)', async (rejected) => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    files.saveEditorFile.mockRejectedValueOnce(new Error('Old document failed'));
    let finish!: () => void;
    files.saveDraft.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = rejected ? () => reject(new Error('Old backup failed')) : resolve; }));
    try {
      await act(async () => { documentAction(getMessages().save).click(); await flushEffects(); });
      expect(files.saveDraft).toHaveBeenCalledOnce();
      await act(async () => { documentAction(getMessages().new).click(); await flushEffects(); });
      const status = host.querySelector('.status-message')?.textContent;
      await act(async () => { finish(); await flushEffects(); });
      expect(host.querySelector('.status-message')?.textContent).toBe(status);
      expect(host.querySelector('.document-name')?.textContent).toBe('Untitled.md');
      expect(host.querySelector('.save-status')?.textContent).toBe(getMessages().saveStatus.saved);
    } finally { confirm.mockRestore(); }
  });

  it('retains both the original save error and a recovery-write failure without closing', async () => {
    const close = await startNative();
    files.saveEditorFile.mockRejectedValueOnce(new Error('Original disk conflict'));
    files.saveDraft.mockRejectedValueOnce(new Error('Recovery disk full'));
    await act(async () => { await close({ preventDefault: vi.fn() }); });
    expect(host.querySelector('.status-message')?.textContent).toContain('Original disk conflict');
    expect(host.querySelector('.status-message')?.textContent).toContain('Recovery disk full');
    expect(host.querySelector('.dirty-dot')).not.toBeNull();
    expect(native.destroy).not.toHaveBeenCalled();
  });

  it.each(['source', 'canvas'] as const)('rebases recovered relative assets in latest %s typing during its first Save As', async (mode) => {
    await act(async () => root.unmount());
    const origin = '/tmp/origin/notes.md';
    const destination = '/copies/notes.md';
    const sourceMarkdown = '# Recovered\r\n\r\n![Diagram](images/a.svg)\r\n';
    const recovered: EditorFile = { name: 'notes.md', recoverySourcePath: origin, sourceMarkdown, document: markdownToDocument(sourceMarkdown) };
    files.loadDraft.mockResolvedValueOnce(recovered);
    root = createRoot(host);
    await act(async () => { root.render(<App />); await flushEffects(); });
    if (mode === 'source') await act(async () => { readingModeButton('source').click(); await flushEffects(); });
    let finishSave!: () => void;
    files.saveEditorFile.mockImplementationOnce((candidate: EditorFile) => new Promise<EditorFile>((resolve) => {
      finishSave = () => {
        const saved = rebaseEditorFileAssets(candidate, origin, destination);
        resolve({ ...saved, diskSourceMarkdown: saved.sourceMarkdown });
      };
    }));
    await act(async () => { documentAction(getMessages().saveAs).click(); await flushEffects(); });
    const latest = sourceMarkdown + '\r\n![Late image](images/b.svg)\r\n';
    await act(async () => {
      if (mode === 'source') harness.sourceProps?.onChange(latest);
      else harness.canvasProps?.onChange(markdownToDocument(latest));
      finishSave();
      await flushEffects();
    });
    const candidate = files.saveEditorFile.mock.calls[1][0] as EditorFile;
    expect(candidate.path).toBe(destination);
    expect(documentToMarkdown(candidate.document)).toContain('../tmp/origin/images/b.svg');
    expect(documentToMarkdown(candidate.document)).not.toContain('../tmp/origin/../tmp/origin');
    if (mode === 'source') expect(candidate.sourceMarkdown).toBe(latest.replaceAll('(images/', '(../tmp/origin/images/'));
  });
});
