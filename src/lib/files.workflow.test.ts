import type { JSONContent } from '@tiptap/core';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMarkdownComment, parseMarkdownComments } from '../editor/comments';
import { markdownToDocument } from '../editor/markdown';
import {
  documentToPortableMarkdown,
  exportMarkdownFile,
  loadDraft,
  openMarkdownFile,
  renameEditorFile,
  saveDraft,
  saveEditorFile,
  type EditorFile,
} from './files';

const boundary = vi.hoisted(() => ({
  entries: new Map<string, Uint8Array | null>(),
  settings: new Map<string, unknown>(),
  choices: [] as string[],
  recovery: null as string | null,
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: async (command: string, args?: { path: string; contents: string; expectedContents?: string; source: string; target: string }) => {
    if (command === 'resolve_markdown_document_path') return args!.path;
    if (command === 'read_markdown_file') {
      const bytes = boundary.entries.get(args!.path);
      if (!bytes) throw new Error('Missing document');
      return bytes;
    }
    if (command === 'write_markdown_file') {
      const existing = boundary.entries.get(args!.path);
      if (args!.expectedContents !== undefined && (!existing || new TextDecoder('utf-8', { ignoreBOM: true }).decode(existing) !== args!.expectedContents)) throw 'DOCUMENT_CHANGED_ON_DISK';
      boundary.entries.set(args!.path, new TextEncoder().encode(args!.contents));
    }
    if (command === 'rename_document_entry') {
      if (!boundary.entries.has(args!.source) || boundary.entries.has(args!.target)) throw new Error('Rename collision or missing source');
      for (const [path, bytes] of [...boundary.entries]) {
        if (path !== args!.source && !path.startsWith(args!.source + '/')) continue;
        boundary.entries.delete(path);
        boundary.entries.set(args!.target + path.slice(args!.source.length), bytes);
      }
    }
    if (command === 'write_recovery_draft') boundary.recovery = args!.contents;
    if (command === 'read_recovery_draft') return boundary.recovery;
  },
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: async () => boundary.choices.shift() ?? null,
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async (path: string) => boundary.entries.has(path),
  mkdir: async (path: string) => { boundary.entries.set(path, null); },
  writeFile: async (path: string, contents: Uint8Array) => {
    if (boundary.entries.has(path)) throw new Error('Image name collision');
    boundary.entries.set(path, new Uint8Array(contents));
  },
  readFile: vi.fn(),
  rename: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: async () => ({
    get: async (key: string) => structuredClone(boundary.settings.get(key)),
    set: async (key: string, value: unknown) => { boundary.settings.set(key, structuredClone(value)); },
  }) },
}));

function imageSource(document: JSONContent): string | undefined {
  return document.content?.find((node) => node.type === 'image')?.attrs?.src;
}

beforeEach(() => {
  boundary.entries.clear();
  boundary.settings.clear();
  boundary.choices = [];
  boundary.recovery = null;
});

it.each([
  ['Notes.md', 'Renamed.md'],
  ['研究 中文 🧪.md', '會議記錄 中文.md'],
  ['Reading.markdown', 'Review.markdown'],
  ['Project (100%).MD', 'Project copy.MD'],
])('retains writing, a pasted image, and comments through a complete file lifecycle (%s)', async (initialName, renamedName) => {
  const targetText = 'Comment target 中文 🧪.';
  const document = markdownToDocument(`# Notes\n\n${targetText}\n`);
  document.content!.push({ type: 'image', attrs: { src: 'data:image/png;base64,AAECAw==', alt: 'Pasted diagram' } });
  const body = documentToPortableMarkdown(document);
  const from = body.indexOf(targetText);
  const comment = createMarkdownComment(body, { kind: 'range', from, to: from + targetText.length }, 'Retain this comment.');
  const initialPath = `/notes/${initialName}`;
  boundary.choices.push(initialPath);
  let file: EditorFile = await saveEditorFile({ name: initialName, document, comments: [comment] });
  const initialImagePath = [...boundary.entries.keys()].find((path) => path.includes('.assets/image-'))!;
  expect(boundary.entries.get(initialImagePath)).toEqual(new Uint8Array([0, 1, 2, 3]));
  expect(imageSource(file.document)).toBe(`asset:${initialImagePath}`);

  file = await renameEditorFile(file, renamedName);
  const renamedImagePath = [...boundary.entries.keys()].find((path) => path.includes('.assets/image-'))!;
  expect(renamedImagePath.startsWith(`/notes/${renamedName.replace(/\.md$/i, '')}.assets/`)).toBe(true);
  expect(boundary.entries.has(initialImagePath)).toBe(false);
  expect(boundary.entries.get(renamedImagePath)).toEqual(new Uint8Array([0, 1, 2, 3]));
  expect(imageSource(file.document)).toBe(`asset:${renamedImagePath}`);

  const copiedPath = '/exports/copy.md';
  boundary.choices.push(copiedPath);
  file = await saveEditorFile(file, true);
  expect(file.path).toBe(copiedPath);
  expect(imageSource(file.document)).toBe(`asset:${renamedImagePath}`);
  const laterDocument = structuredClone(file.document);
  laterDocument.content!.push(...markdownToDocument('Later Canvas writing.\n').content!);
  file = await saveEditorFile({ ...file, document: laterDocument, sourceMarkdown: undefined });
  file = await openMarkdownFile(copiedPath);
  expect(file.sourceMarkdown).toContain('Later Canvas writing.');
  expect(imageSource(file.document)).toBe(`asset:${renamedImagePath}`);
  expect(file.diskSourceMarkdown).toBe(file.sourceMarkdown);

  const exportedPath = '/exports/review/exported.md';
  boundary.choices.push(exportedPath);
  await expect(exportMarkdownFile(file.sourceMarkdown!, file.name, file.path)).resolves.toBe('exported.md');
  const exported = await openMarkdownFile(exportedPath);
  expect(imageSource(exported.document)).toBe(`asset:${renamedImagePath}`);
  expect(file.path).toBe(copiedPath);
  // A copy export must not invalidate the active document's next save baseline.
  file = await saveEditorFile(file);

  await saveDraft(file);
  const recovered = await loadDraft();
  expect(recovered?.path).toBeUndefined();
  expect(recovered?.recoverySourcePath).toBe(copiedPath);
  expect(recovered?.sourceMarkdown).toBe(file.sourceMarkdown);
  boundary.choices.push('/recovered/final.md');
  const final = await saveEditorFile(recovered!, true);
  const reopened = await openMarkdownFile(final.path!);
  expect(imageSource(reopened.document)).toBe(`asset:${renamedImagePath}`);
  expect(reopened.sourceMarkdown).toContain('Later Canvas writing.');
  const parsed = parseMarkdownComments(reopened.sourceMarkdown!);
  expect(parsed.status).toBe('valid');
  expect(parsed.comments).toHaveLength(1);
  expect(parsed.comments[0]).toMatchObject({ id: comment.id, content: comment.content, status: 'active' });
  const target = parsed.comments[0].target;
  expect(target.kind).toBe('range');
  if (target.kind === 'range') expect(parsed.body.slice(target.from, target.to)).toBe(targetText);
  expect([...boundary.entries.keys()].filter((path) => path.includes('.assets/image-'))).toEqual([renamedImagePath]);
});

