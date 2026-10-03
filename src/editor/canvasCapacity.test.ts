import { Editor, type JSONContent } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';
import { CanvasCapacity, canvasDocumentSupported, maximumCanvasCharacters, maximumCanvasNodes } from './canvasCapacity';
import { canvasNodesAndMarks } from './canvasSchema';
import { sanitizePastedHtml } from './paste';
import { TableMap } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';

describe('large canvas capacity', () => {
  it('includes point and collapsed-range comment widgets in the shared node budget', () => {
    const document: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] };
    const points = Array.from({ length: 12_000 }, () => ({ target: { kind: 'position' as const, offset: 1 } }));
    const ranges = Array.from({ length: 12_000 }, () => ({ target: { kind: 'range' as const, from: 1, to: 2 } }));
    const supportedCount = Math.floor((maximumCanvasNodes - 3) / 3);

    expect(canvasDocumentSupported(document, points)).toBe(false);
    expect(canvasDocumentSupported(document, points.slice(0, supportedCount))).toBe(true);
    expect(canvasDocumentSupported(document, points.slice(0, supportedCount + 1))).toBe(false);
    expect(canvasDocumentSupported(document, ranges)).toBe(true);
    expect(canvasDocumentSupported(document, ranges.map(({ target }) => ({ target: { ...target, to: target.from } })))).toBe(false);
    expect(points).toHaveLength(12_000);
    expect(document.content?.[0].content?.[0].text).toBe('Body');
  });

  it('rejects a sparse wide table before its automatic repair can exceed capacity', () => {
    const onLimit = vi.fn();
    const editor = new Editor({ element: document.createElement('div'), extensions: [...canvasNodesAndMarks(), CanvasCapacity.configure({ onLimit })], content: '<p>Original writing</p>', editorProps: { transformPastedHTML: sanitizePastedHtml } });
    try {
      const before = editor.getJSON();
      editor.commands.selectAll();
      const html = '<table><tr><td colspan="1000"><p>Wide</p></td></tr>' + '<tr><td><p>Row</p></td></tr>'.repeat(29) + '</table>';
      expect(() => editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent)).not.toThrow();
      expect(onLimit).toHaveBeenCalledOnce();
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.undo()).toBe(false);
      editor.commands.insertContentAt(1, 'Latest ');
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.textContent).toBe('Latest Original writing');
    } finally { editor.destroy(); }
  });

  it('allows small ragged tables to repair and wide merged tables to remain intact', () => {
    const onLimit = vi.fn();
    const editor = new Editor({ extensions: [...canvasNodesAndMarks(), CanvasCapacity.configure({ onLimit })], content: '<p>Original</p>', editorProps: { transformPastedHTML: sanitizePastedHtml } });
    try {
      for (const html of [
        '<table><tr><td colspan="3"><p>Wide</p></td></tr><tr><td><p>Row</p></td></tr></table>',
        '<table><tr><td colspan="1000"><p>Wide</p></td></tr><tr><td colspan="1000"><p>Row</p></td></tr></table>',
      ]) {
        editor.commands.selectAll();
        editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent);
        expect(editor.state.doc.firstChild?.type.name).toBe('table');
        expect(TableMap.get(editor.state.doc.firstChild!).problems).toBeNull();
        expect(editor.state.doc.textContent).toContain('Wide');
        expect(editor.state.doc.textContent).toContain('Row');
        expect(() => editor.state.doc.check()).not.toThrow();
      }
      expect(onLimit).not.toHaveBeenCalled();
    } finally { editor.destroy(); }
  });

  it('uses the same preflight for recovered JSON tables and live table models', () => {
    const paragraph = (text: string): JSONContent => ({ type: 'paragraph', content: [{ type: 'text', text }] });
    const cell = (colspan: number, rowspan: number, text: string): JSONContent => ({ type: 'tableCell', attrs: { colspan, rowspan }, content: [paragraph(text)] });
    const collision: JSONContent = { type: 'table', content: [
      { type: 'tableRow', content: [cell(1, 1, 'First'), cell(999, 2, 'Spanning')] },
      { type: 'tableRow', content: [cell(1000, 1, 'Overlapping')] },
    ] };
    const editor = new Editor({ extensions: canvasNodesAndMarks(), content: '<p>Original</p>' });
    try {
      const document: JSONContent = { type: 'doc', content: [collision] };
      expect(canvasDocumentSupported(document)).toBe(false);
      expect(canvasDocumentSupported(editor.schema.nodeFromJSON(document))).toBe(false);
      const small: JSONContent = { type: 'doc', content: [{ type: 'table', content: [
        { type: 'tableRow', content: [cell(3, 1, 'Wide')] },
        { type: 'tableRow', content: [cell(1, 1, 'Row')] },
      ] }] };
      expect(canvasDocumentSupported(small)).toBe(true);
      expect(canvasDocumentSupported(editor.schema.nodeFromJSON(small))).toBe(true);
    } finally { editor.destroy(); }
  });

  it('rejects table commands that would exceed the recoverable colspan limit', () => {
    const onLimit = vi.fn();
    const editor = new Editor({ extensions: [...canvasNodesAndMarks(), CanvasCapacity.configure({ onLimit })], content: '<table><tr><td colspan="1000"><p>Wide</p></td></tr><tr><td><p>First</p></td><td colspan="999"><p>Rest</p></td></tr></table>' });
    try {
      const before = editor.getJSON();
      const secondRow = 1 + editor.state.doc.firstChild!.firstChild!.nodeSize + 3;
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, secondRow)));
      editor.commands.addColumnAfter();
      expect(onLimit).toHaveBeenCalledOnce();
      expect(editor.getJSON()).toEqual(before);
      expect(() => editor.state.doc.check()).not.toThrow();
      expect(editor.commands.undo()).toBe(false);
    } finally { editor.destroy(); }
  });

  it('bounds both model and JSON trees without modifying their content', () => {
    const large: JSONContent = { type: 'doc', content: Array.from({ length: maximumCanvasNodes }, () => ({ type: 'paragraph' })) };
    expect(canvasDocumentSupported(large)).toBe(false);
    const editor = new Editor({ extensions: canvasNodesAndMarks(), content: { type: 'doc', content: [{ type: 'paragraph' }] } });
    try {
      const model = editor.schema.nodeFromJSON(large);
      expect(canvasDocumentSupported(model)).toBe(false);
      expect(model.childCount).toBe(maximumCanvasNodes);
      expect(canvasDocumentSupported(editor.state.doc)).toBe(true);
      expect(canvasDocumentSupported({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(maximumCanvasCharacters + 1) }] }] })).toBe(false);
    } finally { editor.destroy(); }
  });

  it('rejects an oversized insertion before rendering it, then keeps typing and undo usable', () => {
    const onLimit = vi.fn();
    const editor = new Editor({ element: document.createElement('div'), extensions: [...canvasNodesAndMarks(), CanvasCapacity.configure({ onLimit })], content: '<p>Original writing</p>' });
    try {
      editor.commands.insertContentAt(editor.state.doc.content.size, Array.from({ length: maximumCanvasNodes }, () => ({ type: 'paragraph' })));
      expect(onLimit).toHaveBeenCalledOnce();
      expect(editor.state.doc.textContent).toBe('Original writing');
      expect(editor.view.dom.querySelectorAll('p')).toHaveLength(1);
      editor.commands.insertContentAt(1, 'Latest ');
      expect(editor.state.doc.textContent).toBe('Latest Original writing');
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.textContent).toBe('Original writing');
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.textContent).toBe('Latest Original writing');
    } finally { editor.destroy(); }
  });

  it.each([40_000, 150_000])('rejects a flat HTML preview with %s rendered tags before DOM expansion or argument overflow', (count) => {
    const source = '<br>'.repeat(count);
    const large: JSONContent = { type: 'doc', content: [{ type: 'htmlPreview', attrs: { source } }] };
    if (count === 40_000) expect(source.length).toBeLessThan(maximumCanvasCharacters);
    expect(canvasDocumentSupported(large)).toBe(false);
    const onLimit = vi.fn();
    const editor = new Editor({ element: document.createElement('div'), extensions: [...canvasNodesAndMarks(), CanvasCapacity.configure({ onLimit })], content: '<p>Original writing</p>' });
    try {
      expect(canvasDocumentSupported(editor.schema.nodeFromJSON(large))).toBe(false);
      editor.commands.insertContentAt(0, large.content!);
      expect(onLimit).toHaveBeenCalledOnce();
      expect(editor.state.doc.textContent).toBe('Original writing');
      expect(editor.view.dom.querySelectorAll('br')).toHaveLength(0);
      expect(editor.commands.undo()).toBe(false);
      expect(large.content?.[0].attrs?.source).toBe(source);
    } finally { editor.destroy(); }
  });

  it('combines HTML and model nodes in one budget while leaving literal source, TeX, and image data intact', () => {
    const ordinaryPreview: JSONContent = { type: 'doc', content: [{ type: 'htmlPreview', attrs: { source: '<p>Hello</p><br>' } }, { type: 'paragraph' }] };
    expect(canvasDocumentSupported(ordinaryPreview)).toBe(true);
    const tagSource = '<br>'.repeat(maximumCanvasNodes);
    expect(canvasDocumentSupported({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'inlineHtmlPreview', attrs: { source: tagSource } }] }] })).toBe(false);
    expect(canvasDocumentSupported({ type: 'doc', content: [{ type: 'unsupportedMarkdown', attrs: { source: tagSource } }] })).toBe(true);
    expect(canvasDocumentSupported({ type: 'doc', content: [{ type: 'blockFormula', attrs: { latex: tagSource } }] })).toBe(true);
    expect(canvasDocumentSupported({ type: 'doc', content: [{ type: 'image', attrs: { src: `data:image/png;base64,${'x'.repeat(maximumCanvasCharacters + 1)}` } }] })).toBe(true);
    const source = '<b>x</b>'.repeat(maximumCanvasNodes / 2);
    expect(canvasDocumentSupported({ type: 'doc', content: [{ type: 'htmlPreview', attrs: { source } }, { type: 'htmlPreview', attrs: { source } }] })).toBe(false);
    // Removing comments can leave a separate surviving text node on each side.
    expect(canvasDocumentSupported({ type: 'doc', content: [{ type: 'htmlPreview', attrs: { source: '<div>' + 'x<!>'.repeat(maximumCanvasNodes) + '</div>' } }] })).toBe(false);
  });
});
