import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
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

it('uses the current document path for image paste without recreating the editor after Save As', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const initialDocument = markdownConversion.markdownToDocument('Original text.');
  const copied = '<img src="https://example.com/a.png" data-image-original-src="/notes/images/a.png" alt="Diagram">';
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} documentPath="/notes/source.md" initialDocument={initialDocument} onChange={onChange} />,
    ));
    const editor = harness.editor!;
    await act(async () => {
      editor.commands.selectAll();
      editor.view.pasteHTML(copied, new Event('paste') as ClipboardEvent);
    });
    expect(editor.getJSON().content?.[0].attrs?.originalSrc).toBe('images/a.png');
    const beforePathChange = editor.getJSON();
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} documentPath="/exports/copy.md" initialDocument={initialDocument} onChange={onChange} />,
    ));
    expect(harness.editor).toBe(editor);
    expect(editor.getJSON()).toEqual(beforePathChange);
    await act(async () => {
      editor.commands.selectAll();
      editor.view.pasteHTML(copied, new Event('paste') as ClipboardEvent);
    });
    expect(editor.getJSON().content?.[0].attrs?.originalSrc).toBe('../notes/images/a.png');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
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

it('does not mark a standalone image document edited while setting up its labels', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const onEdit = vi.fn();
  const initialDocument = markdownConversion.markdownToDocument('![Image](https://example.com/a.png)');
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={initialDocument} onChange={onChange} onEdit={onEdit} />,
    ));
    expect(harness.editor!.getJSON().content?.map((node) => node.type)).toEqual(['image']);
    await act(async () => root.render(
      <CanvasEditor language="zh-Hant" documentId={1} initialDocument={initialDocument} onChange={onChange} onEdit={onEdit} />,
    ));
    expect(harness.editor!.getJSON().content?.map((node) => node.type)).toEqual(['image']);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each([
  '# Heading',
  '| A | B |\r\n| - | - |\r\n| First | Last |\r\n',
  '- First\n- Last',
  '```js\nconst value = 1;\n```',
  '![Image](https://example.com/a.png)',
  '<aside>HTML</aside>',
])('keeps a document ending in %s unchanged through reading and mode-selection actions', async (markdown) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<SwitchableEditorHandle>();
  const onChange = vi.fn();
  const onEdit = vi.fn();
  try {
    await act(async () => root.render(
      <CanvasEditor ref={handle} language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument(markdown)} onChange={onChange} onEdit={onEdit} />,
    ));
    const editor = harness.editor!;
    const before = editor.getJSON();
    await act(async () => {
      handle.current!.setSelectionProgress(1);
      handle.current!.focus();
      handle.current!.getMarkdownSelection?.();
      handle.current!.search('First', 'reset');
      handle.current!.clearSearch();
      handle.current!.runContextAction?.('selectAll');
      handle.current!.flushCommentMapping?.();
      editor.view.dom.blur();
    });
    expect(editor.getJSON()).toEqual(before);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(editor.commands.undo()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each(['![Image](https://example.com/a.png)', '| A | B |\n| - | - |\n| First | Last |'])('adds an editable paragraph after the first real edit and undoes it exactly for %s', async (markdown) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onEdit = vi.fn();
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument(markdown)} onChange={() => {}} onEdit={onEdit} />,
    ));
    const editor = harness.editor!;
    const before = editor.getJSON();
    await act(async () => {
      if (editor.state.doc.firstChild!.type.name === 'image') editor.commands.updateAttributes('image', { alt: 'Edited alt' });
      else editor.commands.insertContent('Typed');
    });
    expect(onEdit).toHaveBeenCalledOnce();
    expect(editor.state.doc.lastChild?.type.name).toBe('paragraph');
    const edited = editor.getJSON();
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.getJSON()).toEqual(before);
    await act(async () => { expect(editor.commands.redo()).toBe(true); });
    expect(editor.getJSON()).toEqual(edited);
  } finally {
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

it('preserves undo and redo when changing language', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const initialDocument = markdownConversion.markdownToDocument('Original text');
  const onChange = vi.fn();
  const render = (language: 'en' | 'zh-Hant') => root.render(
    <CanvasEditor language={language} documentId={1} initialDocument={initialDocument} onChange={onChange} />,
  );
  try {
    await act(async () => render('en'));
    const editor = harness.editor!;
    await act(async () => { harness.editor!.commands.insertContent('Typed '); });
    await act(async () => render('zh-Hant'));
    expect(harness.editor).toBe(editor);
    await act(async () => { expect(harness.editor!.commands.undo()).toBe(true); });
    expect(harness.editor!.getText()).toBe('Original text');
    await act(async () => render('en'));
    await act(async () => { expect(harness.editor!.commands.redo()).toBe(true); });
    expect(harness.editor!.getText()).toBe('Typed Original text');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('updates placeholder and footnote labels without replacing the editing state', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const initialDocument = markdownConversion.markdownToDocument('Reference[^a]\n\n[^a]: Note');
  const render = (language: 'en' | 'zh-Hant', documentId = 1, document = initialDocument) => root.render(
    <CanvasEditor language={language} documentId={documentId} initialDocument={document} onChange={onChange} />,
  );
  try {
    await act(async () => render('en'));
    const editor = harness.editor!;
    expect(host.querySelector('[data-footnote-reference] button')?.getAttribute('aria-label')).toBe(getMessages('en').footnoteReferenceLabel('1'));
    await act(async () => render('zh-Hant'));
    expect(harness.editor).toBe(editor);
    expect(host.querySelector('[data-footnote-reference] button')?.getAttribute('aria-label')).toBe(getMessages('zh-Hant').footnoteReferenceLabel('1'));
    expect(host.querySelector('[data-footnote-definition] button')?.getAttribute('aria-label')).toBe(getMessages('zh-Hant').footnoteBacklinkLabel('1'));
    await act(async () => render('zh-Hant', 2, markdownConversion.markdownToDocument('')));
    expect(host.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe(getMessages('zh-Hant').canvasPlaceholder);
    await act(async () => render('en', 2, markdownConversion.markdownToDocument('')));
    expect(host.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe(getMessages('en').canvasPlaceholder);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('keeps a preserved source document byte-for-byte through canvas setup and language changes', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const source = 'Original\0source\r\nwith mixed\nseparators\r';
  const initialDocument = markdownConversion.markdownToDocument(source);
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={initialDocument} onChange={() => {}} />,
    ));
    expect(markdownConversion.documentToMarkdown(harness.editor!.getJSON())).toBe(source);
    expect(host.querySelector('.unsupported-markdown > strong')?.textContent).toBe(getMessages('en').unsupportedMarkdownTitle);
    await act(async () => root.render(
      <CanvasEditor language="zh-Hant" documentId={1} initialDocument={initialDocument} onChange={() => {}} />,
    ));
    expect(markdownConversion.documentToMarkdown(harness.editor!.getJSON())).toBe(source);
    expect(host.querySelector('.unsupported-markdown > strong')?.textContent).toBe(getMessages('zh-Hant').unsupportedMarkdownTitle);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('keeps the same formula textarea and active composition while refreshing language labels', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const initialDocument = markdownConversion.markdownToDocument('Value $x$');
  const onChange = vi.fn();
  const render = (language: 'en' | 'zh-Hant') => root.render(
    <CanvasEditor language={language} documentId={1} initialDocument={initialDocument} onChange={onChange} />,
  );
  try {
    await act(async () => render('en'));
    expect(host.querySelector('.formula-render')?.getAttribute('title')).toBe(getMessages('en').formulaInspect);
    expect(host.querySelector('.formula-copy')?.getAttribute('aria-label')).toBe(getMessages('en').copyLatex);
    await act(async () => { host.querySelector<HTMLElement>('.formula-render')!.click(); });
    const source = host.querySelector<HTMLTextAreaElement>('.formula-editor__textarea')!;
    source.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    source.value = String.raw`\text{中文}`;
    source.setSelectionRange(1, 1);
    source.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    await act(async () => render('zh-Hant'));
    expect(host.querySelector('.formula-editor__textarea')).toBe(source);
    expect(source.value).toBe(String.raw`\text{中文}`);
    expect(source.selectionStart).toBe(1);
    expect(source.getAttribute('aria-label')).toBe(getMessages('zh-Hant').formulaSource('inline'));
    expect(host.querySelector('.formula-editor__done')?.getAttribute('aria-label')).toBe(getMessages('zh-Hant').finishFormula);
    expect(host.querySelector('.formula-editor__header > span')?.textContent).toBe(getMessages('zh-Hant').inlineMath);
    expect(host.querySelector('.formula-live-preview')?.getAttribute('aria-label')).toBe(getMessages('zh-Hant').formulaPreview);
    await act(async () => { source.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    expect(harness.editor!.getJSON().content?.[0].content?.[1]).toMatchObject({ attrs: { latex: String.raw`\text{中文}` } });
    vi.spyOn(harness.editor!.view, 'coordsAtPos').mockReturnValue({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(harness.editor!.commands.undo()).toBe(true);
    expect(harness.editor!.getJSON().content?.[0].content?.[1]).toMatchObject({ attrs: { latex: 'x' } });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each(['Value $x$', '$$\nx\n$$'])('flushes visible composing formula input before publishing %s', async (markdown) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<SwitchableEditorHandle>();
  const onChange = vi.fn();
  const onEdit = vi.fn();
  try {
    await act(async () => root.render(
      <CanvasEditor ref={handle} language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument(markdown)} onChange={onChange} onEdit={onEdit} />,
    ));
    const editor = harness.editor!;
    const before = editor.getJSON();
    await act(async () => handle.current!.flushCommentMapping?.());
    expect(onChange).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLElement>('.formula-render')!.click(); });
    const source = host.querySelector<HTMLTextAreaElement>('textarea')!;
    const value = String.raw`\begin{equation}`;
    source.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    source.value = value;
    source.setSelectionRange(1, 1);
    source.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    await act(async () => handle.current!.flushCommentMapping?.());
    let formula: Editor['state']['doc'] | undefined;
    editor.state.doc.descendants((node) => { if (node.type.name.endsWith('Formula')) formula = node; });
    expect(formula!.attrs.latex).toBe(value);
    expect(host.querySelector('textarea')).toBe(source);
    expect(source.value).toBe(value);
    expect(source.selectionStart).toBe(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    await act(async () => handle.current!.flushCommentMapping?.());
    expect(onChange).toHaveBeenCalledTimes(1);
    const continued = String.raw`\begin{align}`;
    source.value = continued;
    source.setSelectionRange(source.value.length, source.value.length);
    source.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    await act(async () => { source.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    editor.state.doc.descendants((node) => { if (node.type.name.endsWith('Formula')) formula = node; });
    expect(formula!.attrs.latex).toBe(`${continued}\\end{align}`);
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each([
  { isComposing: true, keyCode: 90 },
  { isComposing: false, keyCode: 229 },
])('does not run comment history shortcuts during composition ($isComposing, $keyCode)', async (input) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onUndoComment = vi.fn();
  const onRedoComment = vi.fn();
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('Original text')} onChange={() => {}} canUndoComment canRedoComment onUndoComment={onUndoComment} onRedoComment={onRedoComment} />,
    ));
    const editor = harness.editor!;
    for (const shortcut of [{ key: 'z' }, { key: 'z', shiftKey: true }, { key: 'y' }]) {
      const event = new KeyboardEvent('keydown', { ...shortcut, ...input, ctrlKey: true, cancelable: true });
      const handlers = editor.options.editorProps?.handleDOMEvents;
      expect(handlers?.keydown?.(editor.view, event)).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(onUndoComment).not.toHaveBeenCalled();
    expect(onRedoComment).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('starts a new file session with fresh undo history and preserves undo across Save As', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  const first = markdownConversion.markdownToDocument('First file');
  const second = markdownConversion.markdownToDocument('Second file');
  try {
    await act(async () => root.render(
      <CanvasEditor key={1} language="en" documentId={1} documentPath="/notes/first.md" initialDocument={first} onChange={onChange} />,
    ));
    const previousEditor = harness.editor!;
    await act(async () => { previousEditor.commands.insertContent('Latest '); });
    expect(previousEditor.can().undo()).toBe(true);
    await act(async () => root.render(
      <CanvasEditor key={2} language="en" documentId={2} documentPath="/notes/second.md" initialDocument={second} onChange={onChange} />,
    ));
    const editor = harness.editor!;
    expect(editor).not.toBe(previousEditor);
    expect(editor.getText()).toBe('Second file');
    expect(editor.commands.undo()).toBe(false);
    expect(editor.commands.redo()).toBe(false);
    expect(editor.getText()).toBe('Second file');
    await act(async () => { editor.commands.insertContent('Fresh '); });
    await act(async () => root.render(
      <CanvasEditor key={2} language="en" documentId={2} documentPath="/exports/second.md" initialDocument={second} onChange={onChange} />,
    ));
    expect(harness.editor).toBe(editor);
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.getText()).toBe('Second file');
    await act(async () => { expect(editor.commands.redo()).toBe(true); });
    expect(editor.getText()).toBe('Fresh Second file');
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

it.each([
  { action: 'paste', grouped: true },
  { action: 'drop', grouped: true },
  { action: 'paste', grouped: false },
  { action: 'drop', grouped: false },
] as const)('inserts every $action image in request order even when reads finish in reverse order (grouped: $grouped)', async ({ action, grouped }) => {
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
  const handle = createRef<SwitchableEditorHandle>();
  try {
    await act(async () => root.render(
      <CanvasEditor ref={handle} language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('Original text')} onChange={() => {}} />,
    ));
    const editor = harness.editor!;
    const images = ['first.png', 'second.png', 'third.png'].map((name) => new File(['image'], name, { type: 'image/png' }));
    if (action === 'drop') vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: 0 });
    for (const files of grouped ? [images] : images.map((image) => [image])) {
      const event = new Event(action, { cancelable: true });
      Object.defineProperty(event, action === 'paste' ? 'clipboardData' : 'dataTransfer', { value: { files } });
      if (action === 'paste') {
        expect(editor.view.someProp('handlePaste', (handler) => handler(editor.view, event as ClipboardEvent, null!))).toBe(true);
      } else {
        expect(editor.view.someProp('handleDrop', (handler) => handler(editor.view, event as DragEvent, null!, false))).toBe(true);
      }
    }
    expect(readers).toHaveLength(3);
    const completion = handle.current?.waitForPendingImages?.();
    await act(async () => {
      readers[2].onload?.();
      readers[1].onload?.();
      readers[0].onload?.();
      await completion;
    });
    expect(editor.getJSON().content?.filter((node) => node.type === 'image').map((node) => node.attrs?.alt)).toEqual(['first.png', 'second.png', 'third.png']);
    expect(editor.state.doc.textContent).toBe('Original text');
    await act(async () => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.getJSON().content?.filter((node) => node.type === 'image')).toHaveLength(0);
    expect(editor.getText()).toBe('Original text');
    await act(async () => { expect(editor.commands.redo()).toBe(true); });
    expect(editor.getJSON().content?.filter((node) => node.type === 'image').map((node) => node.attrs?.alt)).toEqual(['first.png', 'second.png', 'third.png']);
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

it.each([
  { text: 'Before **text* after', closing: '*', prefix: 'Before **text*', node: 'text' },
  { text: 'Before $$ after', closing: 'x', prefix: 'Before $', node: 'inlineFormula' },
])('maps a pending image through appended Markdown conversion: $node', async ({ text, closing, prefix, node }) => {
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
  const onLinkError = vi.fn();
  try {
    await act(async () => root.render(
      <CanvasEditor language="en" documentId={1} initialDocument={{ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }} onChange={() => {}} onLinkError={onLinkError} />,
    ));
    const editor = harness.editor!;
    editor.commands.setTextSelection(text.length + 1);
    const event = new Event('paste', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [new File(['image'], 'sample.png', { type: 'image/png' })] },
    });
    editor.view.someProp('handlePaste', (handler) => handler(editor.view, event as ClipboardEvent, null!));
    await act(async () => {
      const position = prefix.length + 1;
      const transaction = editor.state.tr.insertText(closing, position, position);
      transaction.setSelection(TextSelection.create(transaction.doc, position + closing.length));
      editor.view.dispatch(transaction);
    });
    const beforeImage = editor.getJSON();
    expect(beforeImage.content?.[0].content?.some((content) => content.type === node)).toBe(true);
    await act(async () => { finishRead?.(); });
    expect(onLinkError).not.toHaveBeenCalled();
    expect(editor.getJSON().content?.filter((content) => content.type === 'image')).toHaveLength(1);
    expect(editor.getJSON().content?.[0]).toEqual(beforeImage.content?.[0]);
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

it.each([
  { waiting: false, replacing: false },
  { waiting: true, replacing: false },
  { waiting: true, replacing: true },
])('handles failed image reads without unhandled rejection (waiting: $waiting, replacement: $replacing)', async ({ waiting, replacing }) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const failure = new Error('Image could not be read');
  let failRead: (() => void) | undefined;
  vi.stubGlobal('FileReader', class {
    error = failure;
    onerror: (() => void) | null = null;
    readAsDataURL() { failRead = () => this.onerror?.(); }
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<SwitchableEditorHandle>();
  const onChange = vi.fn();
  const onEdit = vi.fn();
  const onLinkError = vi.fn();
  try {
    await act(async () => root.render(
      <CanvasEditor ref={handle} language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('Original text')} onChange={onChange} onEdit={onEdit} onLinkError={onLinkError} />,
    ));
    const editor = harness.editor!;
    let before = editor.getJSON();
    const event = new Event('paste', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [new File(['image'], 'sample.png', { type: 'image/png' })] },
    });
    editor.view.someProp('handlePaste', (handler) => handler(editor.view, event as ClipboardEvent, null!));
    const completion = waiting ? handle.current?.waitForPendingImages?.()?.catch((error: unknown) => error) : undefined;
    if (replacing) {
      await act(async () => root.render(
        <CanvasEditor ref={handle} language="en" documentId={2} initialDocument={markdownConversion.markdownToDocument('Next document')} onChange={onChange} onEdit={onEdit} onLinkError={onLinkError} />,
      ));
      before = editor.getJSON();
    }
    let outcome: unknown;
    await act(async () => {
      failRead?.();
      outcome = await completion;
      await Promise.resolve();
    });
    if (waiting && !replacing) expect(outcome).toBe(failure);
    else expect(outcome).toBeUndefined();
    if (replacing) expect(onLinkError).not.toHaveBeenCalled();
    else expect(onLinkError).toHaveBeenCalledExactlyOnceWith(failure.message);
    expect(onChange).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(before);
    expect(handle.current?.waitForPendingImages?.()).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it('settles an aborted image read so saving does not wait forever', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let abortRead: (() => void) | undefined;
  vi.stubGlobal('FileReader', class {
    onabort: (() => void) | null = null;
    readAsDataURL() { abortRead = () => this.onabort?.(); }
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<SwitchableEditorHandle>();
  const onLinkError = vi.fn();
  try {
    await act(async () => root.render(
      <CanvasEditor ref={handle} language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('Original text')} onChange={() => {}} onLinkError={onLinkError} />,
    ));
    const editor = harness.editor!;
    const event = new Event('paste', { cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { files: [new File(['image'], 'sample.png', { type: 'image/png' })] },
    });
    editor.view.someProp('handlePaste', (handler) => handler(editor.view, event as ClipboardEvent, null!));
    const completion = handle.current?.waitForPendingImages?.()?.catch((error: unknown) => error);
    await act(async () => { abortRead?.(); });
    expect(await completion).toEqual(new Error(getMessages().imageReadFailed));
    expect(onLinkError).toHaveBeenCalledExactlyOnceWith(getMessages().imageReadFailed);
    expect(handle.current?.waitForPendingImages?.()).toBeUndefined();
    expect(editor.state.doc.textContent).toBe('Original text');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each(['copy', 'cut'] as const)('keeps context %s anchored to its captured text after a pending insertion', async (action) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<SwitchableEditorHandle>();
  const originalExec = Object.getOwnPropertyDescriptor(document, 'execCommand');
  const executed = vi.fn((command: string) => {
    const editor = harness.editor!;
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe('world');
    if (command === 'cut') editor.view.dispatch(closeHistory(editor.state.tr).deleteSelection());
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: executed });
  try {
    await act(async () => root.render(<CanvasEditor ref={handle} language="en" documentId={1} initialDocument={markdownConversion.markdownToDocument('hello world')} onChange={() => {}} />));
    const editor = harness.editor!;
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ left: 0, right: 0, top: 0, bottom: 0 });
    const initial = editor.getJSON();
    await act(async () => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7, 12)));
      editor.options.editorProps?.handleDOMEvents?.mousedown?.(editor.view, new MouseEvent('mousedown', { button: 2 }));
      editor.view.dispatch(closeHistory(editor.state.tr).insertText('prefix ', 1));
    });
    const beforeAction = editor.getJSON();
    await act(async () => handle.current!.runContextAction!(action));
    expect(executed).toHaveBeenCalledWith(action);
    const afterAction = editor.getJSON();
    expect(editor.state.doc.textContent).toBe(action === 'cut' ? 'prefix hello ' : 'prefix hello world');
    await act(async () => {
      if (action === 'cut') { expect(editor.commands.undo()).toBe(true); expect(editor.getJSON()).toEqual(beforeAction); }
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(initial);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(beforeAction);
      if (action === 'cut') { expect(editor.commands.redo()).toBe(true); expect(editor.getJSON()).toEqual(afterAction); }
    });
  } finally {
    if (originalExec) Object.defineProperty(document, 'execCommand', originalExec); else Reflect.deleteProperty(document, 'execCommand');
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});

it.each(['appended normalization', 'deleted range', 'replaced file'] as const)('resolves a context selection safely after %s', async (scenario) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const handle = createRef<SwitchableEditorHandle>();
  const originalExec = Object.getOwnPropertyDescriptor(document, 'execCommand');
  const executed = vi.fn(() => {
    const editor = harness.editor!;
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe(scenario === 'appended normalization' ? 'world' : '');
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: executed });
  const render = (id: number, markdown: string) => root.render(<CanvasEditor ref={handle} language="en" documentId={id} initialDocument={markdownConversion.markdownToDocument(markdown)} onChange={() => {}} />);
  try {
    await act(async () => render(1, 'hello world'));
    const editor = harness.editor!;
    await act(async () => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 7, 12)));
      editor.options.editorProps?.handleDOMEvents?.mousedown?.(editor.view, new MouseEvent('mousedown', { button: 2 }));
      if (scenario === 'appended normalization') editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1)).insertText('`x`'));
      if (scenario === 'deleted range') editor.view.dispatch(editor.state.tr.delete(7, 12));
    });
    if (scenario === 'appended normalization') expect(editor.getJSON().content?.[0].content?.[0].marks).toEqual([{ type: 'code' }]);
    if (scenario === 'replaced file') await act(async () => render(2, 'a'));
    const beforeAction = harness.editor!.getJSON();
    await act(async () => handle.current!.runContextAction!('cut'));
    expect(executed).toHaveBeenCalledWith('cut');
    expect(harness.editor!.getJSON()).toEqual(beforeAction);
  } finally {
    if (originalExec) Object.defineProperty(document, 'execCommand', originalExec); else Reflect.deleteProperty(document, 'execCommand');
    await act(async () => root.unmount());
    host.remove();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
  }
});
