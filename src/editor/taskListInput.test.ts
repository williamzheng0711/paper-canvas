import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { afterEach, describe, expect, it } from "vitest";
import { TaskListInput } from "./taskListInput";

const editors: Editor[] = [];

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
});

function typeSequentially(editor: Editor, text: string): void {
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

function createEditor(
  content: object = { type: "doc", content: [{ type: "paragraph" }] },
) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      TaskListInput,
    ],
    content,
  });
  editors.push(editor);
  return editor;
}

describe("task list input", () => {
  it.each([
    ["- [ ] ", false],
    ["* [ ] ", false],
    ["- [x] ", true],
  ])("converts sequential input %j to a task item", (input, checked) => {
    const editor = createEditor();
    typeSequentially(editor, input);
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked },
          content: [{ type: "paragraph" }],
        },
      ],
    });
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("converts only a typed bullet item and preserves surrounding bullet items", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "before" }],
                },
              ],
            },
            { type: "listItem", content: [{ type: "paragraph" }] },
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "after" }],
                },
              ],
            },
          ],
        },
      ],
    });
    let paragraphIndex = 0;
    let target = -1;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph" && paragraphIndex++ === 1) {
        target = position + 1;
        return false;
      }
    });
    editor.commands.setTextSelection(target);
    typeSequentially(editor, "[ ] ");

    expect(editor.getJSON().content?.slice(0, 3)).toEqual([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "before" }],
              },
            ],
          },
        ],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [{ type: "paragraph" }],
          },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "after" }] },
            ],
          },
        ],
      },
    ]);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("keeps the caret in the newly converted item when an earlier task list exists", () => {
    const editor = createEditor({
      type: "doc",
      content: [
        {
          type: "taskList",
          content: [
            {
              type: "taskItem",
              attrs: { checked: false },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "existing" }],
                },
              ],
            },
          ],
        },
        { type: "paragraph" },
      ],
    });
    let target = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === "paragraph" && !node.textContent) {
        target = position + 1;
        return false;
      }
    });
    editor.commands.setTextSelection(target);
    typeSequentially(editor, "- [x] ");

    let activeTaskChecked: boolean | undefined;
    for (
      let depth = editor.state.selection.$from.depth;
      depth > 0;
      depth -= 1
    ) {
      if (editor.state.selection.$from.node(depth).type.name === "taskItem") {
        activeTaskChecked =
          editor.state.selection.$from.node(depth).attrs.checked;
        break;
      }
    }
    expect(activeTaskChecked).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
  });

  it("undoes the marker conversion on Backspace", () => {
    const editor = createEditor();
    typeSequentially(editor, "- [ ] ");
    expect(editor.getJSON().content?.[0].type).toBe("taskList");

    const handled = editor.view.someProp("handleKeyDown", (handler) =>
      handler(
        editor.view,
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
      ),
    );

    expect(handled).toBe(true);
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "[ ] " }] },
          ],
        },
      ],
    });
  });

  it("keeps standalone task marker input working", () => {
    const editor = createEditor();
    typeSequentially(editor, "[ ] ");
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "taskList",
      content: [{ type: "taskItem", attrs: { checked: false } }],
    });
  });
});
