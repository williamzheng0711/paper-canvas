import type { JSONContent } from "@tiptap/core";
import { tableCellPositions } from "./tableGeometry";

function hasUnescapedPipe(source: string): boolean {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "|") continue;
    let slashes = 0;
    for (
      let cursor = index - 1;
      cursor >= 0 && source[cursor] === "\\";
      cursor -= 1
    )
      slashes += 1;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

function unsafeCellInline(node: JSONContent): boolean {
  if (node.type === "inlineFormula") {
    const latex = String(node.attrs?.latex ?? "");
    if (hasUnescapedPipe(latex) || /[\r\n]/.test(latex)) return true;
  }
  if (
    node.type === "inlineHtmlPreview" &&
    /[|\r\n]/.test(String(node.attrs?.source ?? ""))
  )
    return true;
  if (
    node.type === "text" &&
    node.marks?.some((mark) => mark.type === "code") &&
    /\\\||[\r\n]/.test(node.text ?? "")
  )
    return true;
  return (node.content ?? []).some(unsafeCellInline);
}

function cellColumnWidths(cell: JSONContent): number[] | null {
  if (!Array.isArray(cell.attrs?.colwidth)) return null;
  const widths = cell.attrs.colwidth.map((value: unknown) => {
    const width = Number(value);
    return Number.isFinite(width) && width > 0 ? Math.round(width) : 0;
  });
  return widths.some((width: number) => width > 0) ? widths : null;
}

/** Place widths in table columns, accounting for cells spanning earlier rows. */
function tableColumns(table: JSONContent): number[] {
  const widths: number[] = [];
  for (const { cell, column, colspan } of tableCellPositions<JSONContent>(
    (table.content ?? []).map((row) => row.content ?? []),
    (cell) => ({
      colspan: Number(cell.attrs?.colspan ?? 1),
      rowspan: Number(cell.attrs?.rowspan ?? 1),
    }),
  )) {
    const cellWidths = cellColumnWidths(cell);
    for (let offset = 0; offset < colspan; offset += 1) {
      const position = column + offset;
      widths[position] ??= 0;
      if (!widths[position] && cellWidths?.[offset])
        widths[position] = cellWidths[offset];
    }
  }
  return widths;
}

/** GFM cannot represent arbitrary blocks, merged cells, or body-row headers. */
export function requiresHtmlTable(table: JSONContent): boolean {
  return (table.content ?? []).some((row, rowIndex) =>
    (row.content ?? []).some(
      (cell) =>
        cell.type !== (rowIndex === 0 ? "tableHeader" : "tableCell") ||
        Number(cell.attrs?.colspan ?? 1) !== 1 ||
        Number(cell.attrs?.rowspan ?? 1) !== 1 ||
        cellColumnWidths(cell) !== null ||
        unsafeCellInline(cell) ||
        (cell.content ?? []).some((block) => block.type !== "paragraph"),
    ),
  );
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"'\r\n]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
        // Blank lines end a CommonMark HTML block even inside <pre> or an
        // attribute. Entities keep the whole table in one block and restore
        // the source's line breaks when the HTML is rendered or copied.
        "\r": "&#13;",
        "\n": "&#10;",
      })[character]!,
  );
}

function singleLineHtml(source: string): string {
  const encodeBreaks = (value: string) =>
    value.replace(/[\r\n]/g, (character) =>
      character === "\r" ? "&#13;" : "&#10;",
    );
  return source.replace(
    /<!--[\s\S]*?-->|<\/?[A-Za-z][A-Za-z0-9:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>|[^<]+|</g,
    (token) =>
      /^<\/?[A-Za-z]/.test(token)
        ? token.replace(/"[^"]*"|'[^']*'|[\r\n]+/g, (value) =>
            value[0] === '"' || value[0] === "'" ? encodeBreaks(value) : " ",
          )
        : encodeBreaks(token),
  );
}

function attribute(name: string, value: unknown): string {
  return value === null || value === undefined || value === ""
    ? ""
    : ` ${name}="${escapeHtml(value)}"`;
}

function markedHtml(node: JSONContent, html: string): string {
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case "bold":
        html = `<strong>${html}</strong>`;
        break;
      case "italic":
        html = `<em>${html}</em>`;
        break;
      case "strike":
        html = `<del>${html}</del>`;
        break;
      case "underline":
        html = `<u>${html}</u>`;
        break;
      case "code":
        html = `<code>${html}</code>`;
        break;
      case "link":
        html = `<a${attribute("href", mark.attrs?.href)}${attribute("title", mark.attrs?.title)}>${html}</a>`;
        break;
    }
  }
  return html;
}

