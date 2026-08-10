import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { markdownToDocument } from './markdown';
import {
  markdownSelectionFromMarkedDocument,
  markdownToDocumentWithSelection,
  positionFromDocumentAnchor,
  selectionMarker,
} from './selectionMapping';

describe('canvas and Markdown selection mapping', () => {
  it('serializes an exact canvas text offset through Markdown emphasis markers', () => {
    const document: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '開場 ' },
            { type: 'text', text: '精確位置', marks: [{ type: 'bold' }] },
          ],
        },
      ],
    };
    const markedDocument = structuredClone(document);
    markedDocument.content![0].content![1].text = `精確${selectionMarker}位置`;

    const selection = markdownSelectionFromMarkedDocument(document, markedDocument);

    expect(selection).toBeDefined();
    if (!selection) throw new Error('Expected a mapped Markdown selection');
    expect(selection.markdown).toBe('開場 **精確位置**\n');
    expect(selection.offset).toBe(selection.markdown.indexOf('精確') + 2);
  });

  it('maps the marker inserted by a real ProseMirror caret transaction', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Before ' },
              { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
              { type: 'text', text: ' after' },
            ],
          },
        ],
      },
    });
    const position = 1 + 'Before bo'.length;
    const markedDocument = editor.state.tr.insertText(selectionMarker, position, position).doc.toJSON();

    const selection = markdownSelectionFromMarkedDocument(editor.getJSON(), markedDocument);

    expect(selection?.markdown).toBe('Before **bold** after\n');
    expect(selection?.offset).toBe('Before **bo'.length);
    editor.destroy();
  });

  it('maps a Markdown caret to the same rich-text block and character offset', () => {
    const markdown = '# Heading\n\nBefore **bold target** and [link](https://example.com).';
    const sourceOffset = markdown.indexOf('target') + 3;

    const mapped = markdownToDocumentWithSelection(markdown, sourceOffset);

    expect(mapped.document).toEqual(markdownToDocument(markdown));
    expect(mapped.anchor).toEqual({ kind: 'text', path: [1], offset: 15 });
  });

  it('snaps Markdown punctuation to a nearby caret without changing the document', () => {
    const markdown = '# Heading\n\nBefore **bold target** after';
    const punctuationOffset = markdown.indexOf('**') + 1;

    const mapped = markdownToDocumentWithSelection(markdown, punctuationOffset);

    expect(mapped.document).toEqual(markdownToDocument(markdown));
    expect(mapped.anchor).toMatchObject({ kind: 'text', path: [1] });
    if (mapped.anchor?.kind === 'text') {
      expect(mapped.anchor.offset).toBeGreaterThanOrEqual('Before '.length);
      expect(mapped.anchor.offset).toBeLessThanOrEqual('Before bold target'.length);
    }
  });

  it('maps a caret in link syntax to a reasonable position in the linked label', () => {
    const markdown = 'Read [the paper](https://example.com/research) today.';
    const urlOffset = markdown.indexOf('example') + 4;

    const mapped = markdownToDocumentWithSelection(markdown, urlOffset);

    expect(mapped.document).toEqual(markdownToDocument(markdown));
    expect(mapped.anchor).toMatchObject({ kind: 'text', path: [0] });
    if (mapped.anchor?.kind === 'text') {
      expect(mapped.anchor.offset).toBeGreaterThanOrEqual('Read '.length);
      expect(mapped.anchor.offset).toBeLessThanOrEqual('Read the paper'.length);
    }
  });

  it('keeps nested list anchors structural instead of using whole-document progress', () => {
    const markdown = '- Parent\n  - Nested target text\n';
    const sourceOffset = markdown.indexOf('target') + 4;

    const mapped = markdownToDocumentWithSelection(markdown, sourceOffset);

    expect(mapped.anchor).toEqual({
      kind: 'text',
      path: [0, 0, 1, 0, 0],
      offset: 'Nested targ'.length,
    });

    const editor = new Editor({
      extensions: [StarterKit],
      content: mapped.document,
    });
    const resolved = positionFromDocumentAnchor(editor.state.doc, mapped.anchor!);
    expect(resolved).toBeDefined();
    const position = editor.state.doc.resolve(resolved!.position);
    expect(position.parent.textContent).toBe('Nested target text');
    expect(position.parentOffset).toBe('Nested targ'.length);
    editor.destroy();
  });

  it('resolves a structural text anchor to the live ProseMirror caret', () => {
    const editor = new Editor({
      extensions: [StarterKit],
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Nested target' }],
          },
        ],
      },
    });

    const resolved = positionFromDocumentAnchor(editor.state.doc, {
      kind: 'text',
      path: [1],
      offset: 7,
    });

    expect(resolved).toBeDefined();
    const position = editor.state.doc.resolve(resolved!.position);
    expect(position.parent.textContent).toBe('Nested target');
    expect(position.parentOffset).toBe(7);
    editor.destroy();
  });

  it('maps an empty document to its first editable paragraph', () => {
    expect(markdownToDocumentWithSelection('', 0).anchor).toEqual({
      kind: 'text',
      path: [0],
      offset: 0,
    });
  });
});
