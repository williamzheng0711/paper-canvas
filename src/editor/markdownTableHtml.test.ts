import { Editor, getSchema, type JSONContent } from "@tiptap/core";
import {
  DOMParser as ProseMirrorDOMParser,
  DOMSerializer,
} from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableRow } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { describe, expect, it } from "vitest";
import { FootnoteDefinition, FootnoteReference } from "./Footnote";
import { BlockFormula, InlineFormula } from "./Formula";
import {
  createHtmlPreview,
  HtmlPreview,
  InlineHtmlPreview,
} from "./HtmlPreview";
import { PaperOrderedList } from "./PaperOrderedList";
import { PaperTableCell, PaperTableHeader } from "./PaperTable";
import { documentToMarkdown, markdownToDocument } from "./markdown";
import { requiresHtmlTable, tableToHtml } from "./markdownTableHtml";
import { sanitizePastedHtml } from "./paste";

const extensions = [
  StarterKit.configure({ orderedList: false }),
  PaperOrderedList,
  TaskList,
  TaskItem.configure({ nested: true }),
  Table,
  TableRow,
  PaperTableCell,
  PaperTableHeader,
  FootnoteReference,
  FootnoteDefinition,
  InlineFormula,
  BlockFormula,
  HtmlPreview,
  InlineHtmlPreview,
];
const schema = getSchema(extensions);

function richTable(blocks: JSONContent[]): JSONContent {
  return {
    type: "table",
    content: [
      {
        type: "tableRow",
        content: [
          {
            type: "tableHeader",
            attrs: { colspan: 2 },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Merged heading" }],
              },
            ],
          },
        ],
      },
      {
        type: "tableRow",
        content: [
          { type: "tableCell", content: blocks },
          { type: "tableCell", content: [{ type: "paragraph" }] },
        ],
      },
    ],
  };
}

function copiedHtml(table: JSONContent): JSONContent {
  const element = document.createElement("div");
  element.innerHTML = sanitizePastedHtml(tableToHtml(table));
  return ProseMirrorDOMParser.fromSchema(schema).parse(element).toJSON();
}

function nodesOfType(node: JSONContent, type: string): JSONContent[] {
  return [
    ...(node.type === type ? [node] : []),
    ...(node.content ?? []).flatMap((child) => nodesOfType(child, type)),
  ];
}

