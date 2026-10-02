import { Editor } from "@tiptap/core";
import { closeHistory, redo, undo, undoDepth } from "@tiptap/pm/history";
import { Selection, TextSelection } from "@tiptap/pm/state";
import { afterEach, expect, it, vi } from "vitest";
import { canvasNodesAndMarks } from "./canvasSchema";
import { IndentedListInput } from "./indentedListInput";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import { MarkdownTyping } from "./markdownTyping";
import { insertPastedFormula, insertPastedMarkdown } from "./paste";
import { QuoteTyping } from "./quoteTyping";
import { TaskListInput } from "./taskListInput";

const editors: Editor[] = [];
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each([1709, 5697, 13673, 39595, 67511, 99011])(
  "retains exact documents through mixed editing and undo/redo (seed %s)",
  (seed) => {
    let randomState = seed;
    const random = (limit: number) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return (randomState >>> 8) % limit;
    };
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [
        ...canvasNodesAndMarks(),
        MarkdownTyping,
        QuoteTyping,
        IndentedListInput,
        TaskListInput,
      ],
      content: markdownToDocument("Start text\n\nSecond paragraph"),
    });
    editors.push(editor);
    // JSDOM has no text layout; undo may ask to reveal its restored caret.
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    const snapshots = [editor.getJSON()];
    const text = [
      "Typed ",
      "中文",
      "😀",
      "e\u0301",
      " **text** ",
      "`code`",
      "$x$",
      "\n",
      "~~mark~~",
      "NUL\0",
      "\u2028",
      "\uD800",
    ];
    const markdown = [
      "# Heading\n\nBody",
      "- [ ] Task\n- [x] Done",
      "| A | B |\n| - | - |\n| x | y |",
      "> Quoted\n\nText",
      "```js\nconst x = 1;\n```",
      "$$\nx^2\n$$",
      "![Image](a.png)",
      "Text[^a]\n\n[^a]: Note",
      "<aside>HTML</aside>",
    ];
    for (let index = 0; index < 50; index += 1) {
      editor.view.dispatch(closeHistory(editor.state.tr));
      const blocks: Array<{ from: number; to: number }> = [];
      editor.state.doc.descendants((node, position) => {
        if (node.isTextblock)
          blocks.push({ from: position + 1, to: position + node.nodeSize - 1 });
      });
      const block = blocks[random(blocks.length)];
      const selection = block
        ? (() => {
            const from = block.from + random(block.to - block.from + 1);
            return TextSelection.create(
              editor.state.doc,
              from,
              Math.min(block.to, from + random(5)),
            );
          })()
        : Selection.near(editor.state.doc.resolve(0));
      editor.view.dispatch(editor.state.tr.setSelection(selection));
      const before = editor.getJSON();
      const action = random(10);
      const context = `seed ${seed}, operation ${index}, action ${action}`;
      expect(before, context).toEqual(snapshots.at(-1));
      switch (action) {
        case 0:
          editor.view.dispatch(
            editor.state.tr.insertText(text[random(text.length)]),
          );
          break;
        case 1:
          editor.commands.toggleBold();
          break;
        case 2:
          editor.commands.toggleItalic();
          break;
        case 3:
          editor.commands.toggleStrike();
          break;
        case 4:
          editor.commands.toggleBlockquote();
          break;
        case 5:
          editor.commands.toggleBulletList();
          break;
        case 6:
          editor.commands.toggleTaskList();
          break;
        case 7:
          editor.commands.keyboardShortcut("Enter");
          break;
        case 8: {
          const source = markdown[random(markdown.length)];
          if (!insertPastedFormula(editor.view, source))
            insertPastedMarkdown(editor.view, source);
          break;
        }
        case 9:
          editor.view.dispatch(editor.state.tr.deleteSelection());
          break;
      }
      editor.state.doc.check();
      expect(() => documentToMarkdown(editor.getJSON()), context).not.toThrow();
      // Caret mark toggles can create a history entry without changing JSON.
      if (undoDepth(editor.state) === snapshots.length)
        snapshots.push(editor.getJSON());
      else expect(editor.getJSON(), context).toEqual(before);
      expect(undoDepth(editor.state), context).toBe(snapshots.length - 1);
      if (snapshots.length > 1 && random(6) === 0) {
        expect(undo(editor.state, editor.view.dispatch), context).toBe(true);
        expect(editor.getJSON(), context).toEqual(snapshots.at(-2));
        expect(redo(editor.state, editor.view.dispatch), context).toBe(true);
        expect(editor.getJSON(), context).toEqual(snapshots.at(-1));
      }
    }
    for (let index = snapshots.length - 2; index >= 0; index -= 1) {
      expect(undo(editor.state, editor.view.dispatch)).toBe(true);
      expect(editor.getJSON(), `seed ${seed}, undo ${index}`).toEqual(
        snapshots[index],
      );
      editor.state.doc.check();
    }
    expect(undo(editor.state)).toBe(false);
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(redo(editor.state, editor.view.dispatch)).toBe(true);
      expect(editor.getJSON(), `seed ${seed}, redo ${index}`).toEqual(
        snapshots[index],
      );
      editor.state.doc.check();
    }
    expect(redo(editor.state)).toBe(false);
  },
);
