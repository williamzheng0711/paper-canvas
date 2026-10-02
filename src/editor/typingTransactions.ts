import type { ResolvedPos } from "@tiptap/pm/model";
import {
  Plugin,
  type EditorState,
  type PluginSpec,
  type Transaction,
} from "@tiptap/pm/state";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Mapping } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

/** Normalize typed markers only when their textblock actually changes. */
export function changedTypingTextblock(
  transactions: readonly Transaction[],
  oldState: EditorState,
  cursor: ResolvedPos,
): boolean {
  const committedComposition = transactions.some((transaction) =>
    transaction.getMeta("normalizeCommittedComposition"),
  );
  if (
    (!committedComposition &&
      !transactions.some((transaction) => transaction.docChanged)) ||
    transactions.some((transaction) => {
      const origin: Transaction =
        transaction.getMeta("appendedTransaction") ?? transaction;
      return (
        isHistoryTransaction(transaction) ||
        origin.getMeta("preventUpdate") ||
        origin.getMeta("skipTypingNormalization") ||
        ["paste", "drop"].includes(origin.getMeta("uiEvent"))
      );
    })
  )
    return false;

  const mapping = new Mapping();
  for (const transaction of transactions)
    mapping.appendMapping(transaction.mapping);
  const previous = oldState.doc.resolve(mapping.invert().map(cursor.pos, -1));
  // Attribute/mark updates and atom insertions must not reinterpret escaped
  // literal markers elsewhere in the paragraph at a stale canvas caret.
  return (
    committedComposition ||
    previous.parent.textContent !== cursor.parent.textContent
  );
}

/** Keep native composing text intact until its final DOM changes are flushed. */
export function compositionAwareTypingPlugin({
  appendTransaction,
}: {
  appendTransaction: NonNullable<PluginSpec<undefined>["appendTransaction"]>;
}): Plugin {
  let view: EditorView | undefined;
  let composition:
    { doc: EditorState["doc"]; changed: boolean; time: number } | undefined;
  return new Plugin({
    view(currentView) {
      view = currentView;
      return {
        destroy: () => {
          view = undefined;
        },
      };
    },
    props: {
      handleDOMEvents: {
        compositionstart: (currentView) => {
          composition = { doc: currentView.state.doc, changed: false, time: 0 };
          return false;
        },
        compositionend: (currentView) => {
          const pending = composition;
          if (!pending) return false;
          const { doc, selection } = currentView.state;
          // ProseMirror queues the final composition DOM flush after these
          // handlers. A second microtask runs after that flush, if needed.
          void Promise.resolve().then(() =>
            Promise.resolve().then(() => {
              if (composition !== pending) return;
              composition = undefined;
              if (
                !pending.changed ||
                currentView.state.doc.eq(pending.doc) ||
                view !== currentView ||
                currentView.isDestroyed ||
                currentView.composing ||
                currentView.state.doc !== doc ||
                !currentView.state.selection.eq(selection)
              )
                return;
              currentView.dispatch(
                currentView.state.tr
                  .setMeta("normalizeCommittedComposition", true)
                  .setTime(pending.time),
              );
            }),
          );
          return false;
        },
      },
    },
    appendTransaction(transactions, oldState, state) {
      if (view?.composing) {
        if (
          composition &&
          changedTypingTextblock(transactions, oldState, state.selection.$from)
        ) {
          composition.changed = true;
          composition.time = transactions.at(-1)!.time;
        }
        return null;
      }
      // A canceled composition can restore its original text in the final
      // native DOM flush. That restoration must preserve literal markers.
      if (composition && state.doc.eq(composition.doc)) return null;
      return appendTransaction.call(this, transactions, oldState, state);
    },
  });
}
