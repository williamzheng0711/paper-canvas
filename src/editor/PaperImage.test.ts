import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperImage, decodePaperImages } from "./PaperImage";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import { sanitizePastedHtml } from "./paste";

let editor: Editor | undefined;
const restoreDecoders: Array<() => void> = [];
function mockDecode(decode: () => Promise<void>): void {
  const previous = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "decode");
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, value: decode });
  restoreDecoders.push(() => {
    if (previous) Object.defineProperty(HTMLImageElement.prototype, "decode", previous);
    else Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
  });
}

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  restoreDecoders.splice(0).reverse().forEach((restore) => restore());
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
  it("reveals cached pixels after nonblocking decode without waiting for another load event", async () => {
    let resolve: (() => void) | undefined;
    const decode = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    mockDecode(decode);
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(480);
    editor = createEditor("![Cached SVG](https://example.com/cached.svg)");
    const wrapper = editor.view.dom.firstElementChild as HTMLElement;
    const before = editor.getJSON();
    expect(wrapper.style.visibility).toBe("hidden");
    expect(decode).toHaveBeenCalledOnce();
    resolve?.();
    await Promise.resolve();
    expect(wrapper.style.visibility).toBe("");
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.undo()).toBe(false);
  });

  it("refreshes retained image decoding when the canvas is shown again", async () => {
    const resolvers: Array<() => void> = [];
    mockDecode(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(480);
    editor = createEditor("![Retained SVG](https://example.com/retained.svg)");
    const wrapper = editor.view.dom.firstElementChild as HTMLElement;
    const before = editor.getJSON();
    decodePaperImages(editor.view.dom);
    expect(resolvers).toHaveLength(2);
    resolvers[0]();
    await Promise.resolve();
    expect(wrapper.style.visibility).toBe("hidden");
    resolvers[1]();
    await Promise.resolve();
    expect(wrapper.style.visibility).toBe("");
    expect(editor.getJSON()).toEqual(before);
  });

  it("ignores a stale decode after the image source changes", async () => {
    const resolvers: Array<() => void> = [];
    mockDecode(() => new Promise<void>((resolve) => { resolvers.push(resolve); }));
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(480);
    editor = createEditor("![First](https://example.com/first.svg)");
    const image = editor.view.dom.querySelector("img")!;
    editor.commands.setNodeSelection(0);
    editor.commands.updateAttributes("image", { src: "https://example.com/second.svg" });
    image.dispatchEvent(new Event("error"));
    const fallback = editor.view.dom.querySelector<HTMLElement>(".image-load-fallback")!;
    expect(fallback.style.display).toBe("block");
    expect(resolvers).toHaveLength(2);
    resolvers[0]();
    await Promise.resolve();
    expect(fallback.style.display).toBe("block");
    resolvers[1]();
    await Promise.resolve();
    expect(fallback.style.display).toBe("none");
    expect(image.getAttribute("src")).toBe("https://example.com/second.svg");
  });

  it("does not reveal a destroyed node when decoding finishes late", async () => {
    let resolve: (() => void) | undefined;
    mockDecode(() => new Promise<void>((done) => { resolve = done; }));
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(480);
    editor = createEditor("![Closed](https://example.com/closed.svg)");
    const wrapper = editor.view.dom.firstElementChild as HTMLElement;
    editor.destroy();
    editor = undefined;
    resolve?.();
    await Promise.resolve();
    expect(wrapper.style.visibility).toBe("hidden");
  });

  it("retains readable error fallback after decode rejection", async () => {
    mockDecode(() => Promise.reject(new Error("Decode failed")));
    editor = createEditor("![Failed SVG](https://example.com/missing.svg)");
    const image = editor.view.dom.querySelector("img")!;
    image.dispatchEvent(new Event("error"));
    await Promise.resolve();
    expect(editor.view.dom.querySelector(".image-load-fallback")?.textContent).toBe("Failed SVG");
    expect(image.style.display).toBe("none");
  });

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
