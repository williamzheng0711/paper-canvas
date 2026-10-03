import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { describe, expect, it, vi } from 'vitest';
import { getMessages } from '../i18n';
import { focusFormulaSource, InlineFormula } from './Formula';
import { InlineHtmlPreview } from './HtmlPreview';
import { FootnoteDefinition, FootnoteReference } from './Footnote';
import { markdownToDocument } from './markdown';
import { collectOutline, collectOutlineResult, maximumSourceOutlineHeadings, renderedHeadingText, scrollToOutlineHeading } from './outline';

describe('outline navigation', () => {
  it('keeps bounded ATX and setext navigation for oversized exact source while excluding code and HTML deceptions', () => {
    const source = '\uFEFF# Large heading\r\n\r\n' +
      '```markdown\r\n# Fenced deception\r\nSetext code\r\n---\r\n```\r\n\r\n' +
      '    # Indented deception\r\n\t# Tab deception\r\n\r\n' +
      '<div>\r\n# HTML deception\r\n</div>\r\n\r\n' +
      '<!--\r\n# Comment deception\r\n-->\r\n\r\n' +
      '<pre>\r\n# Raw deception\r\n</pre>\r\n\r\n' +
      'Setext **section**\r\n===\r\n\r\n## Cost $x^2$ <kbd>Ctrl</kbd>\r\n\r\n' +
      'Retained writing.\r\n\r\n'.repeat(15_000);
    const document = markdownToDocument(source);
    expect(document.content?.[0].type).toBe('unsupportedMarkdown');
    expect(collectOutline(document)).toEqual([
      { level: 1, text: 'Large heading' },
      { level: 1, text: 'Setext section' },
      { level: 2, text: 'Cost x^2 Ctrl' },
    ]);
    expect(collectOutlineResult(document).limited).toBe(false);
    expect(document.content?.[0].attrs?.source).toBe(source);
  });

  it('bounds oversized source outline entries and candidate labels without constructing a giant sidebar', () => {
    const source = Array.from({ length: maximumSourceOutlineHeadings + 10 }, (_, index) => `# Heading ${index}\n\n`).join('') + 'x'.repeat(300_000);
    const outline = collectOutlineResult(markdownToDocument(source));
    expect(outline.headings).toHaveLength(maximumSourceOutlineHeadings);
    expect(outline.headings[0].text).toBe('Heading 0');
    expect(outline.headings.at(-1)?.text).toBe(`Heading ${maximumSourceOutlineHeadings - 1}`);
    expect(outline.limited).toBe(true);
    const label = collectOutlineResult(markdownToDocument('# ' + '🧪'.repeat(300) + '\n\n' + 'x'.repeat(300_000)));
    expect(label.headings[0].text).toBe('🧪'.repeat(200) + '…');
    expect(label.limited).toBe(true);
    const giant = collectOutlineResult(markdownToDocument('# ' + 'x'.repeat(25_000) + '\n\n# Short\n\n' + 'x'.repeat(300_000)));
    expect(giant.headings).toEqual([{ level: 1, text: 'Short' }]);
    expect(giant.limited).toBe(true);
  });

  it.each([
    '> Foo\n---\n\n# Real',
    '- ```\n  # Fake\n\n# Real',
    '- > # Nested\n\n# Real',
    '- Item\n\n    ### Nested\n\n# Real',
    '```\n- ```\n# Fake\n```\n\n# Real',
    '> ```\n> > ```\n> # Fake\n> ```\n\n# Real',
    '- ```\n  - ```\n  # Fake\n  ```\n\n# Real',
  ])('keeps source outline container boundaries and code contents consistent with ordinary parsing: %s', (source) => {
    const expected = collectOutline(markdownToDocument(source));
    const oversized = source + '\n\n' + 'x'.repeat(300_000);
    expect(collectOutline(markdownToDocument(oversized))).toEqual(expected);
  });

  it('bounds total candidate parsing for dense adversarial headings', () => {
    const source = ('# ' + '\\('.repeat(9000) + '\n\n').repeat(500);
    const started = performance.now();
    const result = collectOutlineResult(markdownToDocument(source));
    expect(result.headings.length).toBeGreaterThan(0);
    expect(result.headings.length).toBeLessThan(500);
    expect(result.limited).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('labels formulas and inline HTML using authored content rather than editor controls', () => {
    const document = markdownToDocument(
      '# Cost $x^2$\n\n## Use <kbd>Ctrl</kbd> &amp; <sup>2</sup>\n\n### $\\alpha$\n\n## <!-- hidden -->',
    );
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
    heading.innerHTML =
      'Visible <span hidden>comment source</span><span aria-hidden="true">duplicate</span><button>Copy</button><br>text';
    expect(renderedHeadingText(heading)).toBe('Visible text');
  });

  it('keeps exact formula labels when an empty formula or its source editor is visible', () => {
    const content = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'inlineFormula', attrs: { latex: '' } }] },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [
            { type: 'text', text: 'Cost ' },
            { type: 'inlineFormula', attrs: { latex: 'x^2' } },
          ],
        },
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

  it('keeps native nested headings in the same source and canvas document order', () => {
    const content = markdownToDocument(
      '# Root\n\n> ## Quoted $x^2$\n\n- Item\n\n  ### Nested list heading\n\n[^note]: #### Footnote heading',
    );
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, InlineHtmlPreview, FootnoteReference, FootnoteDefinition],
      content,
    });
    try {
      expect(collectOutline(content)).toEqual([
        { level: 1, text: 'Root' },
        { level: 2, text: 'Quoted x^2' },
        { level: 3, text: 'Nested list heading' },
        { level: 4, text: 'Footnote heading' },
      ]);
      const headings = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('h1, h2, h3, h4'));
      const scrolls = headings.map((heading) => {
        const scroll = vi.fn();
        Object.defineProperty(heading, 'scrollIntoView', { value: scroll });
        return scroll;
      });
      expect(scrollToOutlineHeading(editor.view.dom, 1)).toBe(true);
      expect(scrolls[1]).toHaveBeenCalledOnce();
      expect(scrollToOutlineHeading(editor.view.dom, 2)).toBe(true);
      expect(scrolls[2]).toHaveBeenCalledOnce();
      expect(scrollToOutlineHeading(editor.view.dom, 3)).toBe(true);
      expect(scrolls[3]).toHaveBeenCalledOnce();
    } finally {
      editor.destroy();
    }
  });

  it.each(['live', 'serialized'])('keeps %s task-item wrappers in source and canvas heading order', (mode) => {
    const content = markdownToDocument('- [x] Task\n\n  ## Nested task heading\n\n# Later');
    const editor = new Editor({ extensions: [StarterKit, TaskList, TaskItem.configure({ nested: true })], content });
    try {
      expect(collectOutline(content)).toEqual([
        { level: 2, text: 'Nested task heading' },
        { level: 1, text: 'Later' },
      ]);
      const root = mode === 'live' ? editor.view.dom : document.createElement('article');
      if (mode === 'serialized') root.innerHTML = editor.getHTML();
      const taskHeading = root.querySelector<HTMLElement>('li h2')!;
      const laterHeading = root.querySelector<HTMLElement>('h1')!;
      const taskScroll = vi.fn();
      const laterScroll = vi.fn();
      Object.defineProperty(taskHeading, 'scrollIntoView', { value: taskScroll });
      Object.defineProperty(laterHeading, 'scrollIntoView', { value: laterScroll });
      expect(scrollToOutlineHeading(root, 0)).toBe(true);
      expect(taskScroll).toHaveBeenCalledOnce();
      expect(laterScroll).not.toHaveBeenCalled();
      expect(scrollToOutlineHeading(root, 1)).toBe(true);
      expect(laterScroll).toHaveBeenCalledOnce();
    } finally {
      editor.destroy();
    }
  });
});
