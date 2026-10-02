import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages } from '../i18n';
import { exportMarkdownFile, saveDraft, saveEditorFile } from './files';

const mocks = vi.hoisted(() => ({ desktop: false, invoke: vi.fn(), createUrl: vi.fn(), revokeUrl: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => mocks.desktop,
  convertFileSrc: (path: string) => path,
  invoke: mocks.invoke,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: async () => '/notes/copy.md', open: vi.fn(), confirm: vi.fn() }));
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({ get: async () => [], set: vi.fn() }) } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = false;
  mocks.createUrl.mockReturnValue('blob:test');
  vi.stubGlobal('URL', { createObjectURL: mocks.createUrl, revokeObjectURL: mocks.revokeUrl });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const file = (sourceMarkdown: string) => ({ path: '/notes/original.md', name: 'original.md', sourceMarkdown, document: { type: 'doc', content: [{ type: 'paragraph' }] } });

describe('lossless Unicode Markdown writes', () => {
  it.each(['Before\ud800 after', 'Before\udc00 after', '😀\ud800x'])('rejects incomplete UTF-16 %j before browser export or native save can replace it', async (source) => {
    await expect(exportMarkdownFile(source, 'original.md')).rejects.toThrow(getMessages().invalidMarkdownUnicode);
    expect(mocks.createUrl).not.toHaveBeenCalled();
    mocks.desktop = true;
    await expect(saveEditorFile(file(source))).rejects.toThrow(getMessages().invalidMarkdownUnicode);
    await expect(exportMarkdownFile(source, 'original.md')).rejects.toThrow(getMessages().invalidMarkdownUnicode);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(file(source).sourceMarkdown).toBe(source);
  });

  it('accepts complete emoji pairs, multilingual text, BOM, line endings, and NUL without changing them', async () => {
    const source = '\uFEFF# 中文 😀 🧪\r\nLiteral\0text\r\n';
    await expect(exportMarkdownFile(source, 'original.md')).resolves.toBe('original.md');
    expect(mocks.createUrl).toHaveBeenCalledOnce();
    mocks.desktop = true;
    await saveEditorFile(file(source));
    expect(mocks.invoke).toHaveBeenCalledWith('write_markdown_file', { path: '/notes/original.md', contents: source });
  });

  it('retains incomplete Unicode in the opaque recovery record so unsaved writing can still be recovered', async () => {
    mocks.desktop = true;
    const source = 'Recoverable\ud800writing';
    await saveDraft(file(source));
    const serialized = mocks.invoke.mock.calls[0]?.[1]?.contents as string;
    expect(JSON.parse(serialized).sourceMarkdown).toBe(source);
    expect(serialized).toContain('\\ud800');
  });
});
