import { Extension, getSchema, type JSONContent } from '@tiptap/core';
import type { Node as ModelNode, Schema } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { canvasNodesAndMarks } from './canvasSchema';
import { formulaPreview, maximumFormulaPreviewMarkup } from './formulaRendering';

// Very large editable DOM trees stall native accessibility queries. Source
// mode keeps the complete document editable without building that DOM tree.
export const maximumCanvasNodes = 10_000;
export const maximumCanvasCharacters = 250_000;

type TreeNode = JSONContent | ModelNode;
type CanvasCommentTarget = { kind: 'position' } | { kind: 'range'; from: number; to: number };
function isModelNode(node: TreeNode): node is ModelNode {
  return typeof (node as ModelNode).child === 'function';
}

function childCount(node: TreeNode): number {
  return isModelNode(node) ? node.childCount : node.content?.length ?? 0;
}

function child(node: TreeNode, index: number): TreeNode {
  return isModelNode(node) ? node.child(index) : node.content![index];
}

let tableSchema: Schema | undefined;

/** Bound table maps and the empty cells inserted by automatic table repair. */
function tableCanvasCost(table: TreeNode): number | undefined {
  const height = childCount(table);
  const expires: number[] = [];
  let activeSpans = 0;
  let width = 0;
  for (let rowIndex = 0; rowIndex < height; rowIndex += 1) {
    activeSpans -= expires[rowIndex] ?? 0;
    const row = child(table, rowIndex);
    let rowWidth = activeSpans;
    for (let index = 0; index < childCount(row); index += 1) {
      const cell = child(row, index);
      const colspan = cell.attrs?.colspan === undefined ? 1 : cell.attrs.colspan;
      const rowspan = cell.attrs?.rowspan === undefined ? 1 : cell.attrs.rowspan;
      if (!Number.isInteger(colspan) || colspan < 1 || colspan > 1000 ||
        !Number.isInteger(rowspan) || rowspan < 1 || rowspan > 65534) return undefined;
      const widths = cell.attrs?.colwidth;
      if (widths !== undefined && widths !== null && (!Array.isArray(widths) || widths.length > 1000 ||
        widths.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value) || value < 0))) return undefined;
      rowWidth += colspan;
      if (rowspan > 1) {
        activeSpans += colspan;
        const end = Math.min(height, rowIndex + rowspan);
        expires[end] = (expires[end] ?? 0) + colspan;
      }
    }
    width = Math.max(width, rowWidth);
    if (width * height > maximumCanvasNodes) return undefined;
  }
  // The resizable table view creates a col element for every logical column.
  let extraNodes = width;
  try {
    const model = isModelNode(table) ? table : (tableSchema ??= getSchema(canvasNodesAndMarks())).nodeFromJSON(table);
    for (const problem of TableMap.get(model).problems ?? []) {
      if (problem.type === 'missing') extraNodes += problem.n * 2;
      else if (problem.type === 'collision') {
        const cell = model.nodeAt(problem.pos);
        extraNodes += problem.n * Number(cell?.attrs.rowspan ?? 1) * 2;
      }
      if (extraNodes > maximumCanvasNodes) return undefined;
    }
  } catch { return undefined; }
  return extraNodes;
}

export function canvasDocumentSupported(
  document: TreeNode,
  comments: readonly { target: CanvasCommentTarget }[] = [],
): boolean {
  const frames = [{ node: document, index: -1 }];
  let nodes = 0;
  for (const { target } of comments) {
    if (target.kind === 'position' || target.from === target.to) {
      // A point marker creates a button, its label, and a split text node.
      nodes += 3;
      if (nodes > maximumCanvasNodes) return false;
    }
  }
  let characters = 0;
  let formulaMarkup = 0;
  while (frames.length) {
    const frame = frames[frames.length - 1];
    if (frame.index === -1) {
      nodes += 1;
      characters += frame.node.text?.length ?? 0;
      for (const key of ['source', 'latex']) {
        const value = frame.node.attrs?.[key];
        if (typeof value === 'string') characters += value.length;
      }
      if (nodes > maximumCanvasNodes || characters > maximumCanvasCharacters) return false;
      const type = isModelNode(frame.node) ? frame.node.type.name : frame.node.type;
      if (type === 'inlineFormula' || type === 'blockFormula') {
        const preview = formulaPreview(String(frame.node.attrs?.latex ?? ''), type === 'blockFormula');
        nodes += preview.nodes + 3;
        formulaMarkup += preview.html?.length ?? 0;
        if (nodes > maximumCanvasNodes || formulaMarkup > maximumFormulaPreviewMarkup) return false;
      }
      if (type === 'table') {
        const cost = tableCanvasCost(frame.node);
        if (cost === undefined) return false;
        nodes += cost;
        if (nodes > maximumCanvasNodes) return false;
      }
      const source = frame.node.attrs?.source;
      if ((type === 'htmlPreview' || type === 'inlineHtmlPreview') && typeof source === 'string') {
        // Preview atoms can render a large DOM tree beneath one model node.
        // Count tags conservatively, including inert quoted/comment markup,
        // without parsing a DOM just to decide whether it is safe to mount.
        const openingTags = /<\s*(?:[!?]|[A-Za-z][A-Za-z0-9:-]*(?=[\s/>]))/g;
        while (openingTags.exec(source)) {
          nodes += 1;
          if (nodes > maximumCanvasNodes) return false;
        }
      }
      frame.index = 0;
    }
    const children = isModelNode(frame.node) ? frame.node.childCount : frame.node.content?.length ?? 0;
    if (frame.index >= children) {
      frames.pop();
      continue;
    }
    const child = isModelNode(frame.node) ? frame.node.child(frame.index) : frame.node.content![frame.index];
    frame.index += 1;
    frames.push({ node: child, index: -1 });
  }
  return true;
}

export const CanvasCapacity = Extension.create<{ onLimit: () => void }>({
  name: 'canvasCapacity',
  addOptions: () => ({ onLimit: () => undefined }),
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction: (transaction) => {
        if (!transaction.docChanged || canvasDocumentSupported(transaction.doc)) return true;
        this.options.onLimit();
        return false;
      },
    })];
  },
});
