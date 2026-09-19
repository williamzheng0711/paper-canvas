import { Extension, InputRule, wrappingInputRule } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { canJoin, findWrapping, liftTarget } from "@tiptap/pm/transform";

type Prefix = { start: number; count: number };
const prefixKey = new PluginKey<Prefix | null>("explicitQuotePrefix");

function quoteDepth(tr: Transaction): number {
  const { $from } = tr.selection;
  let depth = 0;
  for (let level = $from.depth - 1; level > 0; level--) {
    if ($from.node(level).type.name !== "blockquote") break;
    depth++;
  }
  return depth;
}

function setQuoteDepth(tr: Transaction, desired: number): boolean {
  while (quoteDepth(tr) > desired) {
    const range = tr.selection.$from.blockRange();
    const target = range && liftTarget(range);
    if (!range || target === null) return false;
    tr.lift(range, target);
  }
  while (quoteDepth(tr) < desired) {
    const range = tr.selection.$from.blockRange();
    const wrapping =
      range && findWrapping(range, tr.doc.type.schema.nodes.blockquote);
    if (!range || !wrapping) return false;
    tr.wrap(range, wrapping);
    const boundary = tr.selection.$from.before(tr.selection.$from.depth - 1);
    if (
      tr.doc.resolve(boundary).nodeBefore?.type.name === "blockquote" &&
      canJoin(tr.doc, boundary)
    )
      tr.join(boundary);
  }
  return true;
}

/** Repeated explicit Markdown prefixes should not accidentally nest quotes. */
export const QuoteTyping = Extension.create({
  name: "quoteTyping",
  priority: 1100,
  addInputRules() {
    const initial = wrappingInputRule({
      find: /^> $/,
      type: this.editor.schema.nodes.blockquote,
    });
    return [
      new InputRule({
        find: /^> $/,
        handler: (props) => {
          const { state, range } = props;
          const $from = state.selection.$from;
          if ($from.parent.type.name !== "paragraph") return null;
          const count = (prefixKey.getState(state)?.count ?? 0) + 1;
          const tr = state.tr;
          if (quoteDepth(tr) === 0) {
            if (initial.handler(props) === null) return null;
          } else {
            tr.delete(range.from, range.to);
            if (!setQuoteDepth(tr, count)) return null;
          }
          tr.setMeta(prefixKey, { start: tr.selection.$from.start(), count });
        },
      }),
    ];
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => {
        const { state, view } = this.editor;
        const { $from, empty } = state.selection;
        const prefix = prefixKey.getState(state);
        const bare = $from.parent.textContent === ">";
        const prefixedEmpty = $from.parent.content.size === 0 && !!prefix;
        if (
          !empty ||
          $from.parent.type.name !== "paragraph" ||
          (!bare && !prefixedEmpty) ||
          $from.parentOffset !== $from.parent.content.size ||
          $from.parent.firstChild?.marks.some(
            (mark) => mark.type.name === "code",
          )
        )
          return false;
        const count = (prefix?.count ?? 0) + (bare ? 1 : 0);
        const tr = state.tr.delete($from.start(), $from.end());
        if (!setQuoteDepth(tr, count)) return false;
        // A bare quote marker denotes an empty quoted line. Keep its paragraph
        // ready for the following line; another empty Enter still exits normally.
        tr.setMeta(prefixKey, null);
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin<Prefix | null>({
        key: prefixKey,
        state: {
          init: () => null,
          apply(tr, previous) {
            const explicit = tr.getMeta(prefixKey);
            if (explicit !== undefined) return explicit;
            if (!previous) return null;
            const start = tr.mapping.map(previous.start, -1);
            const { $from, empty } = tr.selection;
            return empty &&
              $from.start() === start &&
              /^>?$/.test($from.parent.textContent)
              ? { ...previous, start }
              : null;
          },
        },
      }),
    ];
  },
});
