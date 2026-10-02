import Link from "@tiptap/extension-link";
import Code from "@tiptap/extension-code";

export const PaperLink = Link.extend({
  addAttributes() {
    return { ...this.parent?.(), title: { default: null } };
  },
});

// Markdown permits links and emphasis around inline code. StarterKit's default
// code mark excludes every other mark, stripping those authored hyperlinks.
export const PaperCode = Code.extend({ excludes: "" });
