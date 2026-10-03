import type { Editor, JSONContent } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node } from '@tiptap/pm/model';
import { Selection } from '@tiptap/pm/state';
import { canvasAssetAttributes, canvasAssetRefresh } from './canvasAssetHistory';

export function documentsEqual(left: JSONContent, right: JSONContent): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

/** Replace an editor document without moving a valid existing selection. */
export function replaceDocumentPreservingSelection(
  editor: Editor,
  document: JSONContent,
  { assetRefresh = false }: { assetRefresh?: boolean } = {},
): void {
  const replacement = editor.schema.nodeFromJSON(document);
  const attributeChanges: { position: number; node: Node }[] = [];
  const sameContent = (current: Node, next: Node, position: number): boolean => {
    if (current.type !== next.type || current.text !== next.text || current.childCount !== next.childCount ||
      JSON.stringify(current.marks) !== JSON.stringify(next.marks)) return false;
    if (JSON.stringify(current.attrs) !== JSON.stringify(next.attrs)) {
      const names = canvasAssetAttributes[current.type.name];
      const changed = Object.keys(next.attrs).filter((name) => JSON.stringify(current.attrs[name]) !== JSON.stringify(next.attrs[name]));
      if (!names || changed.some((name) => !names.includes(name))) return false;
      attributeChanges.push({ position, node: next });
    }
    let offset = position + (current.isText ? 0 : 1);
    for (let index = 0; index < current.childCount; index++) {
      if (!sameContent(current.child(index), next.child(index), offset)) return false;
      offset += current.child(index).nodeSize;
    }
    return true;
  };
  // Asset persistence changes attributes, not the user's document structure.
  // Empty attribute maps keep earlier edits and their redo ranges intact.
  if (assetRefresh && sameContent(editor.state.doc, replacement, -1)) {
    if (!attributeChanges.length) return;
    const transaction = closeHistory(editor.state.tr)
      .setMeta('addToHistory', false).setMeta('preventUpdate', true)
      .setMeta(canvasAssetRefresh, true);
    for (const { position, node } of attributeChanges) {
      for (const [name, value] of Object.entries(node.attrs)) {
        const current = position < 0 ? transaction.doc : transaction.doc.nodeAt(position);
        if (JSON.stringify(current?.attrs[name]) !== JSON.stringify(value)) {
          if (position < 0) transaction.setDocAttribute(name, value);
          else transaction.setNodeAttribute(position, name, value);
        }
      }
    }
    editor.view.dispatch(transaction);
    return;
  }
  const selection = editor.state.selection.toJSON();
  const originalPosition = editor.state.selection.from;
  editor.commands.setContent(document, { emitUpdate: false });

  let restored: Selection;
  try {
    restored = Selection.fromJSON(editor.state.doc, selection);
  } catch {
    const position = Math.min(originalPosition, editor.state.doc.content.size);
    restored = Selection.near(editor.state.doc.resolve(position), -1);
  }
  editor.view.dispatch(editor.state.tr.setSelection(restored));
}
