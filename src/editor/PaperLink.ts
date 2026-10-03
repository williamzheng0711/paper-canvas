import Link from "@tiptap/extension-link";
import Code from "@tiptap/extension-code";
import { isMarkActive, type Attribute } from "@tiptap/core";
import { Fragment, Slice, type Mark } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";

export const PaperLink = Link.extend({
  addAttributes() {
    const inherited = this.parent?.() as Record<string, Attribute> | undefined;
    return { ...inherited, href: { ...inherited?.href, validate: "string|null" }, title: { default: null } };
  },
});

// Markdown permits links and emphasis around inline code. StarterKit's default
// code mark excludes every other mark, stripping those authored hyperlinks.
function codeMarkedText(fragment: Fragment, mark: Mark): Fragment {
  return Fragment.fromArray(fragment.content.map((node) => node.isText
    ? node.mark(mark.addToSet(node.marks))
    : node.isLeaf ? node : node.copy(codeMarkedText(node.content, mark))));
}

export const PaperCode = Code.extend({
  excludes: "",
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        props: {
          transformPasted(slice, view, plainText) {
            const { selection, schema } = view.state;
            const { $from } = selection;
            const code = schema.marks.code;
            if (!plainText || !code || !$from.parent.isTextblock || $from.parent.type.spec.code)
              return slice;
            if (!isMarkActive(view.state, code)) return slice;
            // Keep native clipboard paragraph/newline handling. Only restore
            // the inline code style at a selected span's unmarked boundary.
            return new Slice(codeMarkedText(slice.content, code.create()), slice.openStart, slice.openEnd);
          },
        },
      }),
    ];
  },
});
