import { describe, expect, it } from 'vitest';
import { documentToMarkdown, markdownToDocument } from './markdown';

describe('smoke: create, write formula, save Markdown, and reopen', () => {
  it('keeps both formula node types through the complete local document workflow', () => {
    const created = markdownToDocument('研究草稿：The loss is $x^2 + 1$.\n\n$$\\sqrt{x^2+y^2}$$\n');
    const savedToUtf8Markdown = documentToMarkdown(created);
    const reopened = markdownToDocument(savedToUtf8Markdown);
    const reopenedJson = JSON.stringify(reopened);

    expect(savedToUtf8Markdown).toContain('$x^2 + 1$');
    expect(savedToUtf8Markdown).toContain('$$');
    expect(reopenedJson).toContain('inlineFormula');
    expect(reopenedJson).toContain('blockFormula');
  });
});
