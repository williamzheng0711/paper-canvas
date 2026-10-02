import { beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseSavePath, confirmDiscardChanges, saveEditorFile } from './files';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  save: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: mocks.invoke,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ confirm: mocks.confirm, open: vi.fn(), save: mocks.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
  rename: vi.fn(),
  mkdir: mocks.mkdir,
  writeFile: mocks.writeFile,
  writeTextFile: mocks.writeTextFile,
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: async () => ({ get: async () => [], set: async () => undefined }) },
}));

const file = {
  path: '/notes/research.md',
  name: 'research.md',
  document: { type: 'doc', content: [{ type: 'image', attrs: { src: 'data:image/png;base64,aGVsbG8=' } }] },
};

describe('saving documents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mkdir.mockImplementation(async () => {
      if (!mocks.invoke.mock.calls.some(([command]) => command === 'allow_document_assets')) {
        throw new Error('forbidden path: /notes/research.assets');
      }
    });
  });

  it('authorizes the companion directory before saving embedded images', async () => {
    const saved = await saveEditorFile(file);
    expect(mocks.invoke).toHaveBeenCalledWith('allow_document_assets', { path: file.path });
    expect(mocks.mkdir).toHaveBeenCalledWith('/notes/research.assets', { recursive: true });
    expect(mocks.writeFile).toHaveBeenCalledOnce();
    expect(mocks.writeTextFile).toHaveBeenCalledWith(file.path, expect.stringContaining('research.assets/image-'));
    expect(saved.document.content?.[0]?.attrs?.originalSrc).toMatch(/^research.assets\/image-/);
    expect(file.document.content[0].attrs.src).toBe('data:image/png;base64,aGVsbG8=');
  });

  it.each([false, true])('awaits the supported native confirmation command (answer=%s)', async (answer) => {
    const browserConfirm = vi.spyOn(window, 'confirm');
    mocks.confirm.mockResolvedValue(answer);
    try {
      await expect(confirmDiscardChanges('Discard changes?')).resolves.toBe(answer);
      expect(mocks.confirm).toHaveBeenCalledWith('Discard changes?', { kind: 'warning' });
      expect(browserConfirm).not.toHaveBeenCalled();
    } finally {
      browserConfirm.mockRestore();
    }
  });

  it('does not overwrite the original file when Save As is cancelled', async () => {
    mocks.save.mockResolvedValue(null);
    const textFile = { ...file, document: { type: 'doc', content: [{ type: 'paragraph' }] } };
    await expect(saveEditorFile(textFile, true)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it.each(['Research.MD', 'Research.markdown', 'Research.MARKDOWN'])('keeps the existing supported extension in the Save As default: %s', async (name) => {
    mocks.save.mockResolvedValue(null);
    await chooseSavePath(name);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: name, filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] }));
  });

  it('authorizes the selected destination when saving an image document as a new file', async () => {
    mocks.save.mockResolvedValue('/other/proposal.md');
    const saved = await saveEditorFile(file, true);
    expect(mocks.invoke).toHaveBeenCalledWith('allow_document_assets', { path: '/other/proposal.md' });
    expect(mocks.mkdir).toHaveBeenCalledWith('/other/proposal.assets', { recursive: true });
    expect(mocks.writeTextFile).toHaveBeenCalledWith('/other/proposal.md', expect.stringContaining('proposal.assets/'));
    expect(saved.path).toBe('/other/proposal.md');
  });

  it('does not write Markdown if image authorization fails', async () => {
    mocks.invoke.mockRejectedValue(new Error('document not authorized'));
    await expect(saveEditorFile(file)).rejects.toThrow('document not authorized');
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it('writes text-only files without requesting image access', async () => {
    await saveEditorFile({ ...file, document: { type: 'doc', content: [{ type: 'paragraph' }] } });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.writeTextFile).toHaveBeenCalledOnce();
  });
});
