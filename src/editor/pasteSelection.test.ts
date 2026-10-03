import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, expect, it } from "vitest";
import { BlockFormula, InlineFormula } from "./Formula";
import { insertPastedFormula, insertPastedMarkdown } from "./paste";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

it("keeps existing inline atoms when filling a display delimiter pair by paste", () => {
  const editor = new Editor({
    extensions: [StarterKit, InlineFormula, BlockFormula],
    content: {
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "inlineFormula", attrs: { latex: "a" } },
        { type: "text", text: "$$$$" },
      ] }],
    },
  });
  editors.push(editor);
  editor.commands.setTextSelection(3);
  const before = editor.getJSON();
  const handled = insertPastedFormula(editor.view, "x");
  if (!handled) editor.view.dispatch(editor.state.tr.insertText("x").setMeta("uiEvent", "paste"));
  expect(editor.state.doc.firstChild!.type.name).toBe("paragraph");
  expect(editor.state.doc.firstChild!.firstChild!.type.name).toBe("inlineFormula");
  expect(editor.state.doc.firstChild!.firstChild!.attrs.latex).toBe("a");
  expect(editor.state.doc.textContent).toBe("$x$$$");
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(before);
});

it.each([
  ["code block", "<pre><code>before after</code></pre>"],
  ["inline code", "<p><code>before after</code></p>"],
])("keeps ordinary math paste literal inside %s and restores it on undo", (_context, content) => {
  for (const pasted of ["$x$", "$$x$$", "first $x$\n\nsecond"]) {
    for (const replacing of [false, true]) {
      const editor = new Editor({
        extensions: [StarterKit.configure({ trailingNode: false }), InlineFormula, BlockFormula],
        content,
        editorProps: {
          handlePaste: (view, event) => {
            const text = event.clipboardData?.getData("text/plain") ?? "";
            return insertPastedFormula(view, text) || insertPastedMarkdown(view, text);
          },
        },
      });
      editors.push(editor);
      editor.commands.setTextSelection(replacing ? { from: 1, to: 13 } : 8);
      const before = editor.getJSON();
      const event = new Event("paste") as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", {
        value: { getData: (type: string) => type === "text/plain" ? pasted : "" },
      });
      expect(editor.view.pasteText(pasted, event)).toBe(true);
      expect(editor.getJSON().content?.[0]).toMatchObject({
        type: _context === "code block" ? "codeBlock" : "paragraph",
      });
      expect(editor.getText()).toBe(replacing ? pasted : `before ${pasted}after`);
      expect(JSON.stringify(editor.getJSON())).not.toContain('"inlineFormula"');
      expect(JSON.stringify(editor.getJSON())).not.toContain('"blockFormula"');
      if (_context === "inline code") {
        editor.state.doc.firstChild!.forEach((node) => {
          expect(node.marks.some((mark) => mark.type.name === "code")).toBe(true);
        });
      }
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getText()).toBe(replacing ? pasted : `before ${pasted}after`);
    }
  }
});
