import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it, vi } from 'vitest';
import { getMessages } from '../i18n';
import { focusFormulaSource, InlineFormula } from './Formula';
import { InlineHtmlPreview } from './HtmlPreview';
import { markdownToDocument } from './markdown';
import { collectOutline, renderedHeadingText, scrollToOutlineHeading } from './outline';

describe('outline navigation', () => {
  it('labels formulas and inline HTML using authored content rather than editor controls', () => {
    const document = markdownToDocument('# Cost $x^2$\n\n## Use <kbd>Ctrl</kbd> &amp; <sup>2</sup>\n\n### $\\alpha$\n\n## <!-- hidden -->');
    expect(collectOutline(document)).toEqual([
      { level: 1, text: 'Cost x^2' },
      { level: 2, text: 'Use Ctrl & 2' },
      { level: 3, text: '\\alpha' },
      { level: 2, text: getMessages().unnamedHeading },
    ]);
  });

  it('reads actual formula and inline-HTML node views consistently with source outline labels', () => {
    const content = markdownToDocument('# Cost $x^2$\n\n## Press <kbd>Ctrl</kbd>\n\n### $\\notACommand$');
    const editor = new Editor({ extensions: [StarterKit, InlineFormula, InlineHtmlPreview], content });
    try {
      const headings = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('h1, h2, h3'));
      expect(headings[0].querySelector('.katex-mathml')).not.toBeNull();
      expect(headings[0].textContent).toContain('LaTeX');
      expect(headings.map(renderedHeadingText)).toEqual(collectOutline(content).map(({ text }) => text));
      expect(renderedHeadingText(headings[2])).toBe('\\notACommand');
    } finally {
      editor.destroy();
    }
  });

  it('excludes hidden preview comments and helper controls from rendered labels', () => {
    const heading = document.createElement('h2');
    heading.innerHTML = 'Visible <span hidden>comment source</span><span aria-hidden="true">duplicate</span><button>Copy</button><br>text';
    expect(renderedHeadingText(heading)).toBe('Visible text');
  });

  it('keeps exact formula labels when an empty formula or its source editor is visible', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'inlineFormula', attrs: { latex: '' } }] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Cost ' }, { type: 'inlineFormula', attrs: { latex: 'x^2' } }] },
      ],
    };
    const editor = new Editor({ extensions: [StarterKit, InlineFormula], content });
    try {
      const headings = editor.view.dom.querySelectorAll<HTMLElement>('h1, h2');
      expect(renderedHeadingText(headings[0])).toBe('');
      expect(collectOutline(content)[0].text).toBe(getMessages().unnamedHeading);
      let formulaPosition = -1;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === 'inlineFormula' && node.attrs.latex === 'x^2') formulaPosition = position;
      });
      expect(focusFormulaSource(editor.view, formulaPosition, 1)).toBe(true);
      expect(headings[1].querySelector('textarea')).not.toBeNull();
      expect(renderedHeadingText(headings[1])).toBe('Cost x^2');
    } finally {
      editor.destroy();
    }
  });

  it('scrolls to the heading at the same document-order index', () => {
    const editor = document.createElement('article');
    editor.innerHTML = '<h1>First</h1><p>Body</p><h3>Second</h3><section><h2>Nested non-editor heading</h2></section>';
    const secondHeading = editor.querySelector('h3');
    const scrollIntoView = vi.fn();
    Object.defineProperty(secondHeading, 'scrollIntoView', {
      value: scrollIntoView,
    });

    expect(scrollToOutlineHeading(editor, 1)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
    expect(scrollToOutlineHeading(editor, 2)).toBe(false);
  });

  it('scrolls only the canvas and leaves room above the target heading', () => {
    const canvas = document.createElement('section');
    canvas.className = 'canvas-area';
    const editor = document.createElement('article');
    editor.innerHTML = '<h2>Target</h2>';
    canvas.append(editor);
    Object.defineProperty(canvas, 'scrollTop', { value: 100, writable: true });
    Object.defineProperty(canvas, 'scrollTo', { value: vi.fn() });
    canvas.getBoundingClientRect = () => ({ top: 44 }) as DOMRect;
    const heading = editor.querySelector<HTMLElement>('h2');
    if (heading) heading.getBoundingClientRect = () => ({ top: 500 }) as DOMRect;

    expect(scrollToOutlineHeading(editor, 0)).toBe(true);
    expect(canvas.scrollTo).toHaveBeenCalledWith({ top: 536, behavior: 'smooth' });
  });
});
