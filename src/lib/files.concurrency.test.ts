import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownToDocument } from '../editor/markdown';
import { getMessages } from '../i18n';
import { openMarkdownFile, openRecent, renameEditorFile, saveEditorFile, type EditorFile } from './files';

const mocks = vi.hoisted(() => ({
  entries: new Map<string, Uint8Array>(),
  invoke: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: mocks.invoke,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save, open: vi.fn(), confirm: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: async (path: string) => {
    const bytes = mocks.entries.get(path);
    if (!bytes) throw new Error('Missing file');
    return bytes;
  },
  exists: async (path: string) => mocks.entries.has(path),
  mkdir: vi.fn(), rename: vi.fn(), writeFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: async () => ({ get: async () => [], set: async () => undefined }) },
}));

const path = '/notes/shared.md';
const bytes = (text: string) => new TextEncoder().encode(text);
function edited(file: EditorFile, source: string, canvas = false): EditorFile {
  return { ...file, document: markdownToDocument(source), sourceMarkdown: canvas ? undefined : source };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.entries.clear();
  mocks.invoke.mockImplementation(async (command: string, args?: { path: string; contents: string; expectedContents?: string; source: string; target: string }) => {
    if (command === 'write_markdown_file') {
      if (args!.expectedContents !== undefined) {
        const current = mocks.entries.get(args!.path);
        const expected = bytes(args!.expectedContents);
        if (!current || !current.every((value, index) => value === expected[index]) || current.length !== expected.length) {
          throw 'DOCUMENT_CHANGED_ON_DISK';
        }
      }
      mocks.entries.set(args!.path, bytes(args!.contents));
    }
    if (command === 'rename_document_entry') {
      const current = mocks.entries.get(args!.source);
      if (!current || mocks.entries.has(args!.target)) throw new Error('Rename failed');
      mocks.entries.set(args!.target, current);
      mocks.entries.delete(args!.source);
    }
  });
});

describe('external document changes', () => {
  it('retains an exact disk baseline through both open routes and successive normal saves', async () => {
    const original = '\uFEFF# Original 中文\r\n';
    mocks.entries.set(path, bytes(original));
    const opened = await openMarkdownFile(path);
    expect(opened.diskSourceMarkdown).toBe(original);
    expect((await openRecent({ path, name: 'shared.md' }))?.diskSourceMarkdown).toBe(original);
    const unchanged = await saveEditorFile(opened);
    expect(unchanged.diskSourceMarkdown).toBe(original);
    expect(mocks.entries.get(path)).toEqual(bytes(original));
    const first = await saveEditorFile(edited(opened, 'First local revision\n'));
    expect(first.diskSourceMarkdown).toBe('First local revision\n');
    const second = await saveEditorFile(edited(first, 'Second local revision\n', true));
    expect(second.diskSourceMarkdown).toBe(second.sourceMarkdown);
    expect(mocks.invoke).toHaveBeenCalledWith('write_markdown_file', { path, contents: 'First local revision\n', expectedContents: original });
    expect(mocks.invoke).toHaveBeenCalledWith('write_markdown_file', { path, contents: second.sourceMarkdown, expectedContents: first.diskSourceMarkdown });
  });

  it.each([false, true])('preserves external bytes when saving ongoing local edits (canvas=%s)', async (canvas) => {
    mocks.entries.set(path, bytes('Original\n'));
    const opened = await openMarkdownFile(path);
    const external = new Uint8Array([0xff, 0xfe, 0x41, 0x00]);
    mocks.entries.set(path, external);
    await expect(saveEditorFile(edited(opened, 'Our unsaved writing\n', canvas))).rejects.toThrow(getMessages().documentChangedOnDisk);
    expect(mocks.entries.get(path)).toEqual(external);
    expect(opened.diskSourceMarkdown).toBe('Original\n');
  });

  it('does not silently recreate a document deleted elsewhere', async () => {
    mocks.entries.set(path, bytes('Original\n'));
    const opened = await openMarkdownFile(path);
    mocks.entries.delete(path);
    await expect(saveEditorFile(edited(opened, 'Our unsaved writing\n'))).rejects.toThrow(getMessages().documentChangedOnDisk);
    expect(mocks.entries.has(path)).toBe(false);
  });

  it('checks an empty disk baseline rather than treating it as absent', async () => {
    mocks.entries.set(path, bytes(''));
    const opened = await openMarkdownFile(path);
    mocks.entries.set(path, bytes('Someone else started writing'));
    await expect(saveEditorFile(edited(opened, 'Our first line'))).rejects.toThrow(getMessages().documentChangedOnDisk);
    expect(mocks.invoke).toHaveBeenCalledWith('write_markdown_file', { path, contents: 'Our first line', expectedContents: '' });
  });

  it.each([path, '/copies/shared.md'])('allows an explicit Save As destination %s and adopts its committed baseline', async (destination) => {
    mocks.entries.set(path, bytes('Original\n'));
    const opened = await openMarkdownFile(path);
    mocks.entries.set(destination, bytes('Existing chosen destination\n'));
    mocks.save.mockResolvedValueOnce(destination);
    const saved = await saveEditorFile(edited(opened, 'Chosen overwrite\n'), true);
    expect(saved.path).toBe(destination);
    expect(saved.diskSourceMarkdown).toBe('Chosen overwrite\n');
    expect(mocks.entries.get(destination)).toEqual(bytes('Chosen overwrite\n'));
    expect(mocks.invoke).toHaveBeenCalledWith('write_markdown_file', { path: destination, contents: 'Chosen overwrite\n' });
  });

  it('rolls back a rename when external writing no longer matches the opened baseline', async () => {
    mocks.entries.set(path, bytes('Original\n'));
    const opened = await openMarkdownFile(path);
    mocks.entries.set(path, bytes('External writing\n'));
    await expect(renameEditorFile(opened, 'renamed.md')).rejects.toThrow(getMessages().documentChangedOnDisk);
    expect(mocks.entries.get(path)).toEqual(bytes('External writing\n'));
    expect(mocks.entries.has('/notes/renamed.md')).toBe(false);
  });

  it('updates the baseline to the renamed disk source while retaining unsaved local writing', async () => {
    const original = '![asset](shared.assets/image.png)\n';
    mocks.entries.set(path, bytes(original));
    const opened = await openMarkdownFile(path);
    const renamed = await renameEditorFile(edited(opened, original + '\nUnsaved local line\n'), 'renamed.md');
    expect(renamed.diskSourceMarkdown).toBe('![asset](renamed.assets/image.png)\n');
    expect(renamed.sourceMarkdown).toBe('![asset](renamed.assets/image.png)\n\nUnsaved local line\n');
    const saved = await saveEditorFile(renamed);
    expect(mocks.entries.get('/notes/renamed.md')).toEqual(bytes(saved.sourceMarkdown!));
    expect(mocks.invoke).toHaveBeenCalledWith('write_markdown_file', { path: '/notes/renamed.md', contents: renamed.diskSourceMarkdown, expectedContents: original });
  });
});
