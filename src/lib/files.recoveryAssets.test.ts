import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markdownToDocument } from '../editor/markdown';
import { fileAssetSourcePath, hydrateDocumentAssets, loadDraft, saveDraft, saveEditorFile, type EditorFile } from './files';

const mocks = vi.hoisted(() => ({ recovery: null as string | null, invoke: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset://${encodeURIComponent(path)}`,
  invoke: async (command: string, args?: { path: string }) => {
    if (command === 'resolve_markdown_document_path') return args!.path;
    return mocks.invoke(command, args);
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save, open: vi.fn(), confirm: vi.fn() }));
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({ get: async () => [], set: vi.fn() }) } }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.recovery = null;
  mocks.invoke.mockImplementation(async (command: string, args?: { contents: string }) => {
    if (command === 'write_recovery_draft') mocks.recovery = args!.contents;
    if (command === 'read_recovery_draft') return mocks.recovery;
  });
  mocks.save.mockResolvedValue('/copies/kept.md');
});

const path = '/tmp/source/notes.md';
const source = '# Retained writing\r\n\r\n![Diagram](images/My%20figure.svg)\r\n\r\n<div><img src="images/html.svg"></div>\r\n';
const file: EditorFile = { path, name: 'notes.md', sourceMarkdown: source, diskSourceMarkdown: 'Earlier disk source', document: hydrateDocumentAssets(markdownToDocument(source), path) };

describe('asset origins in recovery copies', () => {
  it('rebases the exact source of a BOM recovery copy while retaining CRLF and late writing', async () => {
    const origin = '/tmp/source/external-conflict.md';
    const raw = '\uFEFF# Original disk 中文\r\n\r\n![diagram](./diagram.svg)\r\nLatest local writing 中文 🧪';
    mocks.save.mockResolvedValue('/tmp/source/recovered-copy/recovered-copy.md');
    await saveDraft({ name: 'external-conflict.md', path: origin, sourceMarkdown: raw, document: hydrateDocumentAssets(markdownToDocument(raw), origin) });
    const recovered = await loadDraft();
    expect(recovered?.path).toBeUndefined();
    expect(recovered?.sourceMarkdown).toBe(raw);
    expect(fileAssetSourcePath(recovered!)).toBe(origin);
    const saved = await saveEditorFile(recovered!);
    expect(saved.sourceMarkdown).toBe(raw.replace('./diagram.svg', '.././diagram.svg'));
    expect(mocks.invoke).toHaveBeenCalledWith('write_markdown_file', { path: saved.path, contents: saved.sourceMarkdown });
  });

  it('restores a failed named save with exact source and image origin without activating the old save destination', async () => {
    await saveDraft(file);
    const stored = JSON.parse(mocks.recovery!);
    expect(stored.path).toBeUndefined();
    expect(stored.recoverySourcePath).toBe(path);
    expect(stored.sourceMarkdown).toBe(source);
    const recovered = await loadDraft();
    expect(recovered?.path).toBeUndefined();
    expect(recovered?.diskSourceMarkdown).toBeUndefined();
    expect(recovered?.sourceMarkdown).toBe(source);
    expect(fileAssetSourcePath(recovered!)).toBe(path);
    expect(recovered?.document.content?.find((node) => node.type === 'image')?.attrs?.src).toBe(`asset://${encodeURIComponent('/tmp/source/images/My figure.svg')}`);
    expect(recovered?.document.content?.find((node) => node.type === 'htmlPreview')?.attrs?.basePath).toBe('/tmp/source');

    const saved = await saveEditorFile(recovered!);
    expect(mocks.save).toHaveBeenCalled();
    expect(saved.path).toBe('/copies/kept.md');
    expect(saved.recoverySourcePath).toBeUndefined();
    expect(saved.sourceMarkdown).toBe(source.replace('images/My%20figure.svg', '../tmp/source/images/My%20figure.svg').replace('images/html.svg', '../tmp/source/images/html.svg'));
    expect(mocks.invoke).toHaveBeenCalledWith('write_markdown_file', { path: '/copies/kept.md', contents: saved.sourceMarkdown });
  });

  it('restores canvas-only recovery images and keeps the origin through later unnamed edits', async () => {
    await saveDraft({ ...file, sourceMarkdown: undefined });
    const recovered = await loadDraft();
    expect(recovered?.path).toBeUndefined();
    expect(recovered?.recoverySourcePath).toBe(path);
    expect(recovered?.document.content?.find((node) => node.type === 'image')?.attrs?.src).toBe(`asset://${encodeURIComponent('/tmp/source/images/My figure.svg')}`);
    await saveDraft(recovered!);
    expect(JSON.parse(mocks.recovery!).recoverySourcePath).toBe(path);
    expect(JSON.parse(mocks.recovery!).path).toBeUndefined();
  });

  it.each([42, {}, 'relative.md', '/tmp/not-an-image-origin.txt', '/tmp/\ud800.md', '/tmp/\0.md'])('ignores invalid recovery origins %j while restoring valid writing safely', async (recoverySourcePath) => {
    mocks.recovery = JSON.stringify({ name: 'Recovered.md', sourceMarkdown: source, document: {}, recoverySourcePath });
    const recovered = await loadDraft();
    expect(recovered?.sourceMarkdown).toBe(source);
    expect(recovered?.path).toBeUndefined();
    expect(recovered?.recoverySourcePath).toBeUndefined();
  });

  it('uses an active destination over an older recovery origin', () => {
    expect(fileAssetSourcePath({ ...file, recoverySourcePath: '/old/origin.md' })).toBe(path);
  });
});
