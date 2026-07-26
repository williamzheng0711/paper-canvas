import type { JSONContent } from '@tiptap/core';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  depth?: number;
  ordered?: boolean;
  start?: number;
  checked?: boolean | null;
  url?: string;
  alt?: string | null;
  title?: string | null;
  lang?: string | null;
  align?: Array<'left' | 'right' | 'center' | null>;
};

type MdRoot = MdNode & { children: MdNode[] };

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkStringify);
const imageSizeTitle = /^papercanvas-size:(\d+)x(\d+)(?:\s+\|\s+([\s\S]*))?$/i;

const content = (nodes: MdNode[] | undefined): JSONContent[] => (nodes ?? []).flatMap(fromMdast);

function unsupported(node: MdNode, reason?: string): JSONContent {
  const source = processor.stringify({ type: 'root', children: [node] } as never).trimEnd();
  return {
    type: 'unsupportedMarkdown',
    attrs: { source, reason: reason ?? `不支援的 ${node.type} 結構。` },
  };
}

function textNode(value: string | undefined): JSONContent {
  return { type: 'text', text: value ?? '' };
}

function imageDimension(value: unknown): number | null {
  const dimension = Number(value);
  return Number.isInteger(dimension) && dimension > 0 && dimension <= 10_000 ? dimension : null;
}