it('preserves ordinary rich Markdown through Source save, Rename, Save As and a later Canvas edit', async () => {
  const original = '# Ordinary note\n\nFirst.\n\n<p></p>\n\nSecond.\n\n```js title="example.js" {1,3-5}\nconst x = 1;\n```\n\n![Diagram](research.assets/a.svg "papercanvas-size:300x0 | Caption")\n\n\\(x\\)\\(y\\) and note[^n].\n\n[^n]: Footnote body.\n';
  const imageBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  boundary.entries.set('/notes/research.md', new TextEncoder().encode(original));
  boundary.entries.set('/notes/research.assets', null);
  boundary.entries.set('/notes/research.assets/a.svg', imageBytes);
  let file = await openMarkdownFile('/notes/research.md');
  file = await saveEditorFile(file);
  expect(file.sourceMarkdown).toBe(original);
  file = await renameEditorFile(file, 'renamed.md');
  expect(file.sourceMarkdown).toBe(original.replace('research.assets/', 'renamed.assets/'));
  boundary.choices.push('/exports/copied.md');
  file = await saveEditorFile(file, true);
  expect(file.sourceMarkdown).toContain('../notes/renamed.assets/a.svg');
  const document = structuredClone(file.document);
  document.content!.push(...markdownToDocument('Later Canvas writing.\n').content!);
  file = await saveEditorFile({ ...file, document, sourceMarkdown: undefined });
  const reopened = await openMarkdownFile(file.path!);
  const serialized = reopened.sourceMarkdown!;
  expect(serialized).toContain('First.\n\n<p></p>\n\nSecond.');
  expect(serialized).toContain('```js title="example.js" {1,3-5}\nconst x = 1;\n```');
  expect(serialized).toContain('![Diagram](../notes/renamed.assets/a.svg "papercanvas-size:300x0 | Caption")');
  expect(reopened.document.content?.flatMap((node) => node.content ?? []).filter((node) => node.type === 'inlineFormula')
    .map((node) => node.attrs?.latex)).toEqual(['x', 'y']);
  expect(serialized).toContain(' and note[^n].');
  expect(serialized).toContain('[^n]: Footnote body.');
  expect(serialized).toContain('Later Canvas writing.');
  expect(imageSource(reopened.document)).toBe('asset:/notes/renamed.assets/a.svg');
  expect(boundary.entries.get('/notes/renamed.assets/a.svg')).toEqual(imageBytes);
  expect(boundary.entries.has('/notes/research.assets/a.svg')).toBe(false);
  boundary.choices.push('/exports/review/copy.md');
  await exportMarkdownFile(serialized, reopened.name, reopened.path);
  const exported = await openMarkdownFile('/exports/review/copy.md');
  expect(imageSource(exported.document)).toBe('asset:/notes/renamed.assets/a.svg');
  expect(exported.sourceMarkdown).toContain('```js title="example.js" {1,3-5}');
  expect(exported.document.content?.flatMap((node) => node.content ?? []).filter((node) => node.type === 'inlineFormula')
    .map((node) => node.attrs?.latex)).toEqual(['x', 'y']);
  expect(exported.sourceMarkdown).toContain(' and note[^n].');
});
