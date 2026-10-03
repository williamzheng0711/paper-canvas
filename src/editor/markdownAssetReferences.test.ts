import { describe, expect, it } from "vitest";
import {
  renameHtmlImageAssets,
  renameImageDestination,
  renameMarkdownImageAssets,
  rebaseHtmlImageAssets,
  rebaseImageDestination,
  rebaseMarkdownImageAssets,
  imagePathSourceChanges,
} from "./markdownAssetReferences";
import { localAssetPath } from "../lib/localAssets";
import {
  createMarkdownComment,
  markdownFingerprint,
  parseMarkdownComments,
  serializeMarkdownWithComments,
} from "./comments";

const oldPath = "/notes/research.md";
const newPath = "/notes/renamed.md";
const rename = (source: string) =>
  renameMarkdownImageAssets(source, oldPath, newPath);

describe("image edits in UTF-8 BOM documents", () => {
  it.each(["\n", "\r\n", "\r"])(
    "protects display formula image literals while rebasing actual images with %j separators",
    (ending) => {
      const literal = "![literal](./research.assets/formula.png)";
      const source = `\uFEFF\\[${ending}\\text{${literal}}${ending}\\]${ending}${ending}\\begin{align}${ending}\\text{${literal}}${ending}\\end{align}${ending}${ending}![actual](./research.assets/image.png)${ending}`;
      expect(rebaseMarkdownImageAssets(source, oldPath, "/copies/copy.md")).toBe(source.replace("./research.assets/image.png", "../notes/./research.assets/image.png"));
      expect(rename(source)).toBe(source.replace("./research.assets/image.png", "./renamed.assets/image.png"));
    },
  );

  it("keeps offsets and all other source bytes when rebasing inline, reference, and HTML images", () => {
    const source = '\uFEFF# Original 中文\r\n\r\n![Diagram](./research.assets/image.svg)\r\n\r\n![Reference][diagram]\r\n\r\n[diagram]: ./research.assets/ref.svg "Title"\r\n\r\n<div><img src="./research.assets/html.svg"></div>\r\n\r\n`![literal](./research.assets/literal.svg)`\r\nLatest writing 🧪';
    const expected = source
      .replace('./research.assets/image.svg', '../notes/./research.assets/image.svg')
      .replace('./research.assets/ref.svg', '../notes/./research.assets/ref.svg')
      .replace('./research.assets/html.svg', '../notes/./research.assets/html.svg');
    expect(rebaseMarkdownImageAssets(source, oldPath, '/copies/copy.md')).toBe(expected);
    expect(rename(source)).toBe(source
      .replace('./research.assets/image.svg', './renamed.assets/image.svg')
      .replace('./research.assets/ref.svg', './renamed.assets/ref.svg')
      .replace('./research.assets/html.svg', './renamed.assets/html.svg'));
  });

  it.each([3, 4])("preserves Markdown indentation semantics after the BOM with %i spaces", (spaces) => {
    const source = '\uFEFF' + ' '.repeat(spaces) + '![Diagram](./research.assets/image.svg)\r\n';
    expect(rename(source)).toBe(spaces === 3
      ? source.replace('./research.assets/image.svg', './renamed.assets/image.svg')
      : source);
  });

  it.each([1, 2, 3])("accounts for exactly one stripped BOM with %i leading markers and masked Typora formulas", (count) => {
    const source = '\uFEFF'.repeat(count) + '![Diagram](./research.assets/image.svg)\r\n\r\n`\\( ![literal](./research.assets/code.svg) \\)`\r\n\r\n\\(\\text{![formula](./research.assets/math.svg)}\\)\r\n';
    expect(rename(source)).toBe(source.replace('./research.assets/image.svg', './renamed.assets/image.svg'));
    expect(rebaseMarkdownImageAssets(source, oldPath, '/copies/copy.md')).toBe(source.replace('./research.assets/image.svg', '../notes/./research.assets/image.svg'));
  });

  it.each(['\\[\r\n![literal](./research.assets/math.svg)\r\n\\]', '\\begin{align}\r\n![literal](./research.assets/math.svg)\r\n\\end{align}'])("protects a Typora block formula immediately after the BOM: %s", (formula) => {
    const source = '\uFEFF' + formula + '\r\n\r\n![Diagram](./research.assets/image.svg)\r\n';
    expect(rename(source)).toBe(source.replace('./research.assets/image.svg', './renamed.assets/image.svg'));
  });
});

