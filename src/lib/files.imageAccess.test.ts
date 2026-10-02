import { beforeEach, describe, expect, it, vi } from 'vitest';
import { maximumCanvasCharacters } from '../editor/canvasCapacity';
import { openMarkdownFile, openRecent } from './files';

const mocks = vi.hoisted(() => ({ source: '', invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: mocks.invoke,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  readFile: async () => new TextEncoder().encode(mocks.source),
  exists: async () => true,
  mkdir: vi.fn(), rename: vi.fn(), writeFile: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: async () => ({ get: async () => [], set: vi.fn() }) } }));

beforeEach(() => { vi.resetAllMocks(); mocks.invoke.mockResolvedValue(undefined); mocks.source = ''; });

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
});
