import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, expect, it } from "vitest";
import { IndentedListInput } from "./indentedListInput";
import { documentToMarkdown, markdownToDocument } from "./markdown";
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));
function write(editor: Editor, text: string) {
  for (const character of text) {
    if (character === "\n") {
      editor.commands.keyboardShortcut("Enter");
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
it("keeps indented items nested when typed with blank lines between them", () => {
  const editor = new Editor({
    extensions: [StarterKit, IndentedListInput],
    content: "<p></p>",
  });
  editors.push(editor);
  const source =
    "1. First\n\n2. Second\n\n   * Inner A\n\n   * Inner B\n\n   * Inner C\n\n3. Third";
  write(editor, source);
  expect(markdownToDocument(documentToMarkdown(editor.getJSON()))).toEqual(
    markdownToDocument(source),
  );
});

it.each([
  "- Parent\n\n  - First\n\n  - Second",
  "- Parent\n\n  - Child\n\n    - Grandchild",
  "- Parent\n\n  - Child\n\n    - Grandchild\n\n  - Sibling",
  "1. Parent\n\n   - Child\n\n     1. Grandchild\n\n     2. Next\n\n   - Sibling",
  "- Parent\n\n  1. First\n\n  2. Second",
  "1. Parent\n\n   - First\n\n   - Second",
])("preserves nested list structure for %s", (source) => {
  const editor = new Editor({
    extensions: [StarterKit, IndentedListInput],
    content: "<p></p>",
  });
  editors.push(editor);
  write(editor, source);
  expect(markdownToDocument(documentToMarkdown(editor.getJSON()))).toEqual(
    markdownToDocument(source),
  );
});

it("leaves a prefix inside inline code unchanged", () => {
  const editor = new Editor({
    extensions: [StarterKit, IndentedListInput],
    content: "<ul><li><p>Parent</p></li></ul><p></p>",
  });
  editors.push(editor);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.setCode();
  write(editor, "  - ");
  expect(editor.state.doc.lastChild?.textContent).toBe("  - ");
  expect(editor.state.doc.childCount).toBe(2);
});

it("consumes a matching number in the next item already created by Enter", () => {
  const editor = new Editor({
    extensions: [StarterKit, IndentedListInput],
    content:
      "<ol><li><p>First</p></li><li><p>Second</p><ul><li><p>Inner</p></li></ul></li><li><p></p></li></ol>",
  });
  editors.push(editor);
  editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 3);
  write(editor, "3. Third");
  expect(editor.state.doc.firstChild?.lastChild?.textContent).toBe("Third");
});

it("restores the preceding list when a deeper indentation is undone", () => {
  const editor = new Editor({
    extensions: [StarterKit, IndentedListInput],
    content:
      "<ul><li><p>Parent</p><ul><li><p>Child</p></li></ul></li></ul><p></p>",
  });
  editors.push(editor);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  const original = editor.getJSON();
  write(editor, "    - ");
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(original);
  editor.commands.redo();
  expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  expect(editor.state.selection.$from.depth).toBe(7);
});
