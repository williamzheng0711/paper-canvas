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

it.each([
  ["*", "italic"],
  ["_", "italic"],
  ["`", "code"],
])("supports closing-first %s delimiters", (delimiter, mark) => {
  const editor = make(`内容${delimiter}`);
  editor.commands.setTextSelection(1);
  type(editor, delimiter);
  expect(editor.getJSON().content?.[0].content).toEqual([
    { type: "text", text: "内容", marks: [{ type: mark }] },
  ]);
  expect(editor.state.selection.from).toBe(1);
});

it.each([
  ["*", "italic"],
  ["_", "italic"],
  ["`", "code"],
])("supports writing inside prewritten %s delimiters", (delimiter, mark) => {
  const editor = make(delimiter.repeat(2));
  editor.commands.setTextSelection(2);
  type(editor, "内容");
  expect(editor.getJSON().content?.[0].content).toEqual([
    { type: "text", text: "内容", marks: [{ type: mark }] },
  ]);
  editor.commands.undo();
  expect(editor.getText()).toBe(delimiter.repeat(2));
  editor.commands.redo();
  expect(editor.getText()).toBe("内容");
});

it("does not turn intra-word underscores into emphasis", () => {
  const editor = make("prefix__value__suffix");
  editor.commands.setTextSelection(10);
  type(editor, "x");
  expect(editor.getJSON().content?.[0].content?.[0].marks).toBeUndefined();
  expect(editor.getText()).toBe("prefix__vxalue__suffix");
});

it.each(["**", "__", "*", "_"])(
  "preserves escaped opening %s delimiters typed sequentially",
  (delimiter) => {
    const editor = make("");
    type(editor, `\\${delimiter}内容${delimiter}`);
    expect(editor.getText()).toBe(`\\${delimiter}内容${delimiter}`);
    expect(editor.getJSON().content?.[0].content?.[0].marks).toBeUndefined();
  },
);

it.each([
  ["**", "bold"],
  ["__", "bold"],
  ["*", "italic"],
  ["_", "italic"],
  ["`", "code"],
])("wraps existing text opening-first with %s", (delimiter, mark) => {
  const editor = make("内容");
  editor.commands.setTextSelection(1);
  type(editor, delimiter);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  type(editor, delimiter);
  expect(editor.getJSON().content?.[0].content).toEqual([
    { type: "text", text: "内容", marks: [{ type: mark }] },
  ]);
  type(editor, "后续");
  expect(editor.getJSON().content?.[0].content?.at(-1)).toEqual({
    type: "text",
    text: "后续",
  });
});

it.each([
  ["**", "bold"],
  ["*", "italic"],
  ["`", "code"],
])("accepts %s formatting next to Chinese punctuation", (delimiter, mark) => {
  const editor = make("说明：");
  editor.commands.setTextSelection(4);
  type(editor, `${delimiter}内容${delimiter}。`);
  expect(editor.getJSON().content?.[0].content).toEqual([
    { type: "text", text: "说明：" },
    { type: "text", text: "内容", marks: [{ type: mark }] },
    { type: "text", text: "。" },
  ]);
});

it("keeps markdown characters literal inside code typed closing-first", () => {
  const editor = make("**literal**`");
  editor.commands.setTextSelection(1);
  type(editor, "`");
  expect(editor.getJSON().content?.[0].content).toEqual([
    { type: "text", text: "**literal**", marks: [{ type: "code" }] },
  ]);
});

it("preserves escaped backticks typed sequentially", () => {
  const editor = make("");
  type(editor, "\\`literal`");
  expect(editor.getText()).toBe("\\`literal`");
  expect(editor.getJSON().content?.[0].content?.[0].marks).toBeUndefined();
});

it.each(["**", "__", "*", "_"])(
  "preserves escaped closing %s delimiters typed sequentially",
  (delimiter) => {
    const editor = make("");
    type(editor, `${delimiter}内容\\${delimiter}`);
    expect(editor.getText()).toBe(`${delimiter}内容\\${delimiter}`);
    expect(editor.getJSON().content?.[0].content?.[0].marks).toBeUndefined();
  },
);
