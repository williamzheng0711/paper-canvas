import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { isWindowsFilePath, localAssetPath } from "../lib/localAssets";
import { normalizeLatexDelimiters } from "./markdown";
import {
  commentContext,
  markdownFingerprint,
  parseMarkdownComments,
  relocateMarkdownComments,
  serializeMarkdownWithComments,
  type MarkdownComment,
} from "./comments";

type SourceNode = {
  type: string;
  url?: string;
  identifier?: string;
  children?: SourceNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
export type SourceEdit = { from: number; to: number; value: string };
export type MarkdownSourceChanges = {
  previousValue: string;
  changes: SourceEdit[];
};
type ImagePathOperation = "rebase" | "rename";
type DestinationKind = "markdown" | "html" | "plain";
type DestinationRewrite = (raw: string, kind: DestinationKind) => string;

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~]/;
const htmlTag =
  /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
const rawTextTags = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
]);

function basename(path: string): string {
  return path.split(path.startsWith("/") ? /\// : /[\\/]/).at(-1) ?? "";
}

function directory(path: string): string {
  const index = path.startsWith("/") ? path.lastIndexOf("/") : Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return ".";
  const parent = path.slice(0, index);
  return /^[A-Za-z]:$/.test(parent) ? parent + path[index] : parent || "/";
}

function assetFolder(path: string): string {
  return basename(path).replace(/\.md$/i, "") + ".assets";
}

function decodeEntity(entity: string): string {
  if (typeof document !== "undefined") {
    const decoder = document.createElement("textarea");
    decoder.innerHTML = entity;
    return decoder.value;
  }
  const numeric = /^&#(x[0-9a-f]+|\d+);$/i.exec(entity);
  if (numeric) {
    const code =
      numeric[1][0].toLowerCase() === "x"
        ? Number.parseInt(numeric[1].slice(1), 16)
        : Number(numeric[1]);
    if (code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
  }
  return (
    (
      {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
      } as Record<string, string>
    )[entity] ?? entity
  );
}

/** Decode syntax without losing the original character offsets to replace. */
function decodedDestination(
  raw: string,
  kind: DestinationKind,
  decodePercent = true,
): { text: string; ranges: Array<{ from: number; to: number }> } {
  let text = "";
  const ranges: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < raw.length;) {
    const from = index;
    let value = raw[index];
    if (
      decodePercent &&
      raw[index] === "%" &&
      /^%[0-9a-f]{2}/i.test(raw.slice(index))
    ) {
      const byte = Number.parseInt(raw.slice(index + 1, index + 3), 16);
      const length = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4;
      const encoded = raw.slice(index, index + length * 3);
      try {
        value = decodeURIComponent(encoded);
        index += encoded.length;
      } catch {
        index += 1;
      }
    } else if (
      kind === "markdown" &&
      raw[index] === "\\" &&
      punctuation.test(raw[index + 1] ?? "")
    ) {
      value = raw[index + 1];
      index += 2;
    } else if (kind !== "plain" && raw[index] === "&") {
      const entity = /^&(?:#[xX][0-9a-f]+|#\d+|[A-Za-z][A-Za-z0-9]+);/i.exec(
        raw.slice(index),
      );
      if (entity) {
        value = decodeEntity(entity[0]);
        index += entity[0].length;
      } else index += 1;
    } else index += 1;
    text += value;
    for (let unit = 0; unit < value.length; unit += 1)
      ranges.push({ from, to: index });
  }
  return { text, ranges };
}

/** Rename only a destination that resolves inside this document's asset folder. */
export function renameImageDestination(
  raw: string,
  oldPath: string,
  newPath: string,
  kind: DestinationKind = "plain",
): string {
  if (assetFolder(oldPath) === assetFolder(newPath)) return raw;
  const decoded = decodedDestination(raw, kind);
  if (
    /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(decoded.text) &&
    !/^file:\/\//i.test(decoded.text) &&
    !/^[A-Za-z]:[\\/]/.test(decoded.text)
  )
    return raw;
  const base = directory(oldPath);
  const oldAssets = localAssetPath(
    base,
    encodeURIComponent(assetFolder(oldPath)),
  ).path;
  const target = localAssetPath(
    base,
    decodedDestination(raw, kind, false).text,
  ).path;
  const windows = isWindowsFilePath(oldAssets);
  const separator = windows ? "\\" : "/";
  const equal = (left: string, right: string) =>
    windows ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!equal(target.slice(0, oldAssets.length + 1), oldAssets + separator))
    return raw;
  // Keep ./, parent segments, absolute paths, suffixes, and the original encoded
  // separators. Only the directory name itself needs to change on rename.
  let replacement: { from: number; to: number } | undefined;
  for (const match of decoded.text.matchAll(windows ? /[^/\\]+/g : /[^/]+/g)) {
    if (!equal(match[0], assetFolder(oldPath))) continue;
    const end = match.index + match[0].length;
    const prefix = encodeURI(decoded.text.slice(0, end))
      .replace(/#/g, "%23")
      .replace(/\?/g, "%3F");
    if (!equal(localAssetPath(base, prefix).path, oldAssets)) continue;
    replacement = {
      from: decoded.ranges[match.index].from,
      to: decoded.ranges[end - 1].to,
    };
  }
  if (!replacement) return raw;
  const nextFolder = encodeURIComponent(assetFolder(newPath)).replace(
    /[!'()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return (
    raw.slice(0, replacement.from) + nextFolder + raw.slice(replacement.to)
  );
}

function normalizedDirectory(path: string): string {
  const resolved = localAssetPath(directory(path), ".").path;
  return isWindowsFilePath(resolved) ? resolved.replace(/\\/g, "/") : resolved;
}

function encodedPathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Keep a relative image at its original physical location after Save As. */
export function rebaseImageDestination(
  raw: string,
  oldPath: string,
  newPath: string,
  kind: DestinationKind = "plain",
): string {
  const oldDirectory = normalizedDirectory(oldPath);
  const newDirectory = normalizedDirectory(newPath);
  const windows =
    /^[A-Za-z]:/.test(oldDirectory) || oldDirectory.startsWith("//");
  const equal = (left: string, right: string) =>
    windows ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (equal(oldDirectory, newDirectory)) return raw;
  const decoded = decodedDestination(raw, kind);
  const rootRelative = windows && /^[\\/](?![\\/])/.test(decoded.text);
  if (
    !decoded.text ||
    /^(?:[A-Za-z][A-Za-z0-9+.-]*:|[?#])/.test(decoded.text) ||
    (!rootRelative && (decoded.text.startsWith("/") || (windows && decoded.text.startsWith("\\"))))
  )
    return raw;

  let oldParts = oldDirectory.split("/").filter(Boolean);
  const newParts = newDirectory.split("/").filter(Boolean);
  const oldUnc = oldDirectory.startsWith("//");
  const newUnc = newDirectory.startsWith("//");
  const differentRoot =
    windows &&
    (oldUnc !== newUnc ||
      !equal(oldParts[0] ?? "", newParts[0] ?? "") ||
      (oldUnc && !equal(oldParts[1] ?? "", newParts[1] ?? "")));
  if (differentRoot) {
    // Different Windows drives cannot share a relative path. A file URL still
    // points at the existing image; originals are never copied or moved.
    const syntax = decodedDestination(raw, kind, false);
    const target = localAssetPath(oldDirectory.replace(/\//g, "\\"), syntax.text).path.replace(
      /\\/g,
      "/",
    );
    const suffix = syntax.text.search(/[?#]/);
    const originalSuffix =
      suffix < 0 ? "" : raw.slice(syntax.ranges[suffix].from);
    const encoded = target
      .split("/")
      .map((part, index) =>
        index === 0 && /^[A-Za-z]:$/.test(part)
          ? part
          : encodedPathSegment(part),
      )
      .join("/");
    return (
      (encoded.startsWith("//") ? "file:" : "file:///") +
      encoded +
      originalSuffix
    );
  }
  if (rootRelative) return raw;
  let relative = raw;
  const syntax = decodedDestination(raw, kind, false);
  const suffix = syntax.text.search(/[?#]/);
  try {
    decodeURIComponent(suffix < 0 ? syntax.text : syntax.text.slice(0, suffix));
  } catch {
    // A malformed percent in the original filename prevents decoding an added
    // directory prefix too. Encode the actual local target so both survive.
    const resolved = localAssetPath(oldDirectory, syntax.text).path;
    oldParts = (windows ? resolved.replace(/\\/g, "/") : resolved).split("/").filter(Boolean);
    relative = suffix < 0 ? "" : raw.slice(syntax.ranges[suffix].from);
  }
  let common = 0;
  while (
    common < oldParts.length &&
    common < newParts.length &&
    equal(oldParts[common], newParts[common])
  )
    common += 1;
  const prefix = [
    ...newParts.slice(common).map(() => ".."),
    ...oldParts.slice(common).map(encodedPathSegment),
  ].join("/");
  return prefix
    ? `${prefix}${relative && relative[0] !== "?" && relative[0] !== "#" ? "/" : ""}${relative}`
    : relative;
}

function applyEdits(source: string, edits: SourceEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort((left, right) => right.from - left.from)) {
    result = result.slice(0, edit.from) + edit.value + result.slice(edit.to);
  }
  return result;
}

function htmlImageEdits(
  source: string,
  rewrite: DestinationRewrite,
): SourceEdit[] {
  const edits: SourceEdit[] = [];
  let rawTextTag: string | undefined;
  for (const match of source.matchAll(htmlTag)) {
    const tag = match[0];
    const name = /^<(\/)?([A-Za-z][A-Za-z0-9:-]*)/.exec(tag);
    if (!name) continue;
    const lowerName = name[2].toLowerCase();
    if (rawTextTag) {
      if (name[1] && lowerName === rawTextTag) rawTextTag = undefined;
      continue;
    }
    if (!name[1] && rawTextTags.has(lowerName)) rawTextTag = lowerName;
    if (name[1] || lowerName !== "img") continue;
    for (const attribute of tag.matchAll(
      /\s+([^\s"'=<>`]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g,
    )) {
      if (attribute[1].toLowerCase() !== "src") continue;
      if (attribute[2] === undefined) break;
      const quoted = attribute[2][0] === '"' || attribute[2][0] === "'";
      const value = quoted ? attribute[2].slice(1, -1) : attribute[2];
      const renamed = rewrite(value, "html");
      if (renamed !== value) {
        const from =
          match.index +
          attribute.index +
          attribute[0].indexOf(attribute[2]) +
          (quoted ? 1 : 0);
        edits.push({ from, to: from + value.length, value: renamed });
      }
      break; // HTML uses the first src when duplicate attributes are present.
    }
  }
  return edits;
}

export function renameHtmlImageAssets(
  source: string,
  oldPath: string,
  newPath: string,
): string {
  return applyEdits(
    source,
    htmlImageEdits(source, (raw, kind) =>
      renameImageDestination(raw, oldPath, newPath, kind),
    ),
  );
}

export function rebaseHtmlImageAssets(
  source: string,
  oldPath: string,
  newPath: string,
): string {
  return applyEdits(
    source,
    htmlImageEdits(source, (raw, kind) =>
      rebaseImageDestination(raw, oldPath, newPath, kind),
    ),
  );
}

function closingBracket(source: string, start: number): number {
  let depth = 1;
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === "[") depth += 1;
    if (source[index] === "]" && --depth === 0) return index;
  }
  return -1;
}

function destinationRange(
  source: string,
  definition: boolean,
): { from: number; to: number } | undefined {
  const bracket = closingBracket(source, definition ? 0 : 1);
  if (bracket < 0 || source[bracket + 1] !== (definition ? ":" : "("))
    return undefined;
  let index = bracket + 2;
  while (/\s/.test(source[index] ?? "") && index < source.length) {
    const newline = source[index] === "\n";
    index += 1;
    if (newline)
      index += /^[ \t]*(?:>[ \t]*)+/.exec(source.slice(index))?.[0].length ?? 0;
  }
  if (source[index] === "<") {
    const from = index + 1;
    while (++index < source.length) {
      if (source[index] === "\\") index += 1;
      else if (source[index] === ">") return { from, to: index };
    }
    return undefined;
  }
  const from = index;
  let parentheses = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1;
      continue;
    }
    if (/\s/.test(source[index])) break;
    if (source[index] === "(") parentheses += 1;
    if (source[index] === ")") {
      if (parentheses === 0 && !definition) break;
      parentheses -= 1;
    }
  }
  return { from, to: index };
}

/** Keep the original offsets while hiding formula syntax from CommonMark. */
function maskTyporaMath(source: string): string {
  if (!/\\(?:\(|\[|begin\{)/.test(source)) return source;
  const sourceOffset = source.startsWith('\uFEFF') ? 1 : 0;
  let masked = source;
  let scan = source;
  const blank = (from: number, to: number) => {
    if (from === 0) from = sourceOffset;
    const placeholder = masked
      .slice(from, to)
      .replace(/[^\r\n]/g, " ")
      .replace(/ /, "x");
    masked = masked.slice(0, from) + placeholder + masked.slice(to);
  };
  const protectCodeAndMath = (node: SourceNode) => {
    if (["code", "inlineCode", "math", "inlineMath"].includes(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        const from = start + sourceOffset;
        const to = end + sourceOffset;
        scan =
          scan.slice(0, from) +
          scan.slice(from, to).replace(/[^\r\n]/g, " ") +
          scan.slice(to);
      }
    } else node.children?.forEach(protectCodeAndMath);
  };
  const rawRoot = parser.parse(source) as unknown as SourceNode;
  protectCodeAndMath(rawRoot);
  const protectDestinations = (node: SourceNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      start !== undefined &&
      end !== undefined &&
      ["image", "link", "definition"].includes(node.type)
    ) {
      const from = start + sourceOffset;
      const to = end + sourceOffset;
      const original = source.slice(from, to);
      const range = destinationRange(
        node.type === "link" ? "!" + original : original,
        node.type === "definition",
      );
      if (range) {
        const offset = node.type === "link" ? -1 : 0;
        const start = from + range.from + offset;
        const end = from + range.to + offset;
        scan =
          scan.slice(0, start) +
          scan.slice(start, end).replace(/[^\r\n]/g, " ") +
          scan.slice(end);
      }
    }
    node.children?.forEach(protectDestinations);
  };
  protectDestinations(rawRoot);
  const escaped = (index: number) => {
    let slashes = 0;
    while (index > 0 && scan[--index] === "\\") slashes += 1;
    return slashes % 2 === 1;
  };
  for (const match of scan.matchAll(/\\\(/g)) {
    if (escaped(match.index)) continue;
    const lineEnd = scan.indexOf("\n", match.index);
    let closing = scan.indexOf("\\)", match.index + 2);
    while (closing >= 0 && escaped(closing))
      closing = scan.indexOf("\\)", closing + 2);
    if (closing < 0 || (lineEnd >= 0 && closing > lineEnd)) continue;
    const normalized = normalizeLatexDelimiters(
      scan.slice(match.index, closing + 2),
    );
    if (normalized.startsWith("$") && normalized.endsWith("$"))
      blank(match.index, closing + 2);
  }
  for (const match of scan.matchAll(
    /^[^\S\r\n]*\\\[[\s\S]*?\\\][^\S\r\n]*$/gm,
  )) {
    const formula = match.index === 0 ? match[0].slice(sourceOffset) : match[0];
    if (normalizeLatexDelimiters(formula).startsWith("$$\n"))
      blank(match.index, match.index + match[0].length);
  }
  for (const match of scan.matchAll(
    /^[^\S\r\n]*\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}[\s\S]*?\\end\{\1\}[^\S\r\n]*$/gm,
  )) {
    const formula = match.index === 0 ? match[0].slice(sourceOffset) : match[0];
    if (normalizeLatexDelimiters(formula).startsWith("$$\n"))
      blank(match.index, match.index + match[0].length);
  }
  return masked;
}

/** Keep body bytes apart from image paths and refresh valid comment metadata. */
export function renameMarkdownImageAssets(
  source: string,
  oldPath: string,
  newPath: string,
): string {
  if (assetFolder(oldPath) === assetFolder(newPath)) return source;
  return rewriteMarkdownImageDestinations(source, (raw, kind) =>
    renameImageDestination(raw, oldPath, newPath, kind),
  );
}

export function rebaseMarkdownImageAssets(
  source: string,
  oldPath: string,
  newPath: string,
): string {
  if (normalizedDirectory(oldPath) === normalizedDirectory(newPath))
    return source;
  return rewriteMarkdownImageDestinations(source, (raw, kind) =>
    rebaseImageDestination(raw, oldPath, newPath, kind),
  );
}

function rewriteMarkdownImageDestinations(
  source: string,
  rewrite: DestinationRewrite,
): string {
  const parsed = parseMarkdownComments(source);
  const edits = markdownImageEdits(parsed.body, rewrite);
  const rewritten = applyEdits(parsed.body, edits);
  if (rewritten === parsed.body) return source;
  return parsed.status === "valid"
    ? serializeMarkdownWithComments(
        rewritten,
        commentsThroughSourceEdits(
          parsed.comments,
          parsed.body,
          rewritten,
          edits,
        ),
      )
    : rewritten;
}

function minimalSourceEdit(source: string, edit: SourceEdit): SourceEdit {
  const previous = source.slice(edit.from, edit.to);
  let prefix = 0;
  while (
    prefix < previous.length &&
    prefix < edit.value.length &&
    previous[prefix] === edit.value[prefix]
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < previous.length - prefix &&
    suffix < edit.value.length - prefix &&
    previous[previous.length - 1 - suffix] ===
      edit.value[edit.value.length - 1 - suffix]
  )
    suffix += 1;
  return {
    from: edit.from + prefix,
    to: edit.to - suffix,
    value: edit.value.slice(prefix, edit.value.length - suffix),
  };
}

function markdownImageEdits(
  source: string,
  rewrite: DestinationRewrite,
): SourceEdit[] {
  // remark removes a leading BOM before assigning offsets. Keep its syntax
  // positions aligned with the original bytes when applying image-path edits.
  const offset = source.startsWith('\uFEFF') ? 1 : 0;
  const root = parser.parse(maskTyporaMath(source)) as unknown as SourceNode;
  const nodes: SourceNode[] = [];
  const imageReferences = new Set<string>();
  const definitions = new Map<string, SourceNode>();
  const identifier = (node: SourceNode) =>
    (node.identifier ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const collect = (node: SourceNode) => {
    nodes.push(node);
    if (node.type === "imageReference") imageReferences.add(identifier(node));
    if (node.type === "definition" && !definitions.has(identifier(node)))
      definitions.set(identifier(node), node);
    node.children?.forEach(collect);
  };
  collect(root);
  const edits: SourceEdit[] = [];
  for (const node of nodes) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    const from = start + offset;
    const to = end + offset;
    const original = source.slice(from, to);
    if (node.type === "html") {
      edits.push(
        ...htmlImageEdits(original, rewrite).map((edit) => ({
          ...edit,
          from: from + edit.from,
          to: from + edit.to,
        })),
      );
    } else if (
      node.type === "image" ||
      (node.type === "definition" &&
        imageReferences.has(identifier(node)) &&
        definitions.get(identifier(node)) === node)
    ) {
      const range = destinationRange(original, node.type === "definition");
      if (!range) continue;
      const raw = original.slice(range.from, range.to);
      const renamed = rewrite(raw, "markdown");
      if (renamed !== raw)
        edits.push({
          from: from + range.from,
          to: from + range.to,
          value: renamed,
        });
    }
  }
  return edits
    .map((edit) => minimalSourceEdit(source, edit))
    .sort((left, right) => left.from - right.from);
}

/** Exact changes for one image-path update, including its comment metadata tail. */
export function imagePathSourceChanges(
  beforeSource: string,
  afterSource: string,
  oldPath: string,
  newPath: string,
  operation: ImagePathOperation = "rebase",
): MarkdownSourceChanges | undefined {
  const before = parseMarkdownComments(beforeSource);
  const after = parseMarkdownComments(afterSource);
  const rewrite: DestinationRewrite =
    operation === "rename"
      ? (raw, kind) => renameImageDestination(raw, oldPath, newPath, kind)
      : (raw, kind) => rebaseImageDestination(raw, oldPath, newPath, kind);
  const changes = markdownImageEdits(before.body, rewrite);
  if (
    before.status === "valid" &&
    after.status === "valid" &&
    applyEdits(before.body, changes) === after.body
  ) {
    const beforeTail = beforeSource.slice(before.body.length);
    const afterTail = afterSource.slice(after.body.length);
    if (beforeTail !== afterTail)
      changes.push({
        from: before.body.length,
        to: beforeSource.length,
        value: afterTail,
      });
  }
  if (applyEdits(beforeSource, changes) !== afterSource) return undefined;
  return { previousValue: beforeSource, changes };
}

function commentsThroughSourceEdits(
  comments: readonly MarkdownComment[],
  before: string,
  after: string,
  edits: SourceEdit[],
): MarkdownComment[] {
  const mapOffset = (offset: number, association: -1 | 1) => {
    let shift = 0;
    const position = Math.min(before.length, Math.max(0, offset));
    for (const edit of edits) {
      if (position < edit.from || (position === edit.from && association < 0))
        break;
      if (position < edit.to)
        return edit.from + shift + (association > 0 ? edit.value.length : 0);
      shift += edit.value.length - (edit.to - edit.from);
    }
    return Math.min(after.length, Math.max(0, position + shift));
  };
  return comments.map((comment) => {
    const target =
      comment.target.kind === "position"
        ? {
            kind: "position" as const,
            offset: mapOffset(comment.target.offset, 1),
          }
        : {
            kind: "range" as const,
            from: mapOffset(comment.target.from, 1),
            to: mapOffset(comment.target.to, -1),
          };
    if (target.kind === "range" && target.to < target.from)
      target.to = target.from;
    const context = commentContext(after, target);
    const changedTarget = edits.some(
      (edit) =>
        edit.to > edit.from &&
        (comment.target.kind === "position"
          ? comment.target.offset > edit.from && comment.target.offset < edit.to
          : comment.target.from < edit.to && comment.target.to > edit.from),
    );
    return {
      ...comment,
      target,
      contextBefore: context.before,
      contextAfter: context.after,
      anchorText: context.anchorText,
      bodyFingerprint: markdownFingerprint(after),
      status: changedTarget ? ("needs-review" as const) : comment.status,
    };
  });
}

/** Map canonical comment positions through the same verified image-path edits. */
export function mapImagePathComments(
  comments: readonly MarkdownComment[],
  before: string,
  after: string,
  oldPath: string,
  newPath: string,
  operation: ImagePathOperation = "rebase",
): MarkdownComment[] {
  const update = imagePathSourceChanges(
    before,
    after,
    oldPath,
    newPath,
    operation,
  );
  return update
    ? commentsThroughSourceEdits(comments, before, after, update.changes)
    : relocateMarkdownComments(comments, before, after);
}
