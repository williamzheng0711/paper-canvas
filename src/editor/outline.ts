import type { JSONContent } from '@tiptap/core';
import { getMessages } from '../i18n';
import { createHtmlPreview } from './HtmlPreview';
import { maximumCanvasCharacters } from './documentLimits';
import { markdownToDocument } from './markdown';

type OutlineHeading = { level: number; text: string };
export type OutlineResult = { headings: OutlineHeading[]; limited: boolean };
export const maximumSourceOutlineHeadings = 500;
const maximumOutlineCandidateCharacters = 20_000;
const maximumOutlineLabelCharacters = 200;
const maximumOutlineParsedCharacters = 100_000;
const sourceOutlines = new WeakMap<JSONContent, OutlineResult>();
const htmlBlockNames = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(' '));

type OutlineList = { quotes: number; indent: number };

function outlineLine(source: string, list?: OutlineList, literalQuotes?: number): { value: string; quotes: number; list?: OutlineList; newList: boolean; continuedList: boolean } {
  let value = source.slice(0, maximumOutlineCandidateCharacters + 1);
  let quotes = 0;
  let continued = false;
  let newList: OutlineList | undefined;
  for (let depth = 0; depth < 32; depth += 1) {
    let removedIndent = 0;
    if (list && quotes === list.quotes && !continued) {
      const spaces = /^[ \t]*/.exec(value)![0];
      let width = 0;
      let index = 0;
      while (index < spaces.length && width < list.indent) {
        width += spaces[index++] === '\t' ? 4 - width % 4 : 1;
      }
      if (width >= list.indent) {
        value = ' '.repeat(width - list.indent) + value.slice(index);
        removedIndent = list.indent;
        continued = true;
      } else if (!value.trim()) continued = true;
    }
    const quote = /^ {0,3}>[ \t]?/.exec(value);
    if (quote && (literalQuotes === undefined || quotes < literalQuotes)) {
      value = value.slice(quote[0].length);
      quotes += 1;
      continue;
    }
    if (literalQuotes !== undefined && (!list || continued)) break;
    const marker = /^ {0,3}(?:[-+*]|\d{1,9}[.)]|\[\^[^\]]+\]:)[ \t]/.exec(value);
    if (!marker) break;
    value = value.slice(marker[0].length);
    newList = { quotes, indent: removedIndent + marker[0].length };
  }
  return { value, quotes, list: newList ?? (continued ? list : undefined), newList: Boolean(newList), continuedList: continued };
}

/** Scan block boundaries without parsing the complete oversized document. */
function oversizedSourceOutline(source: string): OutlineResult {
  const headings: OutlineHeading[] = [];
  let limited = false;
  let paragraph = '';
  let paragraphContext = '';
  let parsedCharacters = 0;
  let parsingExhausted = false;
  let list: OutlineList | undefined;
  let fence: { marker: string; length: number; quotes: number; list?: OutlineList } | undefined;
  let html: { ending?: string; raw?: boolean; quotes: number; list?: OutlineList } | undefined;
  const add = (candidate: string) => {
    if (candidate.length > maximumOutlineCandidateCharacters) {
      limited = true;
      return;
    }
    if (parsedCharacters + candidate.length > maximumOutlineParsedCharacters) {
      limited = true;
      parsingExhausted = true;
      return;
    }
    parsedCharacters += candidate.length;
    const parsed = collectParsedOutline(markdownToDocument(candidate));
    for (const heading of parsed) {
      if (headings.length === maximumSourceOutlineHeadings) {
        limited = true;
        return;
      }
      const text = Array.from(heading.text).slice(0, maximumOutlineLabelCharacters).join('');
      if (text.length < heading.text.length) limited = true;
      headings.push({ ...heading, text: text.length < heading.text.length ? text + '…' : text });
    }
  };
  for (const match of source.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/g)) {
    const original = match.index === 0 && match[1].startsWith('\uFEFF') ? match[1].slice(1) : match[1];
    const line = outlineLine(original, list, fence?.quotes ?? html?.quotes);
    const { value, quotes } = line;
    list = line.list;
    const context = `${quotes}/${list?.quotes ?? ''}/${list?.indent ?? ''}`;
    if (context !== paragraphContext || line.newList) paragraph = '';
    paragraphContext = context;
    if (fence && (quotes < fence.quotes || (fence.list && !line.continuedList && value.trim()))) fence = undefined;
    if (html && (quotes < html.quotes || (html.list && !line.continuedList && value.trim()))) html = undefined;
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(value);
      if (closing?.[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    if (html) {
      if (html.raw ? /<\/(?:pre|script|style|textarea)>/i.test(original) : html.ending ? original.includes(html.ending) : !value.trim()) html = undefined;
      continue;
    }
    const openingFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
    if (openingFence && !(openingFence[1][0] === '`' && openingFence[2].includes('`'))) {
      fence = { marker: openingFence[1][0], length: openingFence[1].length, quotes, list };
      paragraph = '';
      continue;
    }
    if (/^(?: {4}|\t)/.test(value)) {
      paragraph = '';
      continue;
    }
    const htmlSource = value.replace(/^ {0,3}/, '');
    const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(htmlSource)?.[1].toLowerCase();
    const ending = htmlSource.startsWith('<!--') ? '-->' : htmlSource.startsWith('<?') ? '?>' : htmlSource.startsWith('<![CDATA[') ? ']]>' : /^<![A-Z]/.test(htmlSource) ? '>' : undefined;
    const raw = Boolean(tag && /^(?:pre|script|style|textarea)$/.test(tag) && !htmlSource.startsWith('</'));
    const completeTag = !paragraph && /^<\/?[A-Za-z][A-Za-z0-9-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>[ \t]*$/.test(htmlSource);
    if (ending || raw || (tag && htmlBlockNames.has(tag)) || completeTag) {
      const ended = raw ? /<\/(?:pre|script|style|textarea)>/i.test(original) : ending ? original.includes(ending) : false;
      if (!ended) html = { ending, raw, quotes, list };
      paragraph = '';
      continue;
    }
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(value)) {
      add(original.length > maximumOutlineCandidateCharacters ? original : value);
      paragraph = '';
    } else if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(value) && paragraph) {
      add(paragraph + '\n' + value);
      paragraph = '';
    } else if (!value.trim()) paragraph = '';
    else if (paragraph.length + value.length + 1 <= maximumOutlineCandidateCharacters)
      paragraph = paragraph ? paragraph + '\n' + value : value;
    else paragraph = '';
    if (headings.length === maximumSourceOutlineHeadings || parsingExhausted) {
      limited = true;
      break;
    }
  }
  return { headings, limited };
}

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

function collectParsedOutline(document: JSONContent): OutlineHeading[] {
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

export function collectOutlineResult(document: JSONContent): OutlineResult {
  const only = document.content?.length === 1 ? document.content[0] : undefined;
  const source = only?.type === 'unsupportedMarkdown' ? only.attrs?.source : undefined;
  if (typeof source !== 'string' || source.length <= maximumCanvasCharacters)
    return { headings: collectParsedOutline(document), limited: false };
  let result = sourceOutlines.get(document);
  if (!result) {
    result = oversizedSourceOutline(source);
    sourceOutlines.set(document, result);
  }
  return result;
}

export function collectOutline(document: JSONContent): OutlineHeading[] {
  return collectOutlineResult(document).headings;
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
