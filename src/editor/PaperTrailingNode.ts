import { TrailingNode, type TrailingNodeOptions } from "@tiptap/extensions";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Plugin } from "@tiptap/pm/state";

/** Reading, selection and focus must not silently change the saved document. */
export const PaperTrailingNode = TrailingNode.extend<TrailingNodeOptions>({
  addProseMirrorPlugins() {
    return (this.parent?.() ?? []).map((plugin) => {
      const appendTransaction = plugin.spec.appendTransaction;
      return new Plugin({
        ...plugin.spec,
        appendTransaction(transactions, oldState, state) {
          // Undo restores the document as it was, including whether its final
          // node originally needed an extra editable paragraph.
          if (
            !transactions.some((transaction) => transaction.docChanged) ||
            transactions.some(isHistoryTransaction)
          )
            return;
          return appendTransaction?.call(this, transactions, oldState, state);
        },
      });
    });
  },
});
