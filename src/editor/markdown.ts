import type { JSONContent } from "@tiptap/core";
import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { getMessages } from "../i18n";
import { parseMarkdownComments } from "./comments";
import { isDisplayLatexEnvironment } from "./formulaInput";
import { isHtmlPreviewCandidate } from "./htmlSafety";

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
  position?: { start: { offset?: number }; end: { offset?: number } };
  align?: Array<"left" | "right" | "center" | null>;
};

type MdRoot = MdNode & { children: MdNode[] };

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify);
const imageSizeTitle = /^papercanvas-size:(\d+)x(\d+)(?:\s+\|\s+([\s\S]*))?$/i;

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

function normalizeInlineLatexDelimiters(line: string): string {
  let result = "";
  let cursor = 0;
  let dollarDelimiter: "$" | "$$" | null = null;

  while (cursor < line.length) {
    if (line[cursor] === "`") {
      let runLength = 1;
      while (line[cursor + runLength] === "`") runLength += 1;
      const delimiter = "`".repeat(runLength);
      const closing = line.indexOf(delimiter, cursor + runLength);
      if (closing === -1) return result + line.slice(cursor);
      result += line.slice(cursor, closing + runLength);
      cursor = closing + runLength;
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
  const lines = markdown.split("\n");
  const normalized: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let bracketOpeningIndex: number | null = null;
  let bracketOpeningSource = "";
  let dollarDisplayBlock = false;
  let latexEnvironment: { name: string; openingIndex: number } | null = null;

  for (const line of lines) {
    if (latexEnvironment !== null) {
      normalized.push(line);
      if (
        new RegExp(
          `\\\\end\\{${latexEnvironment.name.replace(/\*/g, "\\*")}\\}\\s*$`,
        ).test(line)
      ) {
        normalized.push("$$");
        latexEnvironment = null;
      }
      continue;
    }
    if (bracketOpeningIndex !== null) {
      if (/^\s*\\\]\s*$/.test(line)) {
        normalized.push("$$");
        bracketOpeningIndex = null;
        bracketOpeningSource = "";
      } else {
        normalized.push(line);
      }
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

    // Four-space and tab-indented code must win over math delimiter detection.
    if (/^(?: {4}|\t)/.test(line)) {
      normalized.push(line);
      continue;
    }

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
    const sameLineDollarDisplay = /^ {0,3}\$\$([^\n]+)\$\$\s*$/.exec(line);
    if (sameLineDollarDisplay) {
      normalized.push("$$", sameLineDollarDisplay[1], "$$");
      continue;
    }

    const sameLineBracketDisplay = /^\s*\\\[\s*([\s\S]*?\S)\s*\\\]\s*$/.exec(
      line,
    );
    if (sameLineBracketDisplay) {
      normalized.push("$$", sameLineBracketDisplay[1], "$$");
      continue;
    }

    if (/^\s*\\\[\s*$/.test(line)) {
      bracketOpeningIndex = normalized.length;
      bracketOpeningSource = line;
      normalized.push("$$");
      continue;
    }

    const environmentOpening = /^\s*\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}/.exec(
      line,
    );
    if (
      environmentOpening &&
      isDisplayLatexEnvironment(environmentOpening[1])
    ) {
      const name = environmentOpening[1];
      const closing = new RegExp(
        `\\\\end\\{${name.replace(/\*/g, "\\*")}\\}\\s*$`,
      );
      const openingIndex = normalized.length;
      normalized.push("$$", line);
      if (closing.test(line)) normalized.push("$$");
      else latexEnvironment = { name, openingIndex };
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
function resolveReferences(root: MdRoot): void {
  const definitions = new Map<string, MdNode>();
  const used = new Set<string>();
  const collect = (node: MdNode) => {
    if (node.type === "definition" && node.identifier) {
      const key = definitionKey(node.identifier);
      if (!definitions.has(key)) definitions.set(key, node);
    }
    node.children?.forEach(collect);
  };
  collect(root);
  const resolve = (node: MdNode) => {
    if (node.type === "linkReference" || node.type === "imageReference") {
      const key = definitionKey(node.identifier ?? "");
      const definition = definitions.get(key);
      if (definition) {
        used.add(key);
        node.type = node.type === "linkReference" ? "link" : "image";
        node.url = definition.url;
        node.title = definition.title;
      }
    }
    node.children?.forEach(resolve);
  };
  resolve(root);
  const removeConsumedDefinitions = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.filter(
      (child) =>
        child.type !== "definition" ||
        !used.has(definitionKey(child.identifier ?? "")),
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
    !["paragraph", "heading", "tableCell"].includes(node.type)
  )
    return;
  const children: MdNode[] = [];
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const opening =
      child.type === "html"
        ? /^<([A-Za-z][A-Za-z0-9-]*)\b[^>]*>$/.exec(child.value ?? "")
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
      const match = /^<(\/)?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>$/.exec(
        next.value ?? "",
      );
      if (match?.[2].toLowerCase() !== tag) continue;
      depth += match[1] ? -1 : 1;
      if (depth === 0) break;
    }
    const start = child.position?.start.offset;
    const end = node.children[closingIndex]?.position?.end.offset;
    if (depth === 0 && start !== undefined && end !== undefined) {
      children.push({ type: "html", value: source.slice(start, end) });
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
  const source = processor
    .stringify({
      type: "root",
      children:
        context === "inline"
          ? [{ type: "paragraph", children: [node] }]
          : [node],
    } as never)
    .trimEnd();
  // Unsupported phrasing content must remain inline. Block atoms inside a
  // paragraph are discarded by ProseMirror when the document is loaded.
  if (context === "inline")
    return { type: "inlineHtmlPreview", attrs: { source } };
  return {
    type: "unsupportedMarkdown",
    attrs: {
      source,
      reason: reason ?? getMessages().unsupportedStructure(node.type),
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
    return ["text", "inlineFormula", "inlineHtmlPreview"].includes(
      node.type ?? "",
    )
      ? {
          ...node,
          marks: [...(node.marks ?? []), mark].sort((left, right) =>
            left.type.localeCompare(right.type),
          ),
        }
      : node;
  });
}

function containsImage(node: MdNode): boolean {
  return node.type === "image" || (node.children?.some(containsImage) ?? false);
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
    case "inlineCode":
      return [
        { type: "text", text: node.value ?? "", marks: [{ type: "code" }] },
      ];
    case "link":
      return applyMark(content(node.children, "inline"), {
        type: "link",
        attrs: {
          href: node.url ?? "",
          ...(node.title ? { title: node.title } : {}),
        },
      });
    case "image":
      return [{ type: "image", attrs: imageAttributes(node) }];
    case "inlineMath":
      return [{ type: "inlineFormula", attrs: { latex: node.value ?? "" } }];
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
    case "blockquote":
      return [{ type: "blockquote", content: content(node.children) }];
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
      if (node.ordered && node.children?.some(isTask))
        return [unsupported(node)];
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
        type: run.task
          ? "taskList"
          : node.ordered
            ? "orderedList"
            : "bulletList",
        attrs: node.ordered ? { start: node.start ?? 1 } : undefined,
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
          content: children[0]?.type === "paragraph"
            ? children
            : [{ type: "paragraph" }, ...children],
        },
      ];
    }
    case "table":
      // GFM permits images in cells, while our cells currently serialize inline
      // paragraphs. Keep the complete table source until that shape is supported.
      if (containsImage(node)) return [unsupported(node)];
      return [
        {
          type: "table",
          content: (node.children ?? []).map((row, rowIndex) => ({
            type: "tableRow",
            content: (row.children ?? []).map((cell, columnIndex) => ({
              type: rowIndex === 0 ? "tableHeader" : "tableCell",
              attrs: { textAlign: node.align?.[columnIndex] ?? null },
              content: [
                {
                  type: "paragraph",
                  content: content(cell.children, "inline"),
                },
              ],
            })),
          })),
        },
      ];
    case "tableRow":
      return [{ type: "tableRow", content: content(node.children) }];
    case "tableCell":
      return [
        {
          type: "tableCell",
          content: [
            { type: "paragraph", content: content(node.children, "inline") },
          ],
        },
      ];
    case "tableHeader":
      return [
        {
          type: "tableHeader",
          content: [
            { type: "paragraph", content: content(node.children, "inline") },
          ],
        },
      ];
    case "html":
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
  const normalized = normalizeLatexDelimiters(source);
  const root = processor.parse(normalized) as unknown as MdRoot;
  groupInlineHtml(root, normalized);
  resolveReferences(root);
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
    const sameMark = previous?.type === current.type &&
      ["strong", "emphasis", "delete", "link"].includes(current.type) &&
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
    for (const child of current.children ?? []) append(previous.children, child);
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
    return [child.type === "image" && ["blockquote", "listItem", "taskItem"].includes(node.type ?? "")
      ? { type: "paragraph", children: [converted] }
      : converted];
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
      return { type: "break" };
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
  return children.length > 1 && children[0].type === "paragraph" && !children[0].children?.length
    ? children.slice(1)
    : children;
}

function cellInlineChildren(node: JSONContent): MdNode[] {
  const paragraph = node.content?.find((child) => child.type === "paragraph");
  return mergeInlineMarks((paragraph?.content ?? []).flatMap((child) => {
    const converted = toMdast(child);
    return converted ? [converted] : [];
  }));
}

function flattenText(node: JSONContent): string {
  return (node.content ?? [])
    .map((child) => child.text ?? flattenText(child))
    .join("");
}

export function documentToMarkdown(
  document: JSONContent,
  stringLength?: (value: string) => number,
): string {
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
  return serializer.stringify(root as unknown as never);
}

export { collectOutline } from "./outline";
