import type { JSONContent } from "@tiptap/core";
import type {} from "mdast-util-gfm-strikethrough";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { getMessages } from "../i18n";
import { parseMarkdownComments } from "./comments";
import { isDisplayLatexEnvironment } from "./formulaInput";
import { isHtmlPreviewCandidate } from "./htmlSafety";
import { requiresHtmlTable, tableToHtml } from "./markdownTableHtml";

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  depth?: number;
  ordered?: boolean;
  start?: number;
  checked?: boolean | null;
  url?: string;
  alt?: string | null;
  title?: string | null;
  lang?: string | null;
  identifier?: string;
  label?: string;
  originalSource?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  align?: Array<"left" | "right" | "center" | null>;
};

type MdRoot = MdNode & { children: MdNode[] };

function hasExtremeNesting(root: MdNode): boolean {
  const pending: Array<{ node: MdNode; depth: number }> = [
    { node: root, depth: 0 },
  ];
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    // Parser trees can be deeper than the recursive editor/schema walkers or
    // the browser DOM can safely support. Preserve their source as one atom.
    if (depth > 256) return true;
    for (const child of node.children ?? [])
      pending.push({ node: child, depth: depth + 1 });
  }
  return false;
}

function preservedSourceDocument(source: string): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "unsupportedMarkdown",
        attrs: { source, reason: getMessages().unsupportedMarkdownReason },
      },
    ],
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, {
    handlers: {
      delete(node, _parent, state, info) {
        const exit = state.enter("strikethrough");
        const tracker = state.createTracker(info);
        const opening = tracker.move("~~");
        let value = state.containerPhrasing(node, {
          ...tracker.current(),
          before: opening,
          after: "~",
        });
        // GFM rejects whitespace just inside ~~ delimiters. Entity escaping
        // retains the exact marked text when a user strikes a spaced run.
        if (/^\s/.test(value))
          value = `&#${value.charCodeAt(0)};${value.slice(1)}`;
        if (/\s$/.test(value))
          value = `${value.slice(0, -1)}&#${value.charCodeAt(value.length - 1)};`;
        tracker.move(value);
        const closing = tracker.move("~~");
        exit();
        return opening + value + closing;
      },
    },
  });
const imageSizeTitle = /^papercanvas-size:(\d+)x(\d+)(?:\s+\|\s+([\s\S]*))?$/i;
const inlineMarkTypes = new Set([
  "text",
  "inlineFormula",
  "inlineHtmlPreview",
  "footnoteReference",
]);

function carriesLink(nodes: JSONContent[]): boolean {
  return nodes.some((node) =>
    node.type === "text"
      ? Boolean(node.text)
      : node.type === "image" || inlineMarkTypes.has(node.type ?? ""),
  );
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  )
    slashes += 1;
  return slashes % 2 === 1;
}

type SourceRange = { start: number; end: number };

function normalizeInlineLatexDelimiters(
  line: string,
  literalRanges: SourceRange[] = [],
): string {
  let result = "";
  let cursor = 0;
  let dollarDelimiter: "$" | "$$" | null = null;
  let rangeIndex = 0;

  while (cursor < line.length) {
    const literal = literalRanges[rangeIndex];
    if (literal && cursor >= literal.start) {
      result += line.slice(cursor, literal.end);
      cursor = literal.end;
      rangeIndex += 1;
      continue;
    }

    if (line[cursor] === "$" && !isEscaped(line, cursor)) {
      const delimiter = line[cursor + 1] === "$" ? "$$" : "$";
      if (dollarDelimiter === null) dollarDelimiter = delimiter;
      else if (dollarDelimiter === delimiter) dollarDelimiter = null;
      result += delimiter;
      cursor += delimiter.length;
      continue;
    }

    if (
      dollarDelimiter === null &&
      line.startsWith("\\(", cursor) &&
      !isEscaped(line, cursor)
    ) {
      let closing = line.indexOf("\\)", cursor + 2);
      while (closing !== -1 && isEscaped(line, closing)) {
        closing = line.indexOf("\\)", closing + 2);
      }
      if (closing !== -1) {
        result += `$${line.slice(cursor + 2, closing)}$`;
        cursor = closing + 2;
        continue;
      }
    }

    result += line[cursor];
    cursor += 1;
  }
  return result;
}

/**
 * Converts the LaTeX delimiters accepted by Typora into remark-math's dollar
 * delimiters, without touching fenced/indented code or inline code spans.
 */
