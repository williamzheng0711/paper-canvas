import { Editor } from "@tiptap/core";
import { DOMSerializer } from "@tiptap/pm/model";
import { expect, it } from "vitest";
import { canvasNodesAndMarks } from "./canvasSchema";
import { markdownToDocument } from "./markdown";

it("copies the full source of a preserved unsupported block without throwing", () => {
  const source = '# ![Logo](logo.svg "Logo title") Title';
  const editor = new Editor({
    extensions: canvasNodesAndMarks(),
    content: markdownToDocument(source),
  });
  try {
    expect(editor.state.doc.firstChild!.type.name).toBe("unsupportedMarkdown");
    const container = document.createElement("div");
    expect(() => container.append(DOMSerializer.fromSchema(editor.schema)
      .serializeFragment(editor.state.doc.content))).not.toThrow();
    expect(container.textContent).toBe(source);
    expect(editor.getText()).toBe(source);
    editor.commands.selectAll();
    const copied = editor.view.serializeForClipboard(editor.state.selection.content());
    expect(copied.text).toBe(source);
    expect(copied.dom.textContent).toBe(source);
  } finally { editor.destroy(); }
});

it("serializes preserved source as inert text and retains its exact clipboard bytes", () => {
  const source = '# Title\r\n<script>alert("copied")</script>\r\n中文 🧪';
  const editor = new Editor({
    extensions: canvasNodesAndMarks(),
    content: { type: "doc", content: [{ type: "unsupportedMarkdown", attrs: { source } }] },
  });
  try {
    editor.commands.selectAll();
    const copied = editor.view.serializeForClipboard(editor.state.selection.content());
    expect(copied.text).toBe(source);
    expect(copied.dom.textContent).toBe(source);
    expect(copied.dom.querySelector("script")).toBeNull();
  } finally { editor.destroy(); }
});
