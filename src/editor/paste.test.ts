import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { BlockFormula, InlineFormula } from './Formula';
import { insertPastedFormula, insertPastedMarkdown, markdownDocumentFromClipboard, sanitizePastedHtml } from './paste';

describe('HTML paste sanitization', () => {
  it('retains common document markup but removes executable content and unsafe URLs', () => {
    const sanitized = sanitizePastedHtml(
      '<h2>研究</h2><p><a href="javascript:alert(1)" onclick="alert(2)">link</a></p><img src="x" onerror="alert(3)"><script>alert(4)</script>',
    );

    expect(sanitized).toContain('<h2>研究</h2>');
    expect(sanitized).toContain('<img src="x">');
    expect(sanitized).not.toMatch(/script|onclick|onerror|javascript:/i);
  });

  it('preserves safe PaperCanvas formula nodes during editor-to-editor copy', () => {
    const sanitized = sanitizePastedHtml(
      '<p>Before <span latex="x^2" data-formula-kind="inline" data-latex="x^2"></span> after.</p>' +
        '<div latex="y=\\frac{1}{2}" data-formula-kind="block" data-latex="y=\\frac{1}{2}"></div>',
    );
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: sanitized,
    });

    const json = editor.getJSON();
    expect(json.content?.[0].content?.[1]).toMatchObject({
      type: 'inlineFormula',
      attrs: { latex: 'x^2' },
    });
    expect(json.content?.[1]).toMatchObject({
      type: 'blockFormula',
      attrs: { latex: 'y=\\frac{1}{2}' },
    });
    expect(sanitized).not.toMatch(/on\w+=|style=/i);
    editor.destroy();
  });

  it('includes LaTeX delimiters when a formula selection is copied as plain text', () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Before ' },
              { type: 'inlineFormula', attrs: { latex: 'x^2' } },
              { type: 'text', text: ' after.' },
            ],
          },
          { type: 'blockFormula', attrs: { latex: 'y=\\frac{1}{2}' } },
        ],
      },
    });
    editor.commands.selectAll();

    const clipboardText = editor.view.someProp('clipboardTextSerializer', (serializer) =>
      serializer(editor.state.selection.content(), editor.view),
    );

    expect(clipboardText).toContain('Before $x^2$ after.');
    expect(clipboardText).toContain('$$\ny=\\frac{1}{2}\n$$');
    editor.destroy();
  });
});

describe('plain-text Markdown paste', () => {
  it('fills prewritten display delimiters with pasted TeX source', () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: '<p>$$$$</p>',
    });
    editor.commands.setTextSelection(3);

    expect(insertPastedFormula(editor.view, '\\theta')).toBe(true);

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: 'blockFormula',
      attrs: { latex: '\\theta', sourceCaret: 6 },
    });
    editor.destroy();
  });

  it('keeps mixed prose, lists, and formulas as document structure', () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: '<p>replace me</p>',
    });
    editor.commands.selectAll();

    const handled = insertPastedMarkdown(
      editor.view,
      ['# Notes', '', 'Prose with \\cite{paper}, plus $E=mc^2$.', '', '$$x^2+y^2$$', '', '- first', '- second'].join(
        '\n',
      ),
    );

    const json = editor.getJSON();
    expect(handled).toBe(true);
    expect(json.content?.map((node) => node.type)).toEqual([
      'heading',
      'paragraph',
      'blockFormula',
      'bulletList',
      // ProseMirror keeps one editable paragraph after a full-selection paste.
      'paragraph',
    ]);
    expect(JSON.stringify(json)).toContain('\\\\cite{paper}');
    expect(JSON.stringify(json)).toContain('inlineFormula');
    expect(JSON.stringify(json)).toContain('blockFormula');
    expect(json.content?.[0].attrs?.latex).toBeUndefined();
    editor.destroy();
  });

  it('leaves ordinary plain text to the default editor paste path', () => {
    expect(markdownDocumentFromClipboard('ordinary text\n\nwithout math')).toBeNull();
  });

  it('merges a mixed inline-math paste into the current paragraph', () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: '<p>before after</p>',
    });
    editor.commands.setTextSelection(8);

    expect(insertPastedMarkdown(editor.view, 'middle $x^2$')).toBe(true);

    expect(editor.getJSON().content).toEqual([
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'before middle ' },
          expect.objectContaining({
            type: 'inlineFormula',
            attrs: expect.objectContaining({ latex: 'x^2' }),
          }),
          { type: 'text', text: 'after' },
        ],
      },
    ]);
    editor.destroy();
  });
});
