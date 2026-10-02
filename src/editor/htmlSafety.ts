export const previewHtmlTags = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
] as const;

export const previewHtmlAttributes = [
  "align",
  "alt",
  "colspan",
  "dir",
  "height",
  "href",
  "lang",
  "open",
  "reversed",
  "rowspan",
  "scope",
  "src",
  "start",
  "title",
  "width",
] as const;

const previewTagSet = new Set<string>(previewHtmlTags);
const htmlTag =
  /<!--[\s\S]*?-->|<\s*\/?\s*([A-Za-z][A-Za-z0-9-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;

export function isHtmlCommentOnly(source: string): boolean {
  return (
    /<!--[\s\S]*?-->/.test(source) &&
    source.replace(/<!--[\s\S]*?-->/g, "").trim() === ""
  );
}

/**
 * Keeps executable, embedded, and unknown HTML in PaperCanvas's existing
 * source-warning node. Only a deliberately small document-layout subset is
 * eligible for the sanitized visual preview.
 */
export function isHtmlPreviewCandidate(source: string): boolean {
  if (isHtmlCommentOnly(source)) return true;
  let foundTag = false;
  for (const match of source.matchAll(htmlTag)) {
    if (!match[1]) continue;
    foundTag = true;
    if (!previewTagSet.has(match[1].toLowerCase())) return false;
  }
  return foundTag;
}
