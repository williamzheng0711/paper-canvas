import type { JSONContent } from "@tiptap/core";
import type {} from "mdast-util-gfm-strikethrough";
import type { Handle } from "mdast-util-to-markdown";
import { classifyCharacter } from "micromark-util-classify-character";
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
import { selectionMarker } from "./selectionMarker";
import { maximumCanvasCharacters } from "./documentLimits";

const astralCharacter = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const astralTextEdges = new RegExp(
  `^(?:${selectionMarker})?(${astralCharacter})|(${astralCharacter})(?:${selectionMarker})?$`,
  "g",
);
const leadingTextBom = new RegExp(`^(?:${selectionMarker})?\\uFEFF`);

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

function strikeEdge(outside: number, inside: number) {
  const outer = classifyCharacter(outside);
  const inner = classifyCharacter(inside);
  return {
    inside: inner === 1,
    outside:
      (outer === undefined && inner !== undefined) ||
      (outer === 1 && inner === 1),
  };
}

const serializeStrike: Handle & { peek?: Handle } = (
  node,
  _parent,
  state,
  info,
) => {
  const exit = state.enter("strikethrough");
  const tracker = state.createTracker(info);
  const opening = tracker.move("~~");
  let value = state.containerPhrasing(node, {
    ...tracker.current(),
    before: opening,
    after: "~",
  });
  const open = strikeEdge(
    info.before.charCodeAt(info.before.length - 1),
    value.charCodeAt(0),
  );
  // GFM rejects whitespace just inside ~~ delimiters. Entity escaping
  // retains the exact marked text when a user strikes a spaced run.
  if (open.inside) value = `&#${value.charCodeAt(0)};${value.slice(1)}`;
  const close = strikeEdge(
    info.after.charCodeAt(0),
    value.charCodeAt(value.length - 1),
  );
  if (close.inside)
    value = `${value.slice(0, -1)}&#${value.charCodeAt(value.length - 1)};`;
  tracker.move(value);
  const closing = tracker.move("~~");
  exit();
  state.attentionEncodeSurroundingInfo = {
    before: open.outside,
    after: close.outside,
  };
  return opening + value + closing;
};
// Phrasing lookahead must not run this handler and mutate attention state.
serializeStrike.peek = () => "~";

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkStringify, {
    emphasis: "_",
    unsafe: [
      { character: "\\", inConstruct: "phrasing" },
      { character: "$", inConstruct: "phrasing" },
    ],
    handlers: {
      text(node, parent, state, info) {
        // Autolinks retain references and backslashes literally; phrasing
        // escapes would change both their visible text and destination.
        if (state.stack.includes("autolink"))
          return node.value;
        // Attention handlers may entity-encode the neighboring character.
        // Encode literal backslashes so they cannot escape that new entity.
        const value = state
          .safe(node.value, { ...info, encode: ["\\"] })
          // Markdown escapes introduced for literal punctuation must not
          // become Typora's formula openings on the next import.
          .replace(/\\([[(])/g, (_escape, punctuation: string) =>
            `&#${punctuation.charCodeAt(0)};`,
          )
          .replace(/^[\r\n]+|[\r\n]+$/g, (lineEndings) =>
            Array.from(
              lineEndings,
              (character) => `&#${character.charCodeAt(0)};`,
            ).join(""),
          )
          // Remark's attention escaping handles one UTF-16 unit at a time.
          // A character reference at a run edge keeps an entire astral
          // character together when a neighboring mark needs escaping.
          .replace(
            astralTextEdges,
            (edge, first: string | undefined, last: string | undefined) => {
              const character = first ?? last!;
              return edge.replace(character, `&#${character.codePointAt(0)};`);
            },
          )
          // An editable leading zero-width no-break space is content, whereas
          // a literal leading U+FEFF in the saved file is an encoding marker.
          .replace(leadingTextBom, (edge) => edge.replace("\uFEFF", "&#65279;"));
        // Splitting an image out of a paragraph can leave [^note]: at the
        // start of a new block. Keep the colon as text rather than turning a
        // footnote reference into a new (possibly nested) definition.
        const previous = parent?.children?.[state.indexStack.at(-1)! - 1];
        return previous?.type === "footnoteReference" && value.startsWith(":")
          ? `&#58;${value.slice(1)}`
          : value;
      },
      delete: serializeStrike,
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
  let closingRangeIndex = 0;
  // Each closing delimiter is searched once, including a final missing close.
  let nextLatexClosing: number | undefined;

  while (cursor < line.length) {
    while (literalRanges[rangeIndex]?.end <= cursor) rangeIndex += 1;
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
      if (nextLatexClosing === undefined || (nextLatexClosing >= 0 && nextLatexClosing < cursor + 2)) {
        nextLatexClosing = line.indexOf("\\)", cursor + 2);
        while (nextLatexClosing !== -1) {
          while (literalRanges[closingRangeIndex]?.end <= nextLatexClosing)
            closingRangeIndex += 1;
          const literalClosing = literalRanges[closingRangeIndex];
          if (literalClosing && literalClosing.start <= nextLatexClosing)
            nextLatexClosing = line.indexOf("\\)", literalClosing.end);
          else if (isEscaped(line, nextLatexClosing))
            nextLatexClosing = line.indexOf("\\)", nextLatexClosing + 2);
          else break;
        }
      }
      const closing = nextLatexClosing;
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
  let literalRoot: MdRoot;
  try {
    literalRoot = processor.parse(markdown) as unknown as MdRoot;
  } catch {
    return markdown;
  }
  if (hasExtremeNesting(literalRoot)) return markdown;
  groupInlineHtml(literalRoot, markdown);
  if (hasExtremeNesting(literalRoot)) return markdown;
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
  const lines = markdown.split(/(\r\n|\r|\n)/);
  const normalized: string[] = [];
  let lineEnding = "";
  const append = (...values: string[]) => {
    for (const value of values) {
      const previous = normalized.at(-1);
      if (previous !== undefined && !/[\r\n]$/.test(previous))
        normalized[normalized.length - 1] += lineEnding || "\n";
      normalized.push(value + lineEnding);
    }
  };
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

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 2) {
    const line = lines[lineIndex];
    lineEnding = lines[lineIndex + 1] ?? "";
    const lineStart = lineOffset;
    const lineEnd = lineStart + line.length;
    lineOffset = lineEnd + lineEnding.length;
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
      append(line);
      if (
        new RegExp(
          `\\\\end\\{${latexEnvironment.name.replace(/\*/g, "\\*")}\\}\\s*$`,
        ).test(line)
      ) {
        append(`${latexEnvironment.indent}$$`);
        latexEnvironment = null;
      }
      continue;
    }
    if (bracketOpeningIndex !== null) {
      const closing = /^([ \t]*)\\\]\s*$/.exec(line);
      if (closing) {
        append(`${closing[1]}$$`);
        bracketOpeningIndex = null;
        bracketOpeningSource = "";
      } else {
        append(line);
      }
      continue;
    }

    if (lineRanges.length > 0) {
      append(normalizeInlineLatexDelimiters(line, lineRanges));
      continue;
    }

    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      append(line);
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
      append(line);
      continue;
    }

    // Actual indented code is protected by parser ranges above. Indentation
    // alone also occurs in list and footnote continuation paragraphs, where
    // inline TeX must still be converted into an editable formula.

    if (dollarDisplayBlock) {
      append(line);
      if (/^\s*\$\$\s*$/.test(line)) dollarDisplayBlock = false;
      continue;
    }
    if (/^\s*\$\$\s*$/.test(line)) {
      dollarDisplayBlock = true;
      append(line);
      continue;
    }

    // Expand complete display lines here, where code fences are already
    // excluded. A document-wide replacement also changes literal code samples.
    const sameLineDollarDisplay = /^([ \t]*)\$\$([^\n]+)\$\$\s*$/.exec(line);
    if (sameLineDollarDisplay) {
      const [, indent, latex] = sameLineDollarDisplay;
      append(`${indent}$$`, `${indent}${latex}`, `${indent}$$`);
      continue;
    }

    const sameLineBracketDisplay =
      /^([ \t]*)\\\[\s*([\s\S]*?\S)\s*\\\]\s*$/.exec(line);
    if (sameLineBracketDisplay) {
      const [, indent, latex] = sameLineBracketDisplay;
      append(`${indent}$$`, `${indent}${latex}`, `${indent}$$`);
      continue;
    }

    const bracketOpening = /^([ \t]*)\\\[\s*$/.exec(line);
    if (bracketOpening) {
      bracketOpeningIndex = normalized.length;
      bracketOpeningSource = line + lineEnding;
      append(`${bracketOpening[1]}$$`);
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
      append(`${indent}$$`, line);
      if (closing.test(line)) append(`${indent}$$`);
      else latexEnvironment = { name, openingIndex, indent };
      continue;
    }
    append(normalizeInlineLatexDelimiters(line));
  }

  // An unmatched opening delimiter is prose, not a display formula. Restore it
  // so malformed input is retained verbatim instead of being reinterpreted.
  if (bracketOpeningIndex !== null)
    normalized[bracketOpeningIndex] = bracketOpeningSource;
  if (latexEnvironment !== null)
    normalized.splice(latexEnvironment.openingIndex, 1);
  return normalized.join("");
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
    const first = node.children?.[0]?.children?.[0];
    const firstOffset = first?.position?.start.offset;
    // GFM removes only the CR from an empty task marker's CRLF separator,
    // leaving a spurious LF in the following paragraph. Keep source offsets
    // intact while removing that dependency artifact from the parsed text.
    if (
      node.type === "listItem" &&
      typeof node.checked === "boolean" &&
      first?.type === "text" &&
      first.value?.startsWith("\n") &&
      firstOffset !== undefined &&
      source.slice(firstOffset - 1, firstOffset + 1) === "\r\n"
    ) {
      first.value = first.value.slice(1);
      if (!first.value) node.children![0].children!.shift();
    }
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

type ContainerPrefix = { quote: true } | { indent: number };

function expandedColumn(value: string, column = 0): number {
  for (const character of value)
    column += character === "\t" ? 4 - (column % 4) : 1;
  return column;
}

function withoutContainerPrefixes(
  value: string,
  prefixes: ContainerPrefix[],
): string {
  if (!prefixes.length) return value;
  return value.replace(
    /(\r\n|\r|\n)([^\r\n]*)/g,
    (_match, ending: string, sourceLine: string) => {
      let line = sourceLine;
      let column = 0;
      for (const prefix of prefixes) {
        if ("quote" in prefix) {
          const quote = /^[ \t]{0,3}>[ \t]?/.exec(line);
          if (quote) {
            column = expandedColumn(quote[0], column);
            line = line.slice(quote[0].length);
          }
        } else {
          let width = 0;
          let index = 0;
          while (width < prefix.indent && /^[ \t]$/.test(line[index] ?? "")) {
            width += line[index] === "\t" ? 4 - ((column + width) % 4) : 1;
            index += 1;
          }
          // Lazy continuation lines can omit a container's indentation.
          if (width >= prefix.indent) {
            line = " ".repeat(width - prefix.indent) + line.slice(index);
            column += prefix.indent;
          }
        }
      }
      return ending + line;
    },
  );
}

function hasUnterminatedHtmlBlock(value: string): boolean {
  if (value.startsWith("<!--")) return !value.includes("-->");
  if (value.startsWith("<?")) return !value.includes("?>");
  if (value.startsWith("<![CDATA[")) return !value.includes("]]>");
  const rawText = /^<(pre|script|style|textarea)(?:[\s>]|$)/i.exec(value);
  return Boolean(rawText && !new RegExp(`</${rawText[1]}>`, "i").test(value));
}

/** Keep paired inline HTML together so tags such as kbd/sup actually render. */
function groupInlineHtml(
  node: MdNode,
  source: string,
  prefixes: ContainerPrefix[] = [],
  safety?: { preserve: boolean },
): void {
  // Unterminated block HTML can retain the container's final blank separator
  // in its payload. The list/quote serializer adds that separator again on
  // every save; preserve the original source when that boundary is ambiguous.
  if (safety && node.type === "html" && prefixes.length && /[\r\n]$/.test(node.value ?? "") && hasUnterminatedHtmlBlock(node.value ?? ""))
    safety.preserve = true;
  let childPrefixes = prefixes;
  if (node.type === "blockquote")
    childPrefixes = [...prefixes, { quote: true }];
  if (node.type === "footnoteDefinition")
    childPrefixes = [...prefixes, { indent: 4 }];
  if (node.type === "listItem") {
    const start = node.position?.start.offset;
    const marker =
      start !== undefined
        ? /^([*+-]|\d+[.)])([ \t]+)/.exec(source.slice(start))
        : null;
    if (marker && start !== undefined) {
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      const column =
        expandedColumn(source.slice(lineStart, start)) + marker[1].length;
      const padding = expandedColumn(marker[2], column) - column;
      childPrefixes = [
        ...prefixes,
        { indent: marker[1].length + (padding > 4 ? 1 : padding) },
      ];
    }
  }
  node.children?.forEach((child) =>
    groupInlineHtml(child, source, childPrefixes, safety),
  );
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
  const pairedTags = new Map<number, number>();
  const openTags = new Map<string, number[]>();
  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    const match = child.type === "html"
      ? /^<(\/)?([A-Za-z][A-Za-z0-9-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>$/.exec(child.value ?? "")
      : null;
    if (!match || /^(?:br|hr|img|col)$/i.test(match[2])) continue;
    const tag = match[2].toLowerCase();
    const stack = openTags.get(tag) ?? [];
    if (match[1]) {
      const opening = stack.pop();
      if (opening !== undefined) pairedTags.set(opening, index);
    } else {
      stack.push(index);
      // Underline grouping creates recursive editor marks from a flat HTML
      // token stream, which the parser's original AST depth check cannot see.
      if (tag === "u" && stack.length > 256) {
        if (safety) safety.preserve = true;
        return;
      }
    }
    openTags.set(tag, stack);
  }
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
    const closingIndex = pairedTags.get(index);
    const start = child.position?.start.offset;
    const end = closingIndex === undefined ? undefined : node.children[closingIndex]?.position?.end.offset;
    if (closingIndex !== undefined && start !== undefined && end !== undefined) {
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
        groupInlineHtml(underlined, source, prefixes, safety);
        children.push(underlined);
      } else {
        const value = withoutContainerPrefixes(
          source.slice(start, end),
          prefixes,
        );
        if (safety && prefixes.length && /[\r\n]/.test(value)) {
          try {
            const standalone = processor.parse(value) as unknown as MdRoot;
            // Explicit container prefixes added on save can turn a lazy
            // continuation's literal setext/definition line into a block.
            if (
              standalone.children.length !== 1 ||
              !["paragraph", "html"].includes(standalone.children[0].type)
            ) {
              safety.preserve = true;
            }
          } catch {
            safety.preserve = true;
          }
        }
        children.push({
          type: "html",
          value,
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
      // Remove serializer-added line endings, retaining authored nonbreaking
      // whitespace such as NBSP and zero-width no-break spaces as content.
      .replace(/[\r\n]+$/, "");
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

function formulaFromHtml(source: string): string | undefined {
  const match =
    /^<span data-formula-kind="inline" latex="([^"]*)" data-latex="([^"]*)">([\s\S]*)<\/span>$/.exec(
      source,
    );
  if (!match) return undefined;
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
    "#13": "\r",
    "#10": "\n",
  };
  const decode = (value: string) =>
    value.replace(
      /&(amp|lt|gt|quot|#39|#13|#10);/g,
      (_, entity: string) => entities[entity],
    );
  const latex = decode(match[1]);
  // Recognize only the inert formula HTML emitted by our own lossless
  // serializer, keeping ordinary user HTML as its original preview source.
  const candidates = [latex, decode(match[2]), decode(match[3]).slice(1, -1)];
  const clean = (value: string) => value.replaceAll(selectionMarker, "");
  if (
    !decode(match[3]).startsWith("$") ||
    !decode(match[3]).endsWith("$") ||
    candidates.some((value) => clean(value) !== clean(latex))
  )
    return undefined;
  return candidates.find((value) => value.includes(selectionMarker)) ?? latex;
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

function paragraphContent(
  children: JSONContent[],
  taskParagraph = false,
): JSONContent[] {
  const only = children.length === 1 ? children[0] : undefined;
  if (
    !taskParagraph &&
    only?.type === "inlineHtmlPreview" &&
    !only.marks?.length
  ) {
    const source = String(only.attrs?.source ?? "");
    try {
      const standalone = processor.parse(source) as unknown as MdRoot;
      if (
        standalone.children.length === 1 &&
        standalone.children[0].type === "html"
      ) {
        // Image/reference splitting can leave an incomplete tag as an entire
        // paragraph. Classify it as the same HTML block that a save reopens.
        return fromMdast({ ...standalone.children[0], value: source }, "block");
      }
    } catch {
      // Keep the already parsed inline source if a standalone parse fails.
    }
  }
  return [{ type: "paragraph", content: children }];
}

function fromMdast(
  node: MdNode,
  context: MarkdownContext = "block",
  taskParagraph = false,
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
        return paragraphContent(children, taskParagraph);
      }

      // Markdown images are inline syntax, but PaperCanvas images are block
      // nodes so they can be selected and resized. Split mixed paragraphs
      // around each image instead of producing an invalid paragraph/image tree.
      const blocks: JSONContent[] = [];
      let inline: JSONContent[] = [];
      const flushInline = () => {
        if (inline.some((child) => child.type !== "text" || child.text?.trim()))
          blocks.push(
            ...paragraphContent(inline, taskParagraph && blocks.length === 0),
          );
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
      const task = typeof node.checked === "boolean";
      const children = (node.children ?? []).flatMap((child, index) =>
        fromMdast(child, "block", task && index === 0),
      );
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
    case "html": {
      const latex = formulaFromHtml(node.value ?? "");
      if (latex !== undefined) {
        const formula = { type: "inlineFormula", attrs: { latex } };
        return context === "inline"
          ? [formula]
          : [{ type: "paragraph", content: [formula] }];
      }
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
    }
    default:
      return [unsupported(node, undefined, context)];
  }
}

function hasAmbiguousHtmlParagraph(
  node: JSONContent,
  parent?: JSONContent,
  index = 0,
): boolean {
  const first = node.content?.[0];
  if (
    node.type === "paragraph" &&
    !(parent?.type === "taskItem" && index === 0) &&
    (node.content?.length ?? 0) > 1 &&
    first?.type === "inlineHtmlPreview" &&
    !first.marks?.length
  ) {
    try {
      const standalone = processor.parse(
        String(first.attrs?.source ?? ""),
      ) as unknown as MdRoot;
      if (standalone.children[0]?.type === "html") return true;
    } catch {
      return true;
    }
  }
  return (
    node.content?.some((child, childIndex) =>
      hasAmbiguousHtmlParagraph(child, node, childIndex),
    ) ?? false
  );
}

export function markdownToDocument(markdown: string): JSONContent {
  const source = parseMarkdownComments(markdown).body;
  // Parsing dense Markdown can stall long before the Canvas DOM limit is
  // checked. Source mode retains every character without building that tree.
  if (source.length > maximumCanvasCharacters) return preservedSourceDocument(source);
  // CommonMark replaces literal NULs with U+FFFD; a lossless source atom keeps
  // those bytes recoverable instead of silently modifying the opened file.
  if (source.includes("\0")) return preservedSourceDocument(source);
  // remark strips a leading BOM without accounting for it in source offsets.
  // Remove the file marker before any position-sensitive normalization. Keep
  // repeated markers as exact source, since remark would strip another one.
  if (source.startsWith("\uFEFF\uFEFF")) return preservedSourceDocument(source);
  const parseSource = source.startsWith("\uFEFF") ? source.slice(1) : source;
  let normalized: string;
  let root: MdRoot;
  try {
    normalized = normalizeLatexDelimiters(parseSource);
    root = processor.parse(normalized) as unknown as MdRoot;
  } catch {
    // A malformed construct can trip a parser dependency assertion. Keeping
    // all source available is safer than crashing or returning a partial tree.
    return preservedSourceDocument(source);
  }
  if (hasExtremeNesting(root)) return preservedSourceDocument(source);
  const safety = { preserve: false };
  groupInlineHtml(root, normalized, [], safety);
  if (safety.preserve || hasExtremeNesting(root)) return preservedSourceDocument(source);
  resolveReferences(root, normalized);
  const converted = content(root.children);
  const document: JSONContent = {
    type: "doc",
    content: converted.length > 0 ? converted : [{ type: "paragraph" }],
  };
  // A newly standalone HTML comment/declaration can swallow native text after
  // an image split. Its original phrasing cannot be represented losslessly.
  return hasAmbiguousHtmlParagraph(document)
    ? preservedSourceDocument(source)
    : document;
}

function wrapInlineMarks(node: JSONContent, bare: MdNode): MdNode {
  const marks = node.marks ?? [];
  const mark = (type: string) => marks.find((item) => item.type === type);
  let wrapped = bare;
  // Distinct bold/italic delimiters keep overlapping mark runs unambiguous.
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
  // Keep delimiters beside their text rather than HTML's punctuation, which
  // prevents closing emphasis/strike spans from being recognized next to words.
  if (mark("underline")) wrapped = { type: "underline", children: [wrapped] };
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
    case "orderedList": {
      const start = Number(node.attrs?.start ?? 1);
      // CommonMark accepts only nonnegative markers with at most nine digits.
      // Preserve the entire list as HTML when any emitted marker exceeds that
      // range, rather than resetting its numbering or splitting off its items.
      if (
        !Number.isInteger(start) ||
        start < 0 ||
        start > 999999999 ||
        start + (node.content?.length ?? 0) - 1 > 999999999
      )
        return { type: "html", value: tableToHtml(node) };
      return {
        type: "list",
        ordered: true,
        start,
        children: childNodes,
      };
    }
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
    case "inlineFormula": {
      const latex = String(node.attrs?.latex ?? "");
      const requiresHtml = !latex || /[\r\n]|(?:^|[^$])\$(?:[^$]|$)/.test(latex);
      return wrapInlineMarks(node, {
        // Inline math serializers rewrite newlines that resemble Markdown
        // blocks, and empty/single-dollar source needs a double-dollar fence
        // which Typora interprets as display math. Inert HTML keeps its kind.
        type: requiresHtml ? "html" : "inlineMath",
        value: requiresHtml
          ? tableToHtml({ ...node, marks: undefined })
          : latex,
      });
    }
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
