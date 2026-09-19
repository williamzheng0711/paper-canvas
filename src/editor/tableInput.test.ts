import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  Table,
  TableRow,
  TableCell,
  TableHeader,
} from "@tiptap/extension-table";
import { afterEach, expect, it } from "vitest";
import { MarkdownTyping } from "./markdownTyping";
import { InlineFormula } from "./Formula";
const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((e) => e.destroy()));
it("turns completed pipe rows into a table on a blank line without losing inline content", () => {
  const editor = new Editor({
    extensions: [
      StarterKit,
      Table,
      TableRow,
      TableHeader,
      TableCell,
      InlineFormula,
      MarkdownTyping,
    ],
    content:
      '<p>| Name | Value |</p><p>| --- | --- |</p><p>| <strong>Test</strong> | <span data-formula-kind="inline" data-latex="x^2"></span> |</p><p></p>',
  });
  editors.push(editor);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.keyboardShortcut("Enter");
  expect(editor.getJSON().content?.[0].type).toBe("table");
  expect(editor.getJSON().content?.[0].content).toHaveLength(2);
  expect(JSON.stringify(editor.getJSON())).toContain("inlineFormula");
  expect(JSON.stringify(editor.getJSON())).toContain("bold");
  expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  expect(editor.state.selection.$from.depth).toBe(1);
});
it.each([
  "<p>| a | b |</p><p>| x | y |</p><p></p>",
  "<p>| a | b |</p><p>| --- | --- |</p><p>| one |</p><p></p>",
])("leaves incomplete or ambiguous pipe text untouched", (content) => {
  const editor = new Editor({
    extensions: [
      StarterKit,
      Table,
      TableRow,
      TableHeader,
      TableCell,
      MarkdownTyping,
    ],
    content,
  });
  editors.push(editor);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.keyboardShortcut("Enter");
  expect(editor.getJSON().content?.[0].type).toBe("paragraph");
});
it("ignores pipes in code and restores the typed rows on undo", () => {
  const editor = new Editor({
    extensions: [
      StarterKit,
      Table,
      TableRow,
      TableHeader,
      TableCell,
      MarkdownTyping,
    ],
    content:
      "<p>| Name | Value |</p><p>| --- | --- |</p><p>| <code>a|b</code> | c |</p><p></p>",
  });
  editors.push(editor);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.keyboardShortcut("Enter");
  expect(editor.getJSON().content?.[0].type).toBe("table");
  expect(editor.getText()).toContain("a|b");
  editor.commands.undo();
  expect(editor.getJSON().content?.[0].type).toBe("paragraph");
  editor.commands.redo();
  expect(editor.getJSON().content?.[0].type).toBe("table");
});

it("decodes escaped cell pipes without losing formatting", () => {
  const editor = new Editor({
    extensions: [
      StarterKit,
      Table,
      TableRow,
      TableHeader,
      TableCell,
      MarkdownTyping,
    ],
    content:
      "<p>| Name | Value |</p><p>| --- | --- |</p><p>| <strong>a\\|b</strong> | c |</p><p></p>",
  });
  editors.push(editor);
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.keyboardShortcut("Enter");
  const text =
    editor.state.doc.firstChild?.lastChild?.firstChild?.firstChild?.firstChild;
  expect(text?.text).toBe("a|b");
  expect(text?.marks[0].type.name).toBe("bold");
});

it.each([
  "<p>| A | B \\|</p><p>| --- |</p><p></p>",
  "<p>| A | <code>B |</code></p><p>| --- |</p><p></p>",
  "<p><code>| A</code> | B |</p><p>| --- |</p><p></p>",
])("keeps all row content when an edge pipe is literal", (content) => {
  const editor = new Editor({
    extensions: [
      StarterKit,
      Table,
      TableRow,
      TableHeader,
      TableCell,
      MarkdownTyping,
    ],
    content,
  });
  editors.push(editor);
  const before = editor.getText();
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editor.commands.keyboardShortcut("Enter");
  expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
  expect(editor.getText().trim()).toBe(before.trim());
});
