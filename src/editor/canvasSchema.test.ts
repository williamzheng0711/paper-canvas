import { Editor, type JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { canvasNodesAndMarks } from "./canvasSchema";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import { sanitizePastedHtml } from "./paste";
import { loadDraft, saveDraft } from "../lib/files";

describe("shared canvas attribute validation", () => {
  it("keeps spacing created by Enter twice through Source mode and Markdown reopen", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: canvasNodesAndMarks(), content: markdownToDocument("First.") });
    try {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      expect(editor.commands.splitBlock()).toBe(true);
      expect(editor.commands.splitBlock()).toBe(true);
      editor.commands.insertContent("Second.");
      const before = editor.getJSON();
      expect(editor.view.dom.querySelectorAll("p")).toHaveLength(3);
      expect(before.content?.[1]).toEqual({ type: "paragraph" });
      const source = documentToMarkdown(before);
      expect(source).toBe("First.\n\n<p></p>\n\nSecond.\n");
      editor.commands.setContent(markdownToDocument(source));
      expect(editor.getJSON()).toEqual(before);
      expect(editor.view.dom.querySelectorAll("p")).toHaveLength(3);
      expect(markdownToDocument(documentToMarkdown(editor.getJSON()))).toEqual(before);
      expect(() => editor.state.doc.check()).not.toThrow();
    } finally {
      editor.destroy();
    }
  });

  it("keeps two formulas pasted beside each other through Source mode and reopen", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: canvasNodesAndMarks(), content: markdownToDocument("Before after.") });
    try {
      editor.commands.setTextSelection(8);
      editor.commands.insertContent([{ type: "inlineFormula", attrs: { latex: "x" } }, { type: "inlineFormula", attrs: { latex: "y" } }]);
      const before = editor.getJSON();
      expect(before.content?.[0].content?.filter((node) => node.type === "inlineFormula")).toHaveLength(2);
      const source = documentToMarkdown(before);
      editor.commands.setContent(markdownToDocument(source));
      expect(editor.getJSON()).toEqual(before);
      expect(editor.state.doc.textContent).toBe("Before after.");
      expect(() => editor.state.doc.check()).not.toThrow();
    } finally {
      editor.destroy();
    }
  });

  it.each([['width', 300], ['height', 150]] as const)(
    "keeps a pasted image's %s through Source mode and reopen",
    (dimension, size) => {
      const editor = new Editor({ element: document.createElement("div"), extensions: canvasNodesAndMarks(), editorProps: { transformPastedHTML: sanitizePastedHtml }, content: markdownToDocument("replace me") });
      try {
        editor.commands.selectAll();
        expect(editor.view.pasteHTML(`<img src="https://example.com/diagram.png" ${dimension}="${size}" alt="Diagram" title="Caption">`, new Event("paste") as ClipboardEvent)).toBe(true);
        const before = editor.getJSON();
        expect(before.content?.[0].attrs?.[dimension]).toBe(size);
        const source = documentToMarkdown(before);
        editor.commands.setContent(markdownToDocument(source));
        expect(editor.getJSON()).toEqual(before);
        expect(editor.view.dom.querySelector("img")?.style[dimension]).toBe(`${size}px`);
        expect(() => editor.state.doc.check()).not.toThrow();
      } finally {
        editor.destroy();
      }
    },
  );

  it.each([
    'Before $x$ after[^note].\n\n[^note]: Footnote body.',
    '# Before $x$ after[^note].\n\n[^note]: Footnote body.',
    '| Header |\n| --- |\n| Before $a\\|b$ after[^note]. |\n\n[^note]: Footnote body.',
  ])("keeps inline-code formatting on formulas and footnotes after the actual command: %s", (source) => {
    const editor = new Editor({ element: document.createElement("div"), extensions: canvasNodesAndMarks(), content: markdownToDocument(source) });
    try {
      editor.commands.selectAll();
      expect(editor.commands.toggleCode()).toBe(true);
      const before = editor.getJSON();
      const atoms: JSONContent[] = [];
      editor.state.doc.descendants((node) => {
        if (node.type.name === "inlineFormula" || node.type.name === "footnoteReference") atoms.push(node.toJSON());
      });
      expect(atoms).toHaveLength(2);
      expect(atoms.every((atom) => atom.marks?.some((mark) => mark.type === "code"))).toBe(true);
      const saved = documentToMarkdown(before);
      expect(saved).toContain("<code><span data-formula-kind");
      expect(saved).toContain("<code><sup data-footnote-reference");
      editor.commands.setContent(markdownToDocument(saved));
      expect(editor.getJSON()).toEqual(before);
      expect(documentToMarkdown(editor.getJSON())).toBe(saved);
      expect(() => editor.state.doc.check()).not.toThrow();
    } finally {
      editor.destroy();
    }
  });

  it("keeps overlapping formatting around code-marked formula and footnote atoms", () => {
    const editor = new Editor({ element: document.createElement("div"), extensions: canvasNodesAndMarks(), content: markdownToDocument('Before \\(\\text{\\$5}\\) after[^中文].\n\n[^中文]: Footnote body.') });
    try {
      editor.commands.selectAll();
      editor.commands.toggleBold();
      editor.commands.toggleItalic();
      editor.commands.toggleStrike();
      editor.commands.toggleUnderline();
      editor.commands.toggleCode();
      const before = editor.getJSON();
      editor.commands.setContent(markdownToDocument(documentToMarkdown(before)));
      expect(editor.getJSON()).toEqual(before);
      expect(() => editor.state.doc.check()).not.toThrow();
    } finally {
      editor.destroy();
    }
  });

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
