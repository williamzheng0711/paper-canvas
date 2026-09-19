import type { Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { isEscaped } from "./formulaInput";

/** Split a typed row by unescaped pipes outside code and formula atoms. */
function cells(
  node: ProseMirrorNode,
): Array<{ from: number; to: number; text: string }> | null {
  if (node.type.name !== "paragraph") return null;
  const text = node.textBetween(0, node.content.size, "\n", "\ufffc");
  if (!/^\s*\|/.test(text) || !/\|\s*$/.test(text)) return null;
  const boundaries: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "|" || isEscaped(text, i)) continue;
    const code = node.type.schema.marks.code;
    if (code && node.rangeHasMark(i, i + 1, code)) continue;
    boundaries.push(i);
  }
  if (
    boundaries.length < 2 ||
    boundaries[0] !== text.search(/\S/) ||
    boundaries[boundaries.length - 1] !== text.trimEnd().length - 1
  )
    return null;
  return boundaries.slice(0, -1).map((start, index) => {
    const raw = text.slice(start + 1, boundaries[index + 1]);
    const from = start + 1 + (raw.length - raw.trimStart().length);
    return {
      from,
      to: Math.max(
        from,
        boundaries[index + 1] - (raw.length - raw.trimEnd().length),
      ),
      text: raw.trim(),
    };
  });
}

function cellContent(
  node: ProseMirrorNode,
  from: number,
  to: number,
  schema: Schema,
): ProseMirrorNode {
  let content = node.content.cut(from, to);
  const text = node.textBetween(from, to, "\n", "\ufffc");
  // A backslash that protects a cell pipe is Markdown syntax, not visible text.
  // Remove only that escape while preserving the inline nodes and their marks.
  for (let index = text.length - 1; index > 0; index--) {
    if (text[index] === "|" && isEscaped(text, index)) {
      content = content.cut(0, index - 1).append(content.cut(index));
    }
  }
  return schema.nodes.paragraph.create(null, content);
}

/** Commit contiguous pipe rows when Enter is pressed on the following blank line. */
export function completeTypedTable(state: EditorState): Transaction | null {
  const { $from, empty } = state.selection;
  const { schema } = state;
  if (
    !empty ||
    $from.depth < 1 ||
    $from.parent.type.name !== "paragraph" ||
    $from.parent.content.size !== 0 ||
    !schema.nodes.table
  )
    return null;
  const parent = $from.node(-1);
  const endIndex = $from.index(-1);
  const rows: ProseMirrorNode[] = [];
  let from = $from.before();
  for (let index = endIndex - 1; index >= 0; index--) {
    const node = parent.child(index);
    if (!cells(node)) break;
    rows.unshift(node);
    from -= node.nodeSize;
  }
  if (rows.length < 2) return null;
  const parsed = rows.map((node) => cells(node)!);
  const width = parsed[0].length;
  if (
    parsed.some((row) => row.length !== width) ||
    !parsed[1].every((cell) => /^:?-{3,}:?$/.test(cell.text))
  )
    return null;
  const tableRows = rows.flatMap((node, index) =>
    index === 1
      ? []
      : [
          schema.nodes.tableRow.create(
            null,
            parsed[index].map((cell) =>
              schema.nodes[index === 0 ? "tableHeader" : "tableCell"].create(
                null,
                cellContent(node, cell.from, cell.to, schema),
              ),
            ),
          ),
        ],
  );
  const table = schema.nodes.table.create(null, tableRows);
  if (!parent.canReplaceWith(endIndex - rows.length, endIndex, table.type))
    return null;
  const tr = state.tr.replaceWith(from, $from.before(), table);
  return tr.setSelection(
    TextSelection.create(tr.doc, from + table.nodeSize + 1),
  );
}
