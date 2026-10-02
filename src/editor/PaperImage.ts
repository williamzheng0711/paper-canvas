import Image from "@tiptap/extension-image";

export const PaperImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      originalSrc: { default: null, rendered: false },
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
      linkTitle: { default: null, rendered: false },
    };
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
