import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownComment, parseMarkdownComments, serializeMarkdownWithComments } from '../editor/comments';
import { saveEditorFile } from './files';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
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
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: mocks.save }));
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

describe('saving Markdown source', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('writes the exact source, including comments metadata and user formatting', async () => {
    const body = '# Heading_with_underscores\n\nLiteral \\theta and  *spacing*  .\n';
    const comment = createMarkdownComment(body, { kind: 'range', from: 2, to: 9 }, 'Keep this note', 'Heading');
    const source = serializeMarkdownWithComments(body, [comment]);
    const file = {
      path: '/notes/source.md',
      name: 'source.md',
      document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'parsed content' }] }] },
      comments: [comment],
    };

    await saveEditorFile(file, false, source);

    expect(mocks.writeTextFile).toHaveBeenCalledWith(file.path, source);
    expect(parseMarkdownComments(mocks.writeTextFile.mock.calls[0][1]).comments).toEqual([comment]);
  });

  it('keeps embedded image source intact without extracting assets on repeated saves', async () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8=';
    const source = `Before ![diagram](${dataUrl}) after\n`;
    const file = {
      path: '/notes/source.md',
      name: 'source.md',
      document: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: dataUrl, alt: 'diagram' } }] }],
      },
    };

    await saveEditorFile(file, false, source);
    await saveEditorFile(file, false, source);

    expect(mocks.writeTextFile).toHaveBeenNthCalledWith(1, file.path, source);
    expect(mocks.writeTextFile).toHaveBeenNthCalledWith(2, file.path, source);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(source).toContain(dataUrl);
  });
});
