import { Extension, type JSONContent } from '@tiptap/core';
import type { Node as ModelNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';

// Very large editable DOM trees stall native accessibility queries. Source
// mode keeps the complete document editable without building that DOM tree.
export const maximumCanvasNodes = 10_000;
export const maximumCanvasCharacters = 250_000;

type TreeNode = JSONContent | ModelNode;
function isModelNode(node: TreeNode): node is ModelNode {
  return typeof (node as ModelNode).child === 'function';
}

export function canvasDocumentSupported(document: TreeNode): boolean {
  const frames = [{ node: document, index: -1 }];
  let nodes = 0;
  let characters = 0;
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
