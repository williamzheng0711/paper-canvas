import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type * as TiptapReact from '@tiptap/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CanvasEditor } from '../components/CanvasEditor';
import { markdownToDocument } from '../editor/markdown';

const harness = vi.hoisted(() => ({ editor: null as Editor | null }));
vi.mock('@tiptap/react', async (importOriginal) => {
  const actual = await importOriginal<typeof TiptapReact>();
  return { ...actual, useEditor: (...args: Parameters<typeof actual.useEditor>) => {
    const editor = actual.useEditor(...args);
    harness.editor = editor;
    return editor;
  } };
});

it('keeps an embedded-image Save rewrite out of the user Undo history', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const onEdit = vi.fn();
  const original = markdownToDocument('Body\n');
  try {
    await act(async () => root.render(<CanvasEditor language="en" documentId={1} documentPath="/notes/first.md" initialDocument={original} onChange={onChange} onEdit={onEdit} />));
    const editor = harness.editor!;
    await act(async () => {
      editor.commands.insertContent({ type: 'image', attrs: { src: 'data:image/png;base64,AAECAw==', alt: 'Pasted diagram' } });
      editor.view.dispatch(closeHistory(editor.state.tr));
    });
    const savedDocument = structuredClone(editor.getJSON());
    const image = savedDocument.content!.find((node) => node.type === 'image')!;
    image.attrs = { ...image.attrs, src: 'asset:/notes/first.assets/image.png', originalSrc: 'first.assets/image.png', basePath: '/notes' };
    const selection = editor.state.selection.toJSON();
    onEdit.mockClear();
    onChange.mockClear();
    await act(async () => root.render(<CanvasEditor language="en" documentId={2} documentPath="/notes/first.md" assetRefresh initialDocument={savedDocument} onChange={onChange} onEdit={onEdit} />));
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.getJSON().content!.find((node) => node.type === 'image')?.attrs?.src).toBe('asset:/notes/first.assets/image.png');
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.getJSON().content!.some((node) => node.type === 'image')).toBe(false);
    expect(editor.getText()).toBe('Body');
    await act(async () => { expect(editor.commands.redo()).toBe(true); });
    expect(editor.getJSON().content!.find((node) => node.type === 'image')?.attrs?.originalSrc).toBe('first.assets/image.png');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});
