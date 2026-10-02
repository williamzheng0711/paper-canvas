import type { JSONContent } from '@tiptap/core';
import { getMessages } from '../i18n';
import { createHtmlPreview } from './HtmlPreview';

const headingSelector = 'h1, h2, h3, h4, h5, h6';
const headingContainerSelector =
  'blockquote, ul, ol, li, table, thead, tbody, tfoot, tr, td, th, .tableWrapper, .footnote-definition, .footnote-content, li[data-checked] > div, li[data-type="taskItem"] > div';

function readableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Read a node view once, without its hidden duplicates or editing controls. */
export function renderedHeadingText(heading: HTMLElement): string {
  const read = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return Array.from(node.childNodes, read).join('');
    const element = node as HTMLElement;
    if (element.matches('.formula-node, [data-formula-kind], .katex')) {
      const source = element.querySelector<HTMLTextAreaElement>('textarea.formula-editor__textarea');
      const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
      return source?.value
        ?? element.getAttribute('data-latex')
        ?? element.getAttribute('latex')
        ?? annotation?.textContent
        ?? element.querySelector('.formula-render--error code')?.textContent
        ?? element.querySelector('.katex-html')?.textContent
        ?? '';
    }
    if (
      element.hidden || element.getAttribute('aria-hidden') === 'true' ||
      element.matches('button, input, textarea, select, script, style, template, .ProseMirror-widget')
    ) return '';
    if (element.tagName === 'BR') return ' ';
    if (element.tagName === 'IMG') return element.getAttribute('alt') ?? '';
    return Array.from(element.childNodes, read).join('');
  };
  return readableText(read(heading));
}

function headingNodeText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'inlineFormula') return String(node.attrs?.latex ?? '');
  if (node.type === 'inlineHtmlPreview') {
    const preview = createHtmlPreview(String(node.attrs?.source ?? ''), { kind: 'inline' });
    return renderedHeadingText(preview);
  }
  if (node.type === 'hardBreak') return ' ';
  return (node.content ?? []).map(headingNodeText).join('');
}

export function collectOutline(document: JSONContent): Array<{ level: number; text: string }> {
  const walk = (node: JSONContent): Array<{ level: number; text: string }> =>
    node.type === 'heading'
      ? [
          {
            level: Number(node.attrs?.level ?? 1),
            text: readableText(headingNodeText(node)) || getMessages().unnamedHeading,
          },
        ]
      : (node.content ?? []).flatMap(walk);
  return walk(document);
}

/** Follow native editor containers, keeping preview HTML outside the outline. */
export function renderedOutlineHeadings(editorRoot: HTMLElement): HTMLElement[] {
  const headings: HTMLElement[] = [];
  const walk = (parent: Element) => {
    for (const child of parent.children) {
      if (child instanceof HTMLElement && child.matches(headingSelector)) headings.push(child);
      else if (child.matches(headingContainerSelector)) walk(child);
    }
  };
  walk(editorRoot);
  return headings;
}

export function scrollToOutlineHeading(editorRoot: HTMLElement, index: number): boolean {
  const heading = renderedOutlineHeadings(editorRoot)[index];
  if (!heading) return false;
  const scrollContainer = editorRoot.closest<HTMLElement>('.canvas-area');
  if (scrollContainer) {
    const containerTop = scrollContainer.getBoundingClientRect().top;
    const headingTop = heading.getBoundingClientRect().top;
    scrollContainer.scrollTo({
      top: Math.max(0, scrollContainer.scrollTop + headingTop - containerTop - 20),
      behavior: 'smooth',
    });
  } else {
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return true;
}