export function normalizeLatexDelimiters(markdown: string): string {
  if (!/\\(?:[([]|begin\{)|\$\$/.test(markdown)) return markdown;

  // Markdown's parser knows where nested fences, multiline code spans and
  // paired HTML end. Line-based fence detection alone rewrites literal TeX in
  // quoted/list code and changes the source of supposedly lossless previews.
  const literalRoot = processor.parse(markdown) as unknown as MdRoot;
  if (hasExtremeNesting(literalRoot)) return markdown;
  groupInlineHtml(literalRoot, markdown);
  const literalRanges: SourceRange[] = [];
  const collectLiteralRanges = (node: MdNode) => {
    if (["code", "inlineCode", "html"].includes(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        literalRanges.push({ start, end });
      return;
    }
    node.children?.forEach(collectLiteralRanges);
  };
  collectLiteralRanges(literalRoot);
  literalRanges.sort((left, right) => left.start - right.start);
  const lines = markdown.split("\n");
  const normalized: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let bracketOpeningIndex: number | null = null;
  let bracketOpeningSource = "";
  let dollarDisplayBlock = false;
  let latexEnvironment: {
    name: string;
    openingIndex: number;
    indent: string;
  } | null = null;
  let lineOffset = 0;
  let rangeIndex = 0;

  for (const line of lines) {
    const lineStart = lineOffset;
    const lineEnd = lineStart + line.length;
    lineOffset = lineEnd + 1;
    while (literalRanges[rangeIndex]?.end <= lineStart) rangeIndex += 1;
    const lineRanges: SourceRange[] = [];
    for (
      let index = rangeIndex;
      literalRanges[index]?.start < lineEnd;
      index += 1
    ) {
      const range = literalRanges[index];
      lineRanges.push({
        start: Math.max(0, range.start - lineStart),
        end: Math.min(line.length, range.end - lineStart),
      });
    }
    if (latexEnvironment !== null) {
      normalized.push(line);
      if (
        new RegExp(
          `\\\\end\\{${latexEnvironment.name.replace(/\*/g, "\\*")}\\}\\s*$`,
        ).test(line)
      ) {
        normalized.push(`${latexEnvironment.indent}$$`);
        latexEnvironment = null;
      }
      continue;
    }
    if (bracketOpeningIndex !== null) {
      const closing = /^([ \t]*)\\\]\s*$/.exec(line);
      if (closing) {
        normalized.push(`${closing[1]}$$`);
        bracketOpeningIndex = null;
        bracketOpeningSource = "";
      } else {
        normalized.push(line);
      }
      continue;
    }

    if (lineRanges.length > 0) {
      normalized.push(normalizeInlineLatexDelimiters(line, lineRanges));
      continue;
    }

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      normalized.push(line);
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        line.slice(fenceMatch[0].length).trim() === ""
      ) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1][0] as "`" | "~",
        length: fenceMatch[1].length,
      };
      normalized.push(line);
      continue;
    }

    // Actual indented code is protected by parser ranges above. Indentation
    // alone also occurs in list and footnote continuation paragraphs, where
    // inline TeX must still be converted into an editable formula.

    if (dollarDisplayBlock) {
      normalized.push(line);
      if (/^\s*\$\$\s*$/.test(line)) dollarDisplayBlock = false;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      dollarDisplayBlock = true;
      normalized.push(line);
      continue;
    }

    // Expand complete display lines here, where code fences are already
    // excluded. A document-wide replacement also changes literal code samples.
    const sameLineDollarDisplay = /^([ \t]*)\$\$([^\n]+)\$\$\s*$/.exec(line);
    if (sameLineDollarDisplay) {
      const [, indent, latex] = sameLineDollarDisplay;
      normalized.push(`${indent}$$`, `${indent}${latex}`, `${indent}$$`);
      continue;
    }

    const sameLineBracketDisplay =
      /^([ \t]*)\\\[\s*([\s\S]*?\S)\s*\\\]\s*$/.exec(line);
    if (sameLineBracketDisplay) {
      const [, indent, latex] = sameLineBracketDisplay;
      normalized.push(`${indent}$$`, `${indent}${latex}`, `${indent}$$`);
      continue;
    }

    const bracketOpening = /^([ \t]*)\\\[\s*$/.exec(line);
    if (bracketOpening) {
      bracketOpeningIndex = normalized.length;
      bracketOpeningSource = line;
      normalized.push(`${bracketOpening[1]}$$`);
      continue;
    }

    const environmentOpening =
      /^([ \t]*)\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}/.exec(line);
    if (
      environmentOpening &&
      isDisplayLatexEnvironment(environmentOpening[2])
    ) {
      const [, indent, name] = environmentOpening;
      const closing = new RegExp(
        `\\\\end\\{${name.replace(/\*/g, "\\*")}\\}\\s*$`,
      );
      const openingIndex = normalized.length;
      normalized.push(`${indent}$$`, line);
      if (closing.test(line)) normalized.push(`${indent}$$`);
      else latexEnvironment = { name, openingIndex, indent };
      continue;
    }
    normalized.push(normalizeInlineLatexDelimiters(line));
  }

  // An unmatched opening delimiter is prose, not a display formula. Restore it
  // so malformed input is retained verbatim instead of being reinterpreted.
  if (bracketOpeningIndex !== null)
    normalized[bracketOpeningIndex] = bracketOpeningSource;
  if (latexEnvironment !== null)
    normalized.splice(latexEnvironment.openingIndex, 1);
  return normalized.join("\n");
}

