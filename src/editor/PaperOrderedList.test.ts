import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { afterEach, describe, expect, it } from "vitest";
import { PaperOrderedList } from "./PaperOrderedList";
import { TaskListInput } from "./taskListInput";
import { IndentedListInput } from "./indentedListInput";

const editors: Editor[] = [];

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

function createEditor(
  content: JSONContent | string = "<p></p>",
  stockKeyboard = false,
) {
  const element = document.createElement("div");
  element.classList.add("paper-editor");
  const editor = new Editor({
    element,
    extensions: [
      StarterKit.configure({ orderedList: false }),
      stockKeyboard
        ? PaperOrderedList.extend({ addKeyboardShortcuts: () => ({}) })
        : PaperOrderedList,
      TaskList,
      TaskItem.configure({ nested: true }),
      TaskListInput,
      IndentedListInput,
    ],
    content,
  });
  editors.push(editor);
  return editor;
}

function item(text: string, checked?: boolean): JSONContent {
  return {
    type: checked === undefined ? "listItem" : "taskItem",
    ...(checked === undefined ? {} : { attrs: { checked } }),
    content: [
      {
        type: "paragraph",
        ...(text ? { content: [{ type: "text", text }] } : {}),
      },
    ],
  };
}

function ordered(items: JSONContent[], start = 3): JSONContent {
  return {
    type: "doc",
    content: [{ type: "orderedList", attrs: { start }, content: items }],
  };
}

function typeSequentially(editor: Editor, text: string) {
  for (const character of text) {
    if (character === "\n") {
      editor.commands.keyboardShortcut("Enter");
      continue;
    }
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

function selectItem(editor: Editor, index: number, atEnd = false) {
  const list = editor.state.doc.firstChild!;
  let position = 3;
  for (let itemIndex = 0; itemIndex < index; itemIndex++)
    position += list.child(itemIndex).nodeSize;
  if (atEnd) position += list.child(index).firstChild!.content.size;
  editor.commands.setTextSelection(position);
}

function selectText(editor: Editor, text: string, offset = 0) {
  let position: number | undefined;
  editor.state.doc.descendants((node, pos) => {
    if (
      position === undefined &&
      node.type.name === "paragraph" &&
      node.textContent === text
    )
      position = pos + 1 + offset;
  });
  if (position === undefined) throw new Error(`Paragraph not found: ${text}`);
  editor.commands.setTextSelection(position);
}

function parentItem(
  text: string,
  checked: boolean | undefined,
  children: JSONContent[],
  start = 1,
): JSONContent {
  const parent = item(text, checked);
  return {
    ...parent,
    content: [...parent.content!, ordered(children, start).content![0]],
  };
}

function pressKey(editor: Editor, key: string, shiftKey = false) {
  return editor.view.someProp("handleKeyDown", (handler) =>
    handler(
      editor.view,
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }),
    ),
  );
}

