import { Extension } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { completeTypedTable } from "./tableInput";
import { isEscaped } from "./formulaInput";

/** Complete bold markers regardless of which side of the text was typed first. */
export const MarkdownTyping = Extension.create({
  name: "markdownTyping",
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const tr = completeTypedTable(this.editor.state);
        if (!tr) return false;
        this.editor.view.dispatch(tr);
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, state) {
          if (
            !transactions.some((tr) => tr.docChanged) ||
            transactions.some(isHistoryTransaction)
          )
            return null;
          if (
            !(state.selection instanceof TextSelection) ||
            !state.selection.empty
          )
            return null;
          const { $from } = state.selection;
          if (!$from.parent.isTextblock || $from.parent.type.spec.code)
            return null;
          // A leaf placeholder preserves document offsets around formulas/images.
          const text = $from.parent.textBetween(
            0,
            $from.parent.content.size,
            "\n",
            "\ufffc",
          );
          const pattern = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;
          for (const match of text.matchAll(pattern)) {
            const start = match.index;
            const end = start + match[0].length;
            if ($from.parentOffset < start || $from.parentOffset > end)
              continue;
            if (!match[1]?.trim() && !match[2]?.trim()) continue;
            if (isEscaped(text, start) || isEscaped(text, end - 2))
              continue;
            // Dollar-delimited source belongs to the formula input rules.
            if (
              text.slice(0, start).replace(/\\\$/g, "").split("$").length %
                2 ===
              0
            )
              continue;
            const from = $from.start() + start;
            const to = $from.start() + end;
            const code = state.schema.marks.code;
            if (code && state.doc.rangeHasMark(from, to, code)) continue;
            const tr = state.tr.delete(to - 2, to).delete(from, from + 2);
            tr.addMark(from, to - 4, state.schema.marks.bold.create());
            const caret = Math.max(
              from,
              Math.min(to - 4, tr.mapping.map(state.selection.from)),
            );
            tr.setSelection(TextSelection.create(tr.doc, caret));
            // Do not make subsequent prose bold when the caret is at its end.
            if ($from.parentOffset >= end - 1)
              tr.removeStoredMark(state.schema.marks.bold);
            else tr.addStoredMark(state.schema.marks.bold.create());
            return tr;
          }
          return null;
        },
      }),
    ];
  },
});
