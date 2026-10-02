import { describe, expect, it } from "vitest";
import { isHtmlCommentOnly, isHtmlPreviewCandidate } from "./htmlSafety";
import { createHtmlPreview } from "./HtmlPreview";

describe("HTML preview candidate scanning", () => {
  it.each([
    "<!-- note -->",
    " \n<!-- first -->\r\n<!-- second --> ",
    "<!-->",
    "<!--->",
    "<!-- x --!>",
  ])("recognizes a complete invisible HTML comment %j", (source) => {
    expect(isHtmlCommentOnly(source)).toBe(true);
    expect(isHtmlPreviewCandidate(source)).toBe(true);
    expect(createHtmlPreview(source, { kind: "block" }).hidden).toBe(true);
  });

  it.each([
    "<!--<script>bad()</script>",
    "<!-- <div>text</div>",
    "<!-- x",
    "<!--<!--",
  ])(
    "keeps an unfinished comment as source without scanning its body as tags: %j",
    (source) => {
      expect(isHtmlCommentOnly(source)).toBe(false);
      expect(isHtmlPreviewCandidate(source)).toBe(false);
    },
  );

  it.each(["<!-->", "<!--->", "<!-- x --!>", "<!-- x -->"])(
    "checks executable tags following the browser's comment ending %j",
    (comment) => {
      const source = `${comment}<script>bad()</script>`;
      expect(isHtmlCommentOnly(source)).toBe(false);
      expect(isHtmlPreviewCandidate(source)).toBe(false);
      const preview = createHtmlPreview(source, { kind: "inline" });
      expect(preview.querySelector("script")).toBeNull();
      expect(preview.textContent).toBe(source);
    },
  );

  it("distinguishes comment markers inside quoted attributes from actual comments", () => {
    expect(
      isHtmlPreviewCandidate('<span title="<!-- <script> -->">Text</span>'),
    ).toBe(true);
    expect(
      isHtmlPreviewCandidate(
        '<span title="<!--"><script>bad()</script><!-- end -->Text</span>',
      ),
    ).toBe(false);
    expect(
      isHtmlPreviewCandidate("<!-- <script>bad()</script> --><p>Visible</p>"),
    ).toBe(true);
    expect(
      isHtmlPreviewCandidate("<p>Visible</p><!-- <script>hidden</script>"),
    ).toBe(true);
  });

  it("scans repeated incomplete comment openings in linear time", () => {
    const unfinished = "<!--".repeat(50_000);
    const started = performance.now();
    expect(isHtmlCommentOnly(unfinished)).toBe(false);
    expect(isHtmlPreviewCandidate(unfinished)).toBe(false);
    expect(
      isHtmlPreviewCandidate(
        `${unfinished}<div>still inside the comment</div>`,
      ),
    ).toBe(false);
    expect(isHtmlCommentOnly(`<!-- complete -->${unfinished}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
