import { Node, type NodeViewRendererProps } from "@tiptap/core";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { localAssetUrl } from "../lib/localAssets";
import {
  isHtmlCommentOnly,
  isHtmlPreviewCandidate,
  previewHtmlAttributes,
  previewHtmlTags,
} from "./htmlSafety";
import { sanitizePastedHtml } from "./paste";

type PreviewKind = "block" | "inline";
type LocalFileConverter = (path: string) => string;

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
  // Browsers ignore ASCII whitespace in URL schemes. Classify that normalized
  // candidate, but preserve the original bytes when resolving local filenames.
  const schemeCandidate = source.replace(/\s/g, "");
  return (
    Boolean(source) &&
    !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|[\\/]|#)/.test(schemeCandidate)
  );
}

function isAbsoluteLocalResource(source: string): boolean {
  if (/^file:\/\//i.test(source)) {
    try {
      return new URL(source).protocol === "file:";
    } catch {
      return false;
    }
  }
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\)/.test(source);
}

function resolveImageSources(
  preview: ParentNode,
  basePath?: string | null,
  convertLocalFile?: LocalFileConverter,
): void {
  preview.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const source = image.getAttribute("src")?.trim() ?? "";
    image.setAttribute("referrerpolicy", "no-referrer");

    if (isAllowedRenderedImage(source)) return;
    const absoluteLocal = isAbsoluteLocalResource(source);
    const relativeLocal = isRelativeResource(source);
    if (!absoluteLocal && !relativeLocal) {
      image.removeAttribute("src");
      return;
    }
    if (!convertLocalFile || (!absoluteLocal && !basePath)) {
      if (absoluteLocal) image.removeAttribute("src");
      return;
    }

    image.setAttribute(
      "src",
      localAssetUrl(basePath ?? "", source, convertLocalFile),
    );
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
  const preview = document.createElement(
    options.kind === "block" ? "div" : "span",
  );
  preview.className = `html-preview html-preview--${options.kind}`;
  preview.hidden = isHtmlCommentOnly(source);

  if (!isHtmlPreviewCandidate(source)) {
    preview.classList.add("html-preview--blocked");
    preview.textContent = source;
    return preview;
  }

  const sanitized = DOMPurify.sanitize(source, {
    ALLOWED_TAGS: [...previewHtmlTags],
    ALLOWED_ATTR: [...previewHtmlAttributes],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    // Image URLs are validated and converted below before this detached
    // fragment is rendered. Retain local file URLs for that explicit resolver;
    // the ordinary DOMPurify URL policy still applies to links.
    ADD_URI_SAFE_ATTR: ["src"],
  });
  const template = document.createElement("template");
  template.innerHTML = String(sanitized);
  resolveImageSources(
    template.content,
    options.basePath,
    options.convertLocalFile,
  );
  preview.append(template.content.cloneNode(true));
  preview.querySelectorAll<HTMLAnchorElement>("a").forEach((anchor) => {
    anchor.removeAttribute("target");
    anchor.rel = "noopener noreferrer";
  });
  return preview;
}

