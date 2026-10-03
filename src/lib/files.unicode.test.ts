import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages } from '../i18n';
import { exportMarkdownFile, saveDraft, saveEditorFile, validateDocumentUnicode } from './files';
import type { JSONContent } from '@tiptap/core';

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

  it.each([
    { type: 'paragraph', content: [{ type: 'text', text: 'Before\ud800 after' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'text', text: '\ud800', marks: [{ type: 'italic' }] }, { type: 'text', text: 'b' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'text', text: '\udc00', marks: [{ type: 'bold' }] }, { type: 'text', text: 'b' }] },
    { type: 'paragraph', content: [{ type: 'inlineFormula', attrs: { latex: 'x\ud800+y' } }] },
    { type: 'htmlPreview', attrs: { source: '<div>Before\udc00 after</div>' } },
    { type: 'image', attrs: { src: 'data:image/png;base64,AQ==', alt: 'Caption\ud800' } },
    { type: 'paragraph', content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href: 'https://example.com/\udc00' } }] }] },
  ] as JSONContent[])('rejects invalid Canvas Unicode before entities or serialized markup can hide it: %j', async (node) => {
    mocks.desktop = true;
    const document = { type: 'doc', content: [node] };
    await expect(saveEditorFile({ path: '/notes/original.md', name: 'original.md', document })).rejects.toThrow(getMessages().invalidMarkdownUnicode);
    expect(() => validateDocumentUnicode(document)).toThrow(getMessages().invalidMarkdownUnicode);
    expect(mocks.invoke).not.toHaveBeenCalled();
    await saveDraft({ path: '/notes/original.md', name: 'original.md', document });
    expect(JSON.parse(mocks.invoke.mock.calls[0][1].contents).document).toEqual(document);
  });

  it('accepts corrected authoritative source despite an older invalid Canvas cache', async () => {
    mocks.desktop = true;
    const document = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Earlier\ud800cache' }] }] };
    const sourceMarkdown = '# Corrected 中文 🧪\r\n';
    await saveEditorFile({ path: '/notes/original.md', name: 'original.md', document, sourceMarkdown });
    expect(mocks.invoke).toHaveBeenCalledWith('write_markdown_file', { path: '/notes/original.md', contents: sourceMarkdown });
  });
});
