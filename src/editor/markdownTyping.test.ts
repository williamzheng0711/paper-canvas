import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, expect, it } from "vitest";
import { MarkdownTyping } from "./markdownTyping";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));
function make(text: string) {
  const editor = new Editor({
    extensions: [StarterKit, MarkdownTyping],
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: text ? [{ type: "text", text }] : [] },
      ],
    },
  });
  editors.push(editor);
  return editor;
}
function type(editor: Editor, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    if (
      !editor.view.someProp("handleTextInput", (handler) =>
        handler(editor.view, from, to, character, () =>
          editor.state.tr.insertText(character, from, to),
        ),
      )
    ) {
      editor.view.dispatch(editor.state.tr.insertText(character, from, to));
    }
  }
}
it("supports closing-first bold markers and preserves the caret inside the text", () => {
  const editor = make("核心问题**");
  editor.commands.setTextSelection(1);
  type(editor, "**");
  expect(editor.getJSON().content?.[0].content).toEqual([
    { type: "text", marks: [{ type: "bold" }], text: "核心问题" },
  ]);
  expect(editor.state.selection.from).toBe(1);
  type(editor, "新");
  expect(editor.getText()).toBe("新核心问题");
});
it("supports prewritten bold markers with content inserted later", () => {
  const editor = make("****");
  editor.commands.setTextSelection(3);
  type(editor, "重要内容");
  expect(editor.getText()).toBe("重要内容");
  expect(editor.getJSON().content?.[0].content).toEqual([
    { type: "text", text: "重要内容", marks: [{ type: "bold" }] },
  ]);
});
it("does not reinterpret literal code, escaped markers or formula source", () => {
  for (const source of ["\\**literal**", "$x**y**$"]) {
    const editor = make(source);
    editor.commands.setTextSelection(4);
    type(editor, "z");
    expect(editor.getJSON().content?.[0].content?.[0].marks).toBeUndefined();
  }
  const editor = make("****");
  editor.commands.selectAll();
  editor.commands.setCode();
  editor.commands.setTextSelection(3);
  type(editor, "literal");
  expect(editor.getText()).toBe("**literal**");
});
it("undoes normalization together with its insertion", () => {
  const editor = make("****");
  editor.commands.setTextSelection(3);
  type(editor, "a");
  editor.commands.undo();
  expect(editor.getText()).toBe("****");
  editor.commands.redo();
  expect(editor.getText()).toBe("a");
});

it("preserves escaped closing bold markers when the opening pair is typed last", () => {
  const editor = make("text\\**");
  editor.commands.setTextSelection(1);
  type(editor, "**");
  expect(editor.getText()).toBe("**text\\**");
  expect(editor.getJSON().content?.[0].content?.[0].marks).toBeUndefined();
});
