import type { Editor } from '@tiptap/core';
import type * as TiptapReact from '@tiptap/react';
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CanvasEditor } from './CanvasEditor';
import type { SwitchableEditorHandle } from '../editor/search';
import { commentContext, markdownFingerprint, type MarkdownComment } from '../editor/comments';
import { commentDecorationsPluginKey } from '../editor/commentDecorations';
import * as markdownConversion from '../editor/markdown';
import * as documentSynchronization from '../editor/documentSync';
import { getMessages } from '../i18n';

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

it('does not publish an unchanged document when reading tools flush the canvas', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<SwitchableEditorHandle>();
  const onChange = vi.fn();
  const serialize = vi.spyOn(markdownConversion, 'documentToMarkdown');
  const replace = vi.spyOn(documentSynchronization, 'replaceDocumentPreservingSelection');
  try {
    await act(async () => root.render(
      <CanvasEditor ref={handle} language="en" documentId={1} initialDocument={{ type: 'doc', content: [{ type: 'paragraph' }] }} onChange={onChange} />,
    ));
    handle.current?.flushCommentMapping?.();
    expect(onChange).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  } finally {
    serialize.mockRestore();
    replace.mockRestore();
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('keeps comment anchors and publishes pending typing after a language change', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const markdown = 'First target\n';
  const target = { kind: 'range' as const, from: 6, to: 12 };
  const context = commentContext(markdown, target);
  const comment: MarkdownComment = {
    id: 'comment-1', content: 'Read this', target, excerpt: 'target',
    contextBefore: context.before, contextAfter: context.after, anchorText: context.anchorText,
    bodyFingerprint: markdownFingerprint(markdown), status: 'active',
  };
  const initialDocument = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First target' }] }] };
  const onChange = vi.fn();
  const comments = [comment];
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={initialDocument} comments={comments} onChange={onChange} />,
    ));
    await act(async () => { harness.editor!.commands.insertContent('New '); });
    const selectionBeforeLanguageChange = harness.editor!.state.selection.head;
    expect(commentDecorationsPluginKey.getState(harness.editor!.state)?.positions[0].from).toBe(11);
    await act(async () => root.render(
      <CanvasEditor language="zh-Hant" documentId={1} initialDocument={initialDocument} comments={comments} onChange={onChange} />,
    ));
    expect(harness.editor!.getText()).toBe('New First target');
    expect(harness.editor!.state.selection.head).toBe(selectionBeforeLanguageChange);
    expect(commentDecorationsPluginKey.getState(harness.editor!.state)?.positions[0].from).toBe(11);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)); });
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][1][0].target).toEqual({ kind: 'range', from: 10, to: 16 });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('activates a reading link without editing the document', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('Read [the paper](https://example.com/paper).')} onChange={onChange} />,
    ));
    const editor = harness.editor!;
    const before = editor.getJSON();
    const link = host.querySelector('a')!;
    const event = new MouseEvent('click', { button: 0, cancelable: true });
    Object.defineProperty(event, 'target', { value: link });
    expect(editor.view.someProp('handleClick', (handler) => handler(editor.view, 1, event))).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/paper', '_blank', 'noopener,noreferrer');
    expect(editor.getJSON()).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('reports a missing heading fragment without navigation or document edits', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const onEdit = vi.fn();
  const onLinkError = vi.fn();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('# Available\n\n[Missing](#not-here).')} onChange={onChange} onEdit={onEdit} onLinkError={onLinkError} />,
    ));
    const editor = harness.editor!;
    const before = editor.getJSON();
    const event = new MouseEvent('click', { button: 0, cancelable: true });
    Object.defineProperty(event, 'target', { value: host.querySelector('a') });
    await act(async () => {
      expect(editor.view.someProp('handleClick', (handler) => handler(editor.view, 1, event))).toBe(true);
      await Promise.resolve();
    });
    expect(event.defaultPrevented).toBe(true);
    expect(onLinkError).toHaveBeenCalledOnce();
    expect(onLinkError).toHaveBeenCalledWith(getMessages('en').documentLinkUnavailable);
    expect(open).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(before);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
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

