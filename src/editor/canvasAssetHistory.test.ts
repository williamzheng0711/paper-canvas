import { Editor, type JSONContent } from '@tiptap/core';
import { closeHistory, redoDepth, undoDepth } from '@tiptap/pm/history';
import type * as TauriCore from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';
import { canvasNodesAndMarks } from './canvasSchema';
import { CanvasAssetHistory, canvasAssetTransitionKey, type CanvasAssetTransition } from './canvasAssetHistory';
import { replaceDocumentPreservingSelection } from './documentSync';
import { documentToPortableMarkdown } from '../lib/files';
import { CanvasCapacity, maximumCanvasCharacters } from './canvasCapacity';
import { getMessages } from '../i18n';

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
}));

function createEditor(): Editor {
  return new Editor({
    extensions: [...canvasNodesAndMarks(), CanvasAssetHistory],
    content: { type: 'doc', content: [
      { type: 'image', attrs: { src: 'asset:/notes/research.assets/a.svg', originalSrc: 'research.assets/a.svg', basePath: '/notes', alt: 'Diagram' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
    ] },
  });
}

function move(editor: Editor, oldPath: string, newPath: string, operation: CanvasAssetTransition['operation']): void {
  editor.view.dispatch(closeHistory(editor.state.tr)
    .setMeta('addToHistory', false).setMeta('preventUpdate', true)
    .setMeta(canvasAssetTransitionKey, { oldPath, newPath, operation }));
}

function separateEdit(editor: Editor, edit: () => void): void {
  editor.view.dispatch(closeHistory(editor.state.tr));
  edit();
}

describe('Canvas asset Undo history', () => {
  it('keeps resize, delete and typing history through consecutive Rename and Save As operations', () => {
    const editor = createEditor();
    try {
      separateEdit(editor, () => editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { ...editor.state.doc.nodeAt(0)!.attrs, width: '320' })));
      separateEdit(editor, () => { editor.commands.setNodeSelection(0); editor.commands.deleteSelection(); });
      move(editor, '/notes/research.md', '/notes/renamed.md', 'rename');
      move(editor, '/notes/renamed.md', '/projects/final.md', 'rename');
      move(editor, '/projects/final.md', '/exports/copy.md', 'rebase');
      separateEdit(editor, () => { editor.commands.setTextSelection(2); editor.commands.insertContent('new '); });

      expect(editor.commands.undo()).toBe(true);
      expect(editor.getText()).toBe('Body');
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.nodeAt(0)!.attrs).toMatchObject({
        originalSrc: '../projects/final.assets/a.svg', basePath: '/exports', src: 'asset:/projects/final.assets/a.svg', width: '320',
      });
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.nodeAt(0)!.attrs.width).toBeNull();
      expect(documentToPortableMarkdown(editor.getJSON())).toContain('![Diagram](../projects/final.assets/a.svg)');
      expect(editor.commands.undo()).toBe(false);
      for (let cycle = 0; cycle < 3; cycle++) {
        expect(editor.commands.redo()).toBe(true);
        expect(editor.state.doc.nodeAt(0)!.attrs).toMatchObject({ width: '320', originalSrc: '../projects/final.assets/a.svg' });
        expect(editor.commands.redo()).toBe(true);
        expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
        expect(editor.commands.redo()).toBe(true);
        expect(editor.getText()).toBe('Bnew ody');
        expect(editor.commands.redo()).toBe(false);
        expect(editor.commands.undo()).toBe(true);
        expect(editor.commands.undo()).toBe(true);
        expect(editor.commands.undo()).toBe(true);
        expect(documentToPortableMarkdown(editor.getJSON())).toContain('![Diagram](../projects/final.assets/a.svg)');
      }
    } finally { editor.destroy(); }
  });

  it('retains a first-save image rewrite in older resize Undo events and paste Redo', () => {
    const saved = new Editor({ extensions: [...canvasNodesAndMarks(), CanvasAssetHistory], content: '<p>Body</p>' });
    try {
      separateEdit(saved, () => saved.commands.insertContent({ type: 'image', attrs: { src: 'data:image/png;base64,AAECAw==', alt: 'Pasted' } }));
      const imagePosition = (() => { let position = 0; saved.state.doc.descendants((node, pos) => { if (node.type.name === 'image') position = pos; }); return position; })();
      separateEdit(saved, () => saved.view.dispatch(saved.state.tr.setNodeAttribute(imagePosition, 'width', '320')));
      const replacement = saved.getJSON();
      const image = replacement.content!.find((node) => node.type === 'image')!;
      image.attrs = { ...image.attrs, src: 'asset:/notes/first.assets/a.png', originalSrc: 'first.assets/a.png', basePath: '/notes' };
      replaceDocumentPreservingSelection(saved, replacement, { assetRefresh: true });
      move(saved, '/notes/first.md', '/notes/final.md', 'rename');
      expect(saved.commands.undo()).toBe(true);
      expect(saved.state.doc.nodeAt(imagePosition)!.attrs).toMatchObject({ width: null, originalSrc: 'final.assets/a.png', src: 'asset:/notes/final.assets/a.png' });
      expect(saved.commands.undo()).toBe(true);
      expect(saved.getJSON().content!.some((node) => node.type === 'image')).toBe(false);
      expect(saved.getText()).toBe('Body');
      expect(saved.commands.redo()).toBe(true);
      expect(documentToPortableMarkdown(saved.getJSON())).toContain('![Pasted](final.assets/a.png)');
      expect(saved.commands.redo()).toBe(true);
      expect(saved.state.doc.nodeAt(imagePosition)!.attrs.width).toBe('320');
    } finally { saved.destroy(); }
  });

  it.each([
    { type: 'htmlPreview', attrs: { source: '<figure><img src="research.assets/a.svg"></figure>', basePath: '/notes' } },
    { type: 'unsupportedMarkdown', attrs: { source: '### ![Diagram](research.assets/a.svg) ###' } },
  ] as JSONContent[])('rebases restored $type asset sources', (node) => {
    const editor = new Editor({ extensions: [...canvasNodesAndMarks(), CanvasAssetHistory], content: { type: 'doc', content: [node, { type: 'paragraph' }] } });
    try {
      editor.commands.setNodeSelection(0);
      editor.commands.deleteSelection();
      move(editor, '/notes/research.md', '/exports/copy.md', 'rebase');
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.firstChild!.attrs.source).toContain('../notes/research.assets/a.svg');
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
    } finally { editor.destroy(); }
  });

  it('rejects an oversized restored asset source before changing history, then permits retry after writing is reduced', () => {
    const image = '### ![Diagram](research.assets/a.svg) ###\n\n';
    const source = image + 'a'.repeat(230_000 - image.length);
    const writing = 'b'.repeat(maximumCanvasCharacters - source.length - 80);
    const onError = vi.fn();
    const editor = new Editor({
      extensions: [...canvasNodesAndMarks(), CanvasAssetHistory.configure({ onError }), CanvasCapacity],
      content: { type: 'doc', content: [
        { type: 'unsupportedMarkdown', attrs: { source } },
        { type: 'paragraph', content: [{ type: 'text', text: writing }] },
      ] },
    });
    try {
      editor.commands.setNodeSelection(0);
      editor.commands.deleteSelection();
      const longName = 'a'.repeat(200);
      move(editor, '/notes/research.md', `/notes/${longName}.md`, 'rename');
      const before = editor.state;
      const history = [undoDepth(before), redoDepth(before)];
      expect(() => editor.commands.undo()).not.toThrow();
      expect(editor.state).toBe(before);
      expect([undoDepth(editor.state), redoDepth(editor.state)]).toEqual(history);
      expect(onError).toHaveBeenCalledWith(getMessages().canvasEditLimited);

      // An external reduction of the current writing keeps the blocked Undo
      // event available and makes its complete restoration fit the same limit.
      editor.view.dispatch(editor.state.tr.delete(1, 501).setMeta('addToHistory', false));
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.firstChild!.attrs.source).toContain(`${longName}.assets/a.svg`);
      expect(editor.state.doc.lastChild!.textContent).toBe(writing.slice(500));
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.firstChild!.type.name).toBe('paragraph');
      expect(editor.getText()).toBe(writing.slice(500));
    } finally { editor.destroy(); }
  });

  it('reports an intermediate rewrite budget failure without changing the document or either history branch', () => {
    const image = '### ![Diagram](research.assets/a.svg) ###\n\n';
    const source = image + 'a'.repeat(maximumCanvasCharacters - image.length - 80);
    const onError = vi.fn();
    const editor = new Editor({
      extensions: [...canvasNodesAndMarks(), CanvasAssetHistory.configure({ onError }), CanvasCapacity],
      content: { type: 'doc', content: [
        { type: 'unsupportedMarkdown', attrs: { source } },
        { type: 'paragraph', content: [{ type: 'text', text: 'Body' }] },
      ] },
    });
    try {
      editor.commands.setNodeSelection(0);
      editor.commands.deleteSelection();
      separateEdit(editor, () => { editor.commands.setTextSelection(5); editor.commands.insertContent(' edited'); });
      expect(editor.commands.undo()).toBe(true);
      const longPath = `/notes/${'a'.repeat(200)}.md`;
      move(editor, '/notes/research.md', longPath, 'rename');
      move(editor, longPath, '/notes/final.md', 'rename');
      const before = editor.state;
      expect([undoDepth(before), redoDepth(before)]).toEqual([1, 1]);
      expect(() => editor.commands.undo()).not.toThrow();
      expect(editor.state).toBe(before);
      expect([undoDepth(editor.state), redoDepth(editor.state)]).toEqual([1, 1]);
      expect(onError).toHaveBeenCalledWith(getMessages().assetRewriteLimited);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getText()).toBe('Body edited');
    } finally { editor.destroy(); }
  });
});
