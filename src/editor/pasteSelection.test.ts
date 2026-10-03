import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, expect, it } from "vitest";
import { BlockFormula, InlineFormula } from "./Formula";
import { insertPastedFormula } from "./paste";

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
