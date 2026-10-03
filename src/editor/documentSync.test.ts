import { Editor, type JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it, vi } from 'vitest';
import { documentsEqual, replaceDocumentPreservingSelection } from './documentSync';
import { canvasNodesAndMarks } from './canvasSchema';
import { CanvasAssetHistory } from './canvasAssetHistory';

describe('document synchronization', () => {
  it('compares a shared cached document without serializing it', () => {
    const document = { type: 'doc', content: [{ type: 'paragraph' }] };
    const stringify = vi.spyOn(JSON, 'stringify');
    const equal = documentsEqual(document, document);
    const calls = stringify.mock.calls.length;
    stringify.mockRestore();
    expect(equal).toBe(true);
    expect(calls).toBe(0);
  });

  it('does not treat a cloned saved document as changed', () => {
    const document = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '一段文字' }] }],
    };

    expect(documentsEqual(document, structuredClone(document))).toBe(true);
    expect(
      documentsEqual(document, {
        ...document,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '另一段文字' }],
          },
        ],
      }),
    ).toBe(false);
  });

  it('keeps the cursor in the middle when a transformed document must be reloaded', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: '<p>abcdefghij</p>',
    });
    editor.commands.setTextSelection(5);

    replaceDocumentPreservingSelection(editor, structuredClone(editor.getJSON()));

    expect(editor.state.selection.from).toBe(5);
    expect(editor.state.selection.to).toBe(5);
    editor.destroy();
  });

  it('moves only as far as the new document permits when content becomes shorter', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: '<p>abcdefghij</p>',
    });
    editor.commands.setTextSelection(9);

    replaceDocumentPreservingSelection(editor, {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'abc' }] }],
    });

    expect(editor.state.selection.from).toBe(4);
    editor.destroy();
  });

  it.each([
    ['heading level', { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] }, { level: 3 }],
    ['formula source', { type: 'paragraph', content: [{ type: 'inlineFormula', attrs: { latex: 'x' } }] }, { latex: 'y' }],
    ['image caption', { type: 'image', attrs: { src: 'https://example.com/a.png', alt: 'Before' } }, { alt: 'After' }],
    ['image source', { type: 'image', attrs: { src: 'asset:/notes/a.png', originalSrc: 'a.png', basePath: '/notes' } }, { src: 'asset:/notes/b.png', originalSrc: 'b.png' }],
    ['HTML source', { type: 'htmlPreview', attrs: { source: '<aside>Before</aside>' } }, { source: '<aside>After</aside>' }],
    ['opaque Markdown source', { type: 'unsupportedMarkdown', attrs: { source: '### Before ###' } }, { source: '### After ###' }],
  ] as [string, JSONContent, Record<string, unknown>][])('retains Canvas Undo for a user %s edit made in Source', (_name, node, changedAttributes) => {
    const editor = new Editor({
      extensions: [...canvasNodesAndMarks(), CanvasAssetHistory],
      content: { type: 'doc', content: [node, { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] },
    });
    try {
      const original = editor.getJSON();
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.commands.insertContent(' extended');
      editor.view.dispatch(closeHistory(editor.state.tr));
      const beforeSourceEdit = editor.getJSON();
      const replacement = structuredClone(beforeSourceEdit);
      const target = (node.type === 'paragraph' ? replacement.content![0].content![0] : replacement.content![0]) as JSONContent;
      target.attrs = { ...target.attrs, ...changedAttributes };
      replaceDocumentPreservingSelection(editor, replacement);
      expect(editor.getJSON()).toEqual(replacement);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(beforeSourceEdit);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(original);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(replacement);
    } finally { editor.destroy(); }
  });

  it('keeps user attributes in Undo even when a file update also requests an asset refresh', () => {
    const editor = new Editor({ extensions: canvasNodesAndMarks(), content: '<h2>Title</h2>' });
    try {
      const before = editor.getJSON();
      const replacement = structuredClone(before);
      replacement.content![0].attrs!.level = 3;
      replaceDocumentPreservingSelection(editor, replacement, { assetRefresh: true });
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
    } finally { editor.destroy(); }
  });
});
