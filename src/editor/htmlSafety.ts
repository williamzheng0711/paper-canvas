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
  /<!--|<\s*\/?\s*([A-Za-z][A-Za-z0-9-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
const commentEnd = /--!?>/g;

function commentEndOffset(source: string, opening: number): number {
  const body = opening + 4;
  // HTML also recognizes these abrupt empty-comment endings.
  if (source[body] === ">") return body + 1;
  if (source[body] === "-" && source[body + 1] === ">") return body + 2;
  commentEnd.lastIndex = body;
  const closing = commentEnd.exec(source);
  return closing ? closing.index + closing[0].length : -1;
}

export function isHtmlCommentOnly(source: string): boolean {
  let cursor = 0;
  let found = false;
  while (cursor < source.length) {
    const opening = source.indexOf("<!--", cursor);
    if (opening < 0) return found && source.slice(cursor).trim() === "";
    if (source.slice(cursor, opening).trim()) return false;
    const closing = commentEndOffset(source, opening);
    if (closing < 0) return false;
    found = true;
    cursor = closing;
  }
  return found;
}

/**
 * Keeps executable, embedded, and unknown HTML in PaperCanvas's existing
 * source-warning node. Only a deliberately small document-layout subset is
 * eligible for the sanitized visual preview.
 */
export function isHtmlPreviewCandidate(source: string): boolean {
  if (isHtmlCommentOnly(source)) return true;
  let foundTag = false;
  htmlTag.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = htmlTag.exec(source))) {
    if (match[0] === "<!--") {
      // Search each comment once. A lazy regex retries every unfinished
      // opening and freezes on a small file containing many '<!--' strings.
      const closing = commentEndOffset(source, match.index);
      if (closing < 0) break;
      htmlTag.lastIndex = closing;
      continue;
    }
    foundTag = true;
    if (!previewTagSet.has(match[1].toLowerCase())) return false;
  }
  return foundTag;
}
