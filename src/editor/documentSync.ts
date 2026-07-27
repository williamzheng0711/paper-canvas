import type { Editor, JSONContent } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';

export function documentsEqual(left: JSONContent, right: JSONContent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Replace an editor document without moving a valid existing selection. */
export function replaceDocumentPreservingSelection(editor: Editor, document: JSONContent): void {
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
