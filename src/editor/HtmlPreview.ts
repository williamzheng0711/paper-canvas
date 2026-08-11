import { Node, mergeAttributes, type NodeViewRendererProps } from '@tiptap/core';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import DOMPurify from 'dompurify';
import { isHtmlPreviewCandidate, previewHtmlAttributes, previewHtmlTags } from './htmlSafety';

type PreviewKind = 'block' | 'inline';
type LocalFileConverter = (path: string) => string;

function pathSeparator(path: string): '/' | '\\' {
  return path.includes('\\') ? '\\' : '/';
}

function joinLocalPath(basePath: string, relativePath: string): string {
  const separator = pathSeparator(basePath);
  const normalizedRelative = relativePath.replace(/[\\/]/g, separator);
  return `${basePath.replace(/[\\/]$/, '')}${separator}${normalizedRelative}`;
}

function splitResourceSuffix(source: string): { path: string; suffix: string } {
  const index = source.search(/[?#]/);
  return index < 0 ? { path: source, suffix: '' } : { path: source.slice(0, index), suffix: source.slice(index) };
}

function isAllowedEmbeddedImage(source: string): boolean {
  return /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(source);
}

function isAllowedRenderedImage(source: string): boolean {
  return (
    /^https:\/\//i.test(source) ||
    /^(?:asset:|blob:|tauri:)/i.test(source) ||
    /^http:\/\/asset\.localhost(?:\/|$)/i.test(source) ||
    isAllowedEmbeddedImage(source)
  );
}

function isRelativeResource(source: string): boolean {
  return Boolean(source) && !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|[\\/]|#)/.test(source);
}

function resolveImageSources(
  preview: ParentNode,
  basePath?: string | null,
  convertLocalFile?: LocalFileConverter,
): void {
  preview.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    const source = image.getAttribute('src')?.trim() ?? '';
    image.setAttribute('referrerpolicy', 'no-referrer');

    if (isAllowedRenderedImage(source)) return;
    if (!isRelativeResource(source)) {
      image.removeAttribute('src');
      return;
    }
    if (!basePath || !convertLocalFile) return;

    const { path, suffix } = splitResourceSuffix(source);
    image.src = `${convertLocalFile(joinLocalPath(basePath, path))}${suffix}`;
  });
}

export function createHtmlPreview(
  source: string,
  options: {
    kind: PreviewKind;
    basePath?: string | null;
    convertLocalFile?: LocalFileConverter;
  },
): HTMLElement {
  const preview = document.createElement(options.kind === 'block' ? 'div' : 'span');
  preview.className = `html-preview html-preview--${options.kind}`;

  if (!isHtmlPreviewCandidate(source)) {
    preview.classList.add('html-preview--blocked');
    preview.textContent = source;
    return preview;
  }

  const sanitized = DOMPurify.sanitize(source, {
    ALLOWED_TAGS: [...previewHtmlTags],
    ALLOWED_ATTR: [...previewHtmlAttributes],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  });
  const template = document.createElement('template');
  template.innerHTML = String(sanitized);
  resolveImageSources(template.content, options.basePath, options.convertLocalFile);
  preview.append(template.content.cloneNode(true));
  preview.querySelectorAll<HTMLAnchorElement>('a').forEach((anchor) => {
    anchor.removeAttribute('target');
    anchor.rel = 'noopener noreferrer';
  });
  return preview;
}

class HtmlPreviewView {
  dom: HTMLElement;
  private node: NodeViewRendererProps['node'];
  private readonly kind: PreviewKind;

  constructor(props: NodeViewRendererProps, kind: PreviewKind) {
    this.node = props.node;
    this.kind = kind;
    this.dom = document.createElement(kind === 'block' ? 'div' : 'span');
    this.dom.contentEditable = 'false';
    this.dom.addEventListener('click', this.preventNavigation);
    this.render();
  }

  update(node: NodeViewRendererProps['node']): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('is-selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('is-selected');
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dom.removeEventListener('click', this.preventNavigation);
  }

  private readonly preventNavigation = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest('a')) event.preventDefault();
  };

  private render(): void {
    const source = String(this.node.attrs.source ?? '');
    const basePath = typeof this.node.attrs.basePath === 'string' ? this.node.attrs.basePath : undefined;
    const convertLocalFile = isTauri() ? convertFileSrc : undefined;
    const preview = createHtmlPreview(source, {
      kind: this.kind,
      basePath,
      convertLocalFile,
    });
    this.dom.className = preview.className;
    this.dom.replaceChildren(...Array.from(preview.childNodes));
  }
}

const htmlPreviewAttributes = {
  source: { default: '', rendered: false },
  basePath: { default: null, rendered: false },
};

export const HtmlPreview = Node.create({
  name: 'htmlPreview',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return htmlPreviewAttributes;
  },

  parseHTML() {
    return [{ tag: 'div[data-html-preview]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-html-preview': '' })];
  },

  addNodeView() {
    return (props) => new HtmlPreviewView(props, 'block');
  },
});

export const InlineHtmlPreview = Node.create({
  name: 'inlineHtmlPreview',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return htmlPreviewAttributes;
  },

  parseHTML() {
    return [{ tag: 'span[data-inline-html-preview]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-inline-html-preview': '' })];
  },

  addNodeView() {
    return (props) => new HtmlPreviewView(props, 'inline');
  },
});