type MarkdownContext = "block" | "inline";

function definitionKey(identifier: string): string {
  return identifier.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Resolve CommonMark references before converting to the editor schema. */
function resolveReferences(root: MdRoot, source: string): void {
  const definitions = new Map<string, MdNode>();
  const used = new Set<string>();
  const retained = new Set<string>();
  const collect = (node: MdNode) => {
    if (["link", "linkReference", "definition"].includes(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        node.originalSource = source.slice(start, end);
    }
    if (node.type === "definition" && node.identifier) {
      const key = definitionKey(node.identifier);
      if (!definitions.has(key)) definitions.set(key, node);
    }
    node.children?.forEach(collect);
  };
  collect(root);
  const resolve = (node: MdNode) => {
    node.children?.forEach(resolve);
    if (node.type === "linkReference" || node.type === "imageReference") {
      const key = definitionKey(node.identifier ?? "");
      const definition = definitions.get(key);
      if (definition) {
        node.type = node.type === "linkReference" ? "link" : "image";
        node.url = definition.url;
        node.title = definition.title;
        if (
          node.type === "image" ||
          carriesLink(content(node.children, "inline"))
        )
          used.add(key);
        else retained.add(key);
      }
    }
  };
  resolve(root);
  const removeConsumedDefinitions = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.filter(
      (child) =>
        child.type !== "definition" ||
        !used.has(definitionKey(child.identifier ?? "")) ||
        retained.has(definitionKey(child.identifier ?? "")),
    );
    node.children.forEach(removeConsumedDefinitions);
  };
  removeConsumedDefinitions(root);
}

/** Keep paired inline HTML together so tags such as kbd/sup actually render. */
function groupInlineHtml(node: MdNode, source: string): void {
  node.children?.forEach((child) => groupInlineHtml(child, source));
  if (
    !node.children ||
    ![
      "paragraph",
      "heading",
      "tableCell",
      "underline",
      "strong",
      "emphasis",
      "delete",
      "link",
      "linkReference",
    ].includes(node.type)
  )
    return;
  const children: MdNode[] = [];
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const opening =
      child.type === "html"
        ? /^<([A-Za-z][A-Za-z0-9-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>$/.exec(
            child.value ?? "",
          )
        : null;
    if (
      !opening ||
      /\/\s*>$/.test(child.value ?? "") ||
      /^(?:br|hr|img|col)$/i.test(opening[1])
    ) {
      children.push(child);
      continue;
    }
    const tag = opening[1].toLowerCase();
    let depth = 1;
    let closingIndex = index + 1;
    for (; closingIndex < node.children.length; closingIndex += 1) {
      const next = node.children[closingIndex];
      if (next.type !== "html") continue;
      const match =
        /^<(\/)?([A-Za-z][A-Za-z0-9-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>$/.exec(
          next.value ?? "",
        );
      if (match?.[2].toLowerCase() !== tag) continue;
      depth += match[1] ? -1 : 1;
      if (depth === 0) break;
    }
    const start = child.position?.start.offset;
    const end = node.children[closingIndex]?.position?.end.offset;
    if (depth === 0 && start !== undefined && end !== undefined) {
      if (
        tag === "u" &&
        /^<u\s*>$/i.test(child.value ?? "") &&
        /^<\/u\s*>$/i.test(node.children[closingIndex].value ?? "")
      ) {
        // Underline is an editable editor mark with no Markdown delimiter.
        // Keep its parsed phrasing children so formulas and other marks remain
        // native nodes, while attributed HTML retains its lossless preview.
        const underlined: MdNode = {
          type: "underline",
          children: node.children.slice(index + 1, closingIndex),
        };
        groupInlineHtml(underlined, source);
        children.push(underlined);
      } else {
        children.push({
          type: "html",
          value: source.slice(start, end),
          position: { start: { offset: start }, end: { offset: end } },
        });
      }
      index = closingIndex;
    } else {
      children.push(child);
    }
  }
  node.children = children;
}

const content = (
  nodes: MdNode[] | undefined,
  context: MarkdownContext = "block",
): JSONContent[] => (nodes ?? []).flatMap((node) => fromMdast(node, context));

function unsupported(
  node: MdNode,
  reason?: string,
  context: MarkdownContext = "block",
): JSONContent {
  const source =
    node.originalSource ??
    processor
      .stringify(
        expandUnderline({
          type: "root",
          children:
            context === "inline"
              ? [{ type: "paragraph", children: [node] }]
              : [node],
        }) as never,
      )
      .trimEnd();
  // Unsupported phrasing content must remain inline. Block atoms inside a
  // paragraph are discarded by ProseMirror when the document is loaded.
  if (context === "inline")
    return { type: "inlineHtmlPreview", attrs: { source } };
  return {
    type: "unsupportedMarkdown",
    attrs: {
      source,
      reason: reason ?? getMessages().unsupportedMarkdownReason,
    },
  };
}

function textNode(value: string | undefined): JSONContent {
  return { type: "text", text: value ?? "" };
}

function imageDimension(value: unknown): number | null {
  const dimension = Number(value);
  return Number.isInteger(dimension) && dimension > 0 && dimension <= 10_000
    ? dimension
    : null;
}

function imageAttributes(node: MdNode): Record<string, string | number> {
  const match = imageSizeTitle.exec(node.title ?? "");
  const width = match ? imageDimension(match[1]) : null;
  const height = match ? imageDimension(match[2]) : null;
  return {
    src: node.url ?? "",
    alt: node.alt ?? "",
    ...(match
      ? { title: match[3] ?? "" }
      : node.title
        ? { title: node.title }
        : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
  };
}

function markdownImageTitle(
  attrs: Record<string, unknown> | undefined,
): string | null {
  const title = String(attrs?.title ?? "");
  const width = imageDimension(attrs?.width);
  const height = imageDimension(attrs?.height);
  if (!width || !height) return title || null;
  return `papercanvas-size:${width}x${height}${title ? ` | ${title}` : ""}`;
}

function applyMark(
  nodes: JSONContent[],
  mark: { type: string; attrs?: Record<string, unknown> },
): JSONContent[] {
  return nodes.map((node) => {
    if (node.type === "image") {
      return mark.type === "link"
        ? {
            ...node,
            attrs: {
              ...node.attrs,
              linkHref: mark.attrs?.href ?? "",
              linkTitle: mark.attrs?.title ?? null,
            },
          }
        : node;
    }
    return inlineMarkTypes.has(node.type ?? "")
      ? {
          ...node,
          marks: [
            ...(node.marks ?? []).filter((item) => item.type !== mark.type),
            mark,
          ].sort((left, right) => left.type.localeCompare(right.type)),
        }
      : node;
  });
}

function containsImage(node: MdNode): boolean {
  return node.type === "image" || (node.children?.some(containsImage) ?? false);
}

function tableCellContent(node: MdNode): JSONContent[] {
  const children = node.children ?? [];
  const paragraphs = children.map((child) =>
    child.type === "html"
      ? /^<p>([\s\S]*)<\/p>$/i.exec(child.value ?? "")
      : null,
  );
  // GFM cells have no native paragraph boundary. Standard inline HTML keeps
  // paragraphs created by Enter intact without moving text out of the table.
  if (paragraphs.length > 0 && paragraphs.every(Boolean)) {
    return paragraphs.flatMap((paragraph) => {
      // A prefix forces phrasing context, so literal text such as "# title"
      // or "- item" is not reinterpreted as a block after removing <p>.
      const prefix = "paragraph ";
      const suffix = " paragraph";
      // Parse in the original GFM-cell context: a pipe escaped inside an
      // inline code span is table syntax, not a literal backslash in the code.
      const source = `| cell |\n| --- |\n| ${prefix}${paragraph![1]}${suffix} |`;
      const root = processor.parse(source) as unknown as MdRoot;
      groupInlineHtml(root, source);
      resolveReferences(root, source);
      const cell = root.children[0]?.children?.[1]?.children?.[0];
      if (!cell)
        return [{ type: "paragraph", content: content(children, "inline") }];
      const first = cell.children?.[0];
      if (first?.type === "text" && first.value?.startsWith(prefix)) {
        first.value = first.value.slice(prefix.length);
        if (!first.value) cell.children!.shift();
      }
      const lastChildren = cell.children;
      const last = lastChildren?.at(-1);
      if (last?.type === "text" && last.value?.endsWith(suffix)) {
        last.value = last.value.slice(0, -suffix.length);
        if (!last.value) lastChildren!.pop();
      }
      return fromMdast({ type: "paragraph", children: cell.children });
    });
  }
  return [{ type: "paragraph", content: content(children, "inline") }];
}

function fromMdast(
  node: MdNode,
  context: MarkdownContext = "block",
): JSONContent[] {
  switch (node.type) {
    case "text":
      return [textNode(node.value)];
    case "emphasis":
      return applyMark(content(node.children, "inline"), { type: "italic" });
    case "strong":
      return applyMark(content(node.children, "inline"), { type: "bold" });
    case "delete":
      return applyMark(content(node.children, "inline"), { type: "strike" });
    case "underline":
      return applyMark(content(node.children, "inline"), { type: "underline" });
    case "inlineCode":
      return [
        { type: "text", text: node.value ?? "", marks: [{ type: "code" }] },
      ];
    case "link": {
      const children = content(node.children, "inline");
      if (!carriesLink(children))
        return [unsupported(node, undefined, "inline")];
      return applyMark(children, {
        type: "link",
        attrs: {
          href: node.url ?? "",
          ...(node.title ? { title: node.title } : {}),
        },
      });
    }
    case "image":
      return [{ type: "image", attrs: imageAttributes(node) }];
    case "inlineMath":
      return [{ type: "inlineFormula", attrs: { latex: node.value ?? "" } }];
    case "footnoteReference":
      return [
        {
          type: "footnoteReference",
          attrs: {
            identifier: node.identifier ?? "",
            label: node.label ?? node.identifier ?? "",
          },
        },
      ];
    case "footnoteDefinition": {
      const children = content(node.children);
      return [
        {
          type: "footnoteDefinition",
          attrs: {
            identifier: node.identifier ?? "",
            label: node.label ?? node.identifier ?? "",
          },
          content: children.length ? children : [{ type: "paragraph" }],
        },
      ];
    }
    case "break":
      return [{ type: "hardBreak" }];
    case "paragraph": {
      const children = content(node.children, "inline");
      if (!children.some((child) => child.type === "image")) {
        return [{ type: "paragraph", content: children }];
      }

      // Markdown images are inline syntax, but PaperCanvas images are block
      // nodes so they can be selected and resized. Split mixed paragraphs
      // around each image instead of producing an invalid paragraph/image tree.
      const blocks: JSONContent[] = [];
      let inline: JSONContent[] = [];
      const flushInline = () => {
        if (inline.some((child) => child.type !== "text" || child.text?.trim()))
          blocks.push({ type: "paragraph", content: inline });
        inline = [];
      };
      children.forEach((child) => {
        if (child.type === "image") {
          flushInline();
          blocks.push(child);
          return;
        }
        inline.push(child);
      });
      flushInline();
      return blocks;
    }
    case "heading":
      // Images are block nodes in the editor. Preserve headings containing an
      // image rather than inserting an invalid child that ProseMirror drops.
      if (containsImage(node)) return [unsupported(node)];
      return [
        {
          type: "heading",
          attrs: { level: node.depth ?? 1 },
          content: content(node.children, "inline"),
        },
      ];
    case "blockquote": {
      const children = content(node.children);
      return [
        {
          type: "blockquote",
          content: children.length ? children : [{ type: "paragraph" }],
        },
      ];
    }
    case "thematicBreak":
      return [{ type: "horizontalRule" }];
    case "code":
      return [
        {
          type: "codeBlock",
          attrs: { language: node.lang ?? null },
          content: node.value ? [textNode(node.value)] : [],
        },
      ];
    case "math":
      return [{ type: "blockFormula", attrs: { latex: node.value ?? "" } }];
    case "list": {
      const isTask = (child: MdNode) =>
        child.checked !== null && child.checked !== undefined;
      if (node.ordered)
        return [
          {
            type: "orderedList",
            attrs: { start: node.start ?? 1 },
            content: content(node.children),
          },
        ];
      // The task-list schema accepts only taskItem children. Keep ordinary
      // bullet items in adjacent lists instead of silently discarding them.
      const runs: Array<{ task: boolean; items: MdNode[] }> = [];
      for (const child of node.children ?? []) {
        const task = isTask(child);
        const previous = runs[runs.length - 1];
        if (previous?.task === task) previous.items.push(child);
        else runs.push({ task, items: [child] });
      }
      return runs.map((run) => ({
        type: run.task ? "taskList" : "bulletList",
        content: content(run.items),
      }));
    }
    case "listItem": {
      const children = content(node.children);
      return [
        {
          type:
            node.checked !== null && node.checked !== undefined
              ? "taskItem"
              : "listItem",
          attrs:
            node.checked !== null && node.checked !== undefined
              ? { checked: node.checked }
              : undefined,
          // Both list-item schemas require a paragraph first. This also keeps
          // GFM's checkbox serializer active for an image-only task item.
          content:
            children[0]?.type === "paragraph"
              ? children
              : [{ type: "paragraph" }, ...children],
        },
      ];
    }
    case "table": {
      // GFM permits images in cells, while our cells currently serialize inline
      // paragraphs. Keep the complete table source until that shape is supported.
      if (containsImage(node)) return [unsupported(node)];
      // ProseMirror requires a rectangular table. Pad missing GFM fields up
      // front so opening or saving cannot trigger implicit table repair, and
      // retain overflow cells rather than discarding their authored content.
      const columns = (node.children ?? []).reduce(
        (maximum, row) => Math.max(maximum, row.children?.length ?? 0),
        0,
      );
      return [
        {
          type: "table",
          content: (node.children ?? []).map((row, rowIndex) => ({
            type: "tableRow",
            content: Array.from({ length: columns }, (_, columnIndex) => ({
              type: rowIndex === 0 ? "tableHeader" : "tableCell",
              attrs: { textAlign: node.align?.[columnIndex] ?? null },
              content: tableCellContent(
                row.children?.[columnIndex] ?? { type: "tableCell" },
              ),
            })),
          })),
        },
      ];
    }
    case "tableRow":
      return [{ type: "tableRow", content: content(node.children) }];
    case "tableCell":
      return [
        {
          type: "tableCell",
          content: tableCellContent(node),
        },
      ];
    case "tableHeader":
      return [
        {
          type: "tableHeader",
          content: tableCellContent(node),
        },
      ];
    case "html":
      if (context === "inline" && /^<br\s*\/?\s*>$/i.test(node.value ?? ""))
        return [{ type: "hardBreak" }];
      if (
        context === "block" &&
        /^(?:<br\s*\/?\s*>\s*)+$/i.test(node.value ?? "")
      )
        return [
          {
            type: "paragraph",
            content: Array.from(
              (node.value ?? "").matchAll(/<br\s*\/?\s*>/gi),
              () => ({ type: "hardBreak" }),
            ),
          },
        ];
      if (context === "block" && !isHtmlPreviewCandidate(node.value ?? "")) {
        return [unsupported(node, getMessages().htmlPreserved)];
      }
      return [
        {
          type: context === "inline" ? "inlineHtmlPreview" : "htmlPreview",
          attrs: { source: node.value ?? "" },
        },
      ];
    default:
      return [unsupported(node, undefined, context)];
  }
}

export function markdownToDocument(markdown: string): JSONContent {
  const source = parseMarkdownComments(markdown).body;
  // CommonMark replaces literal NULs with U+FFFD; a lossless source atom keeps
  // those bytes recoverable instead of silently modifying the opened file.
  if (source.includes("\0")) return preservedSourceDocument(source);
  const normalized = normalizeLatexDelimiters(source);
  const root = processor.parse(normalized) as unknown as MdRoot;
  if (hasExtremeNesting(root)) return preservedSourceDocument(source);
  groupInlineHtml(root, normalized);
  resolveReferences(root, normalized);
  const converted = content(root.children);
  return {
    type: "doc",
    content: converted.length > 0 ? converted : [{ type: "paragraph" }],
  };
}

function wrapInlineMarks(node: JSONContent, bare: MdNode): MdNode {
  const marks = node.marks ?? [];
  const mark = (type: string) => marks.find((item) => item.type === type);
  let wrapped = bare;
  // Native Markdown marks stay outside the HTML underline wrapper so shared
  // runs still merge, including whitespace that cannot end a ~~strike~~ span.
  if (mark("underline")) wrapped = { type: "underline", children: [wrapped] };
  if (mark("link"))
    wrapped = {
      type: "link",
      url: String(mark("link")?.attrs?.href ?? ""),
      title: String(mark("link")?.attrs?.title ?? "") || null,
      children: [wrapped],
    };
  if (mark("strike")) wrapped = { type: "delete", children: [wrapped] };
  if (mark("italic")) wrapped = { type: "emphasis", children: [wrapped] };
  if (mark("bold")) wrapped = { type: "strong", children: [wrapped] };
  return wrapped;
}

function mergeInlineMarks(nodes: MdNode[]): MdNode[] {
  const merged: MdNode[] = [];
  const append = (target: MdNode[], current: MdNode) => {
    const previous = target[target.length - 1];
    const sameMark =
      previous?.type === current.type &&
      ["strong", "emphasis", "delete", "link", "underline"].includes(
        current.type,
      ) &&
      (current.type !== "link" ||
        (previous.url === current.url && previous.title === current.title));
    if (!sameMark) {
      target.push(current);
      return;
    }
    // Editor text and inline atoms are separate nodes. Serialize one shared
    // mark around a contiguous run, since adjacent delimiters such as
    // **text ****$x$** otherwise become literal characters when reopened.
    previous.children ??= [];
    for (const child of current.children ?? [])
      append(previous.children, child);
  };
  for (const node of nodes) {
    const current = node.children
      ? { ...node, children: mergeInlineMarks(node.children) }
      : node;
    append(merged, current);
  }
  return merged;
}

function toMdast(node: JSONContent): MdNode | null {
  const childNodes = (node.content ?? []).flatMap((child) => {
    const converted = toMdast(child);
    if (!converted) return [];
    return [
      child.type === "image" &&
      ["blockquote", "listItem", "taskItem", "footnoteDefinition"].includes(
        node.type ?? "",
      )
        ? { type: "paragraph", children: [converted] }
        : converted,
    ];
  });
  if (node.type === "text") {
    return wrapInlineMarks(node, {
      type: node.marks?.some((mark) => mark.type === "code")
        ? "inlineCode"
        : "text",
      value: node.text ?? "",
    });
  }
  switch (node.type) {
    case "paragraph":
      return { type: "paragraph", children: mergeInlineMarks(childNodes) };
    case "heading":
      return {
        type: "heading",
        depth: Number(node.attrs?.level ?? 1),
        children: mergeInlineMarks(childNodes),
      };
    case "blockquote":
      return { type: "blockquote", children: childNodes };
    case "footnoteReference":
      return wrapInlineMarks(node, {
        type: "footnoteReference",
        identifier: String(node.attrs?.identifier ?? ""),
        label: String(node.attrs?.label ?? node.attrs?.identifier ?? ""),
      });
    case "footnoteDefinition":
      return {
        type: "footnoteDefinition",
        identifier: String(node.attrs?.identifier ?? ""),
        label: String(node.attrs?.label ?? node.attrs?.identifier ?? ""),
        children: childNodes,
      };
    case "bulletList":
      return { type: "list", ordered: false, children: childNodes };
    case "orderedList":
      return {
        type: "list",
        ordered: true,
        start: Number(node.attrs?.start ?? 1),
        children: childNodes,
      };
    case "listItem":
      return { type: "listItem", children: listItemChildren(childNodes) };
    case "taskList":
      return { type: "list", ordered: false, children: childNodes };
    case "taskItem":
      return {
        type: "listItem",
        checked: Boolean(node.attrs?.checked),
        children: listItemChildren(childNodes),
      };
    case "codeBlock":
      return {
        type: "code",
        lang: String(node.attrs?.language ?? "") || null,
        value: flattenText(node),
      };
    case "horizontalRule":
      return { type: "thematicBreak" };
    case "hardBreak":
      // Markdown line endings followed by inline HTML are flattened by remark,
      // and heading line endings leave the heading. HTML keeps the same break
      // in every phrasing context and imports back into the native break node.
      return { type: "html", value: "<br>" };
    case "image": {
      const image: MdNode = {
        type: "image",
        url: String(node.attrs?.originalSrc ?? node.attrs?.src ?? ""),
        alt: String(node.attrs?.alt ?? "") || null,
        title: markdownImageTitle(node.attrs),
      };
      return node.attrs?.linkHref
        ? {
            type: "link",
            url: String(node.attrs.linkHref),
            title: String(node.attrs.linkTitle ?? "") || null,
            children: [image],
          }
        : image;
    }
    case "inlineFormula":
      return wrapInlineMarks(node, {
        type: "inlineMath",
        value: String(node.attrs?.latex ?? ""),
      });
    case "blockFormula":
      return { type: "math", value: String(node.attrs?.latex ?? "") };
    case "table":
      if (requiresHtmlTable(node))
        return { type: "html", value: tableToHtml(node) };
      return {
        type: "table",
        align: (node.content?.[0]?.content ?? []).map((cell) => {
          const alignment = cell.attrs?.textAlign;
          return alignment === "left" ||
            alignment === "right" ||
            alignment === "center"
            ? alignment
            : null;
        }),
        children: childNodes,
      };
    case "tableRow":
      return { type: "tableRow", children: childNodes };
    case "tableCell":
      return { type: "tableCell", children: cellInlineChildren(node) };
    case "tableHeader":
      return { type: "tableCell", children: cellInlineChildren(node) };
    case "htmlPreview":
    case "unsupportedMarkdown":
      return { type: "html", value: String(node.attrs?.source ?? "") };
    case "inlineHtmlPreview":
      return wrapInlineMarks(node, {
        type: "html",
        value: String(node.attrs?.source ?? ""),
      });
    default:
      return null;
  }
}

function listItemChildren(children: MdNode[]): MdNode[] {
  // The schema-only leading paragraph is unnecessary in Markdown. An empty
  // marker line would push later blocks outside the list or break GFM tasks.
  return children.length > 1 &&
    children[0].type === "paragraph" &&
    !children[0].children?.length
    ? children.slice(1)
    : children;
}

function cellInlineChildren(node: JSONContent): MdNode[] {
  const paragraphs = (node.content ?? []).filter(
    (child) => child.type === "paragraph",
  );
  return paragraphs.flatMap((paragraph) => {
    const children = mergeInlineMarks(
      (paragraph.content ?? []).flatMap((child) => {
        // remark-gfm flattens Markdown hard breaks into a space in cells. HTML
        // breaks fit on one table row and retain the authored line boundary.
        const converted =
          child.type === "hardBreak"
            ? { type: "html", value: "<br>" }
            : toMdast(child);
        return converted ? [converted] : [];
      }),
    );
    return paragraphs.length > 1
      ? [
          { type: "html", value: "<p>" },
          ...children,
          { type: "html", value: "</p>" },
        ]
      : children;
  });
}

function flattenText(node: JSONContent): string {
  return (node.content ?? [])
    .map((child) => child.text ?? flattenText(child))
    .join("");
}

/** Expand semantic underline after merging shared mark runs for remark. */
function expandUnderline(node: MdNode): MdNode {
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.flatMap((child) => {
      const converted = expandUnderline(child);
      return converted.type === "underline"
        ? [
            { type: "html", value: "<u>" },
            ...(converted.children ?? []),
            { type: "html", value: "</u>" },
          ]
        : [converted];
    }),
  };
}

export function documentToMarkdown(
  document: JSONContent,
  stringLength?: (value: string) => number,
): string {
  if (
    document.content?.length === 1 &&
    document.content[0].type === "unsupportedMarkdown"
  )
    return String(document.content[0].attrs?.source ?? "");
  const root: MdRoot = {
    type: "root",
    children: (document.content ?? []).flatMap((node) => {
      const converted = toMdast(node);
      // A root containing bare phrasing nodes makes remark join all blocks as
      // one paragraph (even headings). Images are block nodes in our schema.
      return converted
        ? [
            node.type === "image"
              ? { type: "paragraph", children: [converted] }
              : converted,
          ]
        : [];
    }),
  };
  const serializer = stringLength
    ? processor().use(remarkGfm, { stringLength })
    : processor;
  return serializer.stringify(expandUnderline(root) as unknown as never);
}

export { collectOutline } from "./outline";
