import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, expect, it, vi } from "vitest";
import { canvasNodesAndMarks } from "./canvasSchema";
import { replaceDocumentPreservingSelection } from "./documentSync";
import { markdownToDocument } from "./markdown";
import { MarkdownTyping } from "./markdownTyping";
import { insertPastedMarkdown } from "./paste";

const editors: Editor[] = [];
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function make(source: string | JSONContent) {
  const editor = new Editor({
    extensions: [...canvasNodesAndMarks(), MarkdownTyping],
    content: typeof source === "string" ? markdownToDocument(source) : source,
  });
  editors.push(editor);
  return editor;
}

const literals = [
  String.raw`\*\*literal\*\*`,
  String.raw`\`literal\``,
  String.raw`\$y\$`,
];

it.each(literals)(
  "preserves unrelated literal %s while editing formula source, including undo/redo",
  (literal) => {
    const editor = make(`${literal} $x$`);
    const before = editor.getJSON();
    editor.commands.setTextSelection(2);
    editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
    const source =
      editor.view.dom.querySelector<HTMLTextAreaElement>("textarea")!;
    source.value = "x+1";
    source.dispatchEvent(new Event("input", { bubbles: true }));

    const expected: JSONContent = structuredClone(before);
    expected.content![0].content!.at(-1)!.attrs!.latex = "x+1";
    expect(editor.getJSON()).toEqual(expected);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(expected);
  },
);

it.each(literals)(
  "preserves parsed literal %s when adopting a document",
  (literal) => {
    const editor = make("old document");
    editor.commands.setTextSelection(2);
    const document = markdownToDocument(literal);
    replaceDocumentPreservingSelection(editor, document);
    expect(editor.getJSON()).toEqual(
      editor.schema.nodeFromJSON(document).toJSON(),
    );
  },
);

it.each(literals)(
  "preserves parsed literal %s in a mixed Markdown paste and its undo/redo",
  (literal) => {
    const editor = make("");
    const before = editor.getJSON();
    const source = `$x$ ${literal}`;
    expect(insertPastedMarkdown(editor.view, source)).toBe(true);
    const pasted = editor.schema
      .nodeFromJSON(markdownToDocument(source))
      .toJSON();
    expect(editor.getJSON()).toEqual(pasted);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(pasted);
  },
);

it("does not normalize literal markers on an image attribute or mark change", () => {
  const editor = make(
    String.raw`\*\*literal\*\* ![image](data:image/png;base64,AA==)`,
  );
  const text = editor.state.doc.textContent;
  editor.commands.setTextSelection(2);
  let imagePosition = 0;
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === "image") imagePosition = position;
  });
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(imagePosition, undefined, {
      ...editor.state.doc.nodeAt(imagePosition)!.attrs,
      width: 120,
    }),
  );
  expect(editor.state.doc.textContent).toBe(text);
  editor.view.dispatch(
    editor.state.tr.addMark(1, 3, editor.schema.marks.italic.create()),
  );
  expect(editor.state.doc.textContent).toBe(text);
});

it.each([
  { source: "****", caret: 3, value: "中文", type: "bold" },
  { source: "``", caret: 2, value: "中文", type: "code" },
  { source: "Before $$ after", caret: 9, value: "θ", type: "inlineFormula" },
  { source: "$$$$", caret: 3, value: "θ", type: "blockFormula" },
])(
  "keeps $type composing text intact and normalizes the commit with one undo",
  async ({ source, caret, value, type }) => {
    // Raw prewritten delimiters are entered in the canvas, before Markdown parsing.
    const editor = make({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: source }] },
      ],
    });
    editor.commands.setTextSelection(caret);
    const before = editor.getJSON();
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    expect(editor.view.composing).toBe(true);
    const composingNode = editor.view.dom.querySelector("p")!.firstChild;
    const first = editor.state.tr.insertText("z").setMeta("composition", 7);
    editor.view.dispatch(first);
    expect(editor.state.doc.textContent).toBe(
      `${source.slice(0, caret - 1)}z${source.slice(caret - 1)}`,
    );
    expect(editor.view.dom.querySelector("p")!.firstChild).toBe(composingNode);
    editor.view.dispatch(
      editor.state.tr
        .insertText(value, caret, caret + 1)
        .setMeta("composition", 7)
        .setTime(first.time + 100),
    );
    expect(JSON.stringify(editor.getJSON())).not.toContain(`"type":"${type}"`);

    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.stringify(editor.getJSON())).toContain(`"type":"${type}"`);
    const committed = editor.getJSON();
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getJSON()).toEqual(committed);
  },
);

it("does not normalize canceled composition or a replacement document after compositionend", async () => {
  const editor = make(String.raw`\*\*literal\*\*`);
  editor.commands.setTextSelection(3);
  const before = editor.getJSON();
  editor.view.dom.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  editor.view.dom.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true }),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(editor.getJSON()).toEqual(before);

  editor.view.dom.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  editor.view.dispatch(
    editor.state.tr.insertText("z").setMeta("composition", 8),
  );
  editor.view.dispatch(editor.state.tr.delete(3, 4).setMeta("composition", 8));
  editor.view.dom.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true }),
  );
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(editor.getJSON()).toEqual(before);

  editor.view.dom.dispatchEvent(
    new CompositionEvent("compositionstart", { bubbles: true }),
  );
  editor.view.dispatch(
    editor.state.tr.insertText("z").setMeta("composition", 8),
  );
  editor.view.dom.dispatchEvent(
    new CompositionEvent("compositionend", { bubbles: true }),
  );
  replaceDocumentPreservingSelection(
    editor,
    markdownToDocument(String.raw`\`replacement\``),
  );
  const replacement = editor.getJSON();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(editor.getJSON()).toEqual(replacement);
});

it("waits for the final native composition DOM mutation before formatting", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [...canvasNodesAndMarks(), MarkdownTyping],
    content: "<p>****</p>",
    // jsdom has no text-range geometry; this test exercises native DOM input.
    editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(editor);
  try {
    const before = editor.getJSON();
    editor.commands.setTextSelection(3);
    editor.view.focus();
    const composingNode = editor.view.dom.querySelector("p")!.firstChild!;
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    composingNode.nodeValue = "**z**";
    window.getSelection()!.collapse(composingNode, 3);
    editor.view.dom.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "z",
        inputType: "insertCompositionText",
        isComposing: true,
      }),
    );
    await vi.waitFor(() => expect(editor.state.doc.textContent).toBe("**z**"));
    expect(editor.view.dom.querySelector("p")!.firstChild).toBe(composingNode);

    composingNode.nodeValue = "**中文**";
    window.getSelection()!.collapse(composingNode, 4);
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "中文" }),
    );
    await vi.waitFor(() =>
      expect(editor.view.dom.querySelector("strong")?.textContent).toBe("中文"),
    );
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  } finally {
    element.remove();
  }
});