function imageAttributes(node: MdNode): Record<string, string | number> {
  const match = imageSizeTitle.exec(node.title ?? '');
  const width = match ? imageDimension(match[1]) : null;
  const height = match ? imageDimension(match[2]) : null;
  return {
    src: node.url ?? '',
    alt: node.alt ?? '',
    ...(match ? { title: match[3] ?? '' } : node.title ? { title: node.title } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

function markdownImageTitle(attrs: Record<string, unknown> | undefined): string | null {
  const title = String(attrs?.title ?? '');
  const width = imageDimension(attrs?.width);
  const height = imageDimension(attrs?.height);
  if (!width || !height) return title || null;
  return `papercanvas-size:${width}x${height}${title ? ` | ${title}` : ''}`;
}

function applyMark(
  nodes: JSONContent[],
  mark: { type: string; attrs?: Record<string, unknown> },
): JSONContent[] {
  return nodes.map((node) =>
    node.type === 'text' ? { ...node, marks: [...(node.marks ?? []), mark] } : node,
  );
}

function fromMdast(node: MdNode): JSONContent[] {
  switch (node.type) {
    case 'text':
      return [textNode(node.value)];
    case 'emphasis':
      return applyMark(content(node.children), { type: 'italic' });
    case 'strong':
      return applyMark(content(node.children), { type: 'bold' });
    case 'delete':
      return applyMark(content(node.children), { type: 'strike' });
    case 'inlineCode':
      return [{ type: 'text', text: node.value ?? '', marks: [{ type: 'code' }] }];
    case 'link':
      return applyMark(content(node.children), { type: 'link', attrs: { href: node.url ?? '' } });
    case 'image':
      return [{ type: 'image', attrs: imageAttributes(node) }];
    case 'inlineMath':
      return [{ type: 'inlineFormula', attrs: { latex: node.value ?? '' } }];
    case 'break':
      return [{ type: 'hardBreak' }];
    case 'paragraph': {
      const children = content(node.children);
      if (!children.some((child) => child.type === 'image')) {
        return [{ type: 'paragraph', content: children }];
      }

      // Markdown images are inline syntax, but PaperCanvas images are block
      // nodes so they can be selected and resized. Split mixed paragraphs
      // around each image instead of producing an invalid paragraph/image tree.
      const blocks: JSONContent[] = [];
      let inline: JSONContent[] = [];
      const flushInline = () => {
        if (inline.length > 0) blocks.push({ type: 'paragraph', content: inline });
        inline = [];
      };
      children.forEach((child) => {
        if (child.type === 'image') {
          flushInline();
          blocks.push(child);
          return;
        }
        inline.push(child);
      });
      flushInline();
      return blocks;
    }
    case 'heading':
      return [
        { type: 'heading', attrs: { level: node.depth ?? 1 }, content: content(node.children) },
      ];
    case 'blockquote':
      return [{ type: 'blockquote', content: content(node.children) }];
    case 'thematicBreak':
      return [{ type: 'horizontalRule' }];
    case 'code':
      return [
        {
          type: 'codeBlock',
          attrs: { language: node.lang ?? null },
          content: [textNode(node.value)],
        },
      ];
    case 'math':
      return [{ type: 'blockFormula', attrs: { latex: node.value ?? '' } }];
    case 'list':
      return [
        {
          type: node.children?.some(
            (child) => child.checked !== null && child.checked !== undefined,
          )
            ? 'taskList'
            : node.ordered
              ? 'orderedList'
              : 'bulletList',
          attrs: node.ordered ? { start: node.start ?? 1 } : undefined,
          content: content(node.children),
        },
      ];
    case 'listItem':
      return [
        {
          type: node.checked !== null && node.checked !== undefined ? 'taskItem' : 'listItem',
          attrs:
            node.checked !== null && node.checked !== undefined
              ? { checked: node.checked }
              : undefined,
          content: content(node.children),
        },
      ];
    case 'table':
      return [{ type: 'table', content: content(node.children) }];
    case 'tableRow':
      return [{ type: 'tableRow', content: content(node.children) }];
    case 'tableCell':
      return [
        { type: 'tableCell', content: [{ type: 'paragraph', content: content(node.children) }] },
      ];
    case 'tableHeader':
      return [
        { type: 'tableHeader', content: [{ type: 'paragraph', content: content(node.children) }] },
      ];
    case 'html':
      return [unsupported(node, 'HTML 不會執行，已按原文保留。')];
    default:
      return [unsupported(node)];
  }
}

export function markdownToDocument(markdown: string): JSONContent {
  // remark-math deliberately interprets same-line `$$x$$` as inline math.  PaperCanvas
  // treats a complete line using double delimiters as a display formula, matching its UI.
  const normalized = markdown.replace(
    /^\$\$([^\n]+)\$\$\s*$/gm,
    (_line, latex: string) => `$$\n${latex}\n$$`,
  );
  const root = processor.parse(normalized) as unknown as MdRoot;
  const converted = content(root.children);
  return { type: 'doc', content: converted.length > 0 ? converted : [{ type: 'paragraph' }] };
}

function toMdast(node: JSONContent): MdNode | null {
  const childNodes = (node.content ?? []).flatMap((child) => {
    const converted = toMdast(child);
    return converted ? [converted] : [];
  });
  const marks = node.marks ?? [];
  const mark = (type: string) => marks.find((item) => item.type === type);
  if (node.type === 'text') {
    const bare: MdNode = { type: 'text', value: node.text ?? '' };
    if (mark('code')) return { type: 'inlineCode', value: bare.value };
    let wrapped = bare;
    if (mark('link'))
      wrapped = { type: 'link', url: String(mark('link')?.attrs?.href ?? ''), children: [wrapped] };
    if (mark('strike')) wrapped = { type: 'delete', children: [wrapped] };
    if (mark('italic')) wrapped = { type: 'emphasis', children: [wrapped] };
    if (mark('bold')) wrapped = { type: 'strong', children: [wrapped] };
    return wrapped;
  }
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', children: childNodes };
    case 'heading':
      return { type: 'heading', depth: Number(node.attrs?.level ?? 1), children: childNodes };
    case 'blockquote':
      return { type: 'blockquote', children: childNodes };
    case 'bulletList':
      return { type: 'list', ordered: false, children: childNodes };
    case 'orderedList':
      return {
        type: 'list',
        ordered: true,
        start: Number(node.attrs?.start ?? 1),
        children: childNodes,
      };
    case 'listItem':
      return { type: 'listItem', children: childNodes };
    case 'taskList':
      return { type: 'list', ordered: false, children: childNodes };
    case 'taskItem':
      return { type: 'listItem', checked: Boolean(node.attrs?.checked), children: childNodes };
    case 'codeBlock':
      return {
        type: 'code',
        lang: String(node.attrs?.language ?? '') || null,
        value: flattenText(node),
      };
    case 'horizontalRule':
      return { type: 'thematicBreak' };
    case 'hardBreak':
      return { type: 'break' };
    case 'image':
      return {
        type: 'image',
        url: String(node.attrs?.src ?? ''),
        alt: String(node.attrs?.alt ?? '') || null,
        title: markdownImageTitle(node.attrs),
      };
    case 'inlineFormula':
      return { type: 'inlineMath', value: String(node.attrs?.latex ?? '') };
    case 'blockFormula':
      return { type: 'math', value: String(node.attrs?.latex ?? '') };
    case 'table':
      return { type: 'table', children: childNodes };
    case 'tableRow':
      return { type: 'tableRow', children: childNodes };
    case 'tableCell':
      return { type: 'tableCell', children: cellInlineChildren(node) };
    case 'tableHeader':
      return { type: 'tableHeader', children: cellInlineChildren(node) };
    case 'unsupportedMarkdown':
      return { type: 'html', value: String(node.attrs?.source ?? '') };
    default:
      return null;
  }
}

function cellInlineChildren(node: JSONContent): MdNode[] {
  const paragraph = node.content?.find((child) => child.type === 'paragraph');
  return (paragraph?.content ?? []).flatMap((child) => {
    const converted = toMdast(child);
    return converted ? [converted] : [];
  });
}

function flattenText(node: JSONContent): string {
  return (node.content ?? []).map((child) => child.text ?? flattenText(child)).join('');
}

export function documentToMarkdown(document: JSONContent): string {
  const root: MdRoot = {
    type: 'root',
    children: (document.content ?? []).flatMap((node) => {
      const converted = toMdast(node);
      return converted ? [converted] : [];
    }),
  };
  return processor.stringify(root as unknown as never).replace(/\n{3,}/g, '\n\n');
}

export function collectOutline(document: JSONContent): Array<{ level: number; text: string }> {
  return (document.content ?? [])
    .filter((node) => node.type === 'heading')
    .map((node) => ({
      level: Number(node.attrs?.level ?? 1),
      text: flattenText(node) || '未命名標題',
    }));
}
