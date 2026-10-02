import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHtmlPreview,
  HtmlPreview,
  InlineHtmlPreview,
} from "./HtmlPreview";

describe("sanitized HTML previews", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("renders the centered headings, images, and table layout used by the repository READMEs", () => {
    const preview = createHtmlPreview(
      `<h1 align="center">PaperCanvas</h1>
<p align="center"><img src="docs/editor.png" width="100%" alt="Editor"></p>
<table><tr><td width="50%"><strong>Canvas</strong><br><sub>Local first</sub></td></tr></table>`,
      {
        kind: "block",
        basePath: "/Users/example/paper-canvas",
        convertLocalFile: (path) => `asset://${path}`,
      },
    );

    expect(preview.querySelector("h1")?.textContent).toBe("PaperCanvas");
    expect(preview.querySelector("h1")?.getAttribute("align")).toBe("center");
    expect(preview.querySelector("table td")?.getAttribute("width")).toBe(
      "50%",
    );
    expect(preview.querySelector("img")?.src).toContain(
      "asset:///Users/example/paper-canvas/docs/editor.png",
    );
    expect(preview.querySelector("img")?.getAttribute("referrerpolicy")).toBe(
      "no-referrer",
    );
    expect(preview.querySelector("img")?.hasAttribute("loading")).toBe(false);
  });

  it("removes executable attributes and dangerous resource URLs", () => {
    const preview = createHtmlPreview(
      `<p style="position:fixed" onclick="alert(1)">
  <a href="javascript:alert(1)" target="_blank">Unsafe link</a>
  <img src="javascript:alert(2)" onerror="alert(3)" alt="Unsafe image">
</p>`,
      { kind: "block" },
    );
    const paragraph = preview.querySelector("p");
    const anchor = preview.querySelector("a");
    const image = preview.querySelector("img");

    expect(paragraph?.hasAttribute("style")).toBe(false);
    expect(paragraph?.hasAttribute("onclick")).toBe(false);
    expect(anchor?.hasAttribute("href")).toBe(false);
    expect(anchor?.hasAttribute("target")).toBe(false);
    expect(image?.hasAttribute("src")).toBe(false);
    expect(image?.hasAttribute("onerror")).toBe(false);
  });

  it("normalizes parent-relative and URI-encoded local HTML image paths before native conversion", () => {
    const preview = createHtmlPreview(
      '<p><img src="../My%20figure.svg#view" alt="Figure"></p>',
      {
        kind: "block",
        basePath: "/Users/example/notes/chapter",
        convertLocalFile: (path) => `asset://${path}`,
      },
    );
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(
      "asset:///Users/example/notes/My figure.svg#view",
    );
  });

  it.each([
    [
      "/Users/example/My%20figure.svg#view",
      "/Users/example/My figure.svg",
      "#view",
    ],
    ["C:\\notes\\My%20figure.png", "C:\\notes\\My figure.png", ""],
    [
      "file:///C:/notes/images/a%20b.png?size=2&amp;x=1",
      "C:\\notes\\images\\a b.png",
      "?size=2&x=1",
    ],
    [
      "file:///Users/example/My%20figure.png",
      "/Users/example/My figure.png",
      "",
    ],
    ["file://server/share/a%20b.png", "//server/share/a b.png", ""],
  ])(
    "converts explicit local HTML image source %s through the native asset resolver",
    (source, path, suffix) => {
      const convert = vi.fn((value: string) => `asset://${value}`);
      const preview = createHtmlPreview(`<img src="${source}">`, {
        kind: "block",
        basePath: "/Users/example/document",
        convertLocalFile: convert,
      });
      expect(convert).toHaveBeenCalledWith(path);
      expect(preview.querySelector("img")?.getAttribute("src")).toBe(
        `asset://${path}${suffix}`,
      );
    },
  );

  it.each([
    "/Users/example/figure.png",
    "C:\\notes\\figure.png",
    "file:///C:/notes/figure.png",
    "file://server/share/figure.png",
  ])(
    "does not directly load explicit local HTML image source %s without a native converter",
    (source) => {
      const preview = createHtmlPreview(`<img src="${source}">`, {
        kind: "block",
      });
      expect(preview.querySelector("img")?.hasAttribute("src")).toBe(false);
    },
  );

  it.each([
    "javascript:alert(1)",
    "java&#x09;script:alert(1)",
    "java&#x0A;script:alert(1)",
    "java&#x20;script:alert(1)",
    "da&#x09;ta:text/html;base64,PHNjcmlwdD4=",
    "un&#x0A;known://example.com/figure.png",
    "ftp://example.com/figure.png",
    "http://example.com/figure.png",
    "unknown://example.com/figure.png",
    "//example.com/figure.png",
    "data:text/html;base64,PHNjcmlwdD4=",
  ])(
    "rejects image scheme %s even when a native converter is available",
    (source) => {
      const convert = vi.fn((path: string) => `asset://${path}`);
      for (const convertLocalFile of [convert, undefined]) {
        const preview = createHtmlPreview(
          `<img src="${source}" onerror="alert(1)">`,
          {
            kind: "block",
            basePath: "/Users/example",
            convertLocalFile,
          },
        );
        expect(convert).not.toHaveBeenCalled();
        expect(preview.querySelector("img")?.hasAttribute("src")).toBe(false);
        expect(preview.querySelector("img")?.hasAttribute("onerror")).toBe(
          false,
        );
      }
    },
  );

  it("shows blocked embedded HTML as inert source text", () => {
    const preview = createHtmlPreview(
      '<iframe src="https://example.com"></iframe><script>alert(1)</script>',
      {
        kind: "block",
      },
    );

    expect(preview.classList.contains("html-preview--blocked")).toBe(true);
    expect(preview.querySelector("iframe")).toBeNull();
    expect(preview.querySelector("script")).toBeNull();
    expect(preview.textContent).toContain("<script>alert(1)</script>");
  });

  it("keeps comments invisible and ignores tags inside comments when checking preview safety", () => {
    const comment = createHtmlPreview(
      "<!-- A reference to <script> is only a comment. -->",
      { kind: "block" },
    );
    expect(comment.hidden).toBe(true);
    expect(comment.textContent).toBe("");
    const content = createHtmlPreview("<!-- <iframe> --><p>Visible text.</p>", {
      kind: "block",
    });
    expect(content.querySelector("p")?.textContent).toBe("Visible text.");
    expect(content.hidden).toBe(false);
  });

  it("integrates with ProseMirror as selectable block and inline atoms while disabling navigation", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, HtmlPreview, InlineHtmlPreview],
      content: {
        type: "doc",
        content: [
          {
            type: "htmlPreview",
            attrs: {
              source:
                '<p align="center"><a href="https://example.com">PaperCanvas</a></p>',
            },
          },
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Press " },
              {
                type: "inlineHtmlPreview",
                attrs: { source: "<kbd>Command</kbd>" },
              },
              { type: "text", text: "." },
            ],
          },
        ],
      },
    });
    const anchor = host.querySelector<HTMLAnchorElement>(".html-preview a");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor?.dispatchEvent(click);

    expect(host.querySelector(".html-preview--block p")?.textContent).toBe(
      "PaperCanvas",
    );
    expect(host.querySelector(".html-preview--inline kbd")?.textContent).toBe(
      "Command",
    );
    expect(click.defaultPrevented).toBe(true);

    editor.commands.setNodeSelection(0);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(
      host
        .querySelector(".html-preview--block")
        ?.classList.contains("is-selected"),
    ).toBe(true);
    editor.destroy();
  });
});
