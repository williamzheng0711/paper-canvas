import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockFormula, InlineFormula } from "./Formula";
import {
  FootnoteDefinition,
  FootnoteReference,
  footnoteNumbers,
} from "./Footnote";

const editors: Editor[] = [];
const reference = (identifier: string, label = identifier): JSONContent => ({
  type: "footnoteReference",
  attrs: { identifier, label },
});
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const definition = (identifier: string, text: string): JSONContent => ({
  type: "footnoteDefinition",
  attrs: { identifier, label: identifier },
  content: [paragraph(text)],
});

function createEditor(content: JSONContent[]): {
  editor: Editor;
  viewport: HTMLElement;
} {
  const viewport = document.createElement("section");
  viewport.className = "canvas-area";
  viewport.scrollTo = vi.fn();
  const host = document.createElement("article");
  viewport.append(host);
  document.body.append(viewport);
  const editor = new Editor({
    element: host,
    extensions: [
      StarterKit.configure({
        trailingNode: { notAfter: ["footnoteDefinition"] },
      }),
      FootnoteReference,
      FootnoteDefinition,
      InlineFormula,
      BlockFormula,
    ],
    content: { type: "doc", content },
  });
  editors.push(editor);
  return { editor, viewport };
}

function referencePositions(editor: Editor): number[] {
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "footnoteReference") positions.push(pos);
  });
  return positions;
}

