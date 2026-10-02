import { Editor, type JSONContent } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';
import { CanvasCapacity, canvasDocumentSupported, maximumCanvasCharacters, maximumCanvasNodes } from './canvasCapacity';
import { canvasNodesAndMarks } from './canvasSchema';

describe('large canvas capacity', () => {
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