describe("rich table HTML source preservation", () => {
  it("copies a reopened rich-table preview through native editor clipboard serialization and sanitized paste", () => {
    const latex = "a|b\n\nc";
    const table = richTable([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Evidence" },
          {
            type: "footnoteReference",
            attrs: { identifier: "note", label: "Note" },
          },
          { type: "inlineFormula", attrs: { latex } },
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 7 },
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Done" }] },
            ],
          },
        ],
      },
      {
        type: "footnoteDefinition",
        attrs: { identifier: "note", label: "Note" },
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Footnote body" }],
          },
        ],
      },
    ]);
    const source = new Editor({
      extensions,
      content: markdownToDocument(
        documentToMarkdown({ type: "doc", content: [table] }),
      ),
    });
    const destination = new Editor({
      extensions,
      content: "<p>replace me</p>",
      editorProps: { transformPastedHTML: sanitizePastedHtml },
    });
    try {
      expect(source.getJSON().content?.[0].type).toBe("htmlPreview");
      source.commands.selectAll();
      const clipboard = source.view.serializeForClipboard(
        source.state.selection.content(),
      );
      expect(clipboard.text).toContain("Evidence");
      expect(clipboard.text).toContain("Footnote body");
      expect(source.getHTML()).toContain("<table>");
      destination.commands.selectAll();
      destination.view.pasteHTML(
        clipboard.dom.innerHTML,
        new Event("paste") as ClipboardEvent,
      );
      const copied = destination.getJSON();
      expect(nodesOfType(copied, "table")).toHaveLength(1);
      expect(nodesOfType(copied, "tableHeader")[0].attrs?.colspan).toBe(2);
      expect(nodesOfType(copied, "inlineFormula")[0].attrs?.latex).toBe(latex);
      expect(nodesOfType(copied, "orderedList")[0].attrs?.start).toBe(7);
      expect(nodesOfType(copied, "taskItem")[0].attrs?.checked).toBe(true);
      expect(
        nodesOfType(copied, "taskItem")[0].content?.[0].content?.[0].text,
      ).toBe("Done");
      expect(
        nodesOfType(copied, "footnoteReference")[0].attrs?.identifier,
      ).toBe("note");
      expect(
        nodesOfType(copied, "footnoteDefinition")[0].content?.[0].content?.[0]
          .text,
      ).toBe("Footnote body");
      expect(() => destination.state.doc.check()).not.toThrow();
    } finally {
      source.destroy();
      destination.destroy();
    }
  });

  it("keeps blank lines inside nested HTML previews from splitting the table on reopen", () => {
    const source =
      '<div\n title="line one\n\nline two"><pre>one &lt;tag&gt;\r\n\r\n  two &amp; three</pre><!-- hidden\n\ncomment --><p>After</p></div>';
    const table = richTable([{ type: "htmlPreview", attrs: { source } }]);
    const markdown = documentToMarkdown({ type: "doc", content: [table] });
    const reopened = markdownToDocument(markdown);
    expect(reopened.content?.map((node) => node.type)).toEqual(["htmlPreview"]);
    expect(documentToMarkdown(reopened)).toBe(markdown);
    const preview = createHtmlPreview(markdown, { kind: "block" });
    expect(preview.querySelectorAll("table")).toHaveLength(1);
    expect(preview.querySelectorAll("tr")).toHaveLength(2);
    expect(preview.querySelectorAll("td")).toHaveLength(2);
    expect(preview.querySelector("td pre")?.textContent).toBe(
      "one <tag>\r\n\r\n  two & three",
    );
    expect(preview.querySelector("td div")?.getAttribute("title")).toBe(
      "line one\n\nline two",
    );
    expect(preview.textContent).not.toContain("hidden");
    expect(preview.querySelector("td p")?.textContent).toBe("After");
  });

  it("retains footnote reference labels, IDs, formatting and definition bodies after save and copy", () => {
    const table = richTable([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Result" },
          {
            type: "footnoteReference",
            attrs: { identifier: "evidence", label: "Evidence" },
            marks: [{ type: "bold" }],
          },
        ],
      },
      {
        type: "footnoteDefinition",
        attrs: { identifier: "evidence", label: "Evidence" },
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Definition body" }],
          },
        ],
      },
    ]);
    expect(requiresHtmlTable(table)).toBe(true);
    const markdown = documentToMarkdown({ type: "doc", content: [table] });
    const reopened = markdownToDocument(markdown);
    expect(documentToMarkdown(reopened)).toBe(markdown);
    const preview = createHtmlPreview(markdown, { kind: "block" });
    expect(preview.querySelector("sup")?.textContent).toBe("Evidence");
    expect(preview.textContent).toContain("Definition body");
    const copied = copiedHtml(table);
    expect(nodesOfType(copied, "footnoteReference")).toEqual([
      {
        type: "footnoteReference",
        attrs: { identifier: "evidence", label: "Evidence" },
        marks: [{ type: "bold" }],
      },
    ]);
    expect(nodesOfType(copied, "footnoteDefinition")[0]).toMatchObject({
      attrs: { identifier: "evidence", label: "Evidence" },
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Definition body" }],
        },
      ],
    });
  });

  it("keeps exact formula sources when the fallback HTML is copied back into Canvas", () => {
    const inlineLatex = 'a|b\n<z> & \\"quoted\\"';
    const blockLatex = "\\begin{aligned}\nx&=1\\\\\ny&=2\n\\end{aligned}";
    const table = richTable([
      {
        type: "paragraph",
        content: [
          {
            type: "inlineFormula",
            attrs: { latex: inlineLatex },
            marks: [{ type: "italic" }],
          },
        ],
      },
      { type: "blockFormula", attrs: { latex: blockLatex } },
    ]);
    const copied = copiedHtml(table);
    expect(nodesOfType(copied, "inlineFormula")[0]).toMatchObject({
      attrs: { latex: inlineLatex },
      marks: [{ type: "italic" }],
    });
    expect(nodesOfType(copied, "blockFormula")[0]).toMatchObject({
      attrs: { latex: blockLatex },
    });
    const preview = createHtmlPreview(tableToHtml(table), { kind: "block" });
    expect(preview.textContent).toContain(inlineLatex);
    expect(preview.textContent).toContain(blockLatex);
  });

  it("preserves checkbox state and numbered task metadata along with readable fallback markers", () => {
    const table = richTable([
      {
        type: "orderedList",
        attrs: { start: 7 },
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Done" }] },
            ],
          },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Pending" }],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Ordinary" }],
              },
            ],
          },
        ],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Nested task" }],
              },
            ],
          },
        ],
      },
    ]);
    const html = tableToHtml(table);
    const preview = createHtmlPreview(html, { kind: "block" });
    expect(preview.textContent).toContain("[x]");
    expect(preview.textContent).toContain("[ ]");
    const copied = copiedHtml(table);
    expect(nodesOfType(copied, "orderedList")[0].attrs?.start).toBe(7);
    expect(nodesOfType(copied, "taskList")).toHaveLength(1);
    expect(
      nodesOfType(copied, "taskItem").map((node) => node.attrs?.checked),
    ).toEqual([true, false, true]);
    expect(
      nodesOfType(copied, "taskItem").map(
        (node) => node.content?.[0].content?.[0].text,
      ),
    ).toEqual(["Done", "Pending", "Nested task"]);
  });

  it("keeps nested code-block language and literal text when fallback HTML is copied", () => {
    const source = "const value = '<script> & <tag>';\n\n\nvalue();";
    const table = richTable([
      {
        type: "codeBlock",
        attrs: { language: "typescript" },
        content: [{ type: "text", text: source }],
      },
    ]);
    expect(nodesOfType(copiedHtml(table), "codeBlock")[0]).toEqual({
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [{ type: "text", text: source }],
    });
    expect(
      createHtmlPreview(tableToHtml(table), { kind: "block" }).querySelector(
        "pre",
      )?.textContent,
    ).toBe(source);
    const markdown = documentToMarkdown({ type: "doc", content: [table] });
    const reopened = markdownToDocument(markdown);
    expect(reopened.content?.map((node) => node.type)).toEqual(["htmlPreview"]);
    expect(documentToMarkdown(reopened)).toBe(markdown);
  });

  it("does not let blank lines or CRLF in formula sources split an HTML table on reopen", () => {
    const latex = "x|y\r\n\r\nz";
    const table = richTable([
      {
        type: "paragraph",
        content: [{ type: "inlineFormula", attrs: { latex } }],
      },
    ]);
    const markdown = documentToMarkdown({ type: "doc", content: [table] });
    const reopened = markdownToDocument(markdown);
    expect(reopened.content?.map((node) => node.type)).toEqual(["htmlPreview"]);
    expect(documentToMarkdown(reopened)).toBe(markdown);
    expect(
      nodesOfType(copiedHtml(table), "inlineFormula")[0].attrs?.latex,
    ).toBe(latex.replace(/\r\n/g, "\n"));
  });

  it("retains nested tables, alignment, image links and sizes in the safe HTML fallback", () => {
    const nested = richTable([
      { type: "paragraph", content: [{ type: "text", text: "Nested value" }] },
    ]);
    const table = richTable([
      nested,
      {
        type: "image",
        attrs: {
          src: "asset://converted.png",
          originalSrc: "figures/source.png",
          alt: "Diagram",
          title: "Figure",
          width: 320,
          height: 180,
          linkHref: "https://example.com/guide",
          linkTitle: "Guide",
        },
      },
    ]);
    table.content![1].content![0].attrs = { textAlign: "center" };
    const preview = createHtmlPreview(tableToHtml(table), { kind: "block" });
    expect(preview.querySelectorAll("table")).toHaveLength(2);
    expect(preview.querySelector('td[align="center"]')).not.toBeNull();
    const image = preview.querySelector("img");
    expect(image?.getAttribute("src")).toBe("figures/source.png");
    expect(image?.getAttribute("width")).toBe("320");
    expect(image?.getAttribute("height")).toBe("180");
    expect(image?.closest("a")?.getAttribute("href")).toBe(
      "https://example.com/guide",
    );
    expect(image?.closest("a")?.getAttribute("title")).toBe("Guide");
  });

  it("retains resized column widths through Markdown save, safe preview and native copy", () => {
    const table = markdownToDocument(
      "| A | B |\n| --- | --- |\n| First | Second |",
    ).content![0];
    for (const row of table.content!) {
      row.content!.forEach((cell, index) => {
        cell.attrs = { ...cell.attrs, colwidth: [index === 0 ? 140 : 260] };
      });
    }
    expect(requiresHtmlTable(table)).toBe(true);
    const markdown = documentToMarkdown({ type: "doc", content: [table] });
    const reopened = markdownToDocument(markdown);
    expect(reopened.content?.map((node) => node.type)).toEqual(["htmlPreview"]);
    expect(documentToMarkdown(reopened)).toBe(markdown);
    const preview = createHtmlPreview(markdown, { kind: "block" });
    expect(
      [...preview.querySelectorAll("col")].map((column) =>
        column.getAttribute("width"),
      ),
    ).toEqual(["140", "260"]);
    const expected = [140, 260, 140, 260];
    const widths = (document: JSONContent) =>
      [
        ...nodesOfType(document, "tableHeader"),
        ...nodesOfType(document, "tableCell"),
      ].flatMap((cell) => cell.attrs?.colwidth ?? []);
    expect(widths(copiedHtml(table))).toEqual(expected);

    // Copying an editable native table follows the real schema DOM serializer,
    // a different path from copying the noneditable fallback table above.
    const editable = schema.nodeFromJSON({ type: "doc", content: [table] });
    const clipboard = document.createElement("div");
    clipboard.append(
      DOMSerializer.fromSchema(schema).serializeFragment(editable.content),
    );
    const pasted = document.createElement("div");
    pasted.innerHTML = sanitizePastedHtml(clipboard.innerHTML);
    expect(
      widths(ProseMirrorDOMParser.fromSchema(schema).parse(pasted).toJSON()),
    ).toEqual(expected);
  });

  it("keeps merged-cell width arrays and column positions under rowspans", () => {
    const table = richTable([{ type: "paragraph" }]);
    table.content![0].content![0].attrs = { colspan: 2, colwidth: [100, 240] };
    table.content![1].content![0].attrs = { rowspan: 2, colwidth: [100] };
    table.content![1].content![1].attrs = { colwidth: [240] };
    table.content!.push({
      type: "tableRow",
      content: [
        {
          type: "tableCell",
          attrs: { colwidth: [240] },
          content: [{ type: "paragraph" }],
        },
      ],
    });
    const preview = createHtmlPreview(tableToHtml(table), { kind: "block" });
    expect(
      [...preview.querySelectorAll("col")].map((column) =>
        column.getAttribute("width"),
      ),
    ).toEqual(["100", "240"]);
    const copied = copiedHtml(table);
    expect(nodesOfType(copied, "tableHeader")[0].attrs?.colwidth).toEqual([
      100, 240,
    ]);
    expect(
      nodesOfType(copied, "tableCell").map((cell) => cell.attrs?.colwidth),
    ).toEqual([[100], [240], [240]]);
  });

  it("preserves underline marks on rich table text and inline formulas", () => {
    const table = richTable([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "Underlined ", marks: [{ type: "underline" }] },
          {
            type: "inlineFormula",
            attrs: { latex: "a|b" },
            marks: [{ type: "underline" }],
          },
        ],
      },
    ]);
    const copied = copiedHtml(table);
    expect(
      nodesOfType(copied, "text").find((node) => node.text === "Underlined ")
        ?.marks,
    ).toEqual([{ type: "underline" }]);
    expect(nodesOfType(copied, "inlineFormula")[0].marks).toEqual([
      { type: "underline" },
    ]);
    expect(
      createHtmlPreview(tableToHtml(table), { kind: "block" }).querySelectorAll(
        "u",
      ),
    ).toHaveLength(2);
  });
});
