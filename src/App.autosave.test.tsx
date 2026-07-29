import type { JSONContent } from '@tiptap/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

type CanvasProps = {
  documentId: number;
  initialDocument: JSONContent;
  outlineTarget?: { index: number; request: number };
  onChange: (document: JSONContent) => void;
};

const harness = vi.hoisted(() => ({ canvasProps: null as CanvasProps | null }));

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
    sidebarOpen: true,
    language: 'zh-Hant' as const,
  })),
  hideRecentFile: vi.fn(async () => []),
  loadRecent: vi.fn(async () => [{ path: '/tmp/recent.md', name: 'recent.md' }]),
  openRecent: vi.fn(async () => ({
    path: '/tmp/recent.md',
    name: 'recent.md',
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
  })),
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
  CanvasEditor: (props: CanvasProps) => {
    harness.canvasProps = props;
    return null;
  },
}));
vi.mock('./components/MarkdownSourceEditor', () => ({
  MarkdownSourceEditor: () => null,
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
  loadDraft: files.loadDraft,
  loadPreferences: files.loadPreferences,
  loadRecent: files.loadRecent,
  newEditorFile: () => ({
    name: 'Untitled.md',
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
  }),
  openMarkdownFile: vi.fn(),
  openRecent: files.openRecent,
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
    expect(host.querySelector('.recent-list')).toBeNull();
    expect(host.textContent).toContain('尚未有最近文件');
  });
});
