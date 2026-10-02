import { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { canvasNodesAndMarks } from "./canvasSchema";

describe("bounded code highlighting", () => {
  it.each(["js", null, "unknown-language"])(
    "keeps a large adversarial code block editable without token decoration expansion (%s)",
    (language) => {
      const source = "`".repeat(500_000);
      const content = {
        type: "doc",
        content: [
          {
            type: "codeBlock",
            attrs: { language },
            content: [{ type: "text", text: source }],
          },
        ],
      };
      const editor = new Editor({
        element: document.createElement("div"),
        extensions: canvasNodesAndMarks(),
        content,
      });
      try {
        expect(editor.state.doc.textContent).toBe(source);
        expect(editor.getJSON().content?.[0].attrs?.language).toBe(language);
        expect(editor.view.dom.querySelector("code")?.textContent).toBe(source);
        expect(editor.view.dom.querySelectorAll("code *")).toHaveLength(0);
        const before = editor.getJSON();
        editor.view.dispatch(
          editor.state.tr
            .setSelection(TextSelection.create(editor.state.doc, 2))
            .insertText("changed"),
        );
        expect(editor.state.doc.textContent).toBe("`changed" + source.slice(1));
        expect(editor.view.dom.querySelector("code")?.textContent).toBe(
          editor.state.doc.textContent,
        );
        expect(editor.view.dom.querySelectorAll("code *")).toHaveLength(0);
        expect(undo(editor.state, editor.view.dispatch)).toBe(true);
        expect(editor.getJSON()).toEqual(before);
        editor.state.doc.check();
      } finally {
        editor.destroy();
      }
    },
  );

  it("highlights ordinary code and resumes highlighting after a large block is reduced", () => {
    const source = "`".repeat(20_001);
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: canvasNodesAndMarks(),
      content: {
        type: "doc",
        content: [
          {
            type: "codeBlock",
            attrs: { language: "js" },
            content: [{ type: "text", text: source }],
          },
        ],
      },
    });
    try {
      expect(editor.view.dom.querySelectorAll("code *")).toHaveLength(0);
      const ordinaryCode = "const value = 42;";
      editor.view.dispatch(
        editor.state.tr
          .setSelection(
            TextSelection.create(editor.state.doc, 1, source.length + 1),
          )
          .insertText(ordinaryCode),
      );
      expect(editor.view.dom.querySelector(".hljs-keyword")?.textContent).toBe(
        "const",
      );
      expect(editor.view.dom.querySelector(".hljs-number")?.textContent).toBe(
        "42",
      );
      expect(editor.state.doc.textContent).toBe(ordinaryCode);
      expect(undo(editor.state, editor.view.dispatch)).toBe(true);
      expect(editor.view.dom.querySelectorAll("code *")).toHaveLength(0);
      expect(editor.state.doc.textContent).toBe(source);
    } finally {
      editor.destroy();
    }
  });
});
