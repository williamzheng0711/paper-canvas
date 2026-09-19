import { Extension, InputRule } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { canJoin } from "@tiptap/pm/transform";

const taskMarker = /^\[([ xX])\]\s$/;

/** Converts a marker typed into a bullet item into a task item. */
export const TaskListInput = Extension.create({
  name: "taskListInput",
  priority: 1000,

  addInputRules() {
    return [
      new InputRule({
        find: taskMarker,
        handler: ({ state, range, match }) => {
          const $marker = state.doc.resolve(range.from);
          if ($marker.parent.type.name !== "paragraph") return;
          if (
            $marker.depth >= 2 &&
            $marker.node(-1).type.name === "taskItem" &&
            $marker.parentOffset === 0 &&
            $marker.index(-1) === 0
          ) {
            state.tr.delete(range.from, range.to);
            state.tr.setNodeMarkup(
              $marker.before($marker.depth - 1),
              undefined,
              {
                ...$marker.node(-1).attrs,
                checked: match[1].toLowerCase() === "x",
              },
            );
            return;
          }

          let listDepth = $marker.depth;
          while (
            listDepth > 0 &&
            ($marker.node(listDepth).type.name !== "bulletList" ||
              $marker.node(listDepth + 1)?.type.name !== "listItem")
          ) {
            listDepth -= 1;
          }
          if (
            listDepth === 0 ||
            $marker.parentOffset !== 0 ||
            $marker.index(listDepth + 1) !== 0
          )
            return;

          const listPosition = $marker.before(listDepth);
          const list = state.doc.nodeAt(listPosition);
          if (!list || list.type.name !== "bulletList") return;

          const itemIndex = $marker.index(listDepth);
          if (itemIndex >= list.childCount) return;

          const tr = state.tr;
          tr.delete(range.from, range.to);
          const updatedList = tr.doc.nodeAt(listPosition);
          if (!updatedList || updatedList.type.name !== "bulletList") return;

          const before = Array.from({ length: itemIndex }, (_, index) =>
            updatedList.child(index),
          );
          const after = Array.from(
            { length: updatedList.childCount - itemIndex - 1 },
            (_, index) => updatedList.child(itemIndex + index + 1),
          );
          const targetItem = updatedList.child(itemIndex);
          const taskItem = state.schema.nodes.taskItem.create(
            { checked: match[1].toLowerCase() === "x" },
            targetItem.content,
            targetItem.marks,
          );
          const replacements = [];
          if (before.length) {
            replacements.push(
              updatedList.type.create(
                updatedList.attrs,
                Fragment.fromArray(before),
                updatedList.marks,
              ),
            );
          }
          const taskList = state.schema.nodes.taskList.create(null, taskItem);
          replacements.push(taskList);
          if (after.length) {
            replacements.push(
              updatedList.type.create(
                updatedList.attrs,
                Fragment.fromArray(after),
                updatedList.marks,
              ),
            );
          }

          tr.replaceWith(
            listPosition,
            listPosition + updatedList.nodeSize,
            Fragment.fromArray(replacements),
          );
          const taskListPosition =
            listPosition + (before.length ? replacements[0].nodeSize : 0);
          tr.setSelection(TextSelection.create(tr.doc, taskListPosition + 3));
          // A blank line or an explicit bullet prefix can temporarily split a
          // task list. Rejoin matching neighbors after its checkbox is complete.
          const $task = tr.doc.resolve(taskListPosition);
          if (
            $task.nodeBefore?.type.name === "taskList" &&
            canJoin(tr.doc, taskListPosition)
          ) {
            tr.join(taskListPosition);
          }
        },
      }),
    ];
  },
});