/** Preserve richer tables as standard HTML, rendered by the existing safe preview. */
export function tableToHtml(node: JSONContent): string {
  const children = () => (node.content ?? []).map(tableToHtml).join("");
  switch (node.type) {
    case "text":
      return markedHtml(node, escapeHtml(node.text));
    case "paragraph":
      return `<p>${children()}</p>`;
    case "heading": {
      const level = Math.max(1, Math.min(6, Number(node.attrs?.level ?? 1)));
      return `<h${level}>${children()}</h${level}>`;
    }
    case "blockquote":
      return `<blockquote>${children()}</blockquote>`;
    case "bulletList":
      return `<ul>${children()}</ul>`;
    case "taskList":
      return `<ul data-type="taskList">${children()}</ul>`;
    case "orderedList":
      return `<ol${attribute("start", node.attrs?.start)}>${children()}</ol>`;
    case "listItem":
      return `<li>${children()}</li>`;
    case "taskItem":
      return `<li data-type="taskItem" data-checked="${Boolean(node.attrs?.checked)}"><span data-papercanvas-task-marker="">${node.attrs?.checked ? "[x]" : "[ ]"} </span><div>${children()}</div></li>`;
    case "codeBlock":
      return `<pre><code${attribute("lang", node.attrs?.language)}${node.attrs?.language ? attribute("class", `language-${node.attrs.language}`) : ""}>${escapeHtml((node.content ?? []).map((child) => child.text ?? "").join(""))}</code></pre>`;
    case "horizontalRule":
      return "<hr>";
    case "hardBreak":
      return "<br>";
    case "image": {
      const image = `<img${attribute("src", node.attrs?.originalSrc ?? node.attrs?.src)}${attribute("alt", node.attrs?.alt)}${attribute("title", node.attrs?.title)}${attribute("width", node.attrs?.width)}${attribute("height", node.attrs?.height)}>`;
      return node.attrs?.linkHref
        ? `<a${attribute("href", node.attrs.linkHref)}${attribute("title", node.attrs.linkTitle)}>${image}</a>`
        : image;
    }
    case "inlineFormula":
      return markedHtml(
        node,
        `<span data-formula-kind="inline"${attribute("latex", node.attrs?.latex)}${attribute("data-latex", node.attrs?.latex)}>${escapeHtml(`$${node.attrs?.latex ?? ""}$`)}</span>`,
      );
    case "blockFormula":
      return `<div data-formula-kind="block"${attribute("latex", node.attrs?.latex)}${attribute("data-latex", node.attrs?.latex)}><pre>${escapeHtml(`$$\n${node.attrs?.latex ?? ""}\n$$`)}</pre></div>`;
    case "footnoteReference":
      return markedHtml(
        node,
        `<sup data-footnote-reference=""${attribute("data-footnote-identifier", node.attrs?.identifier)}${attribute("data-footnote-label", node.attrs?.label)}>${escapeHtml(node.attrs?.label || node.attrs?.identifier)}</sup>`,
      );
    case "footnoteDefinition":
      return `<div data-footnote-definition=""${attribute("data-footnote-identifier", node.attrs?.identifier)}${attribute("data-footnote-label", node.attrs?.label)}><span>${escapeHtml(node.attrs?.label || node.attrs?.identifier)} ↩</span><div class="footnote-content">${children()}</div></div>`;
    case "table": {
      const columns = tableColumns(node);
      const colgroup = columns.some((width) => width > 0)
        ? `<colgroup>${columns.map((width) => `<col${width > 0 ? attribute("width", width) : ""}>`).join("")}</colgroup>`
        : "";
      return `<table>${colgroup}${children()}</table>`;
    }
    case "tableRow":
      return `<tr>${children()}</tr>`;
    case "tableHeader":
    case "tableCell": {
      const tag = node.type === "tableHeader" ? "th" : "td";
      const colspan = Number(node.attrs?.colspan ?? 1);
      const rowspan = Number(node.attrs?.rowspan ?? 1);
      const widths = cellColumnWidths(node);
      const align = node.attrs?.textAlign;
      return `<${tag}${colspan > 1 ? attribute("colspan", colspan) : ""}${rowspan > 1 ? attribute("rowspan", rowspan) : ""}${attribute("colwidth", widths?.join(","))}${["left", "center", "right"].includes(String(align)) ? attribute("align", align) : ""}>${children()}</${tag}>`;
    }
    case "htmlPreview":
    case "inlineHtmlPreview":
      return markedHtml(node, singleLineHtml(String(node.attrs?.source ?? "")));
    case "unsupportedMarkdown":
      return `<pre>${escapeHtml(node.attrs?.source)}</pre>`;
    default:
      return children();
  }
}
