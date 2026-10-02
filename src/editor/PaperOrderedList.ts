import OrderedList from "@tiptap/extension-ordered-list";
import {
  inOrderedList,
  liftOrderedListItems,
  orderedListHasTasks,
  sinkOrderedListItems,
} from "./orderedListKeyboard";

/** Numbered lists may mix ordinary items and GFM checkboxes without losing their numbering. */
export const PaperOrderedList = OrderedList.extend({
  priority: 1000,
  content: "(listItem | taskItem)+",

  addKeyboardShortcuts() {
    const lift = () => this.editor.commands.command(liftOrderedListItems);
    return {
      ...this.parent?.(),
      Tab: () => this.editor.commands.command(sinkOrderedListItems),
      "Shift-Tab": lift,
      Enter: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (
          !empty ||
          !inOrderedList(state) ||
          $from.parent.type.name !== "paragraph" ||
          $from.parent.content.size !== 0 ||
          $from.node(-1).childCount !== 1
        )
          return false;
        return lift();
      },
      Backspace: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (
          !empty ||
          !orderedListHasTasks(state) ||
          $from.parent.type.name !== "paragraph" ||
          $from.parentOffset !== 0 ||
          $from.index(-1) !== 0
        )
          return false;
        return this.editor.commands.undoInputRule() || lift();
      },
    };
  },
});
