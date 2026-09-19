import type { Editor } from '@tiptap/core';
import type * as TiptapReact from '@tiptap/react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CanvasEditor } from './CanvasEditor';

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

it('retains unpublished typing when recreating the editor, but accepts a new document', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const initialDocument = { type: 'doc', content: [{ type: 'paragraph' }] };
  const onChange = vi.fn();
  try {
    await act(async () =>
      root.render(<CanvasEditor language="en" documentId={1} initialDocument={initialDocument} onChange={onChange} />),
    );
    await act(async () => {
      harness.editor!.commands.insertContent('Recent unsaved words');
    });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () =>
      root.render(
        <CanvasEditor language="zh-Hant" documentId={1} initialDocument={initialDocument} onChange={onChange} />,
      ),
    );
    expect(harness.editor!.getText()).toBe('Recent unsaved words');
    await act(async () =>
      root.render(
        <CanvasEditor language="zh-Hant" documentId={2} initialDocument={initialDocument} onChange={onChange} />,
      ),
    );
    expect(harness.editor!.getText()).toBe('');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});
