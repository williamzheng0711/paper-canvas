import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    "imports every HTML layout block in %s as a lossless preview",
    (file) => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      const document = markdownToDocument(source);
      const previews = nodesOfType(document, "htmlPreview");
      const serialized = documentToMarkdown(document);

      const expectedPreviewCount = file === "README.md" ? 6 : 13;

      expect(previews).toHaveLength(expectedPreviewCount);
      expect(nodesOfType(document, "unsupportedMarkdown")).toHaveLength(0);
      previews.forEach((preview) =>
        expect(serialized).toContain(String(preview.attrs?.source ?? "")),
      );
      expect(documentToMarkdown(markdownToDocument(serialized))).toBe(
        serialized,
      );
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
