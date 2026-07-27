import type { JSONContent } from '@tiptap/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

type CanvasProps = {
  documentId: number;
  initialDocument: JSONContent;
  onChange: (document: JSONContent) => void;
};

const harness = vi.hoisted(() => ({ canvasProps: null as CanvasProps | null }));

const files = vi.hoisted(() => ({
  clearDraft: vi.fn(async () => undefined),
  exportMarkdownFile: vi.fn(async () => 'research.md'),
  loadDraft: vi.fn(),
  loadPreferences: vi.fn(async () => ({
    theme: 'light' as const,
    font: 'system' as const,
    fontSize: 18,
    sidebarOpen: true,
  })),
  loadRecent: vi.fn(async () => []),
  saveEditorFile: vi.fn(),
  saveDraft: vi.fn(async () => undefined),
  savePreferences: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('./components/CanvasEditor', () => ({
  CanvasEditor: (props: CanvasProps) => {
    harness.canvasProps = props;
    return null;
  },
}));
vi.mock('./components/MarkdownSourceEditor', () => ({ MarkdownSourceEditor: () => null }));
vi.mock('./lib/files', () => ({
  chooseMarkdownFile: vi.fn(async () => null),
  clearDraft: files.clearDraft,
  documentToPortableMarkdown: (document: JSONContent) => {
    const text = document.content?.[0]?.content?.[0]?.text ?? '';
    return `${text}\n`;
  },
  exportMarkdownFile: files.exportMarkdownFile,
  loadDraft: files.loadDraft,
  loadPreferences: files.loadPreferences,
  loadRecent: files.loadRecent,
  newEditorFile: () => ({
    name: 'Untitled.md',
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
  }),
  openMarkdownFile: vi.fn(),
  openRecent: vi.fn(),
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
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '中間新增文字' }] }],
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
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一版＋新輸入' }] }],
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

  it('opens the system print flow for PDF export', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('PDF (.pdf)'),
    );

    await act(async () => {
      button?.click();
      await vi.advanceTimersByTimeAsync(20);
      await flushEffects();
    });

    expect(print).toHaveBeenCalledOnce();
    expect(host.querySelector('.status-message')?.textContent).toContain('儲存為 PDF');
    print.mockRestore();
  });

  it('reports a rejected native PDF print command', async () => {
    const print = vi
      .spyOn(window, 'print')
      .mockImplementation(() => Promise.reject(new Error('系統拒絕列印')) as unknown as void);
    const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('PDF (.pdf)'),
    );

    await act(async () => {
      button?.click();
      await vi.advanceTimersByTimeAsync(20);
      await flushEffects();
    });

    expect(print).toHaveBeenCalledOnce();
    expect(host.querySelector('.status-message')?.textContent).toContain('系統拒絕列印');
    print.mockRestore();
  });
});
