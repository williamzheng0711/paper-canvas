import { beforeEach, describe, expect, it, vi } from 'vitest';
import { maximumCanvasCharacters } from '../editor/canvasCapacity';
import { hydrateDocumentAssets, loadDraft, openMarkdownFile, openRecent, saveEditorFile } from './files';
import { markdownToDocument } from '../editor/markdown';

const mocks = vi.hoisted(() => ({ source: '', recovery: null as string | null, invoke: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: async (command: string, args?: { path: string }) => {
    if (command === 'resolve_markdown_document_path') return args!.path;
    if (command === 'read_markdown_file') return new TextEncoder().encode(mocks.source);
    return mocks.invoke(command, args);
  },
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: async () => new TextEncoder().encode(mocks.source),
  exists: async () => true,
  mkdir: vi.fn(), rename: vi.fn(), writeFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save, open: vi.fn(), confirm: vi.fn() }));
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({ get: async () => [], set: vi.fn() }) } }));

beforeEach(() => {
  vi.resetAllMocks(); mocks.source = ''; mocks.recovery = null;
  mocks.save.mockResolvedValue('/copies/saved.md');
  mocks.invoke.mockImplementation(async (command: string) => command === 'read_recovery_draft' ? mocks.recovery : undefined);
});

const path = '/tmp/outside-home/notes.md';
describe('opened document image access', () => {
  it.each(['open', 'recent'] as const)('authorizes only distinct resolved local Markdown images before %s returns', async (route) => {
    mocks.source = '![First](../My%20figure.svg#view)\n\n![Duplicate](../My%20figure.svg?v=2)\n\n![Absolute](/other/absolute.png)\n\n![File](file:///other/file.png)\n\n![Remote](https://example.com/image.png)\n\n![Inline](data:image/png;base64,aGVsbG8=)\n\n`![Literal](secret.svg)`\n';
    let finish!: () => void;
    mocks.invoke.mockImplementation((command: string) => command === 'allow_document_image_files' ? new Promise<void>((resolve) => { finish = resolve; }) : Promise.resolve());
    let returned = false;
    const request = (route === 'open' ? openMarkdownFile(path) : openRecent({ path, name: 'notes.md' })).then((file) => { returned = true; return file; });
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('allow_document_image_files', { path, images: ['/tmp/My figure.svg', '/other/absolute.png', '/other/file.png'] }));
    expect(returned).toBe(false);
    finish();
    expect((await request)?.sourceMarkdown).toBe(mocks.source);
  });

  it('uses sanitized HTML image sources without granting links, literal markup, or removed containers', async () => {
    mocks.source = '<div><img src="images/My%20figure.svg?view=1&amp;size=2"><img src="images/My%20figure.svg"><a href="private.txt">link</a><code>&lt;img src="literal.svg"&gt;</code></div>\n\n<script><img src="removed.svg"></script>\n';
    await openMarkdownFile(path);
    expect(mocks.invoke).toHaveBeenCalledWith('allow_document_image_files', { path, images: ['/tmp/outside-home/images/My figure.svg'] });
  });

  it('keeps successfully read writing available when supplementary image authorization fails', async () => {
    mocks.source = '# Retained writing\r\n\r\n![Unavailable](images/diagram.svg)\r\n';
    mocks.invoke.mockImplementation(async (command: string) => { if (command === 'allow_document_image_files') throw new Error('Image access unavailable'); });
    const opened = await openMarkdownFile(path);
    expect(opened.sourceMarkdown).toBe(mocks.source);
    expect(opened.diskSourceMarkdown).toBe(mocks.source);
    expect(opened.document.content?.some((node) => node.attrs?.alt === 'Unavailable')).toBe(true);
  });

  it('skips HTML DOM inspection for source-only oversized documents while retaining ordinary image references', async () => {
    mocks.source = 'a'.repeat(maximumCanvasCharacters + 1) + '\n\n<div><img src="large-html.svg"></div>\n\n![Ordinary](ordinary.svg)\n';
    const opened = await openMarkdownFile(path);
    expect(opened.sourceMarkdown).toBe(mocks.source);
    expect(mocks.invoke).toHaveBeenCalledWith('allow_document_image_files', { path, images: ['/tmp/outside-home/ordinary.svg'] });
  });

  it('authorizes newly typed local references in an independent recovery copy before it returns', async () => {
    const sourceMarkdown = '![New local image](new.svg)\r\n\r\n<div><img src="html.svg"></div>\r\n';
    mocks.recovery = JSON.stringify({ name: 'notes.md', recoverySourcePath: path, sourceMarkdown });
    const recovered = await loadDraft();
    expect(recovered?.sourceMarkdown).toBe(sourceMarkdown);
    expect(recovered?.path).toBeUndefined();
    expect(mocks.invoke).toHaveBeenCalledWith('allow_document_image_files', { path, images: ['/tmp/outside-home/new.svg', '/tmp/outside-home/html.svg'] });
  });

  it('authorizes newly saved local references without granting a whole directory', async () => {
    const sourceMarkdown = '![New local image](new.svg)\n';
    const saved = await saveEditorFile({ name: 'notes.md', path, sourceMarkdown, document: hydrateDocumentAssets(markdownToDocument(sourceMarkdown), path) });
    expect(saved.sourceMarkdown).toBe(sourceMarkdown);
    expect(mocks.invoke).toHaveBeenCalledWith('allow_document_image_files', { path, images: ['/tmp/outside-home/new.svg'] });
    expect(mocks.invoke.mock.calls.map(([command]) => command).filter((command) => command === 'write_markdown_file' || command === 'allow_document_image_files')).toEqual(['write_markdown_file', 'allow_document_image_files']);
  });

  it('authorizes the physical source images against the committed Save As destination after rebasing', async () => {
    const sourceMarkdown = '![New local image](images/new.svg)\r\n\r\n<div><img src="html.svg"></div>\r\n';
    const saved = await saveEditorFile({ name: 'notes.md', path, sourceMarkdown, document: hydrateDocumentAssets(markdownToDocument(sourceMarkdown), path) }, true);
    expect(saved.path).toBe('/copies/saved.md');
    expect(saved.sourceMarkdown).toBe(sourceMarkdown.replace('images/new.svg', '../tmp/outside-home/images/new.svg').replace('html.svg', '../tmp/outside-home/html.svg'));
    expect(mocks.invoke).toHaveBeenCalledWith('allow_document_image_files', { path: '/copies/saved.md', images: ['/tmp/outside-home/images/new.svg', '/tmp/outside-home/html.svg'] });
  });
});
