import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { documentsEqual, replaceDocumentPreservingSelection } from './documentSync';

describe('document synchronization', () => {
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
});
