import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMarkdownComment,
  parseMarkdownComments,
  relocateMarkdownComments,
  serializeMarkdownWithComments,
} from "../editor/comments";
import { markdownToDocument } from "../editor/markdown";
import {
  documentToPortableMarkdown,
  hydrateDocumentAssets,
  rebaseEditorFileAssets,
  saveEditorFile,
  type EditorFile,
} from "./files";

const mocks = vi.hoisted(() => ({
  target: "/exports/copy.md",
  save: vi.fn(),
  writeMarkdown: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  storeSet: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: async (command: string, args?: { path: string; contents: string }) => {
    if (command === 'resolve_markdown_document_path') return args!.path;
    if (command === 'write_markdown_file') return mocks.writeMarkdown(args!.path, args!.contents);
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: mocks.save,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
  readFile: vi.fn(),
  rename: mocks.rename,
  writeTextFile: vi.fn(),
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: { load: async () => ({ get: async () => [], set: mocks.storeSet }) },
}));

const oldPath = "/notes/research.md";
function sourceFile(sourceMarkdown: string, path = oldPath): EditorFile {
  return {
    path,
    name: path.split("/").at(-1)!,
    sourceMarkdown,
    document: hydrateDocumentAssets(markdownToDocument(sourceMarkdown), path),
  };
}

describe("Save As local images", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.target = "/exports/copy.md";
    mocks.save.mockImplementation(async () => mocks.target);
    mocks.writeMarkdown.mockResolvedValue(undefined);
  });

  it("keeps original physical images and unrelated source bytes when saving in another directory", async () => {
    const source =
      '# Paths\r\n\r\nLiteral `research.assets/a.png`, [download](research.assets/a.png).\r\n\r\n```md\r\n![literal](research.assets/a.png)\r\n```\r\n\r\n![Diagram](./research%2Eassets/a%20b.png "research.assets/title")\r\n\r\n![Reference][image]\r\n\r\n[image]: <images/reference.png> "Reference title"\r\n[unused]: images/unused.png\r\n\r\n<div data-src="images/literal.png"><IMG SRC="images/html.png?x=1&amp;y=2" alt="Title"></div>\r\n\r\n![Remote](https://example.com/images/remote.png)\r\n\r\n\\(\\text{![literal](images/math.png)}\\)\r\n';
    const file = sourceFile(source);
    const originalImage = file.document.content?.find(
      (node) => node.type === "image",
    )?.attrs?.src;
    const saved = await saveEditorFile(file, true);
    const expected = source
      .replace(
        "./research%2Eassets/a%20b.png",
        "../notes/./research%2Eassets/a%20b.png",
      )
      .replace("<images/reference.png>", "<../notes/images/reference.png>")
      .replace('SRC="images/html.png', 'SRC="../notes/images/html.png');
    expect(mocks.writeMarkdown).toHaveBeenCalledWith(
      "/exports/copy.md",
      expected,
    );
    expect(saved.sourceMarkdown).toBe(expected);
    expect(
      saved.document.content?.find((node) => node.type === "image")?.attrs,
    ).toEqual(
      expect.objectContaining({
        src: originalImage,
        originalSrc: "../notes/./research%2Eassets/a%20b.png",
      }),
    );
    expect(JSON.stringify(saved.document)).toContain(
      "../notes/images/html.png",
    );
    expect(file.sourceMarkdown).toBe(source);
    expect(mocks.rename).not.toHaveBeenCalled();
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves clean source bytes for an ordinary/same-directory save (Save As=%s)",
    async (forceSaveAs) => {
      mocks.target = "/notes/copy.md";
      const source =
        '# Title\r\n\r\n![Image][ref]\r\n\r\n[ref]: <./research%2Eassets/a%20b.png> "Title"\r\n\r\n';
      const saved = await saveEditorFile(sourceFile(source), forceSaveAs);
      expect(saved.sourceMarkdown).toBe(source);
      expect(mocks.writeMarkdown).toHaveBeenCalledWith(
        forceSaveAs ? mocks.target : oldPath,
        source,
      );
      expect(mocks.save).toHaveBeenCalledTimes(forceSaveAs ? 1 : 0);
    },
  );

  it.each(["source", "canvas"] as const)(
    "returns the completed %s Save As when persisting recent history fails",
    async (mode) => {
      const source = "# Reading\n\n![Diagram](research.assets/a.png)\n";
      const file = sourceFile(source);
      if (mode === "canvas") delete file.sourceMarkdown;
      const expected = source.replace("research.assets/", "../notes/research.assets/");
      mocks.storeSet.mockRejectedValueOnce(new Error("Settings write failed"));

      const saved = await saveEditorFile(file, true);

      expect(mocks.writeMarkdown).toHaveBeenCalledWith(mocks.target, expected);
      expect(saved).toEqual(expect.objectContaining({
        path: mocks.target, name: "copy.md", sourceMarkdown: expected,
      }));
      expect(saved.document.content?.find((node) => node.type === "image")?.attrs).toEqual(
        expect.objectContaining({
          src: "asset:/notes/research.assets/a.png",
          originalSrc: "../notes/research.assets/a.png",
        }),
      );
      expect(mocks.storeSet).toHaveBeenCalledOnce();
    },
  );

  it("rebases canvas images and preserved unsupported headings/tables without copying assets", async () => {
    const source =
      "# ![Logo](images/logo.png) Heading\n\n| Figure |\n| --- |\n| ![Figure](images/table.png) |\n\n![Image](research.assets/canvas.png)\n\n![Remote](https://example.com/a.png)";
    const file = sourceFile(source);
    delete file.sourceMarkdown;
    const saved = await saveEditorFile(file, true);
    expect(saved.sourceMarkdown).toContain("../notes/images/logo.png");
    expect(saved.sourceMarkdown).toContain("../notes/images/table.png");
    expect(saved.sourceMarkdown).toContain(
      "../notes/research.assets/canvas.png",
    );
    expect(saved.sourceMarkdown).toContain("https://example.com/a.png");
    expect(
      saved.document.content?.find((node) => node.type === "image")?.attrs?.src,
    ).toBe("asset:/notes/research.assets/canvas.png");
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("updates source and canonical comment offsets after an image destination grows", async () => {
    const body =
      "# Title\r\n\r\n![Image](research.assets/a.png)\r\n\r\nA unique comment target.\r\n";
    const from = body.indexOf("unique comment target");
    const comment = createMarkdownComment(
      body,
      { kind: "range", from, to: from + "unique comment target".length },
      "Keep this comment",
    );
    const file = sourceFile(serializeMarkdownWithComments(body, [comment]));
    file.comments = relocateMarkdownComments(
      [comment],
      body,
      documentToPortableMarkdown(file.document),
    );
    const saved = await saveEditorFile(file, true);
    const parsed = parseMarkdownComments(saved.sourceMarkdown!);
    expect(parsed.body).toBe(
      body.replace("research.assets/a.png", "../notes/research.assets/a.png"),
    );
    expect(parsed.comments[0]).toEqual(
      expect.objectContaining({
        content: "Keep this comment",
        status: "active",
        target: {
          kind: "range",
          from: parsed.body.indexOf("unique comment target"),
          to:
            parsed.body.indexOf("unique comment target") +
            "unique comment target".length,
        },
      }),
    );
    const canonical = documentToPortableMarkdown(saved.document);
    expect(saved.comments?.[0].target).toEqual({
      kind: "range",
      from: canonical.indexOf("unique comment target"),
      to:
        canonical.indexOf("unique comment target") +
        "unique comment target".length,
    });
  });

  it("rebases the latest edits once before a retry at the new Save As path", async () => {
    const first = "# First\n\n![Image](research.assets/a.png)\n";
    let completeWrite!: () => void;
    mocks.writeMarkdown.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          completeWrite = resolve;
        }),
    );
    const saving = saveEditorFile(sourceFile(first), true);
    await vi.waitFor(() => expect(mocks.writeMarkdown).toHaveBeenCalledOnce());
    const latest =
      first.replace("# First", "# Latest") + "\n![Added](images/late.png)\n";
    completeWrite();
    const saved = await saving;
    const rebased = rebaseEditorFileAssets(
      sourceFile(latest),
      oldPath,
      saved.path!,
    );
    const retried = await saveEditorFile(
      rebased,
      false,
      rebased.sourceMarkdown,
    );
    const expected = latest
      .replace("research.assets/a.png", "../notes/research.assets/a.png")
      .replace("images/late.png", "../notes/images/late.png");
    expect(retried.sourceMarkdown).toBe(expected);
    expect(mocks.writeMarkdown).toHaveBeenLastCalledWith(
      "/exports/copy.md",
      expected,
    );
    expect(mocks.save).toHaveBeenCalledOnce();
    expect(retried.sourceMarkdown).not.toContain("../notes/../notes/");
  });

  it("preserves filesystem root directories when hydrating rebased images", async () => {
    mocks.target = "/copy.md";
    const saved = await saveEditorFile(
      sourceFile(
        '![Image](assets/a.png)\n\n<img src="assets/html.png">\n',
        "/note.md",
      ),
      true,
    );
    expect(saved.sourceMarkdown).toBe(
      '![Image](assets/a.png)\n\n<img src="assets/html.png">\n',
    );
    expect(saved.document.content?.[0].attrs?.src).toBe("asset:/assets/a.png");
    expect(saved.document.content?.[1].attrs?.basePath).toBe("/");
  });
});
