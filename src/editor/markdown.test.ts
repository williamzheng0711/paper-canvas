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
});
