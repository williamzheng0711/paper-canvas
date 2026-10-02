import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSchema, type JSONContent } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { splitBlock } from "@tiptap/pm/commands";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableRow } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { describe, expect, it } from "vitest";
import { InlineFormula, BlockFormula } from "./Formula";
import { HtmlPreview, InlineHtmlPreview, htmlPreviewText } from "./HtmlPreview";
import { PaperImage } from "./PaperImage";
import { PaperCode, PaperLink } from "./PaperLink";
import { PaperTableCell, PaperTableHeader } from "./PaperTable";
import { UnsupportedMarkdown } from "./UnsupportedMarkdown";
import { documentToMarkdown, markdownToDocument } from "./markdown";

const schema = getSchema([
  StarterKit.configure({ code: false, link: false }),
  PaperCode,
  PaperLink,
  PaperImage,
  Table,
  TableRow,
  PaperTableCell,
  PaperTableHeader,
  TaskList,
  TaskItem.configure({ nested: true }),
  InlineFormula,
  BlockFormula,
  HtmlPreview,
  InlineHtmlPreview,
  UnsupportedMarkdown,
]);

function allText(node: JSONContent): string {
  return `${node.text ?? ""}${node.attrs?.source ?? ""}${node.content?.map(allText).join("") ?? ""}`;
}