it('blocks unsupported relative links from navigating away from the editor', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onLinkError = vi.fn();
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('[Related notes](../notes.md)')} onChange={() => {}} onLinkError={onLinkError} />,
    ));
    const editor = harness.editor!;
    const before = editor.getJSON();
    const event = new MouseEvent('click', { button: 0, metaKey: true, cancelable: true });
    Object.defineProperty(event, 'target', { value: host.querySelector('a') });
    expect(editor.view.someProp('handleClick', (handler) => handler(editor.view, 1, event))).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(onLinkError).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(before);
  } finally {
    open.mockRestore();
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each(['paste', 'drop'] as const)('does not insert a delayed %s image into a different document', async (action) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const readers: Array<{ result: string; onload: (() => void) | null }> = [];
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,dGVzdA==';
    onload: (() => void) | null = null;
    readAsDataURL() { readers.push(this); }
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const firstDocument = markdownConversion.markdownToDocument('First document');
  const nextDocument = markdownConversion.markdownToDocument('Second document');
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={firstDocument} onChange={onChange} />,
    ));
    const editor = harness.editor!;
    const event = new Event(action, { cancelable: true });
    Object.defineProperty(event, action === 'paste' ? 'clipboardData' : 'dataTransfer', {
      value: { files: [new File(['image'], 'sample.png', { type: 'image/png' })] },
    });
    if (action === 'paste') {
      expect(editor.view.someProp('handlePaste', (handler) => handler(editor.view, event as ClipboardEvent, null!))).toBe(true);
    } else {
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(null);
      expect(editor.view.someProp('handleDrop', (handler) => handler(editor.view, event as DragEvent, null!, false))).toBe(true);
    }
    expect(readers).toHaveLength(1);
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={2} initialDocument={nextDocument} onChange={onChange} />,
    ));
    await act(async () => { readers[0].onload?.(); });
    expect(harness.editor!.getJSON()).toEqual(nextDocument);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each([false, true])('inserts an image while its document remains open (language change: %s)', async (changeLanguage) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let finishRead: (() => void) | undefined;
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,dGVzdA==';
    onload: (() => void) | null = null;
    readAsDataURL() { finishRead = () => this.onload?.(); }
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const initialDocument = markdownConversion.markdownToDocument('A document');
  const onChange = vi.fn();
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={initialDocument} onChange={onChange} />,
    ));
    const editor = harness.editor!;
    editor.commands.setTextSelection(3);
    const event = new Event('paste', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [new File(['image'], 'sample.png', { type: 'image/png' })] },
    });
    editor.view.someProp('handlePaste', (handler) => handler(editor.view, event as ClipboardEvent, null!));
    if (changeLanguage) await act(async () => root.render(
      <CanvasEditor language="zh-Hant" documentId={1} initialDocument={initialDocument} onChange={onChange} />,
    ));
    await act(async () => { finishRead?.(); });
    const content = harness.editor!.getJSON().content!;
    expect(content.map((node) => node.type)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(content[0].content).toEqual([{ type: 'text', text: 'A ' }]);
    expect(content[1]).toEqual(expect.objectContaining({
      type: 'image', attrs: expect.objectContaining({ src: 'data:image/png;base64,dGVzdA==', alt: 'sample.png' }),
    }));
    expect(content[2].content).toEqual([{ type: 'text', text: 'document' }]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('ignores a pasted image that finishes between unmount and deferred editor destruction', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let finishRead: (() => void) | undefined;
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,dGVzdA==';
    onload: (() => void) | null = null;
    readAsDataURL() { finishRead = () => this.onload?.(); }
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onEdit = vi.fn();
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('A document')} onChange={() => {}} onEdit={onEdit} />,
    ));
    const editor = harness.editor!;
    const event = new Event('paste', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [new File(['image'], 'sample.png', { type: 'image/png' })] },
    });
    editor.view.someProp('handlePaste', (handler) => handler(editor.view, event as ClipboardEvent, null!));
    vi.useFakeTimers();
    await act(async () => {
      root.unmount();
      expect(editor.isDestroyed).toBe(false);
      finishRead?.();
    });
    expect(onEdit).not.toHaveBeenCalled();
  } finally {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    host.remove();
    vi.unstubAllGlobals();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each([
  { action: 'paste', changeLanguage: false },
  { action: 'drop', changeLanguage: false },
  { action: 'paste', changeLanguage: true },
  { action: 'drop', changeLanguage: true },
] as const)('maps a delayed $action image through edits and cursor movement (language change: $changeLanguage)', async ({ action, changeLanguage }) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let finishRead: (() => void) | undefined;
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,dGVzdA==';
    onload: (() => void) | null = null;
    readAsDataURL() { finishRead = () => this.onload?.(); }
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('Before after')} onChange={() => {}} />,
    ));
    const editor = harness.editor!;
    editor.commands.setTextSelection(8);
    const event = new Event(action, { cancelable: true });
    Object.defineProperty(event, action === 'paste' ? 'clipboardData' : 'dataTransfer', {
      value: { files: [new File(['image'], 'sample.png', { type: 'image/png' })] },
    });
    if (action === 'paste') {
      editor.view.someProp('handlePaste', (handler) => handler(editor.view, event as ClipboardEvent, null!));
    } else {
      vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 8, inside: 0 });
      editor.view.someProp('handleDrop', (handler) => handler(editor.view, event as DragEvent, null!, false));
    }
    await act(async () => {
      editor.commands.insertContentAt(1, 'New ');
      editor.commands.setTextSelection(1);
    });
    if (changeLanguage) await act(async () => root.render(
      <CanvasEditor language="zh-Hant" documentId={1} initialDocument={markdownConversion.markdownToDocument('Before after')} onChange={() => {}} />,
    ));
    await act(async () => {
      finishRead?.();
    });
    const content = harness.editor!.getJSON().content!;
    expect(content.map((node) => node.type)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(content[0].content).toEqual([{ type: 'text', text: 'New Before ' }]);
    expect(content[2].content).toEqual([{ type: 'text', text: 'after' }]);
    expect(harness.editor!.state.selection.head).toBe(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each([false, true])('replaces only unchanged selected content after an image read (range edited: %s)', async (editRange) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let finishRead: (() => void) | undefined;
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,dGVzdA==';
    onload: (() => void) | null = null;
    readAsDataURL() { finishRead = () => this.onload?.(); }
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<SwitchableEditorHandle>();
  try {
    await act(async () => root.render(
      <CanvasEditor ref={handle} language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('Before target after')} onChange={() => {}} />,
    ));
    const editor = harness.editor!;
    editor.commands.setTextSelection({ from: 8, to: 14 });
    const event = new Event('paste', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [new File(['image'], 'sample.png', { type: 'image/png' })] },
    });
    editor.view.someProp('handlePaste', (handler) => handler(editor.view, event as ClipboardEvent, null!));
    let settled = false;
    const completion = handle.current?.waitForPendingImages?.()?.then(() => { settled = true; });
    expect(completion).toBeDefined();
    await act(async () => {
      if (editRange) editor.commands.insertContentAt(11, 'LATEST');
      editor.commands.setTextSelection(1);
      await Promise.resolve();
    });
    expect(settled).toBe(false);
    await act(async () => {
      finishRead?.();
      await completion;
    });
    expect(settled).toBe(true);
    expect(handle.current?.waitForPendingImages?.()).toBeUndefined();
    const content = editor.getJSON().content!;
    expect(content.map((node) => node.type)).toEqual(['paragraph', 'image', 'paragraph']);
    expect(content[0].content).toEqual([{ type: 'text', text: editRange ? 'Before tarLATESTget' : 'Before ' }]);
    expect(content[2].content).toEqual([{ type: 'text', text: ' after' }]);
    expect(editor.state.selection.head).toBe(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});
