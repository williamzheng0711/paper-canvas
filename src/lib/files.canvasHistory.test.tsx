import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type * as TiptapReact from '@tiptap/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CanvasEditor } from '../components/CanvasEditor';
import { documentToPortableMarkdown } from './files';
import type { CanvasAssetTransition } from '../editor/canvasAssetHistory';
import type * as TauriCore from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
}));

const harness = vi.hoisted(() => ({ editor: null as Editor | null }));
vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof TiptapReact>();
  return {
    ...actual,
    useEditor: (...args: Parameters<typeof actual.useEditor>) => {
      const editor = actual.useEditor(...args);
      harness.editor = editor;
      return editor;
    },
  };
});

it('applies a companion-folder transition once when a failed Rename retains the document path', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const onEdit = vi.fn();
  const initialDocument = { type: 'doc', content: [
    { type: 'image', attrs: { src: 'asset:/notes/research.assets/a.svg', originalSrc: 'research.assets/a.svg', basePath: '/notes', alt: 'Diagram' } },
    { type: 'paragraph' },
  ] };
  const transition: CanvasAssetTransition = { oldPath: '/notes/research.md', newPath: '/notes/renamed.md', operation: 'rename' };
  try {
    await act(async () => root.render(<CanvasEditor language="en" documentId={1} documentPath="/notes/research.md" initialDocument={initialDocument} onChange={onChange} onEdit={onEdit} />));
    const editor = harness.editor!;
    await act(async () => { editor.commands.setNodeSelection(0); editor.commands.deleteSelection(); });
    onEdit.mockClear();
    await act(async () => root.render(<CanvasEditor language="en" documentId={1} documentPath="/notes/research.md" assetSourceTransition={transition} initialDocument={editor.getJSON()} onChange={onChange} onEdit={onEdit} />));
    await act(async () => root.render(<CanvasEditor language="zh-Hant" documentId={1} documentPath="/notes/research.md" assetSourceTransition={transition} initialDocument={editor.getJSON()} onChange={onChange} onEdit={onEdit} />));
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(documentToPortableMarkdown(editor.getJSON())).toContain('![Diagram](renamed.assets/a.svg)');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('starts image history at the current origin when mounting with an already-applied transition', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const initialDocument = { type: 'doc', content: [
    { type: 'image', attrs: { src: 'asset:/exports/images/a.svg', originalSrc: 'images/a.svg', basePath: '/exports', alt: 'Diagram' } },
    { type: 'paragraph' },
  ] };
  try {
    await act(async () => root.render(<CanvasEditor language="en" documentId={1} documentPath="/exports/copy.md" assetSourceTransition={{ oldPath: '/notes/research.md', newPath: '/exports/copy.md', operation: 'rebase' }} initialDocument={initialDocument} onChange={vi.fn()} />));
    const editor = harness.editor!;
    await act(async () => { editor.commands.setNodeSelection(0); editor.commands.deleteSelection(); });
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(documentToPortableMarkdown(editor.getJSON())).toContain('![Diagram](images/a.svg)');
    expect(editor.state.doc.firstChild!.attrs.src).toBe('asset:/exports/images/a.svg');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each([
  ['rename', '/notes/renamed.md', 'renamed.assets/a.svg'],
  ['saveAs', '/exports/copy.md', '../notes/research.assets/a.svg'],
])('restores a deleted Canvas image with its current portable path after %s', async (operation, destination, expectedPath) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  try {
    await act(async () => root.render(<CanvasEditor
      language="en" documentId={1} documentPath="/notes/research.md"
      initialDocument={{ type: 'doc', content: [
        { type: 'image', attrs: { src: 'asset:/notes/research.assets/a.svg', originalSrc: 'research.assets/a.svg', basePath: '/notes', alt: 'Diagram' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
      ] }} onChange={onChange}
    />));
    const editor = harness.editor!;
    await act(async () => {
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.setNodeSelection(0);
      editor.commands.deleteSelection();
    });
    expect(editor.getJSON().content?.some((node) => node.type === 'image')).toBe(false);
    await act(async () => root.render(<CanvasEditor
      language="en" documentId={1} documentPath={destination}
      assetSourceOperation={operation === 'rename' ? 'rename' : 'rebase'}
      initialDocument={editor.getJSON()} onChange={onChange}
    />));
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(documentToPortableMarkdown(editor.getJSON())).toContain(`![Diagram](${expectedPath})`);
    expect(editor.getJSON().content![0].attrs?.basePath).toBe(destination.slice(0, destination.lastIndexOf('/')));
    await act(async () => { expect(editor.commands.redo()).toBe(true); });
    expect(editor.getJSON().content?.some((node) => node.type === 'image')).toBe(false);
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(documentToPortableMarkdown(editor.getJSON())).toContain(`![Diagram](${expectedPath})`);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});
