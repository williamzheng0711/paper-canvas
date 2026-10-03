import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { closeHistory } from "@tiptap/pm/history";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlockFormula,
  InlineFormula,
  focusFormulaSource,
  focusedFormulaSelection,
  flushFormulaSources,
} from "./Formula";

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

describe("formula editing history and selection", () => {
  it("keeps original formula line separators when reading tools flush an untouched textarea", () => {
    const value = "x\r\ny\rz";
    const editor = new Editor({
      extensions: [StarterKit.configure({ trailingNode: false }), BlockFormula],
      content: {
        type: "doc",
        content: [{ type: "blockFormula", attrs: { latex: value } }],
      },
    });
    editors.push(editor);
    const before = editor.getJSON();
    editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
    const source =
      editor.view.dom.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(source.value).toBe("x\ny\nz");
    source.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flushFormulaSources(editor.view);
    source.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    source.dispatchEvent(new FocusEvent("blur"));
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.undo()).toBe(false);
  });

  it.each([
    { flushed: false, value: String.raw`\begin{equation}` },
    { flushed: true, value: String.raw`\begin{equation}` },
    { flushed: false, value: "\\begin{equation}\r\nx\ry" },
    { flushed: true, value: "\\begin{equation}\r\nx\ry" },
  ])(
    "preserves incomplete source and separators when composition cancels (candidate flushed: $flushed, source: $value)",
    ({ flushed, value }) => {
      const editor = new Editor({
        extensions: [
          StarterKit.configure({ trailingNode: false }),
          BlockFormula,
        ],
        content: {
          type: "doc",
          content: [{ type: "blockFormula", attrs: { latex: value } }],
        },
      });
      editors.push(editor);
      const before = editor.getJSON();
      editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
      const source =
        editor.view.dom.querySelector<HTMLTextAreaElement>("textarea")!;
      source.setSelectionRange(value.length, value.length);
      source.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      source.value += "z";
      source.dispatchEvent(
        new InputEvent("input", { bubbles: true, isComposing: true }),
      );
      if (flushed) flushFormulaSources(editor.view);
      source.value = value;
      source.setSelectionRange(value.length, value.length);
      source.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true }),
      );
      // Some engines follow compositionend with an unchanged native input event.
      source.dispatchEvent(new InputEvent("input", { bubbles: true }));
      expect(editor.getJSON()).toEqual(before);
      expect(source.value).toBe(value.replace(/\r\n?/g, "\n"));
    },
  );

  it.each(["Backspace", "Delete"])(
    "removes an empty inline formula immediately with %s before rapid typing",
    (key) => {
      const flush = holdAnimationFrames();
      const editor = new Editor({
        extensions: [StarterKit, InlineFormula],
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Before " },
                { type: "inlineFormula", attrs: { latex: "" } },
                { type: "text", text: " after" },
              ],
            },
          ],
        },
      });
      editors.push(editor);
      const before = editor.getJSON();
      editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
      editor.view.dom.querySelector("textarea")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(editor.getText()).toBe("Before  after");
      const removed = editor.getJSON();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(removed);
      editor.view.dispatch(editor.state.tr.insertText("next"));
      flush();
      expect(editor.getText()).toBe("Before next after");
    },
  );

  it("does not apply an empty block formula deletion to a replacement document", () => {
    const flush = holdAnimationFrames();
    const editor = new Editor({
      extensions: [StarterKit, BlockFormula],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Before ".repeat(30) }],
          },
          { type: "blockFormula", attrs: { latex: "" } },
        ],
      },
    });
    editors.push(editor);
    editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
    editor.view.dom.querySelector("textarea")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(JSON.stringify(editor.getJSON())).not.toContain("blockFormula");
    editor.commands.setContent("<p>Replacement</p>");
    expect(flush).not.toThrow();
    expect(editor.getText()).toBe("Replacement");
  });

  it("updates a focused source field and preview when document undo changes its formula", () => {
    const flush = holdAnimationFrames();
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit, BlockFormula],
      content: {
        type: "doc",
        content: [{ type: "blockFormula", attrs: { latex: "x" } }],
      },
    });
    editors.push(editor);
    editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
    flush();
    const source =
      editor.view.dom.querySelector<HTMLTextAreaElement>("textarea")!;
    source.value = "y";
    source.setSelectionRange(1, 1);
    source.dispatchEvent(new Event("input", { bubbles: true }));
    editor.commands.undo();
    expect(source.value).toBe("x");
    expect(
      editor.view.dom.querySelector(".formula-live-preview")?.textContent,
    ).toContain("x");
  });

  it.each(["inlineFormula", "blockFormula"] as const)(
    "undoes and redoes automatic source completion through keyboard history for %s",
    (type) => {
      const flush = holdAnimationFrames();
      const element = document.createElement("div");
      document.body.append(element);
      const originalLatex = "x\r\n+y\rz";
      const formula = { type, attrs: { latex: originalLatex } };
      const editor = new Editor({
        element,
        extensions: [StarterKit, InlineFormula, BlockFormula],
        // JSDOM has no text geometry for history's scroll-to-selection request.
        editorProps: { handleScrollToSelection: () => true },
        content: { type: "doc", content: type === "inlineFormula"
          ? [{ type: "paragraph", content: [formula, { type: "text", text: " after" }] }]
          : [formula, { type: "paragraph", content: [{ type: "text", text: "after" }] }],
        },
      });
      editors.push(editor);
      const before = editor.getJSON();
      editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
      flush();
      const source = editor.view.dom.querySelector<HTMLTextAreaElement>("textarea")!;
      source.value += "\\begin{matrix}";
      source.setSelectionRange(source.value.length, source.value.length);
      source.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
      const completed = editor.getJSON();
      expect(source.value.endsWith("\\begin{matrix}\\end{matrix}")).toBe(true);

      const shortcut = (key: string, modifiers: KeyboardEventInit) => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
        source.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      };
      shortcut("z", { metaKey: true });
      expect(editor.getJSON()).toEqual(before);
      expect(source.value).toBe("x\n+y\nz");
      shortcut("Z", { metaKey: true, shiftKey: true });
      expect(editor.getJSON()).toEqual(completed);
      expect(source.value.endsWith("\\end{matrix}")).toBe(true);
      shortcut("z", { ctrlKey: true });
      expect(editor.getJSON()).toEqual(before);
      shortcut("y", { ctrlKey: true });
      expect(editor.getJSON()).toEqual(completed);

      source.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      editor.view.dispatch(closeHistory(editor.state.tr));
      editor.commands.insertContent("tail ");
      const afterTyping = editor.getJSON();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(completed);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(completed);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.getJSON()).toEqual(afterTyping);
    },
  );

  it.each(["source flag", "event flag", "legacy key code"])(
    "leaves undo shortcuts to an active composition identified by %s",
    (composition) => {
      const flush = holdAnimationFrames();
      const editor = new Editor({
        extensions: [StarterKit, BlockFormula],
        content: { type: "doc", content: [{ type: "blockFormula", attrs: { latex: "x" } }] },
      });
      editors.push(editor);
      editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
      flush();
      const source = editor.view.dom.querySelector<HTMLTextAreaElement>("textarea")!;
      source.value = "y";
      source.dispatchEvent(new Event("input", { bubbles: true }));
      if (composition === "source flag") source.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      const event = new KeyboardEvent("keydown", {
        key: "z", metaKey: true, bubbles: true, cancelable: true,
        isComposing: composition === "event flag", keyCode: composition === "legacy key code" ? 229 : 0,
      });
      source.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      expect(editor.getJSON().content?.[0].attrs?.latex).toBe("y");
      expect(source.value).toBe("y");
    },
  );
  it("does not redirect typing into an old pending formula after the caret moved elsewhere", () => {
    const flush = holdAnimationFrames();
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>$$$$</p><p>other</p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection(3);
    typeThroughInputRules(editor, "x");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    typeThroughInputRules(editor, "!");
    flush();
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "x" },
    });
    expect(editor.getJSON().content?.[1]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "other!" }],
    });
  });
});

it("restores an exact formula source caret without changing document content", () => {
  const editor = new Editor({
    extensions: [StarterKit, InlineFormula, BlockFormula],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Before " },
            { type: "inlineFormula", attrs: { latex: "x^2 + y" } },
            { type: "text", text: " after" },
          ],
        },
      ],
    },
  });
  editors.push(editor);
  document.body.append(editor.view.dom);
  const before = editor.getJSON();
  expect(focusFormulaSource(editor.view, 8, 2)).toBe(true);
  expect(focusedFormulaSelection(editor.view)).toMatchObject({
    position: 8,
    offset: 2,
  });
  expect(editor.getJSON()).toEqual(before);
  expect(focusFormulaSource(editor.view, 8, 4)).toBe(true);
  expect(focusedFormulaSelection(editor.view)?.offset).toBe(4);
});