const previewBlockTags = new Set([
  "BLOCKQUOTE",
  "CAPTION",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

/** Read the displayed body without searching HTML tags, attributes, or comments. */
export function htmlPreviewText(
  source: string,
  kind: PreviewKind,
  options: { preserveEdges?: boolean } = {},
): string {
  const preview = createHtmlPreview(source, { kind });
  if (preview.hidden) return "";
  // Unsupported HTML is intentionally displayed as inert source text.
  if (preview.classList.contains("html-preview--blocked"))
    return preview.textContent ?? "";

  const text: string[] = [];
  function visit(node: globalThis.Node, preformatted = false): void {
    if (node.nodeType === globalThis.Node.TEXT_NODE) {
      let value = node.textContent ?? "";
      if (!preformatted) {
        value = value.replace(/\s+/g, " ");
        if (text.at(-1)?.endsWith(" ") && value.startsWith(" "))
          value = value.slice(1);
      }
      text.push(value);
      return;
    }
    if (!(node instanceof HTMLElement) || node.hidden) return;
    if (node.tagName === "BR") {
      text.push("\n");
      return;
    }
    const block = previewBlockTags.has(node.tagName);
    if (block) text.push("\n");
    node.childNodes.forEach((child) =>
      visit(child, preformatted || node.tagName === "PRE"),
    );
    if (block) text.push("\n");
  }
  preview.childNodes.forEach((child) => visit(child));
  const readable = text
    .join("")
    .replace(/ *\n */g, "\n")
    .replace(/\n+/g, "\n");
  return options.preserveEdges ? readable : readable.trim();
}

class HtmlPreviewView {
  dom: HTMLElement;
  private node: NodeViewRendererProps["node"];
  private readonly kind: PreviewKind;

  constructor(props: NodeViewRendererProps, kind: PreviewKind) {
    this.node = props.node;
    this.kind = kind;
    this.dom = document.createElement(kind === "block" ? "div" : "span");
    this.dom.contentEditable = "false";
    this.dom.addEventListener("click", this.preventNavigation);
    this.render();
  }

  update(node: NodeViewRendererProps["node"]): boolean {
    if (node.type !== this.node.type) return false;
    if (node === this.node) return true;
    this.node = node;
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("is-selected");
  }

  deselectNode(): void {
    this.dom.classList.remove("is-selected");
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dom.removeEventListener("click", this.preventNavigation);
  }

  private readonly preventNavigation = (event: Event): void => {
    if (event.target instanceof Element && event.target.closest("a"))
      event.preventDefault();
  };

  private render(): void {
    const source = String(this.node.attrs.source ?? "");
    const basePath =
      typeof this.node.attrs.basePath === "string"
        ? this.node.attrs.basePath
        : undefined;
    const convertLocalFile = isTauri() ? convertFileSrc : undefined;
    const preview = createHtmlPreview(source, {
      kind: this.kind,
      basePath,
      convertLocalFile,
    });
    this.dom.className = preview.className;
    this.dom.hidden = preview.hidden;
    this.dom.replaceChildren(...Array.from(preview.childNodes));
  }
}

const htmlPreviewAttributes = {
  source: { default: "", rendered: false },
  basePath: { default: null, rendered: false },
};

function clipboardHtml(source: string, kind: PreviewKind): HTMLElement {
  const wrapper = document.createElement(kind === "block" ? "div" : "span");
  if (isHtmlCommentOnly(source)) return wrapper;
  if (!isHtmlPreviewCandidate(source)) {
    wrapper.textContent = source;
    return wrapper;
  }
  // Serialize the actual body, rather than an empty atom marker. The clipboard
  // sanitizer retains inert formula, footnote, and task metadata; the visual
  // preview sanitizer intentionally removes it and cannot serve this path.
  wrapper.innerHTML = sanitizePastedHtml(source);
  return wrapper;
}

export const HtmlPreview = Node.create({
  name: "htmlPreview",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return htmlPreviewAttributes;
  },

  parseHTML() {
    return [{ tag: "div[data-html-preview]" }];
  },

  renderHTML({ node }) {
    return clipboardHtml(String(node.attrs.source ?? ""), "block");
  },

  renderText({ node }) {
    return htmlPreviewText(String(node.attrs.source ?? ""), "block");
  },

  addNodeView() {
    return (props) => new HtmlPreviewView(props, "block");
  },
});

export const InlineHtmlPreview = Node.create({
  name: "inlineHtmlPreview",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return htmlPreviewAttributes;
  },

  parseHTML() {
    return [{ tag: "span[data-inline-html-preview]" }];
  },

  renderHTML({ node }) {
    return clipboardHtml(String(node.attrs.source ?? ""), "inline");
  },

  renderText({ node }) {
    return htmlPreviewText(String(node.attrs.source ?? ""), "inline", {
      preserveEdges: true,
    });
  },

  addNodeView() {
    return (props) => new HtmlPreviewView(props, "inline");
  },
});
