import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { createHtmlPreview, HtmlPreview, InlineHtmlPreview } from './HtmlPreview';

describe('sanitized HTML previews', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('renders the centered headings, images, and table layout used by the repository READMEs', () => {
    const preview = createHtmlPreview(
      `<h1 align="center">PaperCanvas</h1>
<p align="center"><img src="docs/editor.png" width="100%" alt="Editor"></p>
<table><tr><td width="50%"><strong>Canvas</strong><br><sub>Local first</sub></td></tr></table>`,
      {
        kind: 'block',
        basePath: '/Users/example/paper-canvas',
        convertLocalFile: (path) => `asset://${path}`,
      },
    );

    expect(preview.querySelector('h1')?.textContent).toBe('PaperCanvas');
    expect(preview.querySelector('h1')?.getAttribute('align')).toBe('center');
    expect(preview.querySelector('table td')?.getAttribute('width')).toBe('50%');
    expect(preview.querySelector('img')?.src).toContain('asset:///Users/example/paper-canvas/docs/editor.png');
    expect(preview.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(preview.querySelector('img')?.hasAttribute('loading')).toBe(false);
  });

  it('removes executable attributes and dangerous resource URLs', () => {
    const preview = createHtmlPreview(
      `<p style="position:fixed" onclick="alert(1)">
  <a href="javascript:alert(1)" target="_blank">Unsafe link</a>
  <img src="javascript:alert(2)" onerror="alert(3)" alt="Unsafe image">
</p>`,
      { kind: 'block' },
    );
    const paragraph = preview.querySelector('p');
    const anchor = preview.querySelector('a');
    const image = preview.querySelector('img');

    expect(paragraph?.hasAttribute('style')).toBe(false);
    expect(paragraph?.hasAttribute('onclick')).toBe(false);
    expect(anchor?.hasAttribute('href')).toBe(false);
    expect(anchor?.hasAttribute('target')).toBe(false);
    expect(image?.hasAttribute('src')).toBe(false);
    expect(image?.hasAttribute('onerror')).toBe(false);
  });

  it('shows blocked embedded HTML as inert source text', () => {
    const preview = createHtmlPreview('<iframe src="https://example.com"></iframe><script>alert(1)</script>', {
      kind: 'block',
    });

    expect(preview.classList.contains('html-preview--blocked')).toBe(true);
    expect(preview.querySelector('iframe')).toBeNull();
    expect(preview.querySelector('script')).toBeNull();
    expect(preview.textContent).toContain('<script>alert(1)</script>');
  });

  it('integrates with ProseMirror as selectable block and inline atoms while disabling navigation', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, HtmlPreview, InlineHtmlPreview],
      content: {
        type: 'doc',
        content: [
          {
            type: 'htmlPreview',
            attrs: {
              source: '<p align="center"><a href="https://example.com">PaperCanvas</a></p>',
            },
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Press ' },
              {
                type: 'inlineHtmlPreview',
                attrs: { source: '<kbd>Command</kbd>' },
              },
              { type: 'text', text: '.' },
            ],
          },
        ],
      },
    });
    const anchor = host.querySelector<HTMLAnchorElement>('.html-preview a');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor?.dispatchEvent(click);

    expect(host.querySelector('.html-preview--block p')?.textContent).toBe('PaperCanvas');
    expect(host.querySelector('.html-preview--inline kbd')?.textContent).toBe('Command');
    expect(click.defaultPrevented).toBe(true);

    editor.commands.setNodeSelection(0);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(host.querySelector('.html-preview--block')?.classList.contains('is-selected')).toBe(true);
    editor.destroy();
  });
});
