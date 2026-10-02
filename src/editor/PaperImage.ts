import Image, { type ImageOptions } from "@tiptap/extension-image";
import { mergeAttributes } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import {
  encodeLocalAssetPath,
  localAssetPath,
  localAssetUrl,
} from "../lib/localAssets";
import { rebaseImageDestination } from "./markdownAssetReferences";

interface PaperImageOptions extends ImageOptions {
  getDocumentPath: () => string | undefined;
}

function clipboardOriginalSource(element: HTMLElement): string | null {
  const source = element.getAttribute("data-image-original-src");
  return source && /^(?:\/(?!\/)|[A-Za-z]:[\\/]|file:\/\/)/i.test(source)
    ? source
    : null;
}

export const PaperImage = Image.extend<PaperImageOptions>({
  addOptions() {
    return {
      ...this.parent!(),
      getDocumentPath: () => undefined,
    };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: (element) => {
          const original = clipboardOriginalSource(element);
          return original && isTauri()
            ? localAssetUrl("", original, convertFileSrc)
            : (element.getAttribute("src") ?? original);
        },
      },
      originalSrc: {
        default: null,
        rendered: false,
        parseHTML: (element) => {
          const original = clipboardOriginalSource(element);
          const documentPath = this.options.getDocumentPath();
          if (!original || !documentPath) return original;
          const resolved = localAssetPath("", original);
          const filename = resolved.path.replace(/\\/g, "/").split("/").at(-1);
          if (!filename) return original;
          return rebaseImageDestination(
            encodeLocalAssetPath(filename) + resolved.suffix,
            resolved.path,
            documentPath,
          );
        },
      },
      basePath: {
        default: null,
        rendered: false,
        parseHTML: (element) =>
          clipboardOriginalSource(element)
            ? (this.options.getDocumentPath()?.replace(/[^\\/]*$/, "") ?? null)
            : null,
      },
      linkHref: {
        default: null,
        renderHTML: (attrs) =>
          attrs.linkHref
            ? {
                "data-image-link": attrs.linkHref,
                ...(attrs.linkTitle ? { title: attrs.linkTitle } : {}),
              }
            : {},
        parseHTML: (element) =>
          element.getAttribute("data-image-link") ||
          element.closest("a")?.getAttribute("href") ||
          null,
      },
      linkTitle: {
        default: null,
        rendered: false,
        parseHTML: (element) =>
          element.closest("a[href]")?.getAttribute("title") ?? null,
      },
    };
  },

  parseHTML() {
    return [
      ...(this.parent?.() ?? []),
      {
        tag: "img[data-image-original-src]",
        getAttrs: (element) =>
          clipboardOriginalSource(element) ? null : false,
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    // The live resize view uses the link title as its tooltip. Clipboard HTML
    // needs an actual anchor and separate titles so sanitization and other
    // editors can preserve both the link and the image's authored caption.
    // Relative sources belong to this document's directory. Clipboard origin
    // metadata uses the physical path so another document can save and reopen
    // the same image without retaining a runtime asset-protocol URL.
    let originalSrc: string | undefined;
    if (
      typeof node.attrs.originalSrc === "string" &&
      typeof node.attrs.basePath === "string"
    ) {
      const resolved = localAssetPath(
        node.attrs.basePath,
        node.attrs.originalSrc,
      );
      const encoded = encodeLocalAssetPath(resolved.path);
      originalSrc =
        (encoded.startsWith("//") ? `file:${encoded}` : encoded) + resolved.suffix;
    } else if (
      typeof node.attrs.originalSrc === "string" &&
      /^(?:\/(?!\/)|[A-Za-z]:[\\/]|file:\/\/)/i.test(node.attrs.originalSrc)
    ) {
      originalSrc = node.attrs.originalSrc;
    }
    const image: DOMOutputSpec = [
      "img",
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        title: node.attrs.title,
        ...(originalSrc ? { "data-image-original-src": originalSrc } : {}),
      }),
    ];
    if (!node.attrs.linkHref) return image;
    return [
      "a",
      {
        href: node.attrs.linkHref,
        ...(node.attrs.linkTitle ? { title: node.attrs.linkTitle } : {}),
      },
      image,
    ];
  },

  addNodeView() {
    const parent = this.parent?.();
    if (!parent) return null;
    return (props) => {
      const nodeView = parent(props);
      const dom = nodeView.dom as HTMLElement;
      const image =
        dom instanceof HTMLImageElement ? dom : dom.querySelector("img");
      if (!image) return nodeView;
      let currentNode = props.node;
      let previousSource = image.getAttribute("src");
      const originalDisplay = image.style.display;
      const fallback = document.createElement("span");
      fallback.className = "image-load-fallback";
      fallback.style.display = "none";
      fallback.style.whiteSpace = "normal";
      fallback.style.overflowWrap = "anywhere";
      fallback.setAttribute("role", "img");
      image.parentElement?.append(fallback);
      const reveal = () => {
        dom.style.visibility = "";
        dom.style.pointerEvents = "";
      };
      const syncFallback = () => {
        const label =
          image.alt ||
          String(currentNode.attrs.originalSrc ?? currentNode.attrs.src ?? "");
        fallback.textContent = label;
        fallback.setAttribute("aria-label", label);
        const link = image.getAttribute("data-image-link");
        if (link) fallback.setAttribute("data-image-link", link);
        else fallback.removeAttribute("data-image-link");
      };
      const showImage = () => {
        image.style.display = originalDisplay;
        fallback.style.display = "none";
        reveal();
      };
      const showFallback = () => {
        syncFallback();
        // WebKit's broken-image icon often has no readable alt text. Explicit
        // text avoids depending on browser-specific fallback rendering.
        image.style.display = "none";
        fallback.style.display = "block";
        reveal();
      };
      image.addEventListener("error", showFallback);
      image.addEventListener("load", showImage);
      if (image.complete) {
        if (image.naturalWidth > 0) showImage();
        else showFallback();
      }
      const update = nodeView.update?.bind(nodeView);
      if (update) {
        nodeView.update = (node, decorations, innerDecorations) => {
          const updated = update(node, decorations, innerDecorations);
          if (!updated) return false;
          currentNode = node;
          const source = image.getAttribute("src");
          if (source !== previousSource) {
            previousSource = source;
            showImage();
            if (image.complete && image.naturalWidth === 0) showFallback();
          } else if (fallback.style.display !== "none") syncFallback();
          return true;
        };
      }
      const destroy = nodeView.destroy?.bind(nodeView);
      nodeView.destroy = () => {
        image.removeEventListener("error", showFallback);
        image.removeEventListener("load", showImage);
        destroy?.();
      };
      return nodeView;
    };
  },
});
