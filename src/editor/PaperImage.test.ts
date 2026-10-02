import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperImage } from "./PaperImage";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import { sanitizePastedHtml } from "./paste";

let editor: Editor | undefined;

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function createEditor(source: string): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  return new Editor({
    element: host,
    extensions: [
      StarterKit,
      PaperImage.configure({
        resize: { enabled: true, minWidth: 80, minHeight: 60 },
      }),
    ],
    editorProps: { transformPastedHTML: sanitizePastedHtml },
    content: markdownToDocument(source),
  });
}

describe("image reading fidelity", () => {
  it("reveals failed image nodes so their alt text and selection remain available", () => {
    editor = createEditor(
      "![Missing reading image](https://example.com/missing.png)",
    );
    const image = editor.view.dom.querySelector("img");
    const wrapper = editor.view.dom.firstElementChild as HTMLElement;
    expect(image?.alt).toBe("Missing reading image");
    image?.dispatchEvent(new Event("error"));
    expect(wrapper.style.visibility).toBe("");
    expect(wrapper.style.pointerEvents).toBe("");
    expect(wrapper.querySelector(".image-load-fallback")?.textContent).toBe(
      "Missing reading image",
    );
    expect(image?.style.display).toBe("none");
  });

  it("reveals already completed images instead of waiting for a load event that has passed", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true,
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      480,
    );
    editor = createEditor(
      "![Cached reading image](https://example.com/cached.png)",
    );
    const wrapper = editor.view.dom.firstElementChild as HTMLElement;
    expect(wrapper.style.visibility).toBe("");
    expect(wrapper.style.pointerEvents).toBe("");
    expect(
      (wrapper.querySelector(".image-load-fallback") as HTMLElement)?.style
        .display,
    ).toBe("none");
  });

  it("shows explicit alt text for cached failures and clears it after a successful retry", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true,
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      0,
    );
    editor = createEditor("![Cached failure](missing.png)");
    const image = editor.view.dom.querySelector("img");
    const fallback = editor.view.dom.querySelector(
      ".image-load-fallback",
    ) as HTMLElement;
    expect(fallback.textContent).toBe("Cached failure");
    expect(fallback.style.display).toBe("block");
    image?.dispatchEvent(new Event("load"));
    expect(fallback.style.display).toBe("none");
    expect(image?.style.display).toBe("");
  });

  it("keeps the fallback text current when an image caption changes after a failure", () => {
    editor = createEditor("![Before](missing.png)");
    editor.view.dom.querySelector("img")?.dispatchEvent(new Event("error"));
    editor.commands.setNodeSelection(0);
    editor.commands.updateAttributes("image", { alt: "After" });
    expect(
      editor.view.dom.querySelector(".image-load-fallback")?.textContent,
    ).toBe("After");
  });

  it("retains linked image URLs and titles through the real image schema", () => {
    editor = createEditor(
      '[![Diagram](diagram.png "Figure title")](https://example.com/guide "Read the guide")',
    );
    const image = editor.view.dom.querySelector("img");
    expect(image?.getAttribute("data-image-link")).toBe(
      "https://example.com/guide",
    );
    expect(image?.title).toBe("Read the guide");
    expect(() => editor?.state.doc.check()).not.toThrow();
    const serialized = documentToMarkdown(editor.getJSON());
    expect(serialized).toContain(
      '[![Diagram](diagram.png "Figure title")](https://example.com/guide "Read the guide")',
    );
  });

  it("retains linked images and separate image/link titles through sanitized HTML copy and paste", () => {
    editor = createEditor(
      '[![Diagram](diagram.png "Figure title")](https://example.com/guide "Read the guide")',
    );
    const copied = editor.getHTML();
    const destination = createEditor("replace me");
    try {
      destination.commands.selectAll();
      destination.view.pasteHTML(copied, new Event("paste") as ClipboardEvent);
      expect(destination.getJSON().content?.[0]).toMatchObject({
        type: "image",
        attrs: {
          src: "diagram.png",
          title: "Figure title",
          linkHref: "https://example.com/guide",
          linkTitle: "Read the guide",
        },
      });
      expect(documentToMarkdown(destination.getJSON())).toContain(
        '[![Diagram](diagram.png "Figure title")](https://example.com/guide "Read the guide")',
      );
    } finally {
      destination.destroy();
    }
  });

  it("imports an external image hyperlink title independently from its caption", () => {
    editor = createEditor("replace me");
    editor.commands.selectAll();
    editor.view.pasteHTML(
      '<a href="https://example.com/guide" title="Read the guide"><img src="diagram.png" alt="Diagram" title="Figure title" width="240" height="120"></a>',
      new Event("paste") as ClipboardEvent,
    );
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "image",
      attrs: {
        title: "Figure title",
        linkHref: "https://example.com/guide",
        linkTitle: "Read the guide",
        width: 240,
        height: 120,
      },
    });
  });

  it("does not promote unsafe or relative clipboard origin metadata into image URLs", () => {
    editor = createEditor("replace me");
    editor.commands.selectAll();
    editor.view.pasteHTML(
      '<img src="javascript:discard()" data-image-original-src="javascript:discard()"><img data-image-original-src="images/relative.png">',
      new Event("paste") as ClipboardEvent,
    );
    expect(
      editor.getJSON().content?.some((node) => node.type === "image"),
    ).toBe(false);
    expect(editor.view.dom.querySelector("img")).toBeNull();
  });
});
