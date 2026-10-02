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
import { FootnoteReference, FootnoteDefinition } from "./Footnote";
import { PaperOrderedList } from "./PaperOrderedList";
import { PaperCode, PaperLink } from "./PaperLink";
import { PaperTableCell, PaperTableHeader } from "./PaperTable";
import { UnsupportedMarkdown } from "./UnsupportedMarkdown";
import { documentToMarkdown, markdownToDocument } from "./markdown";

const schema = getSchema([
  StarterKit.configure({ code: false, link: false, orderedList: false }),
  PaperOrderedList,
  FootnoteReference,
  FootnoteDefinition,
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
  it.each([
    "before <span>HTML 中文</span> after\n",
    "\\[\nx + y\n\\]\n\nAfter\n",
    "\\begin{align}\nx &= y\n\\end{align}\n\nAfter\n",
    "`\\(literal\\)` before <kbd>\\(HTML literal\\)</kbd> after\n",
  ])("keeps BOM parsing and ordinary canvas edits faithful: %j", (body) => {
    const imported = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument("\uFEFF" + body),
    );
    imported.check();
    expect(imported.toJSON()).toEqual(
      ProseMirrorNode.fromJSON(schema, markdownToDocument(body)).toJSON(),
    );
    const state = EditorState.create({ schema, doc: imported });
    const edited = state.apply(
      state.tr.insertText(" edited", imported.content.size - 1),
    );
    edited.doc.check();
    const saved = documentToMarkdown(edited.doc.toJSON());
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(saved),
    );
    reopened.check();
    expect(reopened.toJSON(), saved).toEqual(edited.doc.toJSON());
    expect(allText(reopened.toJSON())).toContain(" edited");
    if (body.includes("<span>")) {
      expect(imported.toJSON().content?.[0].content?.[1]).toMatchObject({
        type: "inlineHtmlPreview",
        attrs: { source: "<span>HTML 中文</span>" },
      });
    }
    if (body.startsWith("\\["))
      expect(imported.toJSON().content?.[0]).toMatchObject({
        type: "blockFormula",
        attrs: { latex: "x + y" },
      });
  });

  it.each([2, 3])(
    "preserves %i leading BOM markers without consuming content",
    (count) => {
      const source =
        "\uFEFF".repeat(count) + "before <span>HTML</span> after\r\n";
      const document = markdownToDocument(source);
      expect(document.content?.[0].type).toBe("unsupportedMarkdown");
      expect(documentToMarkdown(document)).toBe(source);
    },
  );

  it.each(["- [x] <d>", "- [x] <!-->", "- [x] <u>", "- [x] <d>![]()"])(
    "retains a task marker when its first paragraph contains incomplete HTML: %j",
    (source) => {
      const imported = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(source),
      );
      imported.check();
      const saved = documentToMarkdown(imported.toJSON());
      expect(saved).toContain("[x]");
      expect(
        ProseMirrorNode.fromJSON(schema, markdownToDocument(saved)).toJSON(),
      ).toEqual(imported.toJSON());
    },
  );

  it.each(["![]()<!-->a", "![]()<!-->*", "![]()<!d>$"])(
    "preserves image-split HTML that would swallow following native text: %j",
    (source) => {
      const document = markdownToDocument(source);
      const imported = ProseMirrorNode.fromJSON(schema, document);
      imported.check();
      expect(document.content?.[0]?.type).toBe("unsupportedMarkdown");
      expect(documentToMarkdown(imported.toJSON())).toBe(source);
    },
  );

  it.each(["<u>![]()", "![]()<u>", "![]()<x>", "![]()<!-->", "[b]:x\n<d>"])(
    "keeps standalone HTML classification stable after paragraph splitting: %j",
    (source) => {
      const imported = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(source),
      );
      imported.check();
      const saved = documentToMarkdown(imported.toJSON());
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(saved),
      );
      reopened.check();
      expect(reopened.toJSON(), saved).toEqual(imported.toJSON());
    },
  );

  it.each(["- <kbd>|\n--\n~</kbd>", "><kbd>|\n--\n</kbd>["])(
    "preserves lazy inline HTML whose continuation would change block structure on save: %j",
    (source) => {
      const document = markdownToDocument(source);
      const imported = ProseMirrorNode.fromJSON(schema, document);
      imported.check();
      expect(document.content?.[0]?.type).toBe("unsupportedMarkdown");
      expect(documentToMarkdown(imported.toJSON())).toBe(source);
    },
  );

  it.each([
    "><kbd>x\n]</kbd>",
    "> <kbd>x\n> ]</kbd>",
    "- <kbd>x\n  y</kbd>",
    "> - <kbd>x\n>   y</kbd>",
    "> > <kbd>x\n> > y</kbd>",
    "3. <kbd>x\n   y</kbd>",
    "[^a]: <kbd>x\n    y</kbd>",
    "> <kbd\n> title='x'>y</kbd>",
    "-\t<kbd>x\n\ty</kbd>",
    "> -\t<kbd>x\n> \ty</kbd>",
    "-     code\n\n  <kbd>x\n  y</kbd>",
  ])("keeps container syntax out of multiline inline HTML: %j", (source) => {
    const imported = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(source),
    );
    imported.check();
    const saved = documentToMarkdown(imported.toJSON());
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(saved),
    );
    reopened.check();
    expect(reopened.toJSON(), saved).toEqual(imported.toJSON());
    expect(allText(imported.toJSON())).not.toContain("> ");
  });

  it.each([
    "[^a]:![]()[^a]:",
    "![]()[^a]:\n[^a]:",
    "text[^a]: punctuation\n\n[^a]: Definition.",
  ])("keeps a footnote reference followed by a colon as text: %j", (source) => {
    const imported = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(source),
    );
    imported.check();
    const saved = documentToMarkdown(imported.toJSON());
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(saved),
    );
    reopened.check();
    expect(reopened.toJSON(), saved).toEqual(imported.toJSON());
  });

  it.each(["*\n[x] a", "*\n[ ] a", "*\n[x] \\(x\\)"])(
    "preserves source when the task parser rejects %j",
    (source) => {
      const document = markdownToDocument(source);
      const imported = ProseMirrorNode.fromJSON(schema, document);
      imported.check();
      expect(document.content?.[0]?.type).toBe("unsupportedMarkdown");
      expect(documentToMarkdown(imported.toJSON())).toBe(source);
    },
  );

  it.each(["- [x]\r\na", "- [ ]\r\na", "- [X]\r\n  a", "1. [x]\r\na"])(
    "round-trips a CRLF task marker without an artificial leading line break: %j",
    (source) => {
      const imported = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(source),
      );
      imported.check();
      expect(allText(imported.toJSON())).toBe("a");
      const saved = documentToMarkdown(imported.toJSON());
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(saved),
      );
      reopened.check();
      expect(reopened.toJSON()).toEqual(imported.toJSON());
    },
  );

  it.each(["$x$", "*a*", "<u>x</u>", "<kbd>x</kbd>"])(
    "does not leave an empty text node before task continuation content %j",
    (value) => {
      const imported = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(`- [x]\r\n${value}`),
      );
      imported.check();
      const saved = documentToMarkdown(imported.toJSON());
      expect(
        ProseMirrorNode.fromJSON(schema, markdownToDocument(saved)).toJSON(),
      ).toEqual(imported.toJSON());
    },
  );

  it.each(["\na", "a\n", "\r\na\r\n"])(
    "preserves literal line endings at task text edges: %j",
    (text) => {
      const edited = ProseMirrorNode.fromJSON(schema, {
        type: "doc",
        content: [
          {
            type: "taskList",
            content: [
              {
                type: "taskItem",
                attrs: { checked: true },
                content: [
                  { type: "paragraph", content: [{ type: "text", text }] },
                ],
              },
            ],
          },
        ],
      });
      const saved = documentToMarkdown(edited.toJSON());
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(saved),
      );
      reopened.check();
      expect(reopened.toJSON(), saved).toEqual(edited.toJSON());
    },
  );

  it("round-trips every adjacent bold, italic, strike and underline combination", () => {
    const types = ["bold", "italic", "strike", "underline"];
    const text = (mask: number, value: string): JSONContent => ({
      type: "text",
      text: value,
      marks: types
        .filter((_, index) => mask & (1 << index))
        .map((type) => ({ type })),
    });
    for (let left = 0; left < 16; left += 1) {
      for (let right = 0; right < 16; right += 1) {
        for (const separator of ["", " ", "\\"]) {
          const edited = ProseMirrorNode.fromJSON(schema, {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [text(left, `a${separator}`), text(right, "b")],
              },
            ],
          });
          const saved = documentToMarkdown(edited.toJSON());
          const reopened = ProseMirrorNode.fromJSON(
            schema,
            markdownToDocument(saved),
          );
          expect(reopened.toJSON(), saved).toEqual(edited.toJSON());
        }
      }
    }
  });

  it.each([
    { type: "text", text: "a ", marks: [{ type: "strike" }] },
    { type: "text", text: "a\\", marks: [{ type: "strike" }] },
    {
      type: "inlineFormula",
      attrs: { latex: "x" },
      marks: [{ type: "strike" }],
    },
    {
      type: "inlineHtmlPreview",
      attrs: { source: "<kbd>x</kbd>" },
      marks: [{ type: "strike" }],
    },
  ] satisfies JSONContent[])(
    "keeps strike around punctuation and spaced runs beside words: %j",
    (inline) => {
      const edited = ProseMirrorNode.fromJSON(schema, {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Before" },
              inline,
              { type: "text", text: "after" },
            ],
          },
        ],
      });
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(documentToMarkdown(edited.toJSON())),
      );
      expect(reopened.toJSON()).toEqual(edited.toJSON());
    },
  );

  it.each(["\n[", "\n# heading", "x\r\n\r\ny", "x\n<&\"'>&amp;&#10;$", "\n"])(
    "retains exact multiline inline formula sources on save/reopen: %j",
    (latex) => {
      const edited = ProseMirrorNode.fromJSON(schema, {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Before " },
              {
                type: "inlineFormula",
                attrs: { latex },
                marks: [{ type: "underline" }, { type: "bold" }],
              },
              { type: "text", text: " after." },
            ],
          },
        ],
      });
      const saved = documentToMarkdown(edited.toJSON());
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(saved),
      );
      expect(reopened.toJSON()).toEqual(edited.toJSON());
      expect(documentToMarkdown(reopened.toJSON())).toBe(saved);
    },
  );

  it.each([
    "***i**c*",
    "**d**<u>*c*</u>",
    "*t*<u>**d**</u>",
    "<u>*c*</u>**d**",
    "<u>~~s~~</u>a",
    "\\a<u>*d*</u>",
    "\\a*c*",
    "*\\a*l",
    "\\*\\**a*\\a*next*",
    "**before <u>middle</u> after**",
  ])(
    "keeps overlapping and adjacent marks without introducing delimiters: %s",
    (source) => {
      const imported = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(source),
      );
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(documentToMarkdown(imported.toJSON())),
      );
      expect(reopened.toJSON()).toEqual(imported.toJSON());
    },
  );

  it.each([
    `${"> ".repeat(2_000)}body $x$`,
    `${"> ".repeat(2_000)}body \\(x\\)`,
    "# Heading\n\nText with a \0 byte.\n\n```\ncode\0data\n```\n",
  ])(
    "preserves extreme nesting and literal NULs as recoverable source",
    (source) => {
      const imported = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(source),
      );
      expect(() => imported.check()).not.toThrow();
      expect(imported.firstChild?.type.name).toBe("unsupportedMarkdown");
      expect(imported.firstChild?.attrs.source).toBe(source);
      expect(documentToMarkdown(imported.toJSON())).toBe(source);
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(documentToMarkdown(imported.toJSON())),
      );
      expect(reopened.toJSON()).toEqual(imported.toJSON());
    },
  );

  it.each([
    "[x][target]\n\n> [target]: /destination",
    "[x][target]\n\n> > [target]: /destination",
    ">",
  ])(
    "keeps empty blockquotes schema-valid after resolving definitions: %s",
    (source) => {
      const imported = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(source),
      );
      expect(() => imported.check()).not.toThrow();
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(documentToMarkdown(imported.toJSON())),
      );
      expect(() => reopened.check()).not.toThrow();
      expect(reopened.toJSON()).toEqual(imported.toJSON());
    },
  );

  it.each([
    "<u>first<br>second</u>",
    "first<br><kbd>second</kbd>",
    "# first<br>second",
    "**first<br>second**",
    "first<br>",
    "<br>",
    "<br><br>",
    "<br>![image](image.png)",
  ])("retains hard breaks next to HTML and inside headings: %s", (source) => {
    const imported = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(source),
    );
    expect(imported.textContent).not.toContain("\\");
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(documentToMarkdown(imported.toJSON())),
    );
    expect(reopened.toJSON()).toEqual(imported.toJSON());
  });

  it.each([" ", " spaced ", "\tspaced\t", "\nspaced\n", "\u00a0spaced\u00a0"])(
    "retains exact whitespace inside a strikethrough run: %j",
    (text) => {
      const edited = ProseMirrorNode.fromJSON(schema, {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text, marks: [{ type: "strike" }] }],
          },
        ],
      });
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(documentToMarkdown(edited.toJSON())),
      );
      expect(reopened.toJSON()).toEqual(edited.toJSON());
    },
  );

  it("makes ragged GFM rows rectangular without losing overflow fields", () => {
    const imported = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(
        "| A | B |\n| --- | --- |\n| short |\n| extra | **field** | $x$ |",
      ),
    );
    const table = imported.firstChild!;
    expect(
      Array.from(
        { length: table.childCount },
        (_, index) => table.child(index).childCount,
      ),
    ).toEqual([3, 3, 3]);
    expect(table.child(2).child(2).firstChild?.firstChild?.type.name).toBe(
      "inlineFormula",
    );
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(documentToMarkdown(imported.toJSON())),
    );
    expect(reopened.toJSON()).toEqual(imported.toJSON());
  });

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
    [{ type: "inlineFormula", attrs: { latex: "x\ny" } }, "x&#10;y"],
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
    const source =
      '# ![Logo](logo.svg "Logo title") Title\n\n- [x] [![Badge](badge.svg)](https://example.com/guide "Guide title")\n\n| Figure |\n| :---: |\n| ![Diagram](diagram.png "Figure title") |\n\nOriginal text.';
    const imported = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(source),
    );
    expect(() => imported.check()).not.toThrow();
    const edited = imported.toJSON();
    edited.content!.at(-1)!.content = [{ type: "text", text: "Edited text." }];
    const serialized = documentToMarkdown(edited);
    expect(serialized).toContain("[x]");
    expect(serialized).toContain("Edited text.");
    for (const value of [
      "logo.svg",
      "Logo title",
      "badge.svg",
      "https://example.com/guide",
      "Guide title",
      "diagram.png",
      "Figure title",
    ])
      expect(serialized).toContain(value);
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(serialized),
    );
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
    '[Cost $x^2$](https://example.com "Price")',
    "***Cost $x^2$*** and ~~$x$ plus $y$~~.",
    "**Press <kbd>Ctrl</kbd>** then **$x$**.",
    "| Formula |\n| --- |\n| **Cost $x^2$** |",
  ])("keeps adversarial reading content valid and stable: %s", (source) => {
    const imported = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(source),
    );
    expect(() => imported.check()).not.toThrow();
    const serialized = documentToMarkdown(imported.toJSON());
    const reopened = ProseMirrorNode.fromJSON(
      schema,
      markdownToDocument(serialized),
    );
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
  ])(
    "keeps the required list-item paragraph and authored content: %s",
    (source) => {
      const imported = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(source),
      );
      expect(() => imported.check()).not.toThrow();
      const serialized = documentToMarkdown(imported.toJSON());
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(serialized),
      );
      expect(() => reopened.check()).not.toThrow();
      expect(reopened.toJSON()).toEqual(imported.toJSON());
      if (source.includes("[x]")) expect(serialized).toContain("[x]");
      if (source.includes("[ ]")) expect(serialized).toContain("[ ]");
      if (source.includes("diagram.png"))
        expect(serialized).toContain("diagram.png");
      if (source.includes("badge.png")) {
        expect(serialized).toContain("badge.png");
        expect(serialized).toContain("https://example.com/guide");
      }
    },
  );

  it.each([
    '# ![Logo](logo.svg "Logo title") Title',
    '# [![Badge](badge.svg)](https://example.com/guide "Read guide") Title',
    '| Figure |\n| :---: |\n| ![Diagram](diagram.png "Figure title") |',
    '| Figure |\n| ---: |\n| [![Badge][image]][guide] |\n\n[image]: badge.svg "Badge title"\n[guide]: https://example.com/guide',
  ])(
    "preserves image-bearing headings and tables without invalid inline images: %s",
    (source) => {
      const imported = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(source),
      );
      expect(() => imported.check()).not.toThrow();
      expect(imported.firstChild?.type.name).toBe("unsupportedMarkdown");
      const serialized = documentToMarkdown(imported.toJSON());
      const reopened = ProseMirrorNode.fromJSON(
        schema,
        markdownToDocument(serialized),
      );
      expect(() => reopened.check()).not.toThrow();
      expect(reopened.toJSON()).toEqual(imported.toJSON());
      for (const value of [
        "logo.svg",
        "badge.svg",
        "diagram.png",
        "https://example.com/guide",
        "Logo title",
        "Figure title",
        "Badge title",
      ]) {
        if (source.includes(value)) expect(serialized).toContain(value);
      }
      if (source.includes(":---:")) expect(serialized).toMatch(/:-+:|:-+\s*:/);
    },
  );

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
