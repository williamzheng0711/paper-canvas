import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownToDocument } from '../editor/markdown';
import { getMessages } from '../i18n';
import { openMarkdownFile, openRecent, renameEditorFile, saveEditorFile } from './files';

const mocks = vi.hoisted(() => ({
  entries: new Map<string, Uint8Array>(),
  readFile: vi.fn(),
  invoke: vi.fn(),
  storeSet: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: mocks.invoke,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: mocks.readFile,
  exists: async (path: string) => mocks.entries.has(path),
  mkdir: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: async () => ({ get: async () => [], set: mocks.storeSet }) },
}));

const path = '/notes/encoding.md';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.entries.clear();
  mocks.readFile.mockImplementation(async (path: string) => {
    const bytes = mocks.entries.get(path);
    if (!bytes) throw new Error('Missing file');
    return bytes;
  });
  mocks.invoke.mockImplementation(async (command: string, args: { path: string; contents: string; source: string; target: string }) => {
    if (command === 'write_markdown_file') mocks.entries.set(args.path, new TextEncoder().encode(args.contents));
    if (command === 'rename_document_entry') {
      const bytes = mocks.entries.get(args.source);
      if (!bytes || mocks.entries.has(args.target)) throw new Error('Rename failed');
      mocks.entries.set(args.target, bytes);
      mocks.entries.delete(args.source);
    }
  });
});

describe('lossless UTF-8 file reads', () => {
  it.each([
    { name: 'Latin-1', bytes: [0x63, 0x61, 0x66, 0xe9] },
    { name: 'UTF-16 little-endian BOM', bytes: [0xff, 0xfe, 0x23, 0x00, 0x20, 0x00, 0x41, 0x00] },
    { name: 'UTF-16 big-endian BOM', bytes: [0xfe, 0xff, 0x00, 0x23, 0x00, 0x20, 0x00, 0x41] },
    { name: 'truncated UTF-8 character', bytes: [0x23, 0x20, 0xe2, 0x82] },
    { name: 'overlong UTF-8 sequence', bytes: [0xc0, 0xaf] },
    { name: 'invalid continuation byte', bytes: [0xe2, 0x28, 0xa1] },
  ])('rejects $name before it can enter either open route or recent history', async ({ bytes }) => {
    const original = new Uint8Array(bytes);
    mocks.entries.set(path, original);
    await expect(openMarkdownFile(path)).rejects.toThrow(getMessages().unsupportedMarkdownEncoding);
    await expect(openRecent({ path, name: 'encoding.md' })).rejects.toThrow(getMessages().unsupportedMarkdownEncoding);
    expect(mocks.storeSet).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.entries.get(path)).toEqual(original);
  });

  it.each(['\uFEFF# Heading\r\n\r\n研究 😀.\r\n', '# Literal replacement �\n', '# Empty\u0000byte\n', ''])('preserves every UTF-8 byte when an unchanged file is saved: %j', async (source) => {
    const original = new TextEncoder().encode(source);
    mocks.entries.set(path, original);
    const opened = await openMarkdownFile(path);
    expect(opened.sourceMarkdown).toBe(source);
    const saved = await saveEditorFile(opened);
    expect(saved.sourceMarkdown).toBe(source);
    expect(mocks.entries.get(path)).toEqual(original);
    const recent = await openRecent({ path, name: 'encoding.md' });
    expect(recent?.sourceMarkdown).toBe(source);
  });

  it('restores the original filename and bytes if an externally changed encoding is detected during rename', async () => {
    const original = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);
    mocks.entries.set(path, original);
    await expect(renameEditorFile({ path, name: 'encoding.md', document: markdownToDocument('Earlier valid contents.\n') }, 'renamed.md')).rejects.toThrow(getMessages().unsupportedMarkdownEncoding);
    expect(mocks.entries.get(path)).toEqual(original);
    expect(mocks.entries.has('/notes/renamed.md')).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'write_markdown_file')).toBe(false);
    expect(mocks.storeSet).not.toHaveBeenCalled();
  });
});
