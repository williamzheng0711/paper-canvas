import { getSchema, type JSONContent } from '@tiptap/core';
import { Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { describe, expect, it } from 'vitest';
import { FootnoteDefinition, FootnoteReference } from './Footnote';
import { InlineFormula, BlockFormula } from './Formula';
import { HtmlPreview, InlineHtmlPreview } from './HtmlPreview';
import { PaperImage } from './PaperImage';
import { PaperCode, PaperLink } from './PaperLink';
import { PaperOrderedList } from './PaperOrderedList';
import { UnsupportedMarkdown } from './UnsupportedMarkdown';
import { createMarkdownComment, relocateMarkdownComments } from './comments';
import { documentToMarkdown, markdownToDocument } from './markdown';
import {
  markdownSelectionFromMarkedDocument,
  markdownToDocumentWithSelection,
  positionFromDocumentAnchor,
  selectionMarker,
} from './selectionMapping';

const schema = getSchema([
  StarterKit.configure({ code: false, link: false, orderedList: false }),
  PaperCode,
  PaperLink,
  PaperImage,
  PaperOrderedList,
  TaskList,
  TaskItem.configure({ nested: true }),
  FootnoteReference,
  FootnoteDefinition,
  InlineFormula,
  BlockFormula,
  HtmlPreview,
  InlineHtmlPreview,
  UnsupportedMarkdown,
]);

function roundTrip(source: string) {
  const imported = ProseMirrorNode.fromJSON(schema, markdownToDocument(source));
  expect(() => imported.check()).not.toThrow();
  const markdown = documentToMarkdown(imported.toJSON());
  const reopened = ProseMirrorNode.fromJSON(schema, markdownToDocument(markdown));
  expect(() => reopened.check()).not.toThrow();
  expect(reopened.toJSON()).toEqual(imported.toJSON());
  return { imported, markdown };
}

function nodesOfType(document: JSONContent, type: string): JSONContent[] {
  return [
    ...(document.type === type ? [document] : []),
    ...(document.content ?? []).flatMap((child) => nodesOfType(child, type)),
  ];
}

describe('native support for structures shown in reading screenshots', () => {
  it.each([7, 42])('retains numbering and mixed checkboxes starting at %d', (start) => {
    const { imported, markdown } = roundTrip(
      `${start}. [x] Completed\n${start + 1}. Ordinary\n${start + 2}. [ ] Pending\n`,
    );
    const list = (imported.toJSON() as JSONContent).content![0];
    expect(list.type).toBe('orderedList');
    expect(list.attrs?.start).toBe(start);
    expect(list.content?.map((item) => item.type)).toEqual(['taskItem', 'listItem', 'taskItem']);
    expect(markdown).toMatch(new RegExp(`^${start}\\. \\[x\\] Completed`, 'm'));
    expect(markdown).toMatch(new RegExp(`^${start + 1}\\. Ordinary`, 'm'));
    expect(markdown).toMatch(new RegExp(`^${start + 2}\\. \\[ \\] Pending`, 'm'));
  });

  it('keeps nested mixed lists inside their numbered item', () => {
    const source =
      '7. [x] Completed\n\n   Further detail $x^2$.\n\n   - Child\n   - [ ] Nested task\n8. Ordinary\n9. [ ] Pending';
    const { imported } = roundTrip(source);
    const json = imported.toJSON();
    expect(json.content![0].type).toBe('orderedList');
    expect(json.content![0].content?.length).toBe(3);
    expect(nodesOfType(json.content![0].content![0], 'taskItem')).toHaveLength(2);
    expect(nodesOfType(json, 'inlineFormula')).toHaveLength(1);
    expect(nodesOfType(json, 'unsupportedMarkdown')).toHaveLength(0);
  });

  it('retains repeated footnote references, nested body blocks, and formulas', () => {
    const source =
      'Text[^Alpha] again[^alpha].\n\n[^Alpha]: Footnote **body** $x^2$.\n\n    Second paragraph.\n\n    > Quoted body.\n\n    - [x] Done\n    - Ordinary\n\n    $$\n    a + b\n    $$';
    const { imported } = roundTrip(source);
    const json = imported.toJSON();
    expect(nodesOfType(json, 'footnoteReference')).toHaveLength(2);
    const definitions = nodesOfType(json, 'footnoteDefinition');
    expect(definitions).toHaveLength(1);
    expect(nodesOfType(definitions[0], 'paragraph').length).toBeGreaterThanOrEqual(4);
    expect(nodesOfType(definitions[0], 'blockquote')).toHaveLength(1);
    expect(nodesOfType(definitions[0], 'inlineFormula')).toHaveLength(1);
    expect(nodesOfType(definitions[0], 'blockFormula')).toHaveLength(1);
    expect(nodesOfType(json, 'unsupportedMarkdown')).toHaveLength(0);
  });

  it.each([
    'Text[^image].\n\n[^image]: ![Diagram](diagram.png "Diagram title")',
    'Text[^code].\n\n[^code]:\n\n    ```text\n    literal \\(x\\)\n    ```',
    'Text[^a].\n\n[^a]: Body with another reference[^b].\n\n[^b]: Second body.',
  ])('preserves footnote images, literal code, and references in definitions: %s', (source) => {
    const { imported, markdown } = roundTrip(source);
    expect(nodesOfType(imported.toJSON(), 'footnoteDefinition').length).toBeGreaterThan(0);
    if (source.includes('diagram.png')) expect(markdown).toContain('diagram.png');
    if (source.includes('literal')) expect(markdown).toContain('literal \\(x\\)');
    expect(nodesOfType(imported.toJSON(), 'unsupportedMarkdown')).toHaveLength(0);
  });

  it('maps source selection and comments into a nested footnote paragraph', () => {
    const source = 'Reference[^n].\n\n[^n]: First paragraph.\n\n    - Nested target text.';
    const offset = source.indexOf('target') + 3;
    const mapped = markdownToDocumentWithSelection(source, offset);
    expect(mapped.anchor).toBeDefined();
    const imported = ProseMirrorNode.fromJSON(schema, mapped.document);
    const resolved = positionFromDocumentAnchor(imported, mapped.anchor!);
    expect(resolved).toBeDefined();
    expect(imported.resolve(resolved!.position).parent.textContent).toBe('Nested target text.');
    expect(imported.resolve(resolved!.position).parentOffset).toBe('Nested tar'.length);

    const canonical = documentToMarkdown(imported.toJSON());
    const from = source.indexOf('target');
    const comment = createMarkdownComment(
      source,
      { kind: 'range', from, to: from + 6 },
      'Review',
      undefined,
      'footnote',
    );
    const [relocated] = relocateMarkdownComments([comment], source, canonical);
    expect(relocated.target).toEqual({
      kind: 'range',
      from: canonical.indexOf('target'),
      to: canonical.indexOf('target') + 6,
    });
    expect(relocated.status).toBe('active');
  });

  it('maps a canvas marker in footnote body text back to its exact source caret', () => {
    const source = 'Reference[^n].\n\n[^n]: Footnote target text.';
    const document = markdownToDocument(source);
    const marked = structuredClone(document);
    const target = nodesOfType(marked, 'text').find((node) => node.text?.includes('target'))!;
    target.text = target.text!.replace('target', `tar${selectionMarker}get`);
    const selection = markdownSelectionFromMarkedDocument(document, marked);
    expect(selection).toBeDefined();
    expect(selection!.offset).toBe(selection!.markdown.indexOf('target') + 3);
    expect(markdownToDocumentWithSelection(selection!.markdown, selection!.offset).anchor).toMatchObject({
      kind: 'text',
      offset: 'Footnote tar'.length,
    });
  });

  it('recognizes TeX inline formulas in footnote continuation paragraphs', () => {
    const source = 'Reference[^n].\n\n[^n]: First \\(x\\).\n\n    Continued \\(y\\).';
    const { imported } = roundTrip(source);
    expect(nodesOfType(imported.toJSON(), 'inlineFormula').map((node) => node.attrs?.latex)).toEqual(['x', 'y']);
  });

  it('preserves formatting marks on footnote references', () => {
    const { imported, markdown } = roundTrip('**Reference[^n]** and *[^n]*.\n\n[^n]: Footnote.');
    const references = nodesOfType(imported.toJSON(), 'footnoteReference');
    expect(references[0].marks).toEqual([{ type: 'bold' }]);
    expect(references[1].marks).toEqual([{ type: 'italic' }]);
    expect(markdown).toContain('**Reference[^n]**');
    expect(markdown).toContain('_[^n]_');
    expect(nodesOfType(markdownToDocument(markdown), 'footnoteReference').map((reference) => reference.marks)).toEqual(
      references.map((reference) => reference.marks),
    );
  });
});
