import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { canvasNodesAndMarks } from "./canvasSchema";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import { sanitizePastedHtml } from "./paste";
import { loadDraft, saveDraft } from "../lib/files";

describe("shared canvas attribute validation", () => {
  it.each([
    {
      html: '<table><colgroup><col width="80"><col width="120"></colgroup><tbody><tr><td rowspan="0">Spanning writing</td><td>One</td></tr><tr><td>Two</td></tr><tr><td>Three</td></tr></tbody></table>',
      colspan: 1, rowspan: 3,
    },
    { html: '<table><tr><td colspan="0" rowspan="-1">Retained writing</td></tr></table>', colspan: 1, rowspan: 1 },
    { html: '<table><tr><td colspan="1001">Wide writing</td></tr></table>', colspan: 1000, rowspan: 1 },
  ])("keeps actual HTML paste with span $colspan/$rowspan recoverable as a canvas-only draft", async ({ html, colspan, rowspan }) => {
    localStorage.clear();
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: canvasNodesAndMarks(),
      editorProps: { transformPastedHTML: sanitizePastedHtml },
      content: markdownToDocument("replace me"),
    });
    try {
      editor.commands.selectAll();
      expect(editor.view.pasteHTML(html, new Event("paste") as ClipboardEvent)).toBe(true);
      const document = editor.getJSON() as JSONContent;
      expect(document.content?.[0].content?.[0].content?.[0].attrs).toEqual(expect.objectContaining({ colspan, rowspan }));
      expect(() => editor.state.doc.check()).not.toThrow();
      await saveDraft({ name: "Pasted.md", document });
      const recovered = await loadDraft();
      expect(recovered?.document).toEqual(document);
      const restored = new Editor({ element: window.document.createElement("div"), extensions: canvasNodesAndMarks(), content: recovered!.document });
      try {
        expect(restored.state.doc.textContent).toBe(editor.state.doc.textContent);
        expect(() => restored.state.doc.check()).not.toThrow();
      } finally { restored.destroy(); }
    } finally {
      editor.destroy();
      localStorage.clear();
    }
  });

  it("keeps supported heading levels consistent between the live canvas and saved Markdown", () => {
    const content = markdownToDocument("# First level\n\n###### Sixth level\n");
    const editor = new Editor({ element: document.createElement("div"), extensions: canvasNodesAndMarks(), content });
    try {
      expect(editor.view.dom.querySelector("h1")?.textContent).toBe("First level");
      expect(editor.view.dom.querySelector("h6")?.textContent).toBe("Sixth level");
      expect(documentToMarkdown(editor.getJSON())).toBe("# First level\n\n###### Sixth level\n");
      expect(() => editor.state.doc.check()).not.toThrow();
    } finally {
      editor.destroy();
    }
  });

  it("mounts linked inline code and highlighted or unlabelled fenced code", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: canvasNodesAndMarks(),
      content: markdownToDocument("[`code`](https://example.test \"Title\")\n\n```js\nconst value = 1;\n```\n\n```\nplain\n```\n"),
    });
    try {
      expect(editor.view.dom.querySelector("a")?.getAttribute("href")).toBe("https://example.test");
      expect(editor.view.dom.querySelectorAll("pre")).toHaveLength(2);
      expect(() => editor.state.doc.check()).not.toThrow();
    } finally {
      editor.destroy();
    }
  });

  it("keeps code-fence metadata through ordinary typing, recovery and internal rich paste", async () => {
    const meta = 'javascript:literal title="中文 🧪 & <example>" {1,3-5}';
    const source = `\`\`\`javascript ${meta}\nconsole.log("hello");\n\`\`\`\n\nAfter.\n`;
    const editor = new Editor({ element: document.createElement("div"), extensions: canvasNodesAndMarks(), content: markdownToDocument(source) });
    const destination = new Editor({ element: document.createElement("div"), extensions: canvasNodesAndMarks(), editorProps: { transformPastedHTML: sanitizePastedHtml }, content: markdownToDocument("replace me") });
    localStorage.clear();
    try {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.commands.insertContent(" Edited.");
      expect(editor.state.doc.textContent).toContain("After. Edited.");
      expect(documentToMarkdown(editor.getJSON())).toContain(`\`\`\`javascript ${meta}\n`);
      await saveDraft({ name: "Code.md", document: editor.getJSON() });
      expect((await loadDraft())?.document?.content?.[0].attrs?.meta).toBe(meta);
      destination.commands.selectAll();
      expect(destination.view.pasteHTML(editor.getHTML(), new Event("paste") as ClipboardEvent)).toBe(true);
      expect(destination.getJSON().content?.[0].attrs?.meta).toBe(meta);
      expect(documentToMarkdown(destination.getJSON())).toBe(documentToMarkdown(editor.getJSON()));
      expect(() => destination.state.doc.check()).not.toThrow();
    } finally {
      editor.destroy();
      destination.destroy();
      localStorage.clear();
    }
  });

  it("mounts merged, resized table cells and retains their ordinary geometry", () => {
    const paragraph = { type: "paragraph" };
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: canvasNodesAndMarks(),
      content: {
        type: "doc", content: [{ type: "table", content: [
          { type: "tableRow", content: [
            { type: "tableHeader", attrs: { colspan: 2, rowspan: 1, colwidth: [80, 120] }, content: [paragraph] },
          ] },
          { type: "tableRow", content: [
            { type: "tableCell", attrs: { colspan: 1, rowspan: 2, colwidth: [80] }, content: [paragraph] },
            { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [0] }, content: [paragraph] },
          ] },
          { type: "tableRow", content: [
            { type: "tableCell", attrs: { colspan: 1, rowspan: 1, colwidth: [120] }, content: [paragraph] },
          ] },
        ] }],
      },
    });
    try {
      expect(editor.view.dom.querySelector("th")?.getAttribute("colspan")).toBe("2");
      expect(editor.view.dom.querySelector("td")?.getAttribute("rowspan")).toBe("2");
      expect(() => editor.state.doc.check()).not.toThrow();
    } finally {
      editor.destroy();
    }
  });
});
