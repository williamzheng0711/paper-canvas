import { Extension, InputRule } from "@tiptap/core";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

function appendNestedItem(
  item: ProseMirrorNode,
  list: ProseMirrorNode,
): ProseMirrorNode {
  const last = item.lastChild;
  if (last?.type === list.type) {
    return item.copy(
      item.content.replaceChild(
        item.childCount - 1,
        last.copy(last.content.append(list.content)),
      ),
    );
  }
  return item.copy(item.content.append(Fragment.from(list)));
}

function isList(node: ProseMirrorNode | null): boolean {
  return (
    !!node && ["bulletList", "orderedList", "taskList"].includes(node.type.name)
  );
}

function emptyItem(node: ProseMirrorNode): boolean {
  return (
    ["listItem", "taskItem"].includes(node.type.name) &&
    node.childCount === 1 &&
    node.firstChild?.type.name === "paragraph" &&
    node.firstChild.content.size === 0
  );
}

// Enter may leave empty items at several levels while moving out of a list.
function pruneTail(
  list: ProseMirrorNode,
  prefix: ProseMirrorNode,
): ProseMirrorNode | null {
  const items: ProseMirrorNode[] = [];
  list.forEach((item) => items.push(item));
  while (items.length) {
    let last = items[items.length - 1];
    if (
      emptyItem(last) ||
      (last.childCount === 1 && last.firstChild === prefix)
    ) {
      items.pop();
      continue;
    }
    if (isList(last.lastChild)) {
      const child = pruneTail(last.lastChild!, prefix);
      const content = child
        ? last.content.replaceChild(last.childCount - 1, child)
        : last.content.cut(0, last.content.size - last.lastChild!.nodeSize);
      last = last.copy(content);
      items[items.length - 1] = last;
    }
    break;
  }
  return items.length ? list.copy(Fragment.fromArray(items)) : null;
}

function markerWidth(list: ProseMirrorNode): number {
  return list.type.name === "orderedList"
    ? String(list.attrs.start + list.childCount - 1).length + 2
    : 2;
}

function appendAtIndent(
  list: ProseMirrorNode,
  nested: ProseMirrorNode,
  indent: number,
  base = 0,
): ProseMirrorNode {
  const last = list.lastChild!;
  const child = last.lastChild;
  const contentIndent = base + markerWidth(list);
  const next =
    isList(child) && indent >= contentIndent + markerWidth(child!)
      ? last.copy(
          last.content.replaceChild(
            last.childCount - 1,
            appendAtIndent(child!, nested, indent, contentIndent),
          ),
        )
      : appendNestedItem(last, nested);
  return list.copy(list.content.replaceChild(list.childCount - 1, next));
}

