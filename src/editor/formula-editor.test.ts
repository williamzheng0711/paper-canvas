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

function holdAnimationFrames(): () => void {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  return () => {
    while (frames.length > 0) frames.shift()?.(0);
  };
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

  it("lets the block rule win when both formula extensions receive sequential $$ input", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    editors.push(editor);

    typeThroughInputRules(editor, "$$f(x)$$");

    const formulas = editor
      .getJSON()
      .content?.filter((node) => node.type === "blockFormula");
    expect(formulas).toEqual([
      expect.objectContaining({
        attrs: expect.objectContaining({ latex: "f(x)" }),
      }),
    ]);
    expect(JSON.stringify(editor.getJSON())).not.toContain("inlineFormula");
  });

  it("normalizes content inserted between four existing dollar signs", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>$$$$</p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection(3);

    editor.commands.insertContent("f(x)");

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "f(x)" },
    });
  });

  it("keeps rapid follow-up typing inside a pre-delimited formula source", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>$$$$</p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection(3);

    editor.commands.insertContent("f");
    while (frames.length > 0) frames.shift()?.(0);

    const source = editor.view.dom.querySelector<HTMLTextAreaElement>(
      ".formula-editor__textarea",
    );
    expect(source).not.toBeNull();
    expect(source?.selectionStart).toBe(1);

    source!.value = "f(x)";
    source!.setSelectionRange(4, 4);
    source!.dispatchEvent(new Event("input", { bubbles: true }));

    expect(editor.getJSON().content?.[0].attrs?.latex).toBe("f(x)");
  });

  it("keeps every rapid physical keystroke between prewritten display delimiters", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>$$$$</p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection(3);

    typeThroughInputRules(editor, "\\theta");
    while (frames.length > 0) frames.shift()?.(0);

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "\\theta" },
    });
    expect(JSON.stringify(editor.getJSON())).not.toContain('"text":"theta"');
  });

  it("keeps a multi-character composition commit inside a pending formula", () => {
    const flushFrames = holdAnimationFrames();
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>$$$$</p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection(3);
    typeThroughInputRules(editor, "\\");

    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, "theta+θ", () =>
        editor.state.tr.insertText("theta+θ", from, to),
      ),
    );
    flushFrames();

    expect(handled).toBe(true);
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "\\theta+θ" },
    });
  });

  it("replaces a selected display source without leaking rapid follow-up keys", () => {
    const flushFrames = holdAnimationFrames();
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>$$old$$</p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection({ from: 3, to: 6 });

    typeThroughInputRules(editor, "\\theta");
    flushFrames();

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "\\theta" },
    });
    expect(editor.getText()).not.toContain("old");
  });

  it("supports both sequential and prewritten bracket display delimiters", () => {
    const sequential = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p></p>",
    });
    editors.push(sequential);
    typeThroughInputRules(sequential, "\\[\\theta\\]");
    expect(sequential.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "\\theta" },
    });

    const flushFrames = holdAnimationFrames();
    const prewritten = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>\\[\\]</p>",
    });
    editors.push(prewritten);
    prewritten.commands.setTextSelection(3);
    typeThroughInputRules(prewritten, "\\theta");
    flushFrames();
    expect(prewritten.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "\\theta" },
    });
  });

  it("supports content inserted between prewritten inline delimiters", () => {
    const flushFrames = holdAnimationFrames();
    const dollar = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>Before $$ after</p>",
    });
    editors.push(dollar);
    dollar.commands.setTextSelection(9);
    typeThroughInputRules(dollar, "x^2");

    const parenthesized = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>Before \\(\\) after</p>",
    });
    editors.push(parenthesized);
    parenthesized.commands.setTextSelection(10);
    typeThroughInputRules(parenthesized, "\\theta");
    flushFrames();

    expect(dollar.getJSON().content?.[0].content?.[1]).toMatchObject({
      type: "inlineFormula",
      attrs: { latex: "x^2" },
    });
    expect(parenthesized.getJSON().content?.[0].content?.[1]).toMatchObject({
      type: "inlineFormula",
      attrs: { latex: "\\theta" },
    });
  });

  it("supports sequential parenthesized inline delimiters", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>Before </p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection(8);

    typeThroughInputRules(editor, "\\(x^2\\) after");

    expect(editor.getJSON().content?.[0].content?.[1]).toMatchObject({
      type: "inlineFormula",
      attrs: { latex: "x^2" },
    });
  });

  it("keeps formula-like delimiters literal inside inline code", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", marks: [{ type: "code" }], text: "$$$$" },
            ],
          },
        ],
      },
    });
    editors.push(editor);
    editor.commands.setTextSelection(3);

    typeThroughInputRules(editor, "\\theta");

    expect(editor.getText()).toBe("$$\\theta$$");
    expect(JSON.stringify(editor.getJSON())).not.toContain("Formula");
  });

  it("undoes and redoes delimiter normalization as one document change", () => {
    const flushFrames = holdAnimationFrames();
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>$$$$</p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection(3);

    editor.commands.insertContent("θ");
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "θ" },
    });
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getText()).toBe("$$$$");
    expect(editor.commands.redo()).toBe(true);
    flushFrames();
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "θ" },
    });
  });

  it("starts a supported standalone environment as an editable block formula", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: { type: "doc", content: [{ type: "paragraph" }] },
    });
    editors.push(editor);

    typeThroughInputRules(editor, "\\begin{equation}");

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: {
        latex: "\\begin{equation}\\end{equation}",
        autoEdit: true,
        sourceCaret: "\\begin{equation}".length,
      },
    });
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

  it("does not insert an environment close command during IME composition", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const editor = new Editor({
      extensions: [StarterKit, BlockFormula],
      content: {
        type: "doc",
        content: [{ type: "blockFormula", attrs: { latex: "" } }],
      },
    });
    editors.push(editor);
    editor.view.dom.querySelector<HTMLElement>(".formula-render")?.click();
    const source = editor.view.dom.querySelector<HTMLTextAreaElement>(
      ".formula-editor__textarea",
    )!;

    source.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    source.value = "\\begin{equation}";
    source.setSelectionRange(source.value.length, source.value.length);
    source.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );

    const escapeDuringComposition = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      isComposing: true,
      cancelable: true,
    });
    source.dispatchEvent(escapeDuringComposition);
    expect(escapeDuringComposition.defaultPrevented).toBe(false);
    expect(editor.view.dom.querySelector(".formula-editor__textarea")).toBe(
      source,
    );

    expect(source.value).toBe("\\begin{equation}");
    expect(editor.getJSON().content?.[0].attrs?.latex).toBe("");

    source.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    expect(source.value).toBe("\\begin{equation}\\end{equation}");
    expect(editor.getJSON().content?.[0].attrs?.latex).toBe(
      "\\begin{equation}\\end{equation}",
    );
  });

  it("commits unfinished IME text on blur without adding an environment close", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const editor = new Editor({
      extensions: [StarterKit, BlockFormula],
      content: {
        type: "doc",
        content: [{ type: "blockFormula", attrs: { latex: "" } }],
      },
    });
    editors.push(editor);
    editor.view.dom.querySelector<HTMLElement>(".formula-render")?.click();
    const source = editor.view.dom.querySelector<HTMLTextAreaElement>(
      ".formula-editor__textarea",
    )!;

    source.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    source.value = "\\begin{equation}";
    source.setSelectionRange(source.value.length, source.value.length);
    source.dispatchEvent(
      new InputEvent("input", { bubbles: true, isComposing: true }),
    );
    source.dispatchEvent(new FocusEvent("blur"));

    expect(editor.getJSON().content?.[0].attrs?.latex).toBe(
      "\\begin{equation}",
    );
    expect(
      editor.view.dom.querySelector(".formula-editor__textarea"),
    ).toBeNull();
  });
});