describe("POSIX filenames containing literal backslashes", () => {
  it("renames the complete companion-folder name without interpreting its backslash as a separator", () => {
    const source = "![Image](research%5Cdraft.assets/image%5Cname.png)\n";
    expect(renameMarkdownImageAssets(source, "/notes/folder\\name/research\\draft.md", "/notes/folder\\name/copy.md")).toBe("![Image](copy.assets/image%5Cname.png)\n");
  });

  it("encodes a literal backslash in the original directory when rebasing Save As", () => {
    const source = "![Image](research%5Cdraft.assets/image%5Cname.png)\n";
    const rebased = rebaseMarkdownImageAssets(source, "/notes/folder\\name/research\\draft.md", "/exports/copy.md");
    expect(rebased).toBe("![Image](../notes/folder%5Cname/research%5Cdraft.assets/image%5Cname.png)\n");
    expect(localAssetPath("/exports", "../notes/folder%5Cname/research%5Cdraft.assets/image%5Cname.png").path).toBe("/notes/folder\\name/research\\draft.assets/image\\name.png");
    expect(rebaseImageDestination("%5Cleading.png", "/notes/research.md", "/exports/copy.md")).toBe("../notes/%5Cleading.png");
  });
});

describe("renaming local image destinations without rewriting document content", () => {
  it.each([
    ["/notes/research.md", "research&#46assets/image.png"],
    ["/notes/research&.md", "research&amp.assets/image.png"],
    ["/notes/research&.md", "research&amp;.assets/image.png"],
    ["/notes/&notit;.md", "&notit;.assets/image.png"],
    ["/notes/research&amp=.md", "research&amp=.assets/image.png"],
  ])("decodes HTML image entities using attribute rules when renaming %s", (sourcePath, destination) => {
    const source = `<div title="${destination}"><img src="${destination}"></div>`;
    const expected = `<div title="${destination}"><img src="new.assets/image.png"></div>`;
    expect(renameHtmlImageAssets(source, sourcePath, "/notes/new.md")).toBe(expected);
    expect(renameMarkdownImageAssets(source, sourcePath, "/notes/new.md")).toBe(expected);
  });

  it("retains literal Markdown entity-looking filenames without accepting HTML-only semicolon omission", () => {
    const source = "![literal](research&amp.assets/image.png)\n";
    expect(renameMarkdownImageAssets(source, "/notes/research&.md", "/notes/new.md")).toBe(source);
    expect(renameMarkdownImageAssets(source, "/notes/research&amp.md", "/notes/new.md")).toBe("![literal](new.assets/image.png)\n");
  });

  it("does not rename an HTML path belonging to another folder when an unclosed named entity precedes '='", () => {
    const source = '<img src="research&amp=.assets/image.png">';
    expect(renameHtmlImageAssets(source, "/notes/research&=.md", "/notes/new.md")).toBe(source);
  });

  it("keeps dense Typora masks, image edits and comment anchors aligned with original BOM/CRLF/Unicode source", () => {
    const row = "\\(\\text{![literal](formula.png)}\\) 中文🧪 `![code](code.png)` [link](link.png) ![actual](image.png)\r\n";
    const source = "\uFEFF" + row.repeat(1000) + "\\[\r\n\\(\\text{![nested](nested.png)}\\)\r\n\\]\r\n";
    const index = source.lastIndexOf("中文");
    const before = serializeMarkdownWithComments(source, [
      createMarkdownComment(source, { kind: "range", from: index, to: index + 2 }, "保持原文"),
    ]);
    const after = rebaseMarkdownImageAssets(before, oldPath, "/copies/copy.md");
    const expected = source.replaceAll("![actual](image.png)", "![actual](../notes/image.png)");
    const parsed = parseMarkdownComments(after);
    expect(parsed.status).toBe("valid");
    expect(parsed.body).toBe(expected);
    expect(parsed.comments[0].target).toEqual({ kind: "range", from: expected.lastIndexOf("中文"), to: expected.lastIndexOf("中文") + 2 });
    expect(parsed.comments[0].anchorText).toBe("中文");
    const update = imagePathSourceChanges(before, after, oldPath, "/copies/copy.md")!;
    let reconstructed = before;
    for (const edit of [...update.changes].reverse())
      reconstructed = reconstructed.slice(0, edit.from) + edit.value + reconstructed.slice(edit.to);
    expect(reconstructed).toBe(after);
  });

  it("rebases an image inside deeply nested source without overflowing AST visitors", () => {
    const source = "> ".repeat(4096) + "![Image](./research.assets/image.png)\n\n\\(literal\\)\n";
    const expected = source.replace("./research.assets/image.png", "../notes/./research.assets/image.png");
    expect(rebaseMarkdownImageAssets(source, oldPath, "/copies/copy.md")).toBe(expected);
    expect(rename(source)).toBe(source.replace("./research.assets/image.png", "./renamed.assets/image.png"));
  });

  it("preserves unfinished comments without rewriting their apparent images or rescanning every opener", () => {
    const source = "<!--".repeat(100_000) + '<img src="research.assets/hidden.png">';
    const started = performance.now();
    expect(renameHtmlImageAssets(source, oldPath, newPath)).toBe(source);
    expect(rebaseHtmlImageAssets(source, oldPath, "/copies/copy.md")).toBe(source);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each(["<!-->", "<!--->", "<!-- hidden <img src='research.assets/hidden.png'> --!>"])(
    "rewrites actual HTML images after the browser's comment ending %j",
    (comment) => {
      const source = `${comment}<img src="research.assets/image.png">`;
      const expected = `${comment}<img src="renamed.assets/image.png">`;
      expect(renameHtmlImageAssets(source, oldPath, newPath)).toBe(expected);
    },
  );

  it("does not treat a comment opening inside raw-text HTML as a document comment", () => {
    const source = '<script><!-- <img src="research.assets/script.png"></script><img src="research.assets/image.png">';
    expect(renameHtmlImageAssets(source, oldPath, newPath)).toBe(source.replace("research.assets/image.png", "renamed.assets/image.png"));
  });

  it("preserves prose, links, code, comments, non-image HTML, and remote image URLs byte for byte", () => {
    const source = [
      "# Paths\r\n",
      "The folder is research.assets/.\r\n",
      "[Download](research.assets/diagram.png)\r\n",
      "`![literal](research.assets/diagram.png)`\r\n",
      "```md\r\n![literal](research.assets/diagram.png)\r\n```\r\n",
      "    ![indented](research.assets/diagram.png)\r\n",
      '<!-- ![hidden](research.assets/diagram.png) <img src="research.assets/x.png"> -->\r\n',
      '<a href="research.assets/diagram.png">link</a>\r\n',
      '<div data-src="research.assets/diagram.png">Text</div>\r\n',
      "![Remote](https://example.com/research.assets/diagram.png)\r\n",
      "![Remote](//example.com/research.assets/diagram.png)\r\n",
      '![Actual](./research.assets/diagram.png "research.assets/title")\r\n',
    ].join("\r\n");
    expect(rename(source)).toBe(
      source.replace(
        "./research.assets/diagram.png",
        "./renamed.assets/diagram.png",
      ),
    );
  });

  it("changes only the first effective image-reference definition, retaining references, titles and unused definitions", () => {
    const source =
      '![Diagram][My ID]\n![My ID][]\n![My ID]\n[plain][Link]\n\n[My ID]: <./research.assets/diagram.png> "research.assets/title"\n[My ID]: research.assets/duplicate.png\n[Link]: research.assets/link.png\n[Unused]: research.assets/unused.png\n';
    expect(rename(source)).toBe(
      source.replace(
        "./research.assets/diagram.png",
        "./renamed.assets/diagram.png",
      ),
    );
  });

  it("keeps blockquote prefixes and definition line breaks intact", () => {
    const source =
      '> ![Image][diagram]\r\n>\r\n> [diagram]:\r\n>   <research.assets/image.png>\r\n>   "research.assets/title"\r\n';
    expect(rename(source)).toBe(
      source.replace("research.assets/image.png", "renamed.assets/image.png"),
    );
  });

  it.each([
    [
      "![Image](research.assets/figure(one).png)",
      "![Image](renamed.assets/figure(one).png)",
    ],
    [
      "![Image](research.assets/figure\\(one\\).png)",
      "![Image](renamed.assets/figure\\(one\\).png)",
    ],
    [
      "![Image](<research.assets/figure one.png> 'Title')",
      "![Image](<renamed.assets/figure one.png> 'Title')",
    ],
    [
      "![Image](research%2Eassets%2Ffigure%20one.png?size=2#preview)",
      "![Image](renamed.assets%2Ffigure%20one.png?size=2#preview)",
    ],
    [
      "![Image](research.assets/a%23b.png)",
      "![Image](renamed.assets/a%23b.png)",
    ],
    [
      "![Image](sub/../research.assets/image.png)",
      "![Image](sub/../renamed.assets/image.png)",
    ],
    [
      "![Image](../research.assets/image.png)",
      "![Image](../research.assets/image.png)",
    ],
    [
      "![Image](other/research.assets/image.png)",
      "![Image](other/research.assets/image.png)",
    ],
    [
      "![Image](research.assets/../other/image.png)",
      "![Image](research.assets/../other/image.png)",
    ],
    [
      "![Image](research.assets.backup/image.png)",
      "![Image](research.assets.backup/image.png)",
    ],
  ])(
    "retains destination syntax and relative path semantics: %s",
    (source, expected) => {
      expect(rename(source)).toBe(expected);
    },
  );

  it("encodes a newly named asset folder safely without changing remaining URL bytes", () => {
    expect(
      renameMarkdownImageAssets(
        "![Img](study%20%28old%29.assets/a%2520b.png)",
        "/notes/study (old).md",
        "/notes/研究 (new).md",
      ),
    ).toBe("![Img](%E7%A0%94%E7%A9%B6%20%28new%29.assets/a%2520b.png)");
    expect(
      renameImageDestination(
        "file:///notes/research.assets/a.png",
        oldPath,
        newPath,
      ),
    ).toBe("file:///notes/renamed.assets/a.png");
    expect(
      renameImageDestination("/notes/research.assets/a.png", oldPath, newPath),
    ).toBe("/notes/renamed.assets/a.png");
    expect(
      renameImageDestination(
        "research.assets\\a.png",
        "C:\\notes\\research.md",
        "C:\\notes\\renamed.md",
      ),
    ).toBe("renamed.assets\\a.png");
  });

  it("renames Windows asset paths regardless of directory-name casing", () => {
    expect(
      renameImageDestination(
        "paper.assets/diagram.png",
        "C:\\Notes\\Paper.md",
        "C:\\Notes\\Renamed.md",
      ),
    ).toBe("Renamed.assets/diagram.png");
    expect(
      renameImageDestination(
        "file:///c:/notes/PAPER.assets/diagram.png?size=2#preview",
        "C:\\Notes\\Paper.md",
        "C:\\Notes\\Renamed.md",
      ),
    ).toBe("file:///c:/notes/Renamed.assets/diagram.png?size=2#preview");
    // POSIX paths retain their case-sensitive physical-directory semantics.
    expect(
      renameImageDestination(
        "paper.assets/diagram.png",
        "/notes/Paper.md",
        "/notes/Renamed.md",
      ),
    ).toBe("paper.assets/diagram.png");
  });

  it.each(["//server/share/Notes/research.md", "\\\\server\\share\\Notes\\research.md"])(
    "renames a Windows network asset directory with either separator convention: %s",
    (sourcePath) => {
      const destinationPath = sourcePath.replace("research.md", "renamed.md");
      for (const destination of ["RESEARCH.ASSETS/image.png", "RESEARCH.ASSETS\\image.png"])
        expect(renameImageDestination(destination, sourcePath, destinationPath)).toBe(destination.replace("RESEARCH.ASSETS", "renamed.assets"));
    },
  );

  it("rewrites only actual HTML img src attributes, including entities and unquoted values", () => {
    const source =
      '<div title="research.assets/">\n<IMG alt="research.assets/" SRC="research&#46;assets/a.png?x=1&amp;y=2">\n<img src=./research.assets/b.png>\n<img data-src="research.assets/c.png" src="https://example.com/research.assets/c.png">\n<img src="research.assets/d.png" src="research.assets/e.png">\n<!-- <img src="research.assets/comment.png"> -->\n<script>const literal = \'<img src="research.assets/script.png">\';</script>\n<textarea><img src="research.assets/textarea.png"></textarea>\n</div>';
    const expected = source
      .replace("research&#46;assets/a.png", "renamed.assets/a.png")
      .replace("./research.assets/b.png", "./renamed.assets/b.png")
      .replace("research.assets/d.png", "renamed.assets/d.png");
    expect(renameHtmlImageAssets(source, oldPath, newPath)).toBe(expected);
    expect(rename(source)).toBe(expected);
  });

  it("preserves image-looking text in every supported math delimiter", () => {
    const literal = "![literal](research.assets/diagram.png)";
    const source = `$\\text{${literal}}$\n\n$$\n\\text{${literal}}\n$$\n\n\\(\\text{${literal}}\\)\n\n\\[\\text{${literal}}\\]\n\n\\[\n\\text{${literal}}\n\\]\n\n\\begin{align*}\n\\text{${literal}}\n\\end{align*}\n\n![Actual](research.assets/actual.png)\n`;
    expect(rename(source)).toBe(
      source.replace("research.assets/actual.png", "renamed.assets/actual.png"),
    );
  });

  it("does not treat unmatched Typora math or escaped delimiters as a formula", () => {
    expect(rename(String.raw`\\( ![Actual](research.assets/a.png) \\)`)).toBe(
      String.raw`\\( ![Actual](renamed.assets/a.png) \\)`,
    );
    expect(rename("\\[\n![Actual](research.assets/a.png)\n")).toBe(
      "\\[\n![Actual](renamed.assets/a.png)\n",
    );
  });

  it("uses the unescaped closing formula delimiter and does not rewrite formulas referenced by images", () => {
    const source =
      String.raw`\(\text{literal \\) and ![literal](research.assets/a.png)}\)` +
      "\n\n![Actual](research.assets/b.png)";
    expect(rename(source)).toBe(
      source.replace("research.assets/b.png", "renamed.assets/b.png"),
    );
    const reference =
      "\\(\\text{![literal][diagram]}\\)\n\n[diagram]: research.assets/a.png\n";
    expect(rename(reference)).toBe(reference);
  });

  it("retains an actual image in the same paragraph after an inline formula", () => {
    const source = "\\(x\\) ![Actual](research.assets/a.png)\n";
    expect(rename(source)).toBe(
      source.replace("research.assets/a.png", "renamed.assets/a.png"),
    );
  });

  it("does not alter escaped HTML or a later duplicate src attribute when the first src is empty", () => {
    const source =
      '&lt;img src="research.assets/literal.png"&gt;\n\n<img src src="research.assets/ignored.png">\n';
    expect(rename(source)).toBe(source);
  });
});

describe("rebasing local images after cross-directory Save As", () => {
  it.each(["rebase", "rename"] as const)(
    "maps repeated-anchor comments between and after image paths using exact %s edits",
    (operation) => {
      const body =
        "![First](research.assets/a.png) target target ![Second](research.assets/b.png)\n\nAfter images: target target.\n";
      const between = body.indexOf("target") + 3;
      const range = body.lastIndexOf("target");
      const comments = [
        createMarkdownComment(
          body,
          { kind: "position", offset: between },
          "Literal research.assets/comment",
        ),
        createMarkdownComment(
          body,
          { kind: "range", from: range, to: range + 6 },
          "After both images",
        ),
      ];
      const before = serializeMarkdownWithComments(body, comments);
      const newPath =
        operation === "rebase"
          ? "/exports/copy.md"
          : "/notes/a-much-longer-name.md";
      const after =
        operation === "rebase"
          ? rebaseMarkdownImageAssets(before, oldPath, newPath)
          : renameMarkdownImageAssets(before, oldPath, newPath);
      const parsed = parseMarkdownComments(after);
      const expectedBody = body.replaceAll(
        "research.assets/",
        operation === "rebase"
          ? "../notes/research.assets/"
          : "a-much-longer-name.assets/",
      );
      expect(parsed.body).toBe(expectedBody);
      expect(parsed.comments[0].target).toEqual({
        kind: "position",
        offset: expectedBody.indexOf("target") + 3,
      });
      expect(parsed.comments[1].target).toEqual({
        kind: "range",
        from: expectedBody.lastIndexOf("target"),
        to: expectedBody.lastIndexOf("target") + 6,
      });
      expect(parsed.comments.map((comment) => comment.status)).toEqual([
        "active",
        "active",
      ]);
      expect(parsed.comments[0].content).toBe(
        "Literal research.assets/comment",
      );
      expect(parsed.comments[1].bodyFingerprint).toBe(
        markdownFingerprint(expectedBody),
      );
      const update = imagePathSourceChanges(
        before,
        after,
        oldPath,
        newPath,
        operation,
      )!;
      expect(update.changes.map((change) => change.from)).toEqual(
        [...update.changes.map((change) => change.from)].sort((a, b) => a - b),
      );
      let reconstructed = before;
      for (const edit of [...update.changes].reverse())
        reconstructed =
          reconstructed.slice(0, edit.from) +
          edit.value +
          reconstructed.slice(edit.to);
      expect(reconstructed).toBe(after);
      expect(update.changes).toHaveLength(3);
    },
  );

  it("does not supply a partial source edit map for an unrelated content replacement", () => {
    const before = "![Image](images/a.png) Before text.";
    const after = "../notes/images/a.png Changed text.";
    expect(
      imagePathSourceChanges(before, after, oldPath, "/exports/copy.md"),
    ).toBeUndefined();
  });

  it.each([
    [
      "/notes and studies/paper.md",
      "/exports/sub/copy.md",
      "research%2Eassets%2Fa%2520b%23c.png?size=2#preview",
      "../../notes%20and%20studies/research%2Eassets%2Fa%2520b%23c.png?size=2#preview",
    ],
    [
      "/notes and studies/paper.md",
      "/exports/copy.md",
      "images/a%20b%.png?size=2",
      "../notes%20and%20studies/images/a%2520b%25.png?size=2",
    ],
    [
      "/notes/paper.md",
      "/notes/exports/copy.md",
      "../shared/a.png",
      "../../shared/a.png",
    ],
    [
      "/notes/old/paper.md",
      "/notes/copy.md",
      "images/a.png",
      "old/images/a.png",
    ],
    [
      "C:\\notes\\paper.md",
      "C:\\exports\\copy.md",
      "images/a%20b.png",
      "../notes/images/a%20b.png",
    ],
    [
      "C:\\note.md",
      "D:\\copy.md",
      "images/a%20b.png",
      "file:///C:/images/a%20b.png",
    ],
    [
      "\\\\server\\docs\\paper.md",
      "\\\\server\\exports\\copy.md",
      "images/a.png",
      "file://server/docs/images/a.png",
    ],
    [
      "\\\\server\\docs\\old\\paper.md",
      "\\\\server\\docs\\new\\copy.md",
      "images/a.png",
      "../old/images/a.png",
    ],
  ])(
    "preserves the physical image target from %s to %s",
    (oldPath, newPath, destination, expected) => {
      const result = rebaseImageDestination(destination, oldPath, newPath);
      expect(result).toBe(expected);
      const parent = (path: string) => {
        const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
        const value = path.slice(0, index);
        return /^[A-Za-z]:$/.test(value) ? value + path[index] : value || "/";
      };
      expect(localAssetPath(parent(newPath), result)).toEqual(
        localAssetPath(parent(oldPath), destination),
      );
    },
  );

  it("preserves same-directory, absolute, remote, data and fragment destinations", () => {
    expect(
      rebaseMarkdownImageAssets(
        "![Image](./a%20b.png)\r\n",
        oldPath,
        "/notes/copy.md",
      ),
    ).toBe("![Image](./a%20b.png)\r\n");
    expect(
      rebaseImageDestination(
        "images/a.png",
        "C:\\Notes\\paper.md",
        "c:\\notes\\copy.md",
      ),
    ).toBe("images/a.png");
    for (const destination of [
      "/images/a.png",
      "file:///images/a.png",
      "C:\\images\\a.png",
      "//example.com/a.png",
      "https://example.com/a.png",
      "data:image/png;base64,eA==",
      "#figure",
    ])
      expect(
        rebaseImageDestination(destination, oldPath, "/exports/copy.md"),
      ).toBe(destination);
  });

  it("retains HTML quoting/entities and all non-image bytes across Windows drives", () => {
    const source =
      '<div data-src="images/literal.png"><img src="images/a%20b.png?size=2&amp;x=1" title="images/title.png"><a href="images/link.png">Link</a></div>';
    expect(
      rebaseHtmlImageAssets(
        source,
        "C:\\notes\\paper.md",
        "D:\\exports\\copy.md",
      ),
    ).toBe(
      source.replace(
        'src="images/a%20b.png',
        'src="file:///C:/notes/images/a%20b.png',
      ),
    );
  });

  it.each([
    ['C:\\notes\\paper.md', 'D:\\copies\\copy.md', '/images/My%20figure.svg?view=1#diagram', 'file:///C:/images/My%20figure.svg?view=1#diagram'],
    ['C:\\notes\\paper.md', 'D:\\copies\\copy.md', '\\images\\My%20figure.svg?view=1#diagram', 'file:///C:/images/My%20figure.svg?view=1#diagram'],
    ['\\\\server\\share\\notes\\paper.md', '\\\\server\\other\\copies\\copy.md', '/images/a.svg', 'file://server/share/images/a.svg'],
    ['\\\\server\\share\\notes\\paper.md', '\\\\other\\share\\copies\\copy.md', '\\images\\a.svg', 'file://server/share/images/a.svg'],
  ])('keeps a Windows root-relative image at its original drive or share: %s → %s', (oldPath, newPath, destination, expected) => {
    const rebased = rebaseImageDestination(destination, oldPath, newPath);
    expect(rebased).toBe(expected);
    const parent = (path: string) => path.slice(0, path.lastIndexOf('\\'));
    expect(localAssetPath(parent(newPath), rebased)).toEqual(localAssetPath(parent(oldPath), destination));
    expect(rebaseMarkdownImageAssets(`![Diagram](${destination})\r\n`, oldPath, newPath)).toBe(`![Diagram](${expected})\r\n`);
    expect(rebaseHtmlImageAssets(`<img src="${destination}">`, oldPath, newPath)).toBe(`<img src="${expected}">`);
  });

  it.each([
    ['C:\\notes\\paper.md', 'c:\\copies\\copy.md'],
    ['\\\\server\\share\\notes\\paper.md', '\\\\SERVER\\SHARE\\copies\\copy.md'],
  ])('retains original single-root image bytes within the same Windows root: %s → %s', (oldPath, newPath) => {
    for (const destination of ['/images/a.svg?view=1#diagram', '\\images\\a.svg?view=1#diagram']) {
      expect(rebaseImageDestination(destination, oldPath, newPath)).toBe(destination);
    }
  });
});