describe("numbered task lists", () => {
  it("keeps checked tasks and ordinary siblings in one valid numbered list", () => {
    const source = ordered([item("Third", true), item("Fourth")]);
    const editor = createEditor(source);
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(editor.state.doc.firstChild?.attrs.start).toBe(3);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.getJSON().content?.[0].content).toEqual(
      source.content?.[0].content,
    );
    expect(editor.view.dom.querySelector("ol")?.start).toBe(3);
    expect(editor.view.dom.querySelectorAll("ol > li")).toHaveLength(2);
    expect(editor.view.dom.querySelector("input")?.checked).toBe(true);
  });

  it("retains a numbered task list across HTML export and import", () => {
    const editor = createEditor(
      ordered([item("Third", true), item("Fourth"), item("Fifth", false)]),
    );
    const restored = createEditor(editor.getHTML());
    expect(restored.getJSON()).toEqual(editor.getJSON());
    expect(() => restored.state.doc.check()).not.toThrow();
  });

  it("toggles a checkbox without changing the list start or ordinary siblings", () => {
    const editor = createEditor(ordered([item("Third", true), item("Fourth")]));
    const checkbox = editor.view.dom.querySelector<HTMLInputElement>("input")!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(editor.state.doc.firstChild?.attrs.start).toBe(3);
    expect(editor.state.doc.firstChild?.firstChild?.attrs.checked).toBe(false);
    expect(editor.state.doc.firstChild?.child(1).type.name).toBe("listItem");
    expect(editor.state.doc.firstChild?.child(1).textContent).toBe("Fourth");
    editor.commands.undo();
    expect(editor.state.doc.firstChild?.firstChild?.attrs.checked).toBe(true);
  });

  it("continues a checked numbered task with an unchecked item on Enter", () => {
    const editor = createEditor(ordered([item("Third", true), item("Fourth")]));
    selectItem(editor, 0, true);
    editor.commands.keyboardShortcut("Enter");
    const list = editor.state.doc.firstChild!;
    expect(list.attrs.start).toBe(3);
    expect(list.childCount).toBe(3);
    expect(list.child(1).type.name).toBe("taskItem");
    expect(list.child(1).attrs.checked).toBe(false);
    expect(list.child(2).type.name).toBe("listItem");
    expect(list.child(2).textContent).toBe("Fourth");
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it.each(["[ ] ", "[x] ", "[X] "])(
    "converts a numbered item with %j in place",
    (marker) => {
      const editor = createEditor(
        ordered([item("Before"), item(""), item("After")], 7),
      );
      selectItem(editor, 1);
      typeSequentially(editor, marker + "Task");
      const list = editor.state.doc.firstChild!;
      expect(list.attrs.start).toBe(7);
      expect(list.childCount).toBe(3);
      expect(list.child(0).textContent).toBe("Before");
      expect(list.child(1).type.name).toBe("taskItem");
      expect(list.child(1).attrs.checked).toBe(marker !== "[ ] ");
      expect(list.child(1).textContent).toBe("Task");
      expect(list.child(2).textContent).toBe("After");
      expect(() => editor.state.doc.check()).not.toThrow();
    },
  );

  it("accepts complete numbered prefixes for mixed task and ordinary items", () => {
    const editor = createEditor();
    typeSequentially(editor, "3. [x] Third\n4. Fourth\n5. [ ] Fifth");
    expect(editor.state.doc.firstChild?.attrs.start).toBe(3);
    expect(editor.getJSON().content?.[0].content).toEqual([
      item("Third", true),
      item("Fourth"),
      item("Fifth", false),
    ]);
    expect(() => editor.state.doc.check()).not.toThrow();
  });

  it("consumes repeated numbers across blank lines while keeping checked state", () => {
    const editor = createEditor();
    typeSequentially(editor, "3. [x] Third\n\n4. Fourth\n\n5. [x] Fifth");
    expect(editor.state.doc.firstChild?.attrs.start).toBe(3);
    expect(editor.getJSON().content?.[0].content).toEqual([
      item("Third", true),
      item("Fourth"),
      item("Fifth", true),
    ]);
    expect(editor.view.dom.querySelectorAll("ol")).toHaveLength(1);
  });

  it("restores a typed marker with Backspace without splitting the numbered list", () => {
    const editor = createEditor(
      ordered([item("Before"), item(""), item("After")]),
    );
    selectItem(editor, 1);
    typeSequentially(editor, "[x] ");
    editor.view.someProp("handleKeyDown", (handler) =>
      handler(
        editor.view,
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
      ),
    );
    const list = editor.state.doc.firstChild!;
    expect(list.attrs.start).toBe(3);
    expect(list.child(1).type.name).toBe("listItem");
    expect(list.child(1).textContent).toBe("[x] ");
    expect(list.child(0).textContent).toBe("Before");
    expect(list.child(2).textContent).toBe("After");
  });

  it("preserves ordered tasks nested inside a task item", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              ...item("Parent", false),
              content: [
                ...item("Parent", false).content!,
                ordered([item("Third", true), item("Fourth")]).content![0],
              ],
            },
          ],
        },
      ],
    });
    expect(() => editor.state.doc.check()).not.toThrow();
    expect(
      editor.view.dom.querySelector<HTMLOListElement>("ul ol")?.start,
    ).toBe(3);
    expect(editor.view.dom.querySelectorAll("ul ol > li")).toHaveLength(2);
    expect(createEditor(editor.getHTML()).getJSON()).toEqual(editor.getJSON());
  });

  it.each([
    [undefined, true],
    [true, undefined],
  ])(
    "indents an item under a sibling of another type (%s, %s)",
    (parentChecked, childChecked) => {
      const editor = createEditor(
        ordered([
          item("Parent", parentChecked),
          item("Child", childChecked),
          item("Next"),
        ]),
      );
      selectItem(editor, 1);
      pressKey(editor, "Tab");
      const list = editor.state.doc.firstChild!;
      expect(list.childCount).toBe(2);
      expect(list.firstChild?.lastChild?.type.name).toBe("orderedList");
      expect(list.firstChild?.lastChild?.firstChild?.type.name).toBe(
        childChecked === undefined ? "listItem" : "taskItem",
      );
      expect(list.firstChild?.lastChild?.firstChild?.textContent).toBe("Child");
      expect(list.firstChild?.attrs.checked).toBe(parentChecked);
      expect(list.firstChild?.lastChild?.firstChild?.attrs.checked).toBe(
        childChecked,
      );
      expect(list.lastChild?.textContent).toBe("Next");
      expect(() => editor.state.doc.check()).not.toThrow();
    },
  );

  it.each([
    [undefined, true, undefined],
    [true, undefined, false],
  ])(
    "indents after an unlike sibling even when the first item is another type (%s, %s, %s)",
    (firstChecked, parentChecked, childChecked) => {
      const editor = createEditor(
        ordered([
          item("First", firstChecked),
          item("Parent", parentChecked),
          item("Child", childChecked),
          item("Next"),
        ]),
      );
      selectItem(editor, 2);
      pressKey(editor, "Tab");
      const list = editor.state.doc.firstChild!;
      expect(list.childCount).toBe(3);
      expect(list.child(1).lastChild?.type.name).toBe("orderedList");
      expect(list.child(1).lastChild?.textContent).toBe("Child");
      expect(list.child(1).lastChild?.firstChild?.attrs.checked).toBe(
        childChecked,
      );
      expect(list.child(1).attrs.checked).toBe(parentChecked);
      expect(list.lastChild?.textContent).toBe("Next");
      expect(() => editor.state.doc.check()).not.toThrow();
    },
  );

  it.each([
    [undefined, true],
    [true, undefined],
  ])(
    "promotes an item from a parent of another type (%s, %s)",
    (parentChecked, childChecked) => {
      const editor = createEditor(
        ordered([
          parentItem("Parent", parentChecked, [
            item("Child", childChecked),
            item("Nested next", false),
          ]),
          item("Next"),
        ]),
      );
      selectText(editor, "Child");
      pressKey(editor, "Tab", true);
      const list = editor.state.doc.firstChild!;
      expect(list.childCount).toBe(3);
      expect(list.child(0).textContent).toBe("Parent");
      expect(list.child(1).type.name).toBe(
        childChecked === undefined ? "listItem" : "taskItem",
      );
      expect(list.child(1).firstChild?.textContent).toBe("Child");
      expect(list.child(1).lastChild?.type.name).toBe("orderedList");
      expect(list.child(1).lastChild?.textContent).toBe("Nested next");
      expect(list.lastChild?.textContent).toBe("Next");
      expect(() => editor.state.doc.check()).not.toThrow();
    },
  );

  it("promotes an empty nested task with Enter when its parent is ordinary", () => {
    const editor = createEditor(
      ordered([
        parentItem("Parent", undefined, [item("Child", true), item("", false)]),
        item("Next"),
      ]),
    );
    selectText(editor, "");
    pressKey(editor, "Enter");
    const list = editor.state.doc.firstChild!;
    expect(list.childCount).toBe(3);
    expect(list.child(0).lastChild?.textContent).toBe("Child");
    expect(list.child(1).type.name).toBe("taskItem");
    expect(list.child(1).attrs.checked).toBe(false);
    expect(list.child(1).childCount).toBe(1);
    expect(list.child(2).textContent).toBe("Next");
  });

  it("keeps suffix numbering after lifting a middle numbered task with Backspace", () => {
    const editor = createEditor(
      ordered([item("First", true), item("Middle", false), item("Last")], 7),
    );
    selectItem(editor, 1);
    pressKey(editor, "Backspace");
    const blocks = editor.getJSON().content!;
    expect(blocks[0]).toMatchObject({
      type: "orderedList",
      attrs: { start: 7 },
    });
    expect(blocks[1]).toMatchObject({
      type: "paragraph",
      content: [{ type: "text", text: "Middle" }],
    });
    expect(blocks[2]).toMatchObject({
      type: "orderedList",
      attrs: { start: 9 },
      content: [item("Last")],
    });
    expect(() => editor.state.doc.check()).not.toThrow();
  });

  it.each([
    ["First", "Second"],
    ["First", "Second", "Third"],
  ])(
    "matches stock Backspace behavior in an ordinary numbered list: %s",
    (...texts) => {
      const source = ordered(
        texts.map((text) => item(text)),
        3,
      );
      const editor = createEditor(source);
      const stock = createEditor(source, true);
      for (const current of [editor, stock]) {
        selectItem(current, 1);
        pressKey(current, "Backspace");
      }
      expect(editor.getJSON()).toEqual(stock.getJSON());
      expect(editor.state.doc.firstChild?.attrs.start).toBe(3);
      expect(editor.state.doc.child(1).textContent).toBe("Second");
      expect(editor.state.selection.$from.parent.type.name).toBe(
        stock.state.selection.$from.parent.type.name,
      );
      expect(() => editor.state.doc.check()).not.toThrow();
    },
  );
});
