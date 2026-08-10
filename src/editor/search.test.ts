import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearDocumentSearch,
  documentSearchPluginKey,
  DocumentSearch,
  findTextMatches,
  searchDocument,
} from './search';

const editors: Editor[] = [];
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    });
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

describe('document search', () => {
  it('finds case-insensitive, non-overlapping string matches', () => {
    expect(findTextMatches('Alpha alpha ALPHA', 'alpha')).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ]);
    expect(findTextMatches('aaaa', 'aa')).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
    expect(findTextMatches('anything', '')).toEqual([]);
    expect(findTextMatches('a.b A.B', 'a.b')).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });

  it('searches across formatting marks but not across block boundaries', () => {
    const editor = new Editor({
      extensions: [StarterKit, DocumentSearch],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Research ' },
              { type: 'text', marks: [{ type: 'bold' }], text: 'Notes' },
            ],
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Research Notes' }],
          },
        ],
      },
    });
    editors.push(editor);

    expect(searchDocument(editor, 'research notes', 'reset')).toEqual({
      current: 1,
      total: 2,
    });
    expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe('Research Notes');
    expect(documentSearchPluginKey.getState(editor.state)?.matches).toHaveLength(2);
    expect(documentSearchPluginKey.getState(editor.state)?.active).toBe(0);
    expect(searchDocument(editor, 'NotesResearch', 'reset')).toEqual({
      current: 0,
      total: 0,
    });
  });

  it('moves forward and backward with wraparound and clears its decorations', () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const editor = new Editor({
      extensions: [StarterKit, DocumentSearch],
      content: '<p>one two one</p>',
    });
    editors.push(editor);

    expect(searchDocument(editor, 'one', 'reset')).toEqual({
      current: 1,
      total: 2,
    });
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'center', inline: 'nearest' });
    expect(searchDocument(editor, 'one', 'next')).toEqual({
      current: 2,
      total: 2,
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(editor.state.selection.from).toBeGreaterThan(1);
    expect(searchDocument(editor, 'one', 'next')).toEqual({
      current: 1,
      total: 2,
    });
    expect(searchDocument(editor, 'one', 'previous')).toEqual({
      current: 2,
      total: 2,
    });

    clearDocumentSearch(editor);
    expect(editor.view.dom.querySelectorAll('.document-search-match')).toHaveLength(0);
  });
});
