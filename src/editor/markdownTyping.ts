import { Extension, InputRule } from "@tiptap/core";
import { isHistoryTransaction } from "@tiptap/pm/history";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { completeTypedTable } from "./tableInput";
import { isEscaped } from "./formulaInput";

const formats = [
  { pattern: /(?<!`)`([^`\n]+)`(?!`)/g, delimiter: "`", mark: "code" },
  { pattern: /(?<!\*)\*\*([^*\n]+)\*\*(?!\*)/g, delimiter: "**", mark: "bold" },
  { pattern: /(?<!_)__([^_\n]+)__(?!_)/g, delimiter: "__", mark: "bold" },
  { pattern: /(?<!\*)\*([^*\n]+)\*(?!\*)/g, delimiter: "*", mark: "italic" },
  { pattern: /(?<!_)_([^_\n]+)_(?!_)/g, delimiter: "_", mark: "italic" },
];

/** Complete inline markers regardless of which side of the text was typed first. */
export const MarkdownTyping = Extension.create({
  name: "markdownTyping",
  priority: 1100,
  addInputRules() {
    return [
      new InputRule({
        // Default mark input rules do not check escaped closing markers or
        // escaped code openers. Keep those keystrokes literal.
        find: (text) => {
          for (const { pattern, delimiter, mark } of formats) {
            for (const match of text.matchAll(pattern)) {
              if (match.index + match[0].length !== text.length) continue;
              if (
                isEscaped(text, match.index) ||
                (mark !== "code" &&
                  isEscaped(text, text.length - delimiter.length))
              )
                return { index: match.index, text: match[0] };
            }
          }
          return null;
        },
        handler: ({ state, range, match }) => {
          state.tr.insertText(match[0], range.from, range.to);
        },
        undoable: false,
      }),
    ];
  },
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
          for (const { pattern, delimiter, mark: markName } of formats) {
            const markType = state.schema.marks[markName];
            if (!markType) continue;
            for (const match of text.matchAll(pattern)) {
              const start = match.index;
              const end = start + match[0].length;
              const width = delimiter.length;
              if ($from.parentOffset < start || $from.parentOffset > end)
                continue;
              if (!match[1].trim()) continue;
              if (
                isEscaped(text, start) ||
                (markName !== "code" && isEscaped(text, end - width))
              )
                continue;
              if (markName !== "code") {
                // Emphasis cannot open or close against whitespace. Underscores
                // inside identifiers are literal, including non-Latin words.
                if (/^\s|\s$/.test(match[1])) continue;
                if (
                  delimiter.startsWith("_") &&
                  (/[\p{L}\p{N}]/u.test(text[start - 1] ?? "") ||
                    /[\p{L}\p{N}]/u.test(text[end] ?? ""))
                )
                  continue;
                // Do not interpret emphasis in unfinished inline code.
                if (
                  text.slice(0, start).replace(/\\`/g, "").split("`").length %
                    2 ===
                  0
                )
                  continue;
              }
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
              const tr = state.tr
                .delete(to - width, to)
                .delete(from, from + width);
              const contentEnd = to - 2 * width;
              tr.addMark(from, contentEnd, markType.create());
              const caret = Math.max(
                from,
                Math.min(contentEnd, tr.mapping.map(state.selection.from)),
              );
              tr.setSelection(TextSelection.create(tr.doc, caret));
              // Keep typing inside a prewritten pair in that style, but let
              // prose following a closing marker resume without the style.
              if ($from.parentOffset >= end - width + 1)
                tr.removeStoredMark(markType);
              else tr.addStoredMark(markType.create());
              return tr;
            }
          }
          return null;
        },
      }),
    ];
  },
});
