import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it, vi } from 'vitest';
import { InlineFormula } from './Formula';
import { HtmlPreview, InlineHtmlPreview } from './HtmlPreview';
import { FootnoteDefinition, FootnoteReference } from './Footnote';
import { markdownToDocument } from './markdown';
import { activateDocumentLink, documentLinkTarget, scrollToDocumentFragment } from './linkNavigation';

const tauri = vi.hoisted(() => ({ native: false, invoke: vi.fn(async () => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke, isTauri: () => tauri.native }));

describe('reading link navigation', () => {
  it('accepts heading fragments and web/mail links, rejecting executable and local-file URLs', () => {
    expect(documentLinkTarget('#features')).toEqual({ kind: 'fragment', fragment: 'features' });
    expect(documentLinkTarget('https://example.com/paper')).toEqual({
      kind: 'external',
      url: 'https://example.com/paper',
    });
    expect(documentLinkTarget('mailto:reader@example.com')).toEqual({
      kind: 'external',
      url: 'mailto:reader@example.com',
    });
    for (const href of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///private/note.md',
      '../note.md',
      'ftp://example.com',
    ]) {
      expect(documentLinkTarget(href)).toBeUndefined();
    }
  });

  it('jumps to Unicode and repeated Markdown headings without changing editor contents', () => {
    const viewport = document.createElement('section');
    viewport.className = 'canvas-area';
    viewport.scrollTo = vi.fn();
    const editor = document.createElement('article');
    editor.innerHTML = '<h1>Overview</h1><h2>📖 閱讀體驗</h2><h2>Overview</h2><h2>Overview-1</h2><h2>Overview</h2>';
    viewport.append(editor);
    const contents = editor.innerHTML;
    expect(scrollToDocumentFragment(editor, encodeURIComponent('閱讀體驗'))).toBe(true);
    expect(scrollToDocumentFragment(editor, 'overview-1')).toBe(true);
    expect(scrollToDocumentFragment(editor, 'overview-1-1')).toBe(true);
    expect(scrollToDocumentFragment(editor, 'overview-2')).toBe(true);
    expect(scrollToDocumentFragment(editor, 'missing')).toBe(false);
    expect(scrollToDocumentFragment(editor, '%not-valid')).toBe(false);
    expect(editor.innerHTML).toBe(contents);
    expect(viewport.scrollTo).toHaveBeenCalledTimes(4);
  });

  it('jumps to rendered formula and inline-HTML headings without including duplicate KaTeX or copy labels', () => {
    const viewport = document.createElement('section');
    viewport.className = 'canvas-area';
    viewport.scrollTo = vi.fn();
    const host = document.createElement('article');
    viewport.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, InlineFormula, InlineHtmlPreview],
      content: markdownToDocument('# Cost $x^2$\n\n## Press <kbd>Ctrl</kbd>\n\n## Cost $x^2$'),
    });
    try {
      const root = editor.view.dom;
      const headings = root.querySelectorAll<HTMLElement>('h1, h2');
      headings.forEach((heading, index) => {
        heading.getBoundingClientRect = () => ({ top: 100 + index * 200 }) as DOMRect;
      });
      const content = editor.getJSON();
      expect(headings[0].textContent).toContain('LaTeX');
      expect(headings[0].querySelector('.katex-mathml')).not.toBeNull();
      expect(scrollToDocumentFragment(root, 'cost-x2')).toBe(true);
      expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: 80, behavior: 'smooth' });
      expect(scrollToDocumentFragment(root, 'press-ctrl')).toBe(true);
      expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: 280, behavior: 'smooth' });
      expect(scrollToDocumentFragment(root, 'cost-x2-1')).toBe(true);
      expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: 480, behavior: 'smooth' });
      expect(editor.getJSON()).toEqual(content);
    } finally {
      editor.destroy();
    }
  });

  it('opens external links in the system browser for the native app', async () => {
    tauri.native = true;
    tauri.invoke.mockClear();
    try {
      const editor = document.createElement('article');
      expect(await activateDocumentLink(editor, 'https://example.com/paper')).toBe(true);
      expect(tauri.invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://example.com/paper' });
      expect(await activateDocumentLink(editor, 'javascript:alert(1)')).toBe(false);
      expect(tauri.invoke).toHaveBeenCalledOnce();
    } finally {
      tauri.native = false;
    }
  });

  it('resolves duplicate nested native headings while excluding HTML preview headings', () => {
    const viewport = document.createElement('section');
    viewport.className = 'canvas-area';
    viewport.scrollTo = vi.fn();
    const host = document.createElement('article');
    viewport.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, InlineFormula, HtmlPreview, InlineHtmlPreview, FootnoteReference, FootnoteDefinition],
      content: markdownToDocument(
        '# Cost $x^2$\n\n<div><h2>Cost x2</h2></div>\n\n> ## Cost $x^2$\n\n- Item\n\n  ### Cost $x^2$\n\n[^note]: #### Cost $x^2$',
      ),
    });
    try {
      const root = editor.view.dom;
      const nested = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4')).filter(
        (heading) => !heading.closest('.html-preview'),
      );
      nested.forEach((heading, index) => {
        heading.getBoundingClientRect = () => ({ top: 100 + 200 * index }) as DOMRect;
      });
      const before = editor.getJSON();
      expect(scrollToDocumentFragment(root, 'cost-x2-1')).toBe(true);
      expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: 280, behavior: 'smooth' });
      expect(scrollToDocumentFragment(root, 'cost-x2-2')).toBe(true);
      expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: 480, behavior: 'smooth' });
      expect(scrollToDocumentFragment(root, 'cost-x2-3')).toBe(true);
      expect(viewport.scrollTo).toHaveBeenLastCalledWith({ top: 680, behavior: 'smooth' });
      expect(editor.getJSON()).toEqual(before);
    } finally {
      editor.destroy();
    }
  });

  it('handles surrounding URL whitespace consistently for fragments and external links', () => {
    expect(documentLinkTarget(' \t#閱讀體驗\n')).toEqual({ kind: 'fragment', fragment: '閱讀體驗' });
    expect(documentLinkTarget(' \thttps://example.com/paper\n')).toEqual({
      kind: 'external',
      url: 'https://example.com/paper',
    });
    expect(documentLinkTarget(' \t../note.md\n')).toBeUndefined();
  });
});
