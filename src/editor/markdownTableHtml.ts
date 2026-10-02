import type { JSONContent } from "@tiptap/core";

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

/** GFM cannot represent arbitrary blocks, merged cells, or body-row headers. */
export function requiresHtmlTable(table: JSONContent): boolean {
  return (table.content ?? []).some((row, rowIndex) =>
    (row.content ?? []).some(
      (cell) =>
        cell.type !== (rowIndex === 0 ? "tableHeader" : "tableCell") ||
        Number(cell.attrs?.colspan ?? 1) !== 1 ||
        Number(cell.attrs?.rowspan ?? 1) !== 1 ||
        unsafeCellInline(cell) ||
        (cell.content ?? []).some((block) => block.type !== "paragraph"),
    ),
  );
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
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
    case "taskList":
      return `<ul>${children()}</ul>`;
    case "orderedList":
      return `<ol${attribute("start", node.attrs?.start)}>${children()}</ol>`;
    case "listItem":
      return `<li>${children()}</li>`;
    case "taskItem":
      return `<li>${node.attrs?.checked ? "[x]" : "[ ]"} ${children()}</li>`;
    case "codeBlock":
      return `<pre><code${attribute("lang", node.attrs?.language)}>${escapeHtml((node.content ?? []).map((child) => child.text ?? "").join(""))}</code></pre>`;
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
        `<span>${escapeHtml(`$${node.attrs?.latex ?? ""}$`)}</span>`,
      );
    case "blockFormula":
      return `<pre>${escapeHtml(`$$\n${node.attrs?.latex ?? ""}\n$$`)}</pre>`;
    case "table":
      return `<table>${children()}</table>`;
    case "tableRow":
      return `<tr>${children()}</tr>`;
    case "tableHeader":
    case "tableCell": {
      const tag = node.type === "tableHeader" ? "th" : "td";
      const colspan = Number(node.attrs?.colspan ?? 1);
      const rowspan = Number(node.attrs?.rowspan ?? 1);
      const align = node.attrs?.textAlign;
      return `<${tag}${colspan > 1 ? attribute("colspan", colspan) : ""}${rowspan > 1 ? attribute("rowspan", rowspan) : ""}${["left", "center", "right"].includes(String(align)) ? attribute("align", align) : ""}>${children()}</${tag}>`;
    }
    case "htmlPreview":
    case "inlineHtmlPreview":
      return markedHtml(node, String(node.attrs?.source ?? ""));
    case "unsupportedMarkdown":
      return `<pre>${escapeHtml(node.attrs?.source)}</pre>`;
    default:
      return children();
  }
}
