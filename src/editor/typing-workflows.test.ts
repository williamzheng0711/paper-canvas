import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineFormula, BlockFormula } from "./Formula";
import { MarkdownTyping } from "./markdownTyping";

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((e) => e.destroy());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function make(content = "<p></p>") {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit, InlineFormula, BlockFormula, MarkdownTyping],
    content,
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
    )
      editor.view.dispatch(editor.state.tr.insertText(character, from, to));
  }
}
function frames() {
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  return () => {
    while (callbacks.length) callbacks.shift()!(0);
  };
}
describe("nonsequential formula entry", () => {
  it("opens multiline math on Enter after an opening delimiter", () => {
    frames();
    const editor = make();
    type(editor, "$$");
    editor.commands.keyboardShortcut("Enter");
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "", autoEdit: true },
    });
  });
  it("preserves adjacent formulas when filling a later inline pair", () => {
    frames();
    const editor = make();
    type(editor, "$x$ and $$");
    editor.commands.setTextSelection(editor.state.selection.from - 1);
    type(editor, "y");
    expect(editor.getJSON().content?.[0].content).toEqual([
      expect.objectContaining({
        type: "inlineFormula",
        attrs: expect.objectContaining({ latex: "x" }),
      }),
      { type: "text", text: " and " },
      expect.objectContaining({
        type: "inlineFormula",
        attrs: expect.objectContaining({ latex: "y" }),
      }),
    ]);
  });
  it("preserves escaped currency delimiters", () => {
    const editor = make();
    type(editor, String.raw`price \$5 and \$10`);
    expect(editor.getJSON().content?.[0].content).toEqual([
      { type: "text", text: String.raw`price \$5 and \$10` },
    ]);
  });
  it("supports delimiter-first formulas in headings", () => {
    frames();
    const editor = make("<h2>Value $$</h2>");
    editor.commands.setTextSelection(8);
    type(editor, "x");
    expect(editor.getJSON().content?.[0].content?.[1]).toMatchObject({
      type: "inlineFormula",
      attrs: { latex: "x" },
    });
  });
  it.each([
    String.raw`\frac{a_i}{b_j}`,
    String.raw`\mathbb{E}[\|X\|^2]`,
    String.raw`\{W_i\}_{i=1}^n`,
    String.raw`\sum_i x_i\,4^{-b_i}`,
  ])("types complex source without applying prose marks: %s", (latex) => {
    const editor = make();
    type(editor, `$${latex}$`);
    expect(editor.getJSON().content?.[0].content).toEqual([
      expect.objectContaining({
        type: "inlineFormula",
        attrs: expect.objectContaining({ latex }),
      }),
    ]);
  });
});
describe("formula source boundaries", () => {
  function setup() {
    const flush = frames();
    const editor = make('<div data-formula-kind="block" data-latex="x"></div>');
    editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
    flush();
    return {
      editor,
      source: editor.view.dom.querySelector<HTMLTextAreaElement>("textarea")!,
      flush,
    };
  }
  it("closes a multiline source with a separately typed delimiter", () => {
    const { editor, source } = setup();
    source.value = "x^2\n$$";
    source.setSelectionRange(6, 6);
    source.dispatchEvent(new Event("input", { bubbles: true }));
    type(editor, "next");
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "x^2" },
    });
    expect(editor.getJSON().content?.[1]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "next" }],
    });
  });
  it.each(["ArrowLeft", "ArrowRight", "Escape"])(
    "resumes prose at a valid caret after %s",
    (key) => {
      const { editor, source } = setup();
      source.setSelectionRange(
        key === "ArrowLeft" ? 0 : 1,
        key === "ArrowLeft" ? 0 : 1,
      );
      source.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
      type(editor, "next");
      expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
      expect(
        editor.getJSON().content?.filter((n) => n.type === "blockFormula"),
      ).toHaveLength(1);
    },
  );
  it("does not close during composition", () => {
    const { editor, source } = setup();
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    source.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(editor.view.dom.querySelector("textarea")).toBe(source);
  });
});
it("does not replace a paragraph containing another formula with a display atom", () => {
  frames();
  const editor = make();
  type(editor, "$a$");
  type(editor, "$$b$$");
  expect(editor.getJSON().content?.[0].type).toBe("paragraph");
  expect(editor.getJSON().content?.[0].content?.[0]).toMatchObject({
    type: "inlineFormula",
    attrs: { latex: "a" },
  });
});
it("preserves the surrounding bold mark when creating an inline formula", () => {
  const editor = make("<p><strong>value </strong></p>");
  editor.commands.setTextSelection(7);
  type(editor, "$x$");
  expect(editor.getJSON().content?.[0].content?.[1]).toMatchObject({
    type: "inlineFormula",
    marks: [{ type: "bold" }],
  });
});