/** Honor explicit Markdown prefixes alongside the list items already created by Enter. */
export const IndentedListInput = Extension.create({
  name: "indentedListInput",
  priority: 1100,
  addInputRules() {
    return [
      new InputRule({
        find: /^((?: {2,}|\t)?)([-+*]|\d+\.) $/,
        handler: ({ state, range, match }) => {
          const $cursor = state.doc.resolve(range.to);
          if (
            $cursor.parent.type.name !== "paragraph" ||
            $cursor.parentOffset !== $cursor.parent.content.size
          )
            return null;
          const code = state.schema.marks.code;
          if (
            code &&
            $cursor.parent.rangeHasMark(0, $cursor.parent.content.size, code)
          )
            return null;
          const listName = /^\d/.test(match[2]) ? "orderedList" : "bulletList";
          const listType = state.schema.nodes[listName];
          const itemType = state.schema.nodes.listItem;
          if (!listType || !itemType) return null;
          const paragraph = state.schema.nodes.paragraph.create();
          const nested = listType.create(
            listName === "orderedList"
              ? { start: parseInt(match[2], 10) }
              : null,
            itemType.create(null, paragraph),
          );
          let from: number;
          let to: number;
          let previous: ProseMirrorNode | null = null;
          let outerDepth = 0;
          for (let depth = 1; depth < $cursor.depth; depth++) {
            if (isList($cursor.node(depth))) {
              outerDepth = depth;
              break;
            }
          }
          if (
            !match[1] &&
            outerDepth === $cursor.depth - 2 &&
            ($cursor.node(outerDepth).type === listType ||
              ($cursor.node(outerDepth).type.name === "taskList" &&
                listName === "bulletList")) &&
            $cursor.index(-1) === 0
          ) {
            state.tr.delete(range.from, range.to);
            // Enter continues a checkbox as another task. An explicit numbered
            // prefix starts an ordinary item; a following [ ] marker can turn
            // it back into a task without disturbing the list's numbering.
            if (
              listName === "orderedList" &&
              $cursor.node(-1).type.name === "taskItem"
            ) {
              state.tr.setNodeMarkup(
                $cursor.before($cursor.depth - 1),
                itemType,
              );
            }
            return;
          }
          if (outerDepth) {
            // Reuse only the trailing item created by Enter, never move existing prose.
            if (
              !["listItem", "taskItem"].includes($cursor.node(-1).type.name) ||
              $cursor.node(-1).childCount !== 1
            )
              return null;
            for (let depth = outerDepth; depth < $cursor.depth; depth++) {
              if ($cursor.index(depth) !== $cursor.node(depth).childCount - 1)
                return null;
            }
            previous = $cursor.node(outerDepth);
            from = $cursor.before(outerDepth);
            to = $cursor.after(outerDepth);
          } else {
            previous = state.doc.resolve($cursor.before()).nodeBefore;
            if (!isList(previous)) return null;
            // A blank line exits the rich-text list, but subsequent Markdown
            // numbers still continue that list regardless of their literal value.
            if (
              !match[1] &&
              (listName !== "orderedList" || previous!.type !== listType)
            )
              return null;
            from = $cursor.before() - previous!.nodeSize;
            to = $cursor.after();
          }
          const cleaned = pruneTail(previous!, $cursor.parent);
          if (!cleaned) return null;
          const indent = match[1].replace(/\t/g, "    ").length;
          const list = indent
            ? appendAtIndent(cleaned, nested, indent)
            : cleaned.type === nested.type
              ? cleaned.copy(cleaned.content.append(nested.content))
              : null;
          const replacement = list
            ? Fragment.from(list)
            : Fragment.fromArray([cleaned, nested]);
          state.tr.replaceWith(from, to, replacement);
          replacement.descendants((node, position) => {
            if (node === paragraph)
              state.tr.setSelection(
                TextSelection.create(state.tr.doc, from + position + 1),
              );
          });
        },
      }),
      new InputRule({
        find: /^(\d+)\. $/,
        handler: ({ state, range, match }) => {
          const $cursor = state.doc.resolve(range.to);
          if (
            $cursor.parent.type.name !== "paragraph" ||
            $cursor.parentOffset !== $cursor.parent.content.size
          )
            return null;
          const code = state.schema.marks.code;
          if (
            code &&
            $cursor.parent.rangeHasMark(0, $cursor.parent.content.size, code)
          )
            return null;
          // Enter can already have created the next numbered item. Consume a
          // matching explicit prefix instead of keeping a second visible number.
          if (
            $cursor.depth >= 3 &&
            $cursor.node(-1).type.name === "listItem" &&
            $cursor.node(-2).type.name === "orderedList" &&
            $cursor.index(-1) === 0 &&
            Number(match[1]) ===
              $cursor.node(-2).attrs.start + $cursor.index(-2)
          ) {
            state.tr.delete(range.from, range.to);
            return;
          }
          const previous = state.doc.resolve($cursor.before()).nodeBefore;
          if (
            previous?.type.name !== "orderedList" ||
            !previous.lastChild ||
            !emptyItem(previous.lastChild) ||
            Number(match[1]) !== previous.attrs.start + previous.childCount - 1
          )
            return null;
          const end = $cursor.before();
          state.tr.delete(end, $cursor.after());
          state.tr.setSelection(TextSelection.create(state.tr.doc, end - 3));
        },
      }),
    ];
  },
});
