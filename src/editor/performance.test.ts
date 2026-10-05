import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { documentToMarkdown, markdownToDocument } from './markdown';
import { canvasNodesAndMarks } from './canvasSchema';
import { canvasDocumentSupported, maximumCanvasNodes } from './canvasCapacity';
import { formulaPreview } from './formulaRendering';

describe('50,000-character local document performance', () => {
  it('parses and serializes a Chinese plain-text document without a multi-second stall', () => {
    const source = '研究筆記與數學推導。'.repeat(5_000); // 50,000 Unicode characters
    const started = performance.now();
    const document = markdownToDocument(source);
    const serialized = documentToMarkdown(document);
    const elapsed = performance.now() - started;

    console.info(`50k Chinese Markdown parse + serialize: ${elapsed.toFixed(1)} ms`);
    expect(serialized).toBe(source + '\n');
    expect(elapsed).toBeLessThan(1_500);
  });
});

describe('math-heavy Canvas editing performance', () => {
  it('keeps repeated text-edit capacity checks responsive for varied equations', () => {
    const source = Array.from({ length: 80 }, (_, index) => (
      `## Result ${index + 1}\n\n` +
      `The bound is $W_1(P_{${index}},Q_\\beta)\\le e_{${index}}$.\n\n` +
      `$$\n\\begin{aligned}J_{${index}}(\\beta)&=\\sum_{u=1}^{U}\\beta_u E_u,\\\\ F_{${index}}(\\beta)&\\le J_{${index}}(\\beta)+\\frac{${index + 1}}{N}.\\end{aligned}\n$$\n\n`
    )).join('');
    const schema = getSchema(canvasNodesAndMarks());
    let state = EditorState.create({ doc: schema.nodeFromJSON(markdownToDocument(source)) });
    let generatedNodes = 0;
    state.doc.descendants((node) => {
      if (node.type.name === 'inlineFormula' || node.type.name === 'blockFormula') {
        generatedNodes += formulaPreview(node.attrs.latex, node.type.name === 'blockFormula').nodes;
      }
    });
    expect(generatedNodes).toBeGreaterThan(maximumCanvasNodes);
    expect(canvasDocumentSupported(state.doc)).toBe(true);

    const started = performance.now();
    for (let edit = 0; edit < 100; edit += 1) {
      state = state.apply(state.tr.insertText('x', 1));
      expect(canvasDocumentSupported(state.doc)).toBe(true);
    }
    const elapsed = performance.now() - started;
    console.info(`Math-heavy paper capacity checks for 100 edits: ${elapsed.toFixed(1)} ms`);
    expect(state.doc.firstChild?.textContent).toBe('x'.repeat(100) + 'Result 1');
    expect(elapsed).toBeLessThan(1_500);
  });
});