describe("editable footnotes", () => {
  afterEach(() => {
    editors.forEach((editor) => editor.destroy());
    editors.length = 0;
    document.body.replaceChildren();
  });

  it("numbers by first appearance, matching repeated labels without adding computed source attributes", () => {
    const { editor } = createEditor([
      {
        type: "paragraph",
        content: [
          reference("SECOND", "Second"),
          reference("first"),
          reference("second"),
        ],
      },
      definition("first", "First definition."),
      definition("second", "Second definition."),
    ]);
    expect([...footnoteNumbers(editor.state.doc)]).toEqual([
      ["second", 1],
      ["first", 2],
    ]);
    expect(
      [...editor.view.dom.querySelectorAll(".footnote-reference-link")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["1", "2", "1"]);
    expect(
      [...editor.view.dom.querySelectorAll(".footnote-backlink")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["2 ↩", "1 ↩"]);
    expect(
      (editor.getJSON() as JSONContent).content?.[0].content?.[0].attrs,
    ).toEqual({ identifier: "SECOND", label: "Second" });
    expect(editor.view.dom.textContent).not.toContain("unsupported");
    editor.state.doc.check();
  });

  it("recomputes numbers when references are inserted and removed, retaining editable definition content", () => {
    const { editor } = createEditor([
      {
        type: "paragraph",
        content: [
          reference("a"),
          { type: "text", text: " body " },
          reference("b"),
        ],
      },
      definition("a", "Alpha."),
      definition("b", "Beta."),
    ]);
    editor.commands.insertContentAt(1, reference("b"));
    expect(
      [...editor.view.dom.querySelectorAll(".footnote-reference-link")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["1", "2", "1"]);
    expect(
      [...editor.view.dom.querySelectorAll(".footnote-backlink")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["2 ↩", "1 ↩"]);
    editor.commands.deleteRange({ from: 1, to: 2 });
    expect(
      [...editor.view.dom.querySelectorAll(".footnote-backlink")].map(
        (node) => node.textContent,
      ),
    ).toEqual(["1 ↩", "2 ↩"]);
    const marker = editor.view.dom.querySelector<HTMLButtonElement>(
      ".footnote-reference-link",
    )!;
    marker.click();
    expect(editor.state.selection.$from.node(-1).type.name).toBe(
      "footnoteDefinition",
    );
    editor.commands.insertContent("Edited ");
    expect(
      editor.view.dom.querySelector(".footnote-content")?.textContent,
    ).toBe("Edited Alpha.");
    expect(
      (editor.getJSON() as JSONContent).content?.[1].content?.[0].content?.[0]
        .text,
    ).toBe("Edited Alpha.");
  });

  it("clicks and keyboard activation move within the editor, and the backlink returns to the activated repeated reference", () => {
    const { editor, viewport } = createEditor([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "First " },
          reference("reading"),
          { type: "text", text: " and repeated " },
          reference("reading"),
        ],
      },
      definition("reading", "A note."),
    ]);
    const snapshot = editor.getJSON();
    const hash = window.location.hash;
    const positions = referencePositions(editor);
    const buttons = editor.view.dom.querySelectorAll<HTMLButtonElement>(
      ".footnote-reference-link",
    );
    buttons[1].dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editor.state.selection.$from.node(-1).type.name).toBe(
      "footnoteDefinition",
    );
    expect(viewport.scrollTo).toHaveBeenCalledOnce();
    const backlink =
      editor.view.dom.querySelector<HTMLButtonElement>(".footnote-backlink")!;
    backlink.click();
    expect(editor.state.selection.from).toBe(positions[1] + 1);
    expect(viewport.scrollTo).toHaveBeenCalledTimes(2);
    buttons[0].click();
    backlink.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: " ",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editor.state.selection.from).toBe(positions[0] + 1);
    expect(editor.getJSON()).toEqual(snapshot);
    expect(window.location.hash).toBe(hash);
  });

  it("keeps the last reference backlink accurate after editing content before it", () => {
    const { editor } = createEditor([
      {
        type: "paragraph",
        content: [
          reference("note"),
          { type: "text", text: " later " },
          reference("note"),
        ],
      },
      definition("note", "Body."),
    ]);
    editor.view.dom
      .querySelectorAll<HTMLButtonElement>(".footnote-reference-link")[1]
      .click();
    editor.commands.insertContentAt(1, "New lead ");
    const expected = referencePositions(editor)[1] + 1;
    editor.view.dom
      .querySelector<HTMLButtonElement>(".footnote-backlink")!
      .click();
    expect(editor.state.selection.from).toBe(expected);
  });

  it("falls back to the surviving first reference when the last activated reference is deleted", () => {
    const { editor } = createEditor([
      {
        type: "paragraph",
        content: [
          reference("note"),
          { type: "text", text: " later " },
          reference("note"),
        ],
      },
      definition("note", "Body."),
    ]);
    editor.view.dom
      .querySelectorAll<HTMLButtonElement>(".footnote-reference-link")[1]
      .click();
    const last = referencePositions(editor)[1];
    editor.commands.deleteRange({ from: last, to: last + 1 });
    editor.view.dom
      .querySelector<HTMLButtonElement>(".footnote-backlink")!
      .click();
    expect(editor.state.selection.from).toBe(referencePositions(editor)[0] + 1);
  });

  it("accepts nested lists, multiple paragraphs, formulas and code as editable definition content", () => {
    const { editor } = createEditor([
      { type: "paragraph", content: [reference("calculation")] },
      {
        type: "footnoteDefinition",
        attrs: { identifier: "calculation", label: "Calculation" },
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "For " },
              { type: "inlineFormula", attrs: { latex: "x^2" } },
            ],
          },
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [paragraph("Nested detail.")] },
            ],
          },
          { type: "blockFormula", attrs: { latex: "a+b=c" } },
          {
            type: "codeBlock",
            attrs: { language: "text" },
            content: [{ type: "text", text: "[^literal]" }],
          },
          paragraph("Another paragraph."),
        ],
      },
    ]);
    editor.state.doc.check();
    const content = editor.view.dom.querySelector(".footnote-content")!;
    expect(content.querySelector("ul li")?.textContent).toBe("Nested detail.");
    expect(content.querySelector("pre code")?.textContent).toBe("[^literal]");
    expect(content.querySelectorAll(".katex")).toHaveLength(2);
    editor.view.dom
      .querySelector<HTMLButtonElement>(".footnote-reference-link")!
      .click();
    editor.commands.insertContent("Edited ");
    expect(
      (editor.getJSON() as JSONContent).content?.[1].content?.[0].content?.[0]
        .text,
    ).toBe("Edited For ");
  });

  it("matches whitespace and casing without changing labels or relying on unsafe CSS selectors", () => {
    const identifier = 'Read "[this]"   Note';
    const { editor } = createEditor([
      { type: "paragraph", content: [reference(identifier)] },
      definition('read "[this]" note', "Exact source survives."),
    ]);
    editor.view.dom
      .querySelector<HTMLButtonElement>(".footnote-reference-link")!
      .click();
    expect(editor.state.selection.$from.node(-1).type.name).toBe(
      "footnoteDefinition",
    );
    expect(
      (editor.getJSON() as JSONContent).content?.[0].content?.[0].attrs
        ?.identifier,
    ).toBe(identifier);
  });

  it("keeps orphaned references visible and inert instead of navigating or throwing", () => {
    const { editor, viewport } = createEditor([
      { type: "paragraph", content: [reference("missing")] },
      definition("unreferenced", "Unused note."),
    ]);
    const referenceButton = editor.view.dom.querySelector<HTMLButtonElement>(
      ".footnote-reference-link",
    )!;
    const backlink =
      editor.view.dom.querySelector<HTMLButtonElement>(".footnote-backlink")!;
    const snapshot = editor.getJSON();
    const selection = editor.state.selection;
    expect(referenceButton.textContent).toBe("1");
    expect(referenceButton.getAttribute("aria-disabled")).toBe("true");
    expect(backlink.getAttribute("aria-disabled")).toBe("true");
    referenceButton.click();
    backlink.click();
    expect(editor.state.selection).toBe(selection);
    expect(editor.getJSON()).toEqual(snapshot);
    expect(viewport.scrollTo).not.toHaveBeenCalled();
  });

  it("retains IDs, labels and definition blocks when copying rendered HTML back into an editor", () => {
    const { editor } = createEditor([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Note " },
          reference("reading", "Reading"),
        ],
      },
      {
        ...definition("reading", "First paragraph."),
        content: [
          paragraph("First paragraph."),
          paragraph("Second paragraph."),
        ],
      },
    ]);
    const snapshot = editor.getJSON();
    const { editor: pasted } = createEditor([]);
    pasted.commands.setContent(editor.getHTML());
    expect(pasted.getJSON()).toEqual(snapshot);
  });

  it("places the caret in editable text when a definition starts with a block formula", () => {
    const { editor } = createEditor([
      { type: "paragraph", content: [reference("calculation")] },
      {
        type: "footnoteDefinition",
        attrs: { identifier: "calculation", label: "Calculation" },
        content: [
          { type: "blockFormula", attrs: { latex: "x^2+y^2=1" } },
          paragraph("Explanation."),
        ],
      },
    ]);
    const originalFormula = (editor.getJSON() as JSONContent).content?.[1]
      .content?.[0];
    editor.view.dom
      .querySelector<HTMLButtonElement>(".footnote-reference-link")!
      .click();
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    editor.commands.insertContent("Added ");
    const content = (editor.getJSON() as JSONContent).content?.[1].content;
    expect(content?.[0]).toEqual(originalFormula);
    expect(content?.[1].content?.[0].text).toBe("Added Explanation.");
  });

  it("scrolls to an atom-only note without selecting a formula that typing would replace", () => {
    const { editor, viewport } = createEditor([
      { type: "paragraph", content: [reference("equation")] },
      {
        type: "footnoteDefinition",
        attrs: { identifier: "equation", label: "Equation" },
        content: [{ type: "blockFormula", attrs: { latex: "e^{i\\pi}+1=0" } }],
      },
    ]);
    const snapshot = editor.getJSON();
    const selection = editor.state.selection;
    editor.view.dom
      .querySelector<HTMLButtonElement>(".footnote-reference-link")!
      .click();
    expect(editor.state.selection).toBe(selection);
    expect(editor.getJSON()).toEqual(snapshot);
    expect(viewport.scrollTo).toHaveBeenCalledOnce();
  });

  it("places the caret in this definition's text when nested definitions precede it", () => {
    const { editor } = createEditor([
      { type: "paragraph", content: [reference("outer")] },
      {
        type: "footnoteDefinition",
        attrs: { identifier: "outer", label: "Outer" },
        content: [definition("inner", "Inner text."), paragraph("Outer text.")],
      },
    ]);
    editor.view.dom
      .querySelector<HTMLButtonElement>(".footnote-reference-link")!
      .click();
    editor.commands.insertContent("Added ");
    const content = (editor.getJSON() as JSONContent).content?.[1].content;
    expect(content?.[0].content?.[0].content?.[0].text).toBe("Inner text.");
    expect(content?.[1].content?.[0].text).toBe("Added Outer text.");
  });

  it("returns through nested footnote references to the original repeated reference", () => {
    const { editor } = createEditor([
      {
        type: "paragraph",
        content: [
          reference("outer"),
          { type: "text", text: " repeated " },
          reference("outer"),
        ],
      },
      {
        type: "footnoteDefinition",
        attrs: { identifier: "outer", label: "Outer" },
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "See another note " },
              reference("inner"),
            ],
          },
        ],
      },
      definition("inner", "Inner note."),
    ]);
    const references = editor.view.dom.querySelectorAll<HTMLButtonElement>(
      ".footnote-reference-link",
    );
    const backlinks =
      editor.view.dom.querySelectorAll<HTMLButtonElement>(".footnote-backlink");
    references[1].click();
    references[2].click();
    editor.commands.insertContentAt(1, "Lead ");
    const positions = referencePositions(editor);
    backlinks[1].click();
    expect(editor.state.selection.from).toBe(positions[2] + 1);
    backlinks[0].click();
    expect(editor.state.selection.from).toBe(positions[1] + 1);
  });
});
