import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { closeHistory } from "@tiptap/pm/history";
import { afterEach, expect, it } from "vitest";
import { QuoteTyping } from "./quoteTyping";
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));
function create() {
  const editor = new Editor({
    extensions: [StarterKit.configure({ trailingNode: false }), QuoteTyping],
    content: "<p></p>",
  });
  editors.push(editor);
  return editor;
}
function write(editor: Editor, text: string) {
  for (const character of text) {
    if (character === "\n") {
      editor.view.someProp("handleKeyDown", (handler) =>
        handler(
          editor.view,
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
      );
      continue;
    }
    const { from, to } = editor.state.selection;
    if (
      !editor.view.someProp("handleTextInput", (handler) =>
        handler(editor.view, from, to, character, () =>
          editor.state.tr.insertText(character, from, to),
        ),
      )
    )
      editor.view.dispatch(editor.state.tr.insertText(character, from, to));
  }
}
it("reuses explicit quote prefixes and exits after an ordinary empty line", () => {
  const editor = create();
  write(editor, "> alpha\n>\n> beta\n\noutside");
  expect(editor.getHTML()).toBe(
    "<blockquote><p>alpha</p><p>beta</p></blockquote><p>outside</p>",
  );
});
it("keeps consecutive explicit prefixes at one quote level", () => {
  const editor = create();
  write(editor, "> alpha\n> beta\n> gamma");
  expect(editor.getHTML()).toBe(
    "<blockquote><p>alpha</p><p>beta</p><p>gamma</p></blockquote>",
  );
});
it("retains intentional nested prefixes and returns to the outer quote", () => {
  const editor = create();
  write(editor, "> alpha\n> > nested\n> > next\n> outer");
  expect(editor.getHTML()).toBe(
    "<blockquote><p>alpha</p><blockquote><p>nested</p><p>next</p></blockquote><p>outer</p></blockquote>",
  );
});
it("allows normal quote continuation without explicit prefixes", () => {
  const editor = create();
  write(editor, "> alpha\nbeta\n\noutside");
  expect(editor.getHTML()).toBe(
    "<blockquote><p>alpha</p><p>beta</p></blockquote><p>outside</p>",
  );
});
it("can undo an immediately consumed quote prefix with Backspace", () => {
  const editor = create();
  write(editor, "> alpha\n> ");
  editor.view.someProp("handleKeyDown", (handler) =>
    handler(
      editor.view,
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    ),
  );
  expect(editor.state.selection.$from.parent.textContent).toBe("> ");
  expect(editor.state.selection.$from.depth).toBe(2);
});
it("does not consume a quote marker in inline code", () => {
  const editor = create();
  editor.commands.setCode();
  write(editor, ">\n");
  expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
  expect(editor.state.doc.firstChild?.textContent).toBe(">");
});

it("accepts an empty quote line with optional trailing space", () => {
  const editor = create();
  write(editor, "> alpha\n> \n> beta\n\noutside");
  expect(editor.getHTML()).toBe(
    "<blockquote><p>alpha</p><p>beta</p></blockquote><p>outside</p>",
  );
});
it("leaves a complete quote prefix in inline code literal", () => {
  const editor = create();
  editor.commands.setCode();
  write(editor, "> ");
  expect(editor.getHTML()).toBe("<p><code>&gt; </code></p>");
});
it("preserves trailing text when inserting a prefix before existing prose", () => {
  const editor = create();
  editor.commands.setContent("<blockquote><p>Existing prose</p></blockquote>");
  editor.commands.setTextSelection(2);
  write(editor, "> ");
  expect(editor.getHTML()).toBe(
    "<blockquote><p>Existing prose</p></blockquote>",
  );
  expect(editor.state.selection.$from.parentOffset).toBe(0);
});
it("preserves nested text across undo and redo", () => {
  const editor = create();
  editor.commands.setContent(
    "<blockquote><p>Existing prose</p><p></p></blockquote>",
  );
  editor.commands.setTextSelection(editor.state.doc.content.size - 2);
  editor.view.dispatch(closeHistory(editor.state.tr));
  const original = editor.getHTML();
  write(editor, "> > ");
  const nested = editor.getHTML();
  expect(nested).toBe(
    "<blockquote><p>Existing prose</p><blockquote><p></p></blockquote></blockquote>",
  );
  editor.commands.undo();
  expect(editor.getHTML()).toBe(original);
  editor.commands.redo();
  expect(editor.getHTML()).toBe(nested);
});
