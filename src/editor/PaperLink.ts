import Link from "@tiptap/extension-link";
import Code from "@tiptap/extension-code";
import type { Attribute } from "@tiptap/core";

export const PaperLink = Link.extend({
  addAttributes() {
    const inherited = this.parent?.() as Record<string, Attribute> | undefined;
    return { ...inherited, href: { ...inherited?.href, validate: "string|null" }, title: { default: null } };
  },
});

// Markdown permits links and emphasis around inline code. StarterKit's default
// code mark excludes every other mark, stripping those authored hyperlinks.
export const PaperCode = Code.extend({ excludes: "" });
