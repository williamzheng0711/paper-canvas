import { Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it, vi } from 'vitest';
import { markdownToDocument } from './markdown';
import * as markdownConversion from './markdown';
import {
  markdownSelectionFromMarkedDocument,
  markdownToDocumentWithSelection,
  positionFromDocumentAnchor,
  positionFromMarkdownOffset,
  selectionMarker,
} from './selectionMapping';

describe('canvas and Markdown selection mapping', () => {
  it("maps exact multiline formula carets through repeated inert HTML metadata", () => {
    const document = markdownToDocument("Before $\n[xy$ after.");
    const marked = structuredClone(document);
    const formula = marked.content![0].content!.find(
      (node) => node.type === "inlineFormula",
    )!;
    formula.attrs!.latex = `\n[x${selectionMarker}y`;
    const selection = markdownSelectionFromMarkedDocument(document, marked);
    expect(selection).toBeDefined();
    expect(selection!.offset).toBe(selection!.markdown.indexOf("[xy") + 2);
    const occurrences = [...selection!.markdown.matchAll(/\[xy/g)];
    expect(occurrences).toHaveLength(3);
    for (const occurrence of occurrences) {
      const mapped = markdownToDocumentWithSelection(
        selection!.markdown,
        occurrence.index! + 2,
      );
      expect(mapped.document).toEqual(document);
      expect(mapped.anchor).toEqual({
        kind: "formula",
        path: [0, 1],
        offset: 3,
      });
    }
  });

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

  it('keeps table column padding stable while mapping a cell caret', () => {
    const document = markdownToDocument('| A | B |\n| - | - |\n| longest cell | target |');
    const marked = structuredClone(document);
    marked.content![0].content![1].content![0].content![0].content![0].text = `long${selectionMarker}est cell`;
    const selection = markdownSelectionFromMarkedDocument(document, marked);
    expect(selection).toBeDefined();
    expect(selection!.offset).toBe(selection!.markdown.indexOf('longest cell') + 4);
    expect(markdownToDocumentWithSelection(selection!.markdown, selection!.offset).anchor).toEqual({
      kind: 'text',
      path: [0, 1, 0, 0],
      offset: 4,
    });
  });

  it.each([0, 1])('snaps a long table delimiter to header column %s with bounded parsing', (column) => {
    const markdown = `${'Reading paragraph with several words.\n\n'.repeat(1000)}| First header | Second header |\n| ${'-'.repeat(30)} | :${'-'.repeat(30)}: |\n| Alpha | Beta |`;
    const delimiter = markdown.indexOf('-'.repeat(30), column === 0 ? 0 : markdown.indexOf('-'.repeat(30)) + 30);
    const expected = markdownToDocument(markdown);
    const parse = vi.spyOn(markdownConversion, 'markdownToDocument');
    try {
      const mapped = markdownToDocumentWithSelection(markdown, delimiter + 15);
      expect(mapped.document).toEqual(expected);
      expect(mapped.anchor).toEqual({ kind: 'text', path: [1000, 0, column, 0], offset: column === 0 ? 12 : 13 });
      expect(parse).toHaveBeenCalledTimes(3);
    } finally {
      parse.mockRestore();
    }
  });

  it('keeps the exact caret in table-like fenced code', () => {
    const markdown = '```text\n| First header | Second header |\n| ------------------------------ | ------------------------------ |\n```';
    const requested = markdown.indexOf('------------------------------') + 15;
    const mapped = markdownToDocumentWithSelection(markdown, requested);
    expect(mapped.document).toEqual(markdownToDocument(markdown));
    expect(mapped.anchor).toEqual({ kind: 'text', path: [0], offset: requested - '```text\n'.length });
  });

  it.each(['`', '~'])('maps long %s code fence boundaries with bounded parsing', (character) => {
    const fence = character.repeat(32);
    const markdown = `${fence}\ncontent\n${fence}\n\n${'Reading paragraph with several words.\n\n'.repeat(1000)}`;
    const expected = markdownToDocument(markdown);
    for (const closing of [false, true]) {
      const requested = (closing ? markdown.indexOf(fence, fence.length) : 0) + 16;
      const parse = vi.spyOn(markdownConversion, 'markdownToDocument');
      try {
        const mapped = markdownToDocumentWithSelection(markdown, requested);
        expect(mapped.document).toEqual(expected);
        expect(mapped.anchor).toEqual({ kind: 'text', path: [0], offset: closing ? 'content'.length : 0 });
        expect(parse.mock.calls.length).toBeLessThanOrEqual(4);
      } finally {
        parse.mockRestore();
      }
    }
  });

  it('maps an empty fenced code block without inventing a language or selecting a neighboring paragraph', () => {
    const fence = '`'.repeat(32);
    const markdown = `${fence}\n${fence}\n\nFollowing paragraph.`;
    for (const requested of [16, fence.length + 1 + 16]) {
      const mapped = markdownToDocumentWithSelection(markdown, requested);
      expect(mapped.document).toEqual(markdownToDocument(markdown));
      expect(mapped.anchor).toEqual({ kind: 'text', path: [0], offset: 0 });
    }
  });

  it('keeps an exact caret on fence-like text inside a longer code fence', () => {
    const fence = '`'.repeat(32);
    const markdown = `${fence}\nBefore\n\`\`\`text\nAfter\n${fence}`;
    const requested = markdown.indexOf('```text') + 1;
    const mapped = markdownToDocumentWithSelection(markdown, requested);
    expect(mapped.document).toEqual(markdownToDocument(markdown));
    expect(mapped.anchor).toEqual({ kind: 'text', path: [0], offset: requested - fence.length - 1 });
  });

  it('handles escaped header pipes and inline marks when snapping a separator', () => {
    const markdown = '| A \\| B | **Title** |\n| ------------------------------ | ------------------------------ |\n| C | D |';
    const requested = markdown.lastIndexOf('------------------------------') + 15;
    const mapped = markdownToDocumentWithSelection(markdown, requested);
    expect(mapped.document).toEqual(markdownToDocument(markdown));
    expect(mapped.anchor).toEqual({ kind: 'text', path: [0, 0, 1, 0], offset: 5 });
  });

  it.each(['Before $x^2 + y$ after', '$$\nx^2 + y\n$$'])('preserves source offsets inside formulas: %s', (markdown) => {
    const sourceOffset = markdown.indexOf('^2') + 1;
    const mapped = markdownToDocumentWithSelection(markdown, sourceOffset);
    expect(mapped.anchor).toMatchObject({ kind: 'formula', offset: 2 });
    const marked = structuredClone(mapped.document);
    let node = marked;
    for (const index of mapped.anchor!.path) node = node.content![index];
    node.attrs!.latex = `x^${selectionMarker}2 + y`;
    const selection = markdownSelectionFromMarkedDocument(mapped.document, marked);
    expect(selection?.offset).toBe(selection!.markdown.indexOf('^2') + 1);
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

  it('reuses the parsed baseline and exact offsets until the live document changes', () => {
    const markdown = 'First target and another target\n';
    const editor = new Editor({ extensions: [StarterKit], content: markdownToDocument(markdown) });
    const parse = vi.spyOn(markdownConversion, 'markdownToDocument');
    try {
      const first = positionFromMarkdownOffset(editor.state.doc, markdown, markdown.indexOf('target'));
      expect(first?.position).toBe(7);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(positionFromMarkdownOffset(editor.state.doc, markdown, markdown.indexOf('target'))).toEqual(first);
      expect(parse).toHaveBeenCalledTimes(2);
      expect(positionFromMarkdownOffset(editor.state.doc, markdown, markdown.lastIndexOf('target'))?.position).toBe(26);
      expect(parse).toHaveBeenCalledTimes(3);

      editor.commands.insertContent('New ');
      const changedMarkdown = 'New ' + markdown;
      expect(positionFromMarkdownOffset(editor.state.doc, changedMarkdown, changedMarkdown.indexOf('target'))?.position).toBe(11);
      expect(parse).toHaveBeenCalledTimes(5);
    } finally {
      parse.mockRestore();
      editor.destroy();
    }
  });
});
