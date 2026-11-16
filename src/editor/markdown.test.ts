import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import type { JSONContent } from "@tiptap/core";
import {
  documentToMarkdown,
  markdownToDocument,
  normalizeLatexDelimiters,
} from "./markdown";

function nodesOfType(document: JSONContent, type: string): JSONContent[] {
  const matches: JSONContent[] = [];
  const visit = (node: JSONContent) => {
    if (node.type === type) matches.push(node);
    node.content?.forEach(visit);
  };
  visit(document);
  return matches;
}

describe("PaperCanvas Markdown subset", () => {
  it.each([
    "Paragraph.",
    "# Heading",
    "![Diagram](notes.assets/a.png)",
    "- First\n- Second",
    "| Header |\n| --- |\n| Cell |",
    "> Quoted writing",
  ])("preserves interior empty paragraphs around %s", (source) => {
    const blocks = markdownToDocument(source).content!;
    const document: JSONContent = { type: "doc", content: [...blocks, { type: "paragraph" }, { type: "paragraph" }, ...blocks] };
    const saved = documentToMarkdown(document);
    expect(saved.match(/<p><\/p>/g)).toHaveLength(2);
    expect(markdownToDocument(saved)).toEqual(document);
  });

  it.each(["blockquote", "listItem", "taskItem", "footnoteDefinition"])(
    "preserves authored empty paragraphs inside %s writing",
    (type) => {
      const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
      const block: JSONContent = { type, content: [paragraph("First."), { type: "paragraph" }, paragraph("Second.")] };
      if (type === "taskItem") block.attrs = { checked: false };
      if (type === "footnoteDefinition") block.attrs = { identifier: "note", label: "note" };
      const container: JSONContent = type === "listItem"
        ? { type: "bulletList", content: [block] }
        : type === "taskItem" ? { type: "taskList", content: [block] } : block;
      const document: JSONContent = { type: "doc", content: [container] };
      const saved = documentToMarkdown(document);
      expect(saved).toContain("<p></p>");
      expect(markdownToDocument(saved)).toEqual(document);
    },
  );

  it("keeps ordinary Markdown blank lines, empty notes and automatic trailing placeholders unchanged", () => {
    const source = "First.\n\n\n\nSecond.\n";
    expect(markdownToDocument(source).content).toHaveLength(2);
    expect(documentToMarkdown({ type: "doc", content: [{ type: "paragraph" }] })).toBe("");
    const heading = markdownToDocument("# Heading").content![0];
    expect(documentToMarkdown({ type: "doc", content: [heading, { type: "paragraph" }] })).toBe("# Heading\n\n");
  });

  it.each(["\\(", "`x", "# Heading\r\n\r\nParagraph.\r\n\r\n"])(
    "preserves oversized %j source before unbounded Markdown parsing can stall",
    (chunk) => {
      const source = "\uFEFF" + chunk.repeat(Math.ceil(5 * 1024 * 1024 / chunk.length));
      const started = performance.now();
      const document = markdownToDocument(source);
      expect(document.content).toHaveLength(1);
      expect(document.content?.[0].type).toBe("unsupportedMarkdown");
      expect(documentToMarkdown(document)).toBe(source);
      expect(performance.now() - started).toBeLessThan(1000);
    },
  );

  it.each(["", "$", "x$y", "\\$", "$$", "a$$b", "a$$$b", "$$ + $x", "a $ b $ c"])(
    "preserves inline formula kind and source when dollar fencing would look like display math: %j",
    (latex) => {
      for (const marks of [undefined, [{ type: "bold" }], [{ type: "underline" }]]) {
        const document: JSONContent = {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "inlineFormula", attrs: { latex }, ...(marks ? { marks } : {}) }] }],
        };
        expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
      }
    },
  );

  it.each(["", "\\text{\\$5}", "a \\$ b", "$", "$$", "a$$b", "a$$$b"])(
    "imports Typora inline formula content without dollar delimiters splitting it: %j",
    (latex) => {
      const source = `\\(${latex}\\)`;
      const document = markdownToDocument(source);
      expect(document.content?.[0].type).toBe("paragraph");
      expect(document.content?.[0].content).toEqual([{ type: "inlineFormula", attrs: { latex } }]);
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
      const code = markdownToDocument("`" + source + "`");
      expect(nodesOfType(code, "inlineFormula")).toHaveLength(0);
      expect(code.content?.[0].content?.[0].text).toBe(source);
    },
  );

  it("keeps adjacent dollar-containing Typora formulas separate without cross-tag math parsing", () => {
    const source = "\\(\\$\\) \\(\\text{\\$5}\\)";
    const document = markdownToDocument(source);
    expect(document.content?.[0].content).toEqual([
      { type: "inlineFormula", attrs: { latex: "\\$" } },
      { type: "text", text: " " },
      { type: "inlineFormula", attrs: { latex: "\\text{\\$5}" } },
    ]);
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it.each(["\\(x\\)\\(y\\)", "$x$\\(y\\)", "\\(x\\)$y$"])(
    "imports adjacent formula boundaries without merging %s",
    (source) => {
      const document = markdownToDocument(source);
      expect(nodesOfType(document, "inlineFormula").map((node) => node.attrs?.latex)).toEqual(["x", "y"]);
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
    },
  );

  it.each(["Paragraph", "# Heading", "| Header |\n| --- |\n| Cell |"])(
    "keeps adjacent marked formula nodes separate inside %s",
    (source) => {
      for (const marks of [undefined, [{ type: "bold" }], [{ type: "italic" }], [{ type: "strike" }], [{ type: "underline" }], [{ type: "link", attrs: { href: "https://example.com", title: "Title" } }]]) {
        const document = markdownToDocument(source);
        const block = document.content![0];
        const paragraph = block.type === "table" ? block.content![0].content![0].content![0] : block;
        paragraph.content = ["x", "y", "z"].map((latex) => ({ type: "inlineFormula", attrs: { latex }, ...(marks ? { marks } : {}) }));
        const saved = documentToMarkdown(document);
        expect(markdownToDocument(saved)).toEqual(document);
        expect(nodesOfType(markdownToDocument(saved), "inlineFormula").map((node) => node.attrs?.latex)).toEqual(["x", "y", "z"]);
      }
    },
  );

  it("keeps ordinary separated formulas in readable Markdown math syntax", () => {
    const source = "$x$ $y$";
    expect(documentToMarkdown(markdownToDocument(source))).toBe(source + "\n");
    expect(normalizeLatexDelimiters("\\(x\\) \\(y\\)")).toBe(source);
  });

  it.each([
    '<code><span data-formula-kind="inline" latex="x" data-latex="y">&#36;x&#36;</span></code>',
    '<code><sup data-footnote-reference="" data-footnote-identifier="note" data-footnote-label="note">different</sup></code>',
    '<code class="custom"><span data-formula-kind="inline" latex="x" data-latex="x">&#36;x&#36;</span></code>',
    '<code>literal $x$</code>',
  ])("preserves ordinary or mismatched code HTML as its exact source: %s", (source) => {
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "inlineFormula")).toHaveLength(0);
    expect(nodesOfType(document, "footnoteReference")).toHaveLength(0);
    expect(documentToMarkdown(document)).toContain(source);
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it("imports dense escaped-dollar Typora formulas without quadratic HTML/math parsing", () => {
    const source = "\\(\\$\\) ".repeat(1000);
    const started = performance.now();
    expect(nodesOfType(markdownToDocument(source), "inlineFormula")).toHaveLength(1000);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it.each(["`\\)`", "<kbd>\\)</kbd>", "<!-- \\) -->"])(
    "ignores a Typora closing delimiter inside a literal %s",
    (literal) => {
      const unmatched = "Before \\( x " + literal + " after";
      expect(normalizeLatexDelimiters(unmatched)).toBe(unmatched);
      expect(nodesOfType(markdownToDocument(unmatched), "inlineFormula")).toHaveLength(0);
      const matched = "Before \\( x " + literal + " y \\) after";
      expect(normalizeLatexDelimiters(matched)).toBe("Before $ x " + literal + " y $ after");
      expect(nodesOfType(markdownToDocument(matched), "inlineFormula")[0].attrs?.latex).toBe("x " + literal + " y");
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "preserves unterminated container HTML without growing blank %j separators on each save",
    (ending) => {
      for (const opening of ["<pre>literal", "<!--x--!>literal</span>", "<![CDATA[<div>x</div>", "<?pi <div>x</div>"]) {
        for (const marker of ["1. ", "- "]) {
          const source = marker + opening + ending + ending + "next";
          const document = markdownToDocument(source);
          expect(nodesOfType(document, "unsupportedMarkdown")[0].attrs?.source).toBe(source);
          expect(documentToMarkdown(document)).toBe(source);
          expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
        }
      }
      for (const source of ["<pre>literal</pre>", "<!--x--><span>literal</span>", "<![CDATA[<div>x</div>]]>", "<?pi <div>x</div>?>"]) {
        const closed = markdownToDocument("1. " + source + ending + ending + "next");
        expect(nodesOfType(closed, "htmlPreview")).toHaveLength(1);
        expect(nodesOfType(closed, "unsupportedMarkdown")).toHaveLength(0);
      }
    },
  );

  it.each(["\uFEFF", "\u00a0", "\u2003"])(
    "retains authored nonbreaking whitespace at the end of a preserved heading: %j",
    (trailing) => {
      const source = "# ![Diagram](image.png) content" + trailing;
      const document = markdownToDocument(source);
      expect(nodesOfType(document, "unsupportedMarkdown")[0].attrs?.source).toBe(source);
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
    },
  );

  it.each(["https://example.com/🧪", "https://example.com/\\", "https://example.com/👨‍👩‍👧‍👦", "mailto:person🧪@example.com"])(
    "preserves autolink text and destinations where phrasing escapes are literal: %s",
    (source) => {
      const document = markdownToDocument(source);
      const saved = documentToMarkdown(document);
      expect(markdownToDocument(saved)).toEqual(document);
      expect(documentToMarkdown(markdownToDocument(saved))).toBe(saved);
    },
  );

  it("keeps serializer-escaped literal link punctuation from opening a Typora formula beside code", () => {
    const document: JSONContent = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "[a](x)" },
          { type: "text", text: "\\)", marks: [{ type: "code" }] },
        ],
      }],
    };
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
    const source = "\\[<u>a</u>](x)`\\)`";
    const parsed = markdownToDocument(source);
    expect(markdownToDocument(documentToMarkdown(parsed))).toEqual(parsed);
  });

  it.each(["Project%20(100%25).assets/a.svg", "notes[archive].md"])(
    "preserves escaped image and link destinations after an ordinary edit: %s",
    (destination) => {
      const source = `![Diagram](${destination})\n\n[Writing](${destination})\n\nBefore.`;
      const document = markdownToDocument(source);
      document.content!.at(-1)!.content = [{ type: "text", text: "After." }];
      const saved = documentToMarkdown(document);
      const reopened = markdownToDocument(saved);
      expect(nodesOfType(reopened, "image")[0].attrs?.src).toBe(destination);
      expect(nodesOfType(reopened, "text").find((node) => node.text === "Writing")?.marks?.[0].attrs?.href).toBe(destination);
      expect(reopened).toEqual(document);
      expect(documentToMarkdown(reopened)).toBe(saved);
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "normalizes Typora prose while preserving literal link destinations, titles and image captions with %j endings",
    (ending) => {
      const source = `[Math \\(x\\)](notes\\(draft\\).md "\\(caption\\)")${ending}${ending}[Reference \\(y\\)][draft]${ending}${ending}[draft]: notes\\(draft\\).md "\\(title\\)"${ending}${ending}![\\(literal\\)](notes\\(draft\\).png "\\(caption\\)")`;
      expect(normalizeLatexDelimiters(source)).toBe(source.replace("Math \\(x\\)", "Math $x$").replace("Reference \\(y\\)", "Reference $y$"));
      const document = markdownToDocument(source);
      expect(nodesOfType(document, "inlineFormula").map((node) => node.attrs?.latex)).toEqual(["x", "y"]);
      expect(nodesOfType(document, "inlineFormula").map((node) => node.marks?.[0].attrs)).toEqual([
        { href: "notes(draft).md", title: "(caption)" },
        { href: "notes(draft).md", title: "(title)" },
      ]);
      expect(nodesOfType(document, "image")[0].attrs).toEqual({ src: "notes(draft).png", alt: "(literal)", title: "(caption)" });
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
    },
  );

  it.each(["<https://example.com/\\(draft\\)>", "https://example.com/\\(draft\\)"])(
    "keeps Typora-looking URL text literal in autolinks: %s",
    (source) => {
      expect(normalizeLatexDelimiters(source + " and \\(x\\)")).toBe(source + " and $x$");
      const document = markdownToDocument(source);
      expect(nodesOfType(document, "inlineFormula")).toHaveLength(0);
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
    },
  );

  it("does not close unmatched prose math using an escaped URL parenthesis", () => {
    const source = "Before \\(missing [Writing](notes\\(draft\\).md) after";
    expect(normalizeLatexDelimiters(source)).toBe(source);
    expect(nodesOfType(markdownToDocument(source), "inlineFormula")).toHaveLength(0);
  });

  it("keeps math in a marked link label editable beside literal bracket code and an escaped destination", () => {
    const source = "[**Math \\(x\\)** and `]`](notes\\(draft\\).md)";
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "inlineFormula")).toEqual([{
      type: "inlineFormula",
      attrs: { latex: "x" },
      marks: [{ type: "bold" }, { type: "link", attrs: { href: "notes(draft).md" } }],
    }]);
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it.each([
    "[Math \\(x\\)]\n\n[Math \\(x\\)]: notes\\(draft\\).md",
    "[Math \\(x\\)][]\n\n[Math \\(x\\)]: notes\\(draft\\).md",
    "[Math \\(x\\)][\\(ref\\)]\n\n[\\(ref\\)]: notes\\(draft\\).md",
    "[Math \\(x\\)][ref\\]\\(key\\)]\n\n[ref\\]\\(key\\)]: notes\\(draft\\).md",
  ])("keeps math-looking reference labels matched while preserving their literal destination: %s", (source) => {
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "inlineFormula")).toEqual([{
      type: "inlineFormula",
      attrs: { latex: "x" },
      marks: [{ type: "link", attrs: { href: "notes(draft).md" } }],
    }]);
    expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it.each([
    "\\[\\text{![literal](notes\\(draft\\).png)}\\]",
    "\\begin{align}\\text{[literal](notes\\(draft\\).md)}\\end{align}",
  ])("keeps link-looking source literal inside a complete Typora display formula: %s", (source) => {
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "blockFormula")).toEqual([{
      type: "blockFormula",
      attrs: { latex: source.startsWith("\\[") ? source.slice(2, -2) : source },
    }]);
    expect(nodesOfType(document, "image")).toHaveLength(0);
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it("normalizes a long line of unfinished TeX openings without repeatedly searching its remaining suffix", () => {
    const source = "\\(".repeat(80_000);
    const started = performance.now();
    expect(normalizeLatexDelimiters(source)).toBe(source);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("pairs a long run of unfinished inline HTML tags without rescanning every following tag", () => {
    const source = "Before " + "<kbd>".repeat(10_000);
    const started = performance.now();
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "inlineHtmlPreview")).toHaveLength(10_000);
    expect(documentToMarkdown(document)).toContain(source);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it.each([0, 240])("preserves source when semantic underline grouping creates extreme nesting inside %i quote levels", (quotes) => {
    const levels = quotes ? 30 : 2000;
    const source = "> ".repeat(quotes) + "Before " + "<u>".repeat(levels) + "x 🧪" + "</u>".repeat(levels);
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "unsupportedMarkdown")[0].attrs?.source).toBe(source);
    expect(documentToMarkdown(document)).toBe(source);
  });

  it.each(["\n", "\r\n", "\r"])(
    "imports Typora display formulas consistently with %j line endings",
    (ending) => {
      for (const formula of [
        `\\[${ending}x+y${ending}\\]`,
        `\\begin{align}${ending}x+y${ending}\\end{align}`,
        "\\[x+y\\]",
        "$$x+y$$",
      ]) {
        const source = `Before${ending}${ending}${formula}${ending}${ending}After${ending}`;
        const document = markdownToDocument(source);
        expect(nodesOfType(document, "blockFormula")).toEqual([
          { type: "blockFormula", attrs: { latex: formula.startsWith("\\begin") ? formula : "x+y" } },
        ]);
        expect(nodesOfType(document, "text").map((node) => node.text)).toEqual(["Before", "After"]);
      }
    },
  );

  it.each(["\n", "\r\n", "\r"])(
    "preserves code, raw HTML, unmatched delimiters and original %j separators during formula normalization",
    (ending) => {
      const literal = `\`\`\`latex${ending}\\[${ending}literal${ending}\\]${ending}\`\`\`${ending}${ending}<div>${ending}\\begin{align}${ending}HTML${ending}\\end{align}${ending}</div>${ending}${ending}`;
      const formula = `\\[${ending}x+y${ending}\\]${ending}`;
      expect(normalizeLatexDelimiters(literal + formula)).toBe(literal + `$$${ending}x+y${ending}$$${ending}`);
      for (const unmatched of [
        `Before${ending}${ending}\\[${ending}unclosed`,
        `Before${ending}${ending}\\begin{align}${ending}unclosed`,
      ]) expect(normalizeLatexDelimiters(unmatched)).toBe(unmatched);
    },
  );

  it.each(["\uFEFF", "\uFEFF\uFEFFhello", "\uFEFF  > literal", "\uFEFF🧪"])(
    "preserves an editable leading zero-width no-break space: %j",
    (text) => {
      const document: JSONContent = {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      };
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
    },
  );

  it.each(["bold", "italic", "strike"])(
    "keeps complete astral characters at %s mark boundaries",
    (type) => {
      for (const character of ["🧪", "𐐀", "𝄞", "👨‍👩‍👧‍👦"]) {
        for (const content of [
          [
            { type: "text", text: character },
            { type: "text", text: "(", marks: [{ type }] },
          ],
          [
            { type: "text", text: "(", marks: [{ type }] },
            { type: "text", text: character },
          ],
          [
            { type: "text", text: "before" },
            { type: "text", text: character, marks: [{ type }] },
            { type: "text", text: "after" },
          ],
        ]) {
          const document: JSONContent = {
            type: "doc",
            content: [{ type: "paragraph", content }],
          };
          const saved = documentToMarkdown(document);
          expect(markdownToDocument(saved)).toEqual(document);
          expect(markdownToDocument(documentToMarkdown(markdownToDocument(saved)))).toEqual(document);
        }
      }
    },
  );

  it("keeps nested marks around emoji without emitting lone-surrogate references", () => {
    const document: JSONContent = {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [
          { type: "text", text: "🧪", marks: [{ type: "bold" }, { type: "underline" }] },
          { type: "text", text: "( 🧪", marks: [{ type: "bold" }, { type: "italic" }, { type: "strike" }, { type: "underline" }] },
        ],
      }],
    };
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it.each(["$`b", "$`&中文", "*$`", "\\$`b"])(
    "retains literal dollar and backtick text across marked runs: %s",
    (text) => {
      const document: JSONContent = {
        type: "doc",
        content: [{
          type: "paragraph",
          content: [
            { type: "text", text, marks: [{ type: "italic" }] },
            { type: "text", text: "following $", marks: [{ type: "bold" }] },
          ],
        }],
      };
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
    },
  );

  it.each([
    '<kbd title="x > y">Press \\(x\\)</kbd>',
    "<span title='x > <script> y'>Press \\(x\\)</span>",
  ])(
    "groups HTML with quoted angle brackets without converting its literal TeX: %s",
    (html) => {
      const document = markdownToDocument(`Before ${html} after.`);
      expect(nodesOfType(document, "inlineHtmlPreview")).toEqual([
        { type: "inlineHtmlPreview", attrs: { source: html } },
      ]);
      expect(nodesOfType(document, "inlineFormula")).toHaveLength(0);
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(
        document,
      );
    },
  );

  it.each([
    "[]( <https://example.com/a> 'Keep title')",
    '[<br>](https://example.com/a "Keep title")',
    '[<u></u>](https://example.com/a "Keep title")',
    '[\\\n](https://example.com/a "Keep title")',
  ])(
    "preserves the exact source of a link with no representable linked content: %s",
    (link) => {
      const document = markdownToDocument(`Before ${link} after.`);
      expect(nodesOfType(document, "inlineHtmlPreview")).toContainEqual({
        type: "inlineHtmlPreview",
        attrs: { source: link },
      });
      const saved = documentToMarkdown(document);
      expect(saved).toContain(link);
      expect(markdownToDocument(saved)).toEqual(document);
    },
  );

  it("keeps empty links recoverable inside underline, headings and ordinary table cells", () => {
    const link = '[](https://example.com/a "Keep title")';
    const source = `# Heading ${link}\n\nBefore <u>${link}</u> after.\n\n| Value |\n| --- |\n| ${link} |`;
    const document = markdownToDocument(source);
    const atoms = nodesOfType(document, "inlineHtmlPreview");
    expect(atoms).toHaveLength(3);
    expect(atoms.every((node) => node.attrs?.source === link)).toBe(true);
    expect(atoms[1].marks).toEqual([{ type: "underline" }]);
    const saved = documentToMarkdown(document);
    expect(saved.match(/Keep title/g)).toHaveLength(3);
    expect(markdownToDocument(saved)).toEqual(document);
  });

  it("retains a definition needed by an unrepresentable reference even when a normal link uses it", () => {
    const definition = "[TARGET]: <https://example.com/a> 'Keep title'";
    const source = `Empty [][target] and [<u></u>][TARGET], plus [visible][target].\n\n${definition}`;
    const document = markdownToDocument(source);
    expect(
      nodesOfType(document, "inlineHtmlPreview").map(
        (node) => node.attrs?.source,
      ),
    ).toEqual(["[][target]", "[<u></u>][TARGET]"]);
    expect(nodesOfType(document, "unsupportedMarkdown")[0].attrs?.source).toBe(
      definition,
    );
    expect(
      nodesOfType(document, "text").find((node) => node.text === "visible")
        ?.marks,
    ).toEqual([
      {
        type: "link",
        attrs: { href: "https://example.com/a", title: "Keep title" },
      },
    ]);
    const saved = documentToMarkdown(document);
    expect(saved).toContain(definition);
    expect(saved).toContain("[][target]");
    expect(saved).toContain("[<u></u>][TARGET]");
    expect(markdownToDocument(saved)).toEqual(document);
  });

  it.each(["[Reference][ref]", "![Diagram][ref]", "Empty [][ref] and [Reference][ref]"])(
    "keeps inactive duplicate definitions when resolving %s",
    (reference) => {
      const first = '[ref]: <https://first.example/diagram.png> "First"';
      const second = '[REF]: <https://second.example/diagram.png> "Second 中文 🧪"';
      const source = `${reference}\n\n${first}\n\n${second}\n\nAfter.\n`;
      const document = markdownToDocument(source);
      expect(nodesOfType(document, "unsupportedMarkdown").map((node) => node.attrs?.source)).toContain(second);
      document.content!.at(-1)!.content![0].text = "After edited.";
      const saved = documentToMarkdown(document);
      expect(saved).toContain(second);
      expect(saved).toContain("https://first.example/diagram.png");
      expect(markdownToDocument(saved)).toEqual(document);
    },
  );

  it("imports semantic underline as editable marks around formatted text and inline formulas", () => {
    const source =
      "Before <u>**bold** and $x$ and [a link](https://example.com)</u> after.";
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "inlineHtmlPreview")).toHaveLength(0);
    expect(nodesOfType(document, "inlineFormula")[0]).toMatchObject({
      attrs: { latex: "x" },
      marks: [{ type: "underline" }],
    });
    expect(
      nodesOfType(document, "text").find((node) => node.text === "bold")?.marks,
    ).toEqual([{ type: "bold" }, { type: "underline" }]);
    expect(
      nodesOfType(document, "text").find((node) => node.text === "a link")
        ?.marks,
    ).toEqual([
      { type: "link", attrs: { href: "https://example.com" } },
      { type: "underline" },
    ]);
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it("keeps underline editable in headings, nested underline and simple table cells", () => {
    const source =
      "# <U>Underlined heading</U>\n\nA <u>nested <u>underline</u> end</u>.\n\n| Value |\n| --- |\n| <u>cell</u> |";
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "inlineHtmlPreview")).toHaveLength(0);
    expect(
      nodesOfType(document, "text")
        .filter((node) => node.marks?.some((mark) => mark.type === "underline"))
        .map((node) => node.text),
    ).toEqual(["Underlined heading", "nested ", "underline", " end", "cell"]);
    expect(documentToMarkdown(document)).toContain(
      "<u>nested underline end</u>",
    );
  });

  it("retains attributed underline HTML as source rather than discarding its metadata", () => {
    const source = 'A <u title="Note">word</u>.';
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "inlineHtmlPreview")[0]).toMatchObject({
      attrs: { source: '<u title="Note">word</u>' },
    });
    expect(documentToMarkdown(document)).toContain('<u title="Note">word</u>');
  });

  it.each([
    "**bold <u>underlined</u>**",
    "*italic <u>underlined</u>*",
    "~~deleted <u>underlined</u>~~",
    "[linked <u>underlined</u>](https://example.com)",
  ])(
    "imports underline nested inside other inline formatting: %s",
    (source) => {
      const document = markdownToDocument(source);
      expect(nodesOfType(document, "inlineHtmlPreview")).toHaveLength(0);
      expect(
        nodesOfType(document, "text").find((node) => node.text === "underlined")
          ?.marks,
      ).toContainEqual({ type: "underline" });
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(
        document,
      );
    },
  );

  it("round-trips supported research-note constructs without exposing formula syntax in the document model", () => {
    const source = `# 研究筆記

中文與 English **bold**、*italic*、~~old~~、\`inline\`、[link](https://example.com)。

The loss is $\\mathcal{L}(\\theta)=\\mathbb{E}_{x\\sim p}[f_\\theta(x)]$.

$$
\\begin{aligned}
x_{t-1} &= \\mu_\\theta(x_t,t)+\\sigma_t\\epsilon, \\\\
\\epsilon &\\sim \\mathcal{N}(0,I).
\\end{aligned}
$$

- [x] 完成公式
- [ ] Review

| Name | Value |
| --- | ---: |
| $x$ | 1 |

> 一段引用

\`\`\`ts
const answer = 42;
\`\`\`
`;
    const document = markdownToDocument(source);
    const serialized = documentToMarkdown(document);

    expect(JSON.stringify(document)).toContain("inlineFormula");
    expect(JSON.stringify(document)).toContain("blockFormula");
    expect(serialized).toContain("$\\mathcal{L}");
    expect(serialized).toContain("$$");
    expect(serialized).toContain("[x] 完成公式");
    expect(serialized).toContain("| Name | Value |");
    expect(serialized).toContain("```ts");
  });

  it("imports Typora-style parenthesis and bracket math from a research document", () => {
    const source = `# 漸進式 Taylor 量化

不直接從大小為 \\(N\\) MB 的模型跳到 \\(n\\) MB。

\\[
S(\\theta')\\le n\\ \\text{MB},
\\qquad n<N,
\\]

若 \\(\\mathcal L(\\theta)\\) 是量化誤差目標，則

\\[
\\mathcal L(\\bar\\theta+\\Delta)
\\approx
\\mathcal L(\\bar\\theta)
+\\frac{1}{2}\\Delta^{\\mathsf T}H(\\bar\\theta)\\Delta.
\\]
`;

    const document = markdownToDocument(source);
    const inline = nodesOfType(document, "inlineFormula");
    const blocks = nodesOfType(document, "blockFormula");

    expect(inline.map((node) => node.attrs?.latex)).toEqual([
      "N",
      "n",
      "\\mathcal L(\\theta)",
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].attrs?.latex).toContain("S(\\theta')\\le n");
    expect(blocks[1].attrs?.latex).toContain("\\Delta^{\\mathsf T}");
    expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);

    const reopened = markdownToDocument(documentToMarkdown(document));
    expect(nodesOfType(reopened, "inlineFormula")).toHaveLength(3);
    expect(nodesOfType(reopened, "blockFormula")).toHaveLength(2);
  });

  it("imports a same-line Typora display formula without leaving literal brackets", () => {
    const document = markdownToDocument("Before\n\n\\[x^2+y^2\\]\n\nAfter");
    const blocks = nodesOfType(document, "blockFormula");

    expect(blocks).toHaveLength(1);
    expect(blocks[0].attrs?.latex).toBe("x^2+y^2");
    expect(JSON.stringify(document)).not.toContain("\\\\[");
  });

  it.each([
    "    \\[x^2+y^2\\]",
    "    \\[\n    x^2+y^2\n    \\]",
    "    \\begin{equation}\n    x^2+y^2\n    \\end{equation}",
    "    $$x^2+y^2$$",
  ])(
    "keeps nested display math inside a footnote continuation: %s",
    (formula) => {
      const source = `Reference[^note].\n\n[^note]: Explanation.\n\n${formula}\n\n    Following text.`;
      const document = markdownToDocument(source);
      const note = nodesOfType(document, "footnoteDefinition")[0];
      expect(nodesOfType(note, "blockFormula")).toHaveLength(1);
      expect(document.content?.map((node) => node.type)).toEqual([
        "paragraph",
        "footnoteDefinition",
      ]);
      expect(JSON.stringify(note)).toContain("Following text.");
      expect(markdownToDocument(documentToMarkdown(document))).toEqual(
        document,
      );
    },
  );

  it("keeps display TeX and following prose inside a numbered list item", () => {
    const source =
      "3. Explanation.\n\n   \\[\n   x^2+y^2\n   \\]\n\n   Following text.\n\n4. Next item.";
    const document = markdownToDocument(source);
    const list = document.content?.[0];
    expect(list?.type).toBe("orderedList");
    expect(list?.attrs?.start).toBe(3);
    expect(list?.content).toHaveLength(2);
    expect(nodesOfType(list!.content![0], "blockFormula")).toHaveLength(1);
    expect(JSON.stringify(list?.content?.[0])).toContain("Following text.");
    expect(document.content).toHaveLength(1);
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it("keeps indented display TeX literal when the parser identifies it as code", () => {
    const source =
      "Example:\n\n    \\[x^2\\]\n    \\begin{equation}\n    y^2\n    \\end{equation}";
    expect(normalizeLatexDelimiters(source)).toBe(source);
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "blockFormula")).toHaveLength(0);
    expect(nodesOfType(document, "codeBlock")[0].content?.[0].text).toContain(
      "\\[x^2\\]",
    );
  });

  it("imports standalone LaTeX display environments and keeps their wrappers", () => {
    const source = `Before

\\begin{equation}
f(x)=x^2
\\end{equation}

\\begin{align}a&=b\\\\c&=d\\end{align}

After`;

    const document = markdownToDocument(source);
    const blocks = nodesOfType(document, "blockFormula");
    expect(blocks.map((node) => node.attrs?.latex)).toEqual([
      "\\begin{equation}\nf(x)=x^2\n\\end{equation}",
      "\\begin{align}a&=b\\\\c&=d\\end{align}",
    ]);
    expect(documentToMarkdown(document)).toContain("\\begin{equation}");
    expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);
  });

  it("does not reinterpret Typora delimiters inside code or an unmatched display block", () => {
    const source = `Inline code: \`\\(notMath\\)\`

    \\[indentedCode\\]

\`\`\`tex
\\[
x
\\]
\`\`\`

\`\`\`tex
\\begin{equation}
x
\\end{equation}
\`\`\`

$$
\\text{literal delimiters } \\(x\\)
$$

\\[
unclosed

\\begin{equation}
unclosed`;

    expect(normalizeLatexDelimiters(source)).toBe(source);
  });

  it("preserves unsupported HTML as a visible warning node and emits the original source", () => {
    const source = '<script>alert("no")</script>\n\nRegular text';
    const document = markdownToDocument(source);
    const serialized = documentToMarkdown(document);

    expect(JSON.stringify(document)).toContain("unsupportedMarkdown");
    expect(serialized).toContain('<script>alert("no")</script>');
    expect(serialized).toContain("Regular text");
  });

  it("renders safe document HTML as lossless preview nodes", () => {
    const source = `<p align="center"><strong>PaperCanvas</strong></p>

<table><tr><td width="50%"><img src="docs/preview.png" alt="Preview"></td></tr></table>`;
    const document = markdownToDocument(source);
    const previews = nodesOfType(document, "htmlPreview");

    expect(previews).toHaveLength(2);
    expect(previews.map((node) => node.attrs?.source)).toEqual([
      '<p align="center"><strong>PaperCanvas</strong></p>',
      '<table><tr><td width="50%"><img src="docs/preview.png" alt="Preview"></td></tr></table>',
    ]);
    expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);
    expect(documentToMarkdown(document)).toContain(source);
  });

  it("keeps inline HTML in an inline preview node instead of creating an invalid paragraph child", () => {
    const source = "Press <kbd>Command</kbd> while saving.";
    const document = markdownToDocument(source);

    expect(nodesOfType(document, "inlineHtmlPreview")).toHaveLength(1);
    expect(nodesOfType(document, "inlineHtmlPreview")[0].attrs?.source).toBe(
      "<kbd>Command</kbd>",
    );
    expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);
    expect(documentToMarkdown(document)).toContain(source);
  });

  it.each(["README.md", "README.en.md", "README.zh-CN.md"])(
    "imports every top-level HTML layout block in %s as a lossless preview",
    (file) => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const sourceTree = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkMath)
        .parse(source);
      const htmlBlocks = sourceTree.children
        .filter((node) => node.type === "html")
        .map((node) => node.value);
      const document = markdownToDocument(source);
      const previews = document.content?.filter(
        (node) => node.type === "htmlPreview",
      );
      const serialized = documentToMarkdown(document);

      expect(previews?.map((node) => node.attrs?.source)).toEqual(htmlBlocks);
      expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);
      htmlBlocks.forEach((block) => expect(serialized).toContain(block));
      expect(documentToMarkdown(markdownToDocument(serialized))).toBe(serialized);
    },
  );

  it("preserves image alt text, title, and PaperCanvas resize dimensions", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "figures/model.png",
            alt: "模型示意圖",
            title: "Figure 1",
            width: 360,
            height: 240,
          },
        },
      ],
    };

    const serialized = documentToMarkdown(document);
    const reopened = markdownToDocument(serialized);
    const image = reopened.content?.[0];

    expect(serialized).toContain("![模型示意圖](figures/model.png");
    expect(serialized).toContain("papercanvas-size:360x240 | Figure 1");
    expect(image?.attrs).toMatchObject({
      src: "figures/model.png",
      alt: "模型示意圖",
      title: "Figure 1",
      width: 360,
      height: 240,
    });
  });

  it.each([{ width: 300 }, { height: 150 }])(
    "preserves an independently specified image dimension: %j",
    (dimensions) => {
      const document: JSONContent = { type: "doc", content: [{ type: "image", attrs: { src: "diagram.png", alt: "Diagram", title: "Caption", ...dimensions } }] };
      const source = documentToMarkdown(document);
      expect(source).toContain(`papercanvas-size:${"width" in dimensions ? dimensions.width : 0}x${"height" in dimensions ? dimensions.height : 0} | Caption`);
      expect(markdownToDocument(source)).toEqual(document);
    },
  );

  it("uses a hydrated image's original path when entering Markdown source mode", () => {
    const serialized = documentToMarkdown({
      type: "doc",
      content: [
        {
          type: "image",
          attrs: {
            src: "http://asset.localhost/docs/editor.png",
            originalSrc: "docs/editor.png",
            alt: "Editor",
          },
        },
      ],
    });

    expect(serialized).toContain("docs/editor.png");
    expect(serialized).not.toContain("asset.localhost");
  });

  it("resolves reference links and images, including titles, without warning nodes", () => {
    const source =
      '# Guide\n\n[Read **the guide**][manual] and ![Logo][logo].\n\n[manual]: https://example.com/guide "Documentation"\n[logo]: https://example.com/logo.png "The logo"\n';
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);
    expect(nodesOfType(document, "inlineHtmlPreview")).toHaveLength(0);
    expect(nodesOfType(document, "image")[0].attrs).toMatchObject({
      src: "https://example.com/logo.png",
      title: "The logo",
    });
    const serialized = documentToMarkdown(document);
    expect(serialized).toContain('https://example.com/guide "Documentation"');
    expect(serialized).toContain('https://example.com/logo.png "The logo"');
    const reopened = markdownToDocument(serialized);
    expect(nodesOfType(reopened, "heading")[0].content?.[0]?.text).toBe(
      "Guide",
    );
    expect(nodesOfType(reopened, "image")[0].attrs).toEqual(
      nodesOfType(document, "image")[0].attrs,
    );
  });

  it("retains unreferenced definitions instead of dropping their URLs", () => {
    const source = "Visible text.\n\n[unused]: https://example.com/retained";
    expect(documentToMarkdown(markdownToDocument(source))).toContain(
      "[unused]: https://example.com/retained",
    );
  });

  it("imports table headers and preserves GFM column alignment on repeated round trips", () => {
    const source =
      "| Name | Value | Note |\n| :--- | ---: | :---: |\n| x | 42 | center |";
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "tableHeader")).toHaveLength(3);
    expect(nodesOfType(document, "tableCell")).toHaveLength(3);
    expect(
      nodesOfType(document, "tableHeader").map((cell) => cell.attrs?.textAlign),
    ).toEqual(["left", "right", "center"]);
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it("preserves links wrapped around inline code in a table of contents", () => {
    const source = "[`Options`](#options) and [**bold**](https://example.com).";
    const document = markdownToDocument(source);
    const serialized = documentToMarkdown(document);
    expect(serialized).toContain("[`Options`](#options)");
    expect(markdownToDocument(serialized)).toEqual(document);
  });

  it("keeps fenced formula examples and significant blank lines inside code unchanged", () => {
    const source = "```tex\n$$x^2$$\n\n\n\\(example\\)\n```\n";
    const document = markdownToDocument(source);
    expect(nodesOfType(document, "blockFormula")).toHaveLength(0);
    expect(nodesOfType(document, "codeBlock")[0].content?.[0]?.text).toBe(
      "$$x^2$$\n\n\n\\(example\\)",
    );
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it.each(['title="example.js" {1,3-5}', 'caption="中文 🧪 & <example>"', 'javascript:literal metadata']) (
    "retains fenced-code metadata when surrounding writing is edited: %s",
    (meta) => {
      const source = `Before.\n\n\`\`\`javascript ${meta}\nconsole.log("hello");\n\`\`\`\n\nAfter.\n`;
      const document = markdownToDocument(source);
      expect(nodesOfType(document, "codeBlock")[0].attrs).toEqual({ language: "javascript", meta });
      document.content!.at(-1)!.content![0].text = "After edited.";
      const saved = documentToMarkdown(document);
      expect(saved).toContain(`\`\`\`javascript ${meta}\n`);
      expect(markdownToDocument(saved)).toEqual(document);
    },
  );

  it.each([
    "> ```tex\n> \\(literal\\)\n> \\[also literal\\]\n> ```",
    "- ```tex\n  \\(literal\\)\n  \\[also literal\\]\n  ```",
    "Code: `first line\n\\(literal\\)` then \\(x\\).",
    "Code: ``a ` b \\(literal\\)`` then \\(x\\).",
  ])("preserves TeX inside nested and multiline code spans: %s", (source) => {
    const document = markdownToDocument(source);
    const codes = [
      ...nodesOfType(document, "codeBlock"),
      ...nodesOfType(document, "text").filter((node) =>
        node.marks?.some((mark) => mark.type === "code"),
      ),
    ];
    expect(
      codes.map((node) => node.text ?? node.content?.[0]?.text).join("\n"),
    ).toContain("\\(literal\\)");
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
    if (source.includes("then"))
      expect(nodesOfType(document, "inlineFormula")[0].attrs?.latex).toBe("x");
  });

  it("does not let a literal escaped backtick hide following math", () => {
    const document = markdownToDocument("Literal \\` then \\(x\\).");
    expect(nodesOfType(document, "inlineFormula")[0]?.attrs?.latex).toBe("x");
  });

  it.each([
    "<pre>\\(literal\\) and $$literal$$</pre>",
    "Before <kbd>\\(literal\\)</kbd> after \\(x\\).",
    "<div>\n\\[literal\\]\n</div>",
  ])("preserves the original TeX syntax inside HTML previews: %s", (source) => {
    const document = markdownToDocument(source);
    const previews = [
      ...nodesOfType(document, "htmlPreview"),
      ...nodesOfType(document, "inlineHtmlPreview"),
    ];
    expect(previews[0]?.attrs?.source).toContain(
      source.includes("\\[") ? "\\[literal\\]" : "\\(literal\\)",
    );
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it("imports starred LaTeX display environments without absorbing following prose", () => {
    const document = markdownToDocument(
      "\\begin{align*}\nx &= y\n\\end{align*}\n\nFollowing prose.",
    );
    expect(nodesOfType(document, "blockFormula")[0].attrs?.latex).toBe(
      "\\begin{align*}\nx &= y\n\\end{align*}",
    );
    expect(nodesOfType(document, "paragraph")[0].content?.[0]?.text).toBe(
      "Following prose.",
    );
  });

  it("imports editable footnote references and definitions with stable source labels", () => {
    const source = "A note[^1].\n\n[^1]: Preserved note.";
    const document = markdownToDocument(source);
    expect(document.content?.[0]?.content?.map((node) => node.type)).toEqual([
      "text",
      "footnoteReference",
      "text",
    ]);
    expect(documentToMarkdown(document)).toContain("[^1]");
    expect(documentToMarkdown(document)).toContain("[^1]: Preserved note.");
    expect(nodesOfType(document, "footnoteDefinition")).toHaveLength(1);
    expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);
    expect(markdownToDocument(documentToMarkdown(document))).toEqual(document);
  });

  it("keeps all items in mixed ordinary and task bullet lists in document order", () => {
    const source =
      "- Ordinary first\n- [x] Completed\n- [ ] Remaining\n- Ordinary last";
    const document = markdownToDocument(source);
    expect(document.content?.map((node) => node.type)).toEqual([
      "bulletList",
      "taskList",
      "bulletList",
    ]);
    expect(nodesOfType(document, "listItem")).toHaveLength(2);
    expect(nodesOfType(document, "taskItem")).toHaveLength(2);
    const serialized = documentToMarkdown(document);
    expect(serialized).toContain("Ordinary first");
    expect(serialized).toContain("[x] Completed");
    expect(serialized).toContain("[ ] Remaining");
    expect(serialized).toContain("Ordinary last");
    expect(
      nodesOfType(markdownToDocument(serialized), "listItem"),
    ).toHaveLength(2);
  });

  it("imports mixed numbered task lists with editable items and stable numbering", () => {
    const source = "3. [x] Third\n4. Plain fourth";
    const document = markdownToDocument(source);
    expect(document.content?.[0]?.type).toBe("orderedList");
    expect(document.content?.[0]?.attrs?.start).toBe(3);
    expect(document.content?.[0]?.content?.map((node) => node.type)).toEqual([
      "taskItem",
      "listItem",
    ]);
    expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);
    const serialized = documentToMarkdown(document);
    expect(serialized).toContain("3. [x] Third");
    expect(serialized).toContain("4. Plain fourth");
    expect(markdownToDocument(serialized)).toEqual(document);
  });

  it("imports the official remark-gfm demo with working reference links and stable code samples", () => {
    const source = readFileSync(
      resolve(process.cwd(), "test-fixtures/reading-demo/remark-gfm-readme.md"),
      "utf8",
    );
    const document = markdownToDocument(source);
    const serialized = documentToMarkdown(document);
    expect(
      nodesOfType(document, "unsupportedMarkdown").map(
        (node) => node.attrs?.source,
      ),
    ).toEqual([]);
    expect(JSON.stringify(document)).toContain('"href":"#what-is-this"');
    expect(markdownToDocument(serialized)).toEqual(document);
  });
});
