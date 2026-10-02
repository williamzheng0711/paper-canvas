import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { canvasNodesAndMarks } from "./canvasSchema";
import { createHtmlPreview } from "./HtmlPreview";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import { sanitizePastedHtml } from "./paste";

function editor(content: JSONContent | string = "<p>replace me</p>"): Editor {
  return new Editor({
    extensions: canvasNodesAndMarks(),
    content,
    editorProps: { transformPastedHTML: sanitizePastedHtml },
  });
}

function paste(editor: Editor, html: string): void {
  editor.commands.selectAll();
  editor.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
  editor.state.doc.check();
}

describe("ordered-list save numbering", () => {
  it.each([-1, 999999999, 1000000000])(
    "preserves HTML-pasted start %i and both items through save and reopen",
    (start) => {
      const source = editor();
      try {
        paste(
          source,
          `<ol start="${start}"><li>First writing</li><li>Second writing</li></ol>`,
        );
        expect(source.getJSON().content?.[0]).toMatchObject({
          type: "orderedList",
          attrs: { start },
        });
        const saved = documentToMarkdown(source.getJSON());
        const reopened = markdownToDocument(saved);
        expect(reopened.content?.[0].type).toBe("htmlPreview");
        expect(reopened.content?.[0].attrs?.source).toBe(saved.trimEnd());
        const savedAgain = documentToMarkdown(reopened);
        expect(documentToMarkdown(markdownToDocument(savedAgain))).toBe(
          savedAgain,
        );
        const preview = createHtmlPreview(
          String(reopened.content?.[0].attrs?.source),
          { kind: "block" },
        );
        expect(preview.querySelector("ol")?.getAttribute("start")).toBe(
          String(start),
        );
        expect(
          Array.from(
            preview.querySelectorAll("li"),
            (item) => item.textContent,
          ),
        ).toEqual(["First writing", "Second writing"]);
      } finally {
        source.destroy();
      }
    },
  );

  it.each([
    [0, 2],
    [1, 2],
    [999999998, 2],
    [999999999, 1],
  ])("keeps representable start %i with %i items editable", (start, count) => {
    const source = editor();
    const destination = editor();
    try {
      paste(
        source,
        `<ol start="${start}">${Array.from({ length: count }, (_, index) => `<li>Item ${index}</li>`).join("")}</ol>`,
      );
      const original = source.getJSON().content?.[0];
      const saved = documentToMarkdown(source.getJSON());
      destination.commands.setContent(markdownToDocument(saved));
      destination.state.doc.check();
      expect(destination.getJSON().content?.[0]).toEqual(original);
      expect(saved).not.toContain("<ol");
    } finally {
      source.destroy();
      destination.destroy();
    }
  });

  it("retains rich contents and task states in the source-preserving HTML fallback", () => {
    const inlineLatex = 'x < y\n\n\\text{"quoted"}';
    const blockLatex = "\\begin{aligned}\nx &= 1\\\\\ny &= 2\n\\end{aligned}";
    const source = editor({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: -4 },
          content: [
            {
              type: "taskItem",
              attrs: { checked: true },
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Done & reviewed ",
                      marks: [{ type: "bold" }, { type: "italic" }],
                    },
                    {
                      type: "inlineFormula",
                      attrs: { latex: inlineLatex },
                      marks: [{ type: "italic" }],
                    },
                  ],
                },
                { type: "blockFormula", attrs: { latex: blockLatex } },
              ],
            },
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Pending <work>",
                      marks: [{ type: "code" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Ordinary item" }],
                },
              ],
            },
          ],
        },
      ],
    });
    const reopened = editor();
    const destination = editor();
    try {
      source.state.doc.check();
      const original = source.getJSON().content?.[0];
      const saved = documentToMarkdown(source.getJSON());
      reopened.commands.setContent(markdownToDocument(saved));
      reopened.state.doc.check();
      expect(reopened.getJSON().content?.[0].type).toBe("htmlPreview");
      expect(reopened.getJSON().content?.[0].attrs?.source).toBe(
        saved.trimEnd(),
      );
      const preview = createHtmlPreview(
        String(reopened.getJSON().content?.[0].attrs?.source),
        { kind: "block" },
      );
      expect(preview.textContent).toContain("[x]");
      expect(preview.textContent).toContain("[ ]");
      expect(preview.querySelector("em strong")?.textContent).toBe(
        "Done & reviewed ",
      );
      expect(preview.querySelector("code")?.textContent).toBe("Pending <work>");
      expect(preview.textContent).toContain(inlineLatex);
      expect(preview.textContent).toContain(blockLatex);
      reopened.commands.selectAll();
      const clipboard = reopened.view.serializeForClipboard(
        reopened.state.selection.content(),
      );
      paste(destination, clipboard.dom.innerHTML);
      expect(destination.getJSON().content?.[0]).toEqual(original);
    } finally {
      source.destroy();
      reopened.destroy();
      destination.destroy();
    }
  });

  it("retains exact formula line endings in saved and reopened list source", () => {
    const latex = "x\r\n\r\ny & z";
    const document: JSONContent = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: -1 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "inlineFormula", attrs: { latex } }],
                },
                { type: "blockFormula", attrs: { latex } },
              ],
            },
          ],
        },
      ],
    };
    const saved = documentToMarkdown(document);
    const reopened = markdownToDocument(saved);
    expect(reopened.content?.[0].type).toBe("htmlPreview");
    expect(documentToMarkdown(reopened)).toBe(saved);
    const source = window.document.createElement("div");
    source.innerHTML = String(reopened.content?.[0].attrs?.source);
    for (const kind of ["inline", "block"]) {
      const formula = source.querySelector(`[data-formula-kind="${kind}"]`);
      expect(formula?.getAttribute("latex")).toBe(latex);
      expect(formula?.getAttribute("data-latex")).toBe(latex);
    }
  });

  it("keeps an outer ordinary list while preserving nested negative numbering", () => {
    const source = editor();
    const destination = editor();
    try {
      paste(
        source,
        '<ol start="2"><li>Outer item<ol start="-1"><li>Inner one</li><li>Inner two</li></ol></li></ol>',
      );
      const saved = documentToMarkdown(source.getJSON());
      const reopened = markdownToDocument(saved);
      destination.commands.setContent(reopened);
      destination.state.doc.check();
      expect(reopened.content?.[0]).toMatchObject({
        type: "orderedList",
        attrs: { start: 2 },
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph" }, { type: "htmlPreview" }],
          },
        ],
      });
      const nested = reopened.content?.[0].content?.[0].content?.[1];
      const preview = createHtmlPreview(String(nested?.attrs?.source), {
        kind: "block",
      });
      expect(preview.querySelector("ol")?.getAttribute("start")).toBe("-1");
      expect(preview.textContent).toBe("Inner oneInner two");
      const savedAgain = documentToMarkdown(reopened);
      expect(markdownToDocument(savedAgain)).toEqual(reopened);
    } finally {
      source.destroy();
      destination.destroy();
    }
  });
});
