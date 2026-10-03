import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownToDocument } from '../editor/markdown';
import { exportMarkdownFile, hydrateDocumentAssets, loadDraft, openMarkdownFile, openRecent, saveEditorFile } from './files';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), save: vi.fn(), recovery: null as string | null,
  settings: new Map<string, unknown>(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: mocks.invoke,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save, open: vi.fn(), confirm: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (path: string) => fs.access(path).then(() => true, () => false),
  mkdir: (path: string, options: { recursive: boolean }) => fs.mkdir(path, options),
  writeFile: (path: string, bytes: Uint8Array) => fs.writeFile(path, bytes),
  readFile: (path: string) => fs.readFile(path),
  rename: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: async () => ({
    get: async (key: string) => mocks.settings.get(key),
    set: async (key: string, value: unknown) => { mocks.settings.set(key, value); },
  }) },
}));

let root: string;
let real: string;
let links: string;
let target: string;
let alias: string;
const source = '\uFEFF# Physical document 中文\r\n\r\n![Diagram](images/diagram.svg)\r\n';

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.settings.clear(); mocks.recovery = null;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paper-canvas-symlinks-')));
  real = path.join(root, 'real'); links = path.join(root, 'links');
  target = path.join(real, 'original.md'); alias = path.join(links, 'alias.md');
  await fs.mkdir(path.join(real, 'images'), { recursive: true });
  await fs.mkdir(links);
  await fs.writeFile(target, source);
  await fs.writeFile(path.join(real, 'images/diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.symlink('../real/original.md', alias);
  mocks.invoke.mockImplementation(async (command: string, args?: { path: string; allowMissing?: boolean; contents: string; expectedContents?: string }) => {
    if (command === 'resolve_markdown_document_path') {
      try {
        const resolved = await fs.realpath(args!.path);
        if (!(await fs.stat(resolved)).isFile()) throw new Error('The Markdown document must be a regular file.');
        return resolved;
      } catch (error) {
        if (!args!.allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return path.join(await fs.realpath(path.dirname(args!.path)), path.basename(args!.path));
      }
    }
    if (command === 'read_markdown_file') return new Uint8Array(await fs.readFile(args!.path));
    if (command === 'read_recovery_draft') return mocks.recovery;
    if (command === 'write_markdown_file') {
      if (args!.expectedContents !== undefined && await fs.readFile(args!.path, 'utf8') !== args!.expectedContents) throw 'DOCUMENT_CHANGED_ON_DISK';
      await fs.writeFile(args!.path, args!.contents);
    }
  });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('physical Markdown paths through symbolic links', () => {
  it.each(['open', 'recent'] as const)('uses the physical filename, image origin, and exact disk baseline through %s', async (route) => {
    mocks.settings.set('recentFiles', [{ path: alias, name: 'alias.md' }]);
    const opened = await (route === 'open' ? openMarkdownFile(alias) : openRecent({ path: alias, name: 'alias.md' }));
    expect(opened).toMatchObject({ path: target, name: 'original.md', sourceMarkdown: source, diskSourceMarkdown: source });
    expect(opened?.document.content?.find((node) => node.type === 'image')?.attrs?.src).toBe(`asset:${real}/images/diagram.svg`);
    expect(mocks.invoke).toHaveBeenCalledWith('allow_document_image_files', { path: target, images: [path.join(real, 'images/diagram.svg')] });
    expect(mocks.settings.get('recentFiles')).toEqual([{ path: target, name: 'original.md' }]);
    await saveEditorFile(opened!);
    expect(await fs.readFile(target, 'utf8')).toBe(source);
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it('writes embedded images beside an existing Save As symlink target', async () => {
    mocks.save.mockResolvedValue(alias);
    const document = { type: 'doc', content: [{ type: 'image', attrs: { src: 'data:image/png;base64,aGVsbG8=' } }] };
    const saved = await saveEditorFile({ name: 'Untitled.md', document }, true);
    expect(saved.path).toBe(target);
    expect(saved.name).toBe('original.md');
    const relative = saved.document.content?.[0]?.attrs?.originalSrc as string;
    expect(relative).toMatch(/^original\.assets\/image-.+\.png$/);
    expect(await fs.readFile(path.join(real, relative), 'utf8')).toBe('hello');
    expect(await fs.readFile(target, 'utf8')).toContain(relative);
    await expect(fs.access(path.join(links, 'alias.assets'))).rejects.toThrow();
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it.each(['save', 'export'] as const)('rebases existing images to the physical selected destination during %s', async (operation) => {
    const origin = path.join(links, 'source.md');
    await fs.mkdir(path.join(links, 'images'));
    await fs.writeFile(path.join(links, 'images/diagram.svg'), 'source image');
    mocks.save.mockResolvedValue(alias);
    if (operation === 'save') {
      const saved = await saveEditorFile({ name: 'source.md', path: origin, sourceMarkdown: source, document: hydrateDocumentAssets(markdownToDocument(source), origin) }, true);
      expect(saved.path).toBe(target);
    } else await expect(exportMarkdownFile(source, 'source.md', origin)).resolves.toBe('original.md');
    const written = await fs.readFile(target, 'utf8');
    expect(written).toBe(source.replace('images/diagram.svg', '../links/images/diagram.svg'));
    expect(await fs.readFile(path.resolve(real, '../links/images/diagram.svg'), 'utf8')).toBe('source image');
    expect((await fs.lstat(alias)).isSymbolicLink()).toBe(true);
  });

  it('keeps an opened target active when its alias is retargeted and protects its disk baseline', async () => {
    const opened = await openMarkdownFile(alias);
    const other = path.join(real, 'other.md');
    await fs.writeFile(other, '# Other document\n');
    await fs.unlink(alias); await fs.symlink(other, alias);
    const saved = await saveEditorFile({ ...opened, sourceMarkdown: 'Our next revision\n' });
    expect(saved.path).toBe(target);
    expect(await fs.readFile(other, 'utf8')).toBe('# Other document\n');
    await fs.writeFile(target, 'External revision\n');
    await expect(saveEditorFile({ ...saved, sourceMarkdown: 'Our later revision\n' })).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe('External revision\n');
    expect(await fs.readFile(other, 'utf8')).toBe('# Other document\n');
  });

  it('canonicalizes the parent of a new Save As file before creating its image folder', async () => {
    const directoryAlias = path.join(links, 'directory');
    await fs.symlink(real, directoryAlias);
    mocks.save.mockResolvedValue(path.join(directoryAlias, 'new.md'));
    const document = { type: 'doc', content: [{ type: 'image', attrs: { src: 'data:image/png;base64,aGVsbG8=' } }] };
    const saved = await saveEditorFile({ name: 'Untitled.md', document });
    expect(saved.path).toBe(path.join(real, 'new.md'));
    expect(await fs.readFile(path.join(real, saved.document.content?.[0]?.attrs?.originalSrc), 'utf8')).toBe('hello');
  });

  it('restores a legacy alias origin without activating a save destination or changing source bytes', async () => {
    mocks.recovery = JSON.stringify({ name: 'alias.md', recoverySourcePath: alias, sourceMarkdown: source });
    const restored = await loadDraft();
    expect(restored).toMatchObject({ name: 'alias.md', recoverySourcePath: target, sourceMarkdown: source });
    expect(restored?.path).toBeUndefined();
    expect(restored?.diskSourceMarkdown).toBeUndefined();
    expect(restored?.document.content?.find((node) => node.type === 'image')?.attrs?.src).toBe(`asset:${real}/images/diagram.svg`);
  });
});
