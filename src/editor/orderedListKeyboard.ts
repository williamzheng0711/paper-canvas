import type { CommandProps } from "@tiptap/core";
import { Fragment, NodeRange, Slice } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import {
  canJoin,
  liftTarget,
  ReplaceAroundStep,
  Transform,
} from "@tiptap/pm/transform";

/** Follow the list container, since its first item may have a different type from the selection. */
function orderedRange(state: EditorState): NodeRange | null {
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (!["orderedList", "bulletList", "taskList"].includes(node.type.name))
      continue;
    if (node.type.name !== "orderedList") return null;
    return $from.blockRange($to, (parent) => parent === node);
  }
  return null;
}

export function inOrderedList(state: EditorState): boolean {
  return orderedRange(state) !== null;
}

export function orderedListHasTasks(state: EditorState): boolean {
  const range = orderedRange(state);
  if (!range) return false;
  let hasTasks = false;
  range.parent.forEach((item) => {
    if (item.type.name === "taskItem") hasTasks = true;
  });
  return hasTasks;
}

/** The structural list transforms retain the moved text's transaction mapping. */
export function sinkOrderedListItems({
  state,
  dispatch,
}: CommandProps): boolean {
  const range = orderedRange(state);
  if (!range || range.startIndex === 0) return false;
  const list = range.parent;
  const previous = list.child(range.startIndex - 1);
  const nested = previous.lastChild?.type === list.type;
  if (dispatch) {
    const inner = Fragment.from(
      nested ? previous.type.create(previous.attrs) : null,
    );
    const slice = new Slice(
      Fragment.from(
        previous.type.create(
          previous.attrs,
          Fragment.from(list.type.create(null, inner)),
        ),
      ),
      nested ? 3 : 1,
      0,
    );
    state.tr
      .step(
        new ReplaceAroundStep(
          range.start - (nested ? 3 : 1),
          range.end,
          range.start,
          range.end,
          slice,
          1,
          true,
        ),
      )
      .scrollIntoView();
  }
  return true;
}

function liftIntoOuterList(tr: Transform, original: NodeRange): boolean {
  let range = original;
  const end = range.end;
  const endOfList = range.$to.end(range.depth);
  if (end < endOfList) {
    // Remaining siblings stay nested under the last promoted item. Keep their
    // original number and the promoted item's checkbox attributes.
    const last = range.parent.child(range.endIndex - 1);
    const suffix = range.parent.type.create({
      ...range.parent.attrs,
      start: range.parent.attrs.start + range.endIndex,
    });
    tr.step(
      new ReplaceAroundStep(
        end - 1,
        endOfList,
        end,
        endOfList,
        new Slice(Fragment.from(last.type.create(last.attrs, suffix)), 1, 0),
        1,
        true,
      ),
    );
    range = new NodeRange(
      tr.doc.resolve(range.$from.pos),
      tr.doc.resolve(endOfList),
      range.depth,
    );
  }
  const target = liftTarget(range);
  if (target === null) return false;
  tr.lift(range, target);
  const $after = tr.doc.resolve(tr.mapping.map(end, -1) - 1);
  if (
    canJoin(tr.doc, $after.pos) &&
    $after.nodeBefore?.type === $after.nodeAfter?.type
  )
    tr.join($after.pos);
  return true;
}

function liftOutOfList(tr: Transform, range: NodeRange): boolean {
  const list = range.parent;
  for (
    let position = range.end, index = range.endIndex - 1;
    index > range.startIndex;
    index--
  ) {
    position -= list.child(index).nodeSize;
    tr.delete(position - 1, position + 1);
  }
  const $start = tr.doc.resolve(range.start);
  const item = $start.nodeAfter!;
  if (tr.mapping.map(range.end) !== range.start + item.nodeSize) return false;
  const atStart = range.startIndex === 0;
  const atEnd = range.endIndex === list.childCount;
  const parent = $start.node(-1);
  const index = $start.index(-1);
  const suffix = list.type.create({
    ...list.attrs,
    start: list.attrs.start + range.endIndex,
  });
  if (
    !parent.canReplace(
      index + (atStart ? 0 : 1),
      index + 1,
      item.content.append(atEnd ? Fragment.empty : Fragment.from(list)),
    )
  )
    return false;
  tr.step(
    new ReplaceAroundStep(
      $start.pos - (atStart ? 1 : 0),
      $start.pos + item.nodeSize + (atEnd ? 1 : 0),
      $start.pos + 1,
      $start.pos + item.nodeSize - 1,
      new Slice(
        (atStart
          ? Fragment.empty
          : Fragment.from(list.copy(Fragment.empty))
        ).append(atEnd ? Fragment.empty : Fragment.from(suffix)),
        atStart ? 0 : 1,
        atEnd ? 0 : 1,
      ),
      atStart ? 0 : 1,
    ),
  );
  return true;
}

export function liftOrderedListItems({
  state,
  tr,
  dispatch,
}: CommandProps): boolean {
  const range = orderedRange(state);
  if (!range) return false;
  // A failed command must leave Tiptap's shared transaction untouched.
  const scratch = new Transform(state.doc);
  const parent = range.$from.node(range.depth - 1);
  const lifted = ["listItem", "taskItem"].includes(parent.type.name)
    ? liftIntoOuterList(scratch, range)
    : liftOutOfList(scratch, range);
  if (lifted && dispatch) {
    scratch.steps.forEach((step) => tr.step(step));
    tr.scrollIntoView();
  }
  return lifted;
}
