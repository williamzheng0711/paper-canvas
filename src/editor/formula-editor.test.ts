import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockFormula, InlineFormula } from "./Formula";

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  vi.unstubAllGlobals();
});

function typeThroughInputRules(editor: Editor, text: string): void {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, character, () =>
        editor.state.tr.insertText(character, from, to),
      ),
    );
    if (!handled) editor.commands.insertContent(character);
  }
}

describe("inline formula input rule", () => {
  it("replaces completed dollar-delimited input with a visual formula node", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    editors.push(editor);

    typeThroughInputRules(editor, "中文 $x^2 + 1$ 文字");

    const json = editor.getJSON();
    expect(JSON.stringify(json)).toContain("inlineFormula");
    expect(JSON.stringify(json)).toContain('"latex":"x^2 + 1"');
    expect(JSON.stringify(json)).not.toContain("$x^2 + 1$");
  });

  it("keeps incomplete display delimiters as text, then atomically replaces a completed line", () => {
    const editor = new Editor({
      extensions: [StarterKit, BlockFormula],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    editors.push(editor);

    typeThroughInputRules(editor, "$$1+1=2");

    expect(JSON.stringify(editor.getJSON())).not.toContain("blockFormula");
    expect(editor.getText()).toBe("$$1+1=2");

    typeThroughInputRules(editor, "$$");

    const json = editor.getJSON();
    const formulas =
      json.content?.filter((node) => node.type === "blockFormula") ?? [];
    expect(formulas).toHaveLength(1);
    expect(formulas[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "1+1=2" },
    });
    expect(JSON.stringify(json)).not.toContain("$$1+1=2$$");
  });

  it("pairs a raw inline LaTeX environment and leaves the caret inside it", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    editors.push(editor);

    typeThroughInputRules(editor, "$\\begin{equation}");

    expect(editor.getText()).toBe("$\\begin{equation}\\end{equation}");
    expect(editor.state.selection.from).toBe("$\\begin{equation}".length + 1);
  });

  it("opens a source-and-preview panel on click and updates both in real time", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const editor = new Editor({
      extensions: [StarterKit, BlockFormula],
      content: {
        type: "doc",
        content: [{ type: "blockFormula", attrs: { latex: "x^2" } }],
      },
    });
    editors.push(editor);

    editor.view.dom.querySelector<HTMLElement>(".formula-render")?.click();

    const source = editor.view.dom.querySelector<HTMLTextAreaElement>(
      ".formula-editor__textarea",
    );
    expect(source?.value).toBe("x^2");
    expect(
      editor.view.dom.querySelector(".formula-live-preview .katex"),
    ).not.toBeNull();

    source!.value = "\\frac{a}{b}";
    source!.setSelectionRange(source!.value.length, source!.value.length);
    source!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(editor.getJSON().content?.[0].attrs?.latex).toBe("\\frac{a}{b}");
    expect(
      editor.view.dom.querySelector(".formula-live-preview .mfrac"),
    ).not.toBeNull();

    editor.view.dom
      .querySelector<HTMLButtonElement>(".formula-editor__done")
      ?.click();
    expect(
      editor.view.dom.querySelector(".formula-editor__textarea"),
    ).toBeNull();
    expect(
      editor.view.dom.querySelector(".formula-render .mfrac"),
    ).not.toBeNull();
  });
});