describe("reading fixtures in the real editor schema", () => {
  it("preserves the additional paragraph and formula created by Enter in a table cell", () => {
    const imported = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(
        "| Heading | Value |\n| --- | --- |\n| First | $x^2$ |",
      ),
    );
    let formulaPosition = 0;
    imported.descendants((node, position) => {
      if (node.type.name === "inlineFormula") formulaPosition = position;
    });
    let state = EditorState.create({
      schema,
      doc: imported,
      selection: TextSelection.create(imported, formulaPosition),
    });
    expect(
      splitBlock(state, (transaction) => {
        state = state.apply(transaction);
      }),
    ).toBe(true);
    state = state.apply(state.tr.insertText("Second line "));
    const edited = state.doc.toJSON();
    const serialized = documentToMarkdown(edited);
    expect(serialized).toContain("Second line");
    expect(serialized).toContain("$x^2$");
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(serialized),
    );
    expect(() => reopened.check()).not.toThrow();
    expect(reopened.toJSON()).toEqual(edited);
  });

  it("preserves hard breaks and formatting in every table-cell paragraph", () => {
    const imported = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument("| Heading |\n| --- |\n| First |"),
    );
    const edited = imported.toJSON();
    edited.content![0].content![1].content![0].content = [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "first | line", marks: [{ type: "bold" }] },
          { type: "hardBreak" },
          { type: "text", text: "after break" },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "inlineFormula", attrs: { latex: "x^2" } },
          { type: "text", text: "second ` line", marks: [{ type: "code" }] },
        ],
      },
      { type: "paragraph" },
    ];
    const before = ProseMirrorNode.fromJSON(schema, edited);
    const serialized = documentToMarkdown(before.toJSON());
    expect(serialized).toContain("after break");
    expect(serialized).toContain("second");
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(serialized),
    );
    expect(() => reopened.check()).not.toThrow();
    expect(reopened.toJSON()).toEqual(before.toJSON());
  });

  it.each([
    "# Literal heading",
    "- Literal list",
    "> Literal quote",
    "    Literal indentation",
    "1. Literal numbering",
    "---",
  ])("retains literal paragraph text in multiline table cells: %s", (text) => {
    const edited = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument("| Heading |\n| --- |\n| First |"),
    ).toJSON();
    edited.content![0].content![1].content![0].content = [
      { type: "paragraph", content: [{ type: "text", text }] },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Second paragraph" }],
      },
    ];
    const before = ProseMirrorNode.fromJSON(schema, edited);
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(documentToMarkdown(before.toJSON())),
    );
    expect(() => reopened.check()).not.toThrow();
    expect(reopened.toJSON()).toEqual(before.toJSON());
  });

  it("decodes table escaping exactly once for inline code in additional paragraphs", () => {
    const edited = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument("| Heading |\n| --- |\n| First |"),
    ).toJSON();
    edited.content![0].content![1].content![0].content = [
      {
        type: "paragraph",
        content: [{ type: "text", text: "a|b", marks: [{ type: "code" }] }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Second paragraph" }],
      },
      { type: "paragraph" },
    ];
    const before = ProseMirrorNode.fromJSON(schema, edited);
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(documentToMarkdown(before.toJSON())),
    );
    expect(reopened.toJSON()).toEqual(before.toJSON());
  });

  it.each([
    [{ type: "text", text: "a\\|b", marks: [{ type: "code" }] }, "a\\|b"],
    [{ type: "inlineFormula", attrs: { latex: "a|b" } }, "a|b"],
    [{ type: "inlineFormula", attrs: { latex: "a\\\\|b" } }, "a\\\\|b"],
    [{ type: "inlineFormula", attrs: { latex: "x\ny" } }, "x\ny"],
    [
      {
        type: "inlineHtmlPreview",
        attrs: { source: '<span title="a|b">t</span>' },
      },
      'title="a|b"',
    ],
  ] satisfies Array<[JSONContent, string]>)(
    "retains inline content that cannot fit a GFM table row: %j",
    (inline, retained) => {
      const edited = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument("| Heading |\n| --- |\n| First |"),
      ).toJSON();
      edited.content![0].content![1].content![0].content = [
        { type: "paragraph", content: [inline] },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second paragraph" }],
        },
      ];
      const serialized = documentToMarkdown(
        ProseMirrorNode.fromJSON(schema, edited).toJSON(),
      );
      expect(serialized).toContain("<table>");
      expect(serialized).toContain(retained);
      expect(serialized).toContain("Second paragraph");
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(serialized),
      );
      expect(() => reopened.check()).not.toThrow();
      expect(reopened.firstChild?.type.name).toBe("htmlPreview");
      expect(documentToMarkdown(reopened.toJSON())).toBe(serialized);
    },
  );

  it("keeps an escaped LaTeX pipe editable in a multiline GFM cell", () => {
    const edited = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument("| Heading |\n| --- |\n| First |"),
    ).toJSON();
    edited.content![0].content![1].content![0].content = [
      {
        type: "paragraph",
        content: [{ type: "inlineFormula", attrs: { latex: "a\\|b" } }],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "Second paragraph" }],
      },
    ];
    const before = ProseMirrorNode.fromJSON(schema, edited);
    const serialized = documentToMarkdown(before.toJSON());
    expect(serialized).not.toContain("<table>");
    expect(
      ProseMirrorNode.fromJSON(schema, markdownToDocument(serialized)).toJSON(),
    ).toEqual(before.toJSON());
  });

  it("preserves every block in rich table cells instead of discarding nonparagraph blocks", () => {
    const edited = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument("| Heading |\n| --- |\n| First |"),
    ).toJSON();
    edited.content![0].content![1].content![0].content = [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Cell heading" }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Nested item" }],
              },
            ],
          },
        ],
      },
      {
        type: "codeBlock",
        attrs: { language: "js" },
        content: [{ type: "text", text: "const example = '<script>';" }],
      },
      { type: "image", attrs: { src: "diagram.png", alt: "Diagram" } },
    ];
    const serialized = documentToMarkdown(
      ProseMirrorNode.fromJSON(schema, edited).toJSON(),
    );
    expect(serialized).toContain('src="diagram.png"');
    expect(serialized).toContain("&lt;script&gt;");
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(serialized),
    );
    expect(() => reopened.check()).not.toThrow();
    expect(reopened.firstChild?.type.name).toBe("htmlPreview");
    const text = htmlPreviewText(
      String(reopened.firstChild?.attrs.source),
      "block",
    );
    for (const value of [
      "Cell heading",
      "Nested item",
      "const example = '<script>';",
    ])
      expect(text).toContain(value);
    expect(documentToMarkdown(reopened.toJSON())).toBe(serialized);
  });

  it("preserves image sources and the task checkbox when unrelated text is edited", () => {
    const source = '# ![Logo](logo.svg "Logo title") Title\n\n- [x] [![Badge](badge.svg)](https://example.com/guide "Guide title")\n\n| Figure |\n| :---: |\n| ![Diagram](diagram.png "Figure title") |\n\nOriginal text.';
    const imported = ProseMirrorNode.fromJSON(schema, markdownToDocument(source));
    expect(() => imported.check()).not.toThrow();
    const edited = imported.toJSON();
    edited.content!.at(-1)!.content = [{ type: "text", text: "Edited text." }];
    const serialized = documentToMarkdown(edited);
    expect(serialized).toContain("[x]");
    expect(serialized).toContain("Edited text.");
    for (const value of ["logo.svg", "Logo title", "badge.svg", "https://example.com/guide", "Guide title", "diagram.png", "Figure title"])
      expect(serialized).toContain(value);
    const reopened = ProseMirrorNode.fromJSON(schema, markdownToDocument(serialized));
    expect(() => reopened.check()).not.toThrow();
    expect(reopened.toJSON()).toEqual(edited);
    expect(reopened.child(1).firstChild?.attrs.checked).toBe(true);
  });

  it.each([
    "- Parent\n  - [x] done\n  - ordinary\n  - [ ] pending",
    "- [x] Parent\n  - [ ] child\n  - ordinary child",
    "1. [x] ordered task\n2. ordinary item",
    "- [x]",
    "- [ ] ",
    "- [x]\n\n  # A heading after a checked item",
    "- [ ]\n\n  ```ts\n  const value = 1;\n  ```",
    "- [x]\n\n  # ![Logo](logo.svg) Title",
    "- Parent\n  - # ![Logo](logo.svg) Title",
    "- [x]\n\n  | Figure |\n  | --- |\n  | ![Diagram](diagram.png) |",
    "Before ![Diagram](diagram.png) after.",
    "**Before ![Diagram](diagram.png) after.**",
    "- [x] Before ![Diagram](diagram.png) after.",
    "- Parent\n  - [x] ![Nested](nested.png)",
    "> ![Diagram](diagram.png)\n>\n> ## Following heading",
    "```ts\n```",
    "```text\nfirst\n\n\n\nlast\n```",
    "Before <kbd>*Ctrl*</kbd> after.",
    "Before <kbd>Ctrl after.",
    "<details><summary>Read more</summary><p>Content</p></details>",
    '<a href="https://example.com"><img src="figure.png" alt="Diagram"></a>',
    "Before <script>alert(1)</script> after.",
    "<!-- hidden comment -->\n\nVisible text.",
    "# **Cost $x^2$** and [$y$](https://example.com)",
    "| Formula | Value |\n| :--- | ---: |\n| **$x^2$** | $y$ |",
    "**Cost $x^2$** and *$x$ plus $y$*.",
    "[Cost $x^2$](https://example.com \"Price\")",
    "***Cost $x^2$*** and ~~$x$ plus $y$~~.",
    "**Press <kbd>Ctrl</kbd>** then **$x$**.",
    "| Formula |\n| --- |\n| **Cost $x^2$** |",
  ])("keeps adversarial reading content valid and stable: %s", (source) => {
    const imported = ProseMirrorNode.fromJSON(schema, markdownToDocument(source));
    expect(() => imported.check()).not.toThrow();
    const serialized = documentToMarkdown(imported.toJSON());
    const reopened = ProseMirrorNode.fromJSON(schema, markdownToDocument(serialized));
    expect(() => reopened.check()).not.toThrow();
    expect(reopened.toJSON()).toEqual(imported.toJSON());
  });

  it.each([
    "- ![Diagram](diagram.png)",
    "- [x] ![Diagram](diagram.png)",
    "- [ ] [![Badge](badge.png)](https://example.com/guide)",
    "- ![Diagram](diagram.png) remaining text",
    "1. ![Diagram](diagram.png)",
    "- # An item beginning with a heading",
    "- ```ts\n  const value = 1;\n  ```",
  ])("keeps the required list-item paragraph and authored content: %s", (source) => {
    const imported = ProseMirrorNode.fromJSON(schema, markdownToDocument(source));
    expect(() => imported.check()).not.toThrow();
    const serialized = documentToMarkdown(imported.toJSON());
    const reopened = ProseMirrorNode.fromJSON(schema, markdownToDocument(serialized));
    expect(() => reopened.check()).not.toThrow();
    expect(reopened.toJSON()).toEqual(imported.toJSON());
    if (source.includes("[x]")) expect(serialized).toContain("[x]");
    if (source.includes("[ ]")) expect(serialized).toContain("[ ]");
    if (source.includes("diagram.png")) expect(serialized).toContain("diagram.png");
    if (source.includes("badge.png")) {
      expect(serialized).toContain("badge.png");
      expect(serialized).toContain("https://example.com/guide");
    }
  });

  it.each([
    '# ![Logo](logo.svg "Logo title") Title',
    '# [![Badge](badge.svg)](https://example.com/guide "Read guide") Title',
    '| Figure |\n| :---: |\n| ![Diagram](diagram.png "Figure title") |',
    '| Figure |\n| ---: |\n| [![Badge][image]][guide] |\n\n[image]: badge.svg "Badge title"\n[guide]: https://example.com/guide',
  ])("preserves image-bearing headings and tables without invalid inline images: %s", (source) => {
    const imported = ProseMirrorNode.fromJSON(schema, markdownToDocument(source));
    expect(() => imported.check()).not.toThrow();
    expect(imported.firstChild?.type.name).toBe("unsupportedMarkdown");
    const serialized = documentToMarkdown(imported.toJSON());
    const reopened = ProseMirrorNode.fromJSON(schema, markdownToDocument(serialized));
    expect(() => reopened.check()).not.toThrow();
    expect(reopened.toJSON()).toEqual(imported.toJSON());
    for (const value of ["logo.svg", "badge.svg", "diagram.png", "https://example.com/guide", "Logo title", "Figure title", "Badge title"]) {
      if (source.includes(value)) expect(serialized).toContain(value);
    }
    if (source.includes(":---:")) expect(serialized).toMatch(/:-+:|:-+\s*:/);
  });

  it.each(["remark-gfm-readme.md", "reading-edge-cases.md"])(
    "loads %s without schema-invalid or silently discarded content",
    (file) => {
      const source = readFileSync(
        resolve(process.cwd(), "test-fixtures/reading-demo", file),
        "utf8",
      );
      const imported = markdownToDocument(source);
      const document = ProseMirrorNode.fromJSON(schema, imported);
      expect(() => document.check()).not.toThrow();
      const serialized = documentToMarkdown(document.toJSON());
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(serialized),
      );
      expect(() => reopened.check()).not.toThrow();
      expect(reopened.toJSON()).toEqual(document.toJSON());
      if (file === "reading-edge-cases.md") {
        expect(allText(document.toJSON())).toContain(
          "An ordinary bullet before the tasks.",
        );
        expect(allText(document.toJSON())).toContain(
          "An ordinary bullet after the tasks.",
        );
        expect(serialized).toContain("[`Code examples`](#code-examples)");
        const alignments: unknown[] = [];
        document.descendants((node) => {
          if (node.type.name === "tableHeader")
            alignments.push(node.attrs.textAlign);
        });
        expect(alignments).toEqual(["left", "right", "center"]);
      }
    },
  );
});
