import type { JSONContent } from '@tiptap/core';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { SwitchableEditorHandle } from './editor/search';

type CanvasProps = {
  documentId: number;
  initialDocument: JSONContent;
  outlineTarget?: { index: number; request: number };
  onChange: (document: JSONContent) => void;
};

const harness = vi.hoisted(() => ({
  canvasProps: null as CanvasProps | null,
  canvasMounts: 0,
  canvasUnmounts: 0,
  searchHandle: {
    search: vi.fn<(query: string, direction: 'reset' | 'next' | 'previous') => { current: number; total: number }>(
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
    setDocumentSelection: vi.fn(() => true),
    isFocused: vi.fn(() => false),
    requestMeasure: vi.fn(),
  },
}));

const files = vi.hoisted(() => ({
  clearDraft: vi.fn(async () => undefined),
  exportMarkdownFile: vi.fn(async () => 'research.md'),
  exportPdfFile: vi.fn(async () => ({
    type: 'saved' as const,
    name: 'research.pdf',
  })),
  loadDraft: vi.fn(),
  loadPreferences: vi.fn(async () => ({
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
  openRecent: vi.fn(async () => ({
    path: '/tmp/recent.md',
    name: 'recent.md',
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
  })),
  removeRecentFile: vi.fn(async () => []),
  revealFileInFolder: vi.fn(async () => undefined),
  saveEditorFile: vi.fn(),
  saveDraft: vi.fn(async () => undefined),
  savePreferences: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
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
  MarkdownSourceEditor: (props: { ref?: React.Ref<SwitchableEditorHandle>; onReady?: () => void }) => {
    const { onReady } = props;
    if (typeof props.ref === 'function') props.ref(harness.searchHandle);
    if (props.ref && typeof props.ref === 'object') props.ref.current = harness.searchHandle;
    useEffect(() => {
      onReady?.();
    }, [onReady]);
    return null;
  },
}));
vi.mock('./lib/files', () => ({
  chooseMarkdownFile: vi.fn(async () => null),
  clearDraft: files.clearDraft,
  documentToPortableMarkdown: (document: JSONContent) => {
    const text = document.content?.[0]?.content?.[0]?.text ?? '';
    return `${text}\n`;
  },
  exportMarkdownFile: files.exportMarkdownFile,
  exportPdfFile: files.exportPdfFile,
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
  removeRecentFile: files.removeRecentFile,
  revealFileInFolder: files.revealFileInFolder,
  renameEditorFile: vi.fn(),
  saveDraft: files.saveDraft,
  saveEditorFile: files.saveEditorFile,
  savePreferences: files.savePreferences,
}));

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

  beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
  afterAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false }));

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    harness.canvasProps = null;
    harness.canvasMounts = 0;
    harness.canvasUnmounts = 0;
    let activeSearchResult = 0;
    harness.searchHandle.search.mockImplementation((query, direction) => {
      if (!query) return { current: 0, total: 0 };
      if (direction === 'next') activeSearchResult = (activeSearchResult % 3) + 1;
      else if (direction === 'previous') activeSearchResult = ((activeSearchResult + 1) % 3) + 1;
      else activeSearchResult = 1;
      return { current: activeSearchResult, total: 3 };
    });
    harness.searchHandle.getSelectedText.mockReturnValue('');
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

  it('keeps the canvas mounted and does not reload an unchanged Markdown round trip', async () => {
    const initialDocumentId = harness.canvasProps?.documentId;
    const showSource = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '顯示原始 Markdown',
    );

    await act(async () => {
      showSource?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(host.querySelector('.editor-mode-pane--canvas')?.hasAttribute('hidden')).toBe(true);
    expect(harness.canvasMounts).toBe(1);
    expect(harness.canvasUnmounts).toBe(0);

    const backToCanvas = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '返回畫布',
    );
    await act(async () => {
      backToCanvas?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(harness.canvasProps?.documentId).toBe(initialDocumentId);
    expect(host.querySelector('.editor-mode-pane--canvas')?.hasAttribute('hidden')).toBe(false);
    expect(harness.canvasMounts).toBe(1);
    expect(harness.canvasUnmounts).toBe(0);
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
    const showSource = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '顯示原始 Markdown',
    );

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
    const showSource = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '顯示原始 Markdown',
    );

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
    const showSource = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '顯示原始 Markdown',
    );

    await act(async () => {
      showSource?.click();
      await flushEffects();
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(harness.searchHandle.setMarkdownOffset).toHaveBeenCalledWith(3);
    expect(harness.searchHandle.focus).toHaveBeenCalled();

    harness.searchHandle.setDocumentSelection.mockClear();
    harness.searchHandle.getMarkdownOffset.mockReturnValue(5);
    const backToCanvas = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === '返回畫布',
    );
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

  it('exports a Markdown copy without changing the active file', async () => {
    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Markdown (.md)'),
    );

    await act(async () => {
      button?.click();
      await flushEffects();
    });

    expect(files.exportMarkdownFile).toHaveBeenCalledWith('原始內容\n', 'research.md');
    expect(host.querySelector('.document-name')?.textContent).toContain('research.md');
  });

  it('switches the full interface among all three languages and saves the preference', async () => {
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
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === '新建')).toBe(true);
    expect(document.documentElement.lang).toBe('zh-Hans');

    await switchLanguage('en');
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'New')).toBe(true);
    expect(document.documentElement.lang).toBe('en');

    await switchLanguage('zh-Hant');
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === '新增')).toBe(true);
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

  it('applies and persists an adjusted line spacing without marking the document dirty', async () => {
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
    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('PDF (.pdf)'),
    );

    await act(async () => {
      button?.click();
      await flushEffects();
    });

    expect(files.exportPdfFile).toHaveBeenCalledWith('research.md');
    expect(print).not.toHaveBeenCalled();
    expect(document.documentElement.className).not.toContain('pdf-export');
    expect(host.querySelector('.status-message')?.textContent).toContain('research.pdf');
    print.mockRestore();
  });

  it('keeps the app interactive while preventing overlapping PDF exports', async () => {
    let completeExport: ((result: { type: 'saved'; name: string }) => void) | undefined;
    files.exportPdfFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeExport = resolve;
        }),
    );
    const button = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((candidate) =>
      candidate.textContent?.includes('PDF (.pdf)'),
    );

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

  it('reports a rejected native PDF export command', async () => {
    files.exportPdfFile.mockRejectedValueOnce(new Error('原生 PDF 導出失敗'));
    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('PDF (.pdf)'),
    );

    await act(async () => {
      button?.click();
      await flushEffects();
    });

    expect(files.exportPdfFile).toHaveBeenCalledWith('research.md');
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

  it('shows all recent-document actions on right click and reveals the selected file', async () => {
    const recent = host.querySelector<HTMLButtonElement>('.recent-list button');
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
    const recent = host.querySelector<HTMLButtonElement>('.recent-list button');
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
    const recent = host.querySelector<HTMLButtonElement>('.recent-list button');

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
    const recent = host.querySelector<HTMLButtonElement>('.recent-list button');

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

  it('collapses recent documents while keeping the outline visible and persists the choice', async () => {
    const toggle = host.querySelector<HTMLButtonElement>('.sidebar-section-toggle');

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.recent-list')).not.toBeNull();
    expect(host.textContent).toContain('大綱');

    await act(async () => {
      toggle?.click();
      await flushEffects();
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.title).toBe('展開最近文件');
    expect(host.querySelector('#recent-files-panel')).toBeNull();
    expect(host.textContent).toContain('大綱');
    expect(files.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ recentFilesExpanded: false }));
  });
});
