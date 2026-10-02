import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMarkdownComment,
  serializeMarkdownWithComments,
  parseMarkdownComments,
  markdownFingerprint,
} from "../editor/comments";
import { markdownToDocument } from "../editor/markdown";
import { documentToPortableMarkdown, renameEditorFile } from "./files";

const mocks = vi.hoisted(() => ({
  entries: new Map<string, string | null>(),
  renameEntry: vi.fn(),
  writeMarkdown: vi.fn(),
  storeSet: vi.fn(),
  storeGet: vi.fn(),
  invoke: vi.fn(),
  exists: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: mocks.exists,
  readTextFile: async (path: string) => {
    const source = mocks.entries.get(path);
    if (typeof source !== "string") throw new Error(`File missing: ${path}`);
    return source;
  },
  rename: vi.fn(),
  writeTextFile: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: { load: async () => ({ get: mocks.storeGet, set: mocks.storeSet }) },
}));

const path = "/notes/research.md";
const target = "/notes/renamed.md";

describe("native document rename", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.invoke.mockImplementation(async (command: string, args?: { path: string; contents: string; source: string; target: string }) => {
      if (command === 'write_markdown_file') return mocks.writeMarkdown(args!.path, args!.contents);
      if (command === 'rename_document_entry') return mocks.renameEntry(args!.source, args!.target);
    });
    mocks.entries.clear();
    mocks.storeGet.mockResolvedValue([]);
    mocks.exists.mockImplementation(async (path: string) =>
      mocks.entries.has(path),
    );
    mocks.renameEntry.mockImplementation(async (from: string, to: string) => {
      if (!mocks.entries.has(from)) throw new Error(`Path missing: ${from}`);
      if (mocks.entries.has(to)) throw new Error(`Path already exists: ${to}`);
      for (const [key, value] of [...mocks.entries]) {
        if (key === from || key.startsWith(from + "/")) {
          mocks.entries.delete(key);
          mocks.entries.set(to + key.slice(from.length), value);
        }
      }
    });
    mocks.writeMarkdown.mockImplementation(
      async (filePath: string, source: string) => {
        mocks.entries.set(filePath, source);
      },
    );
  });

  it("grants the sibling target before checking or moving it", async () => {
    mocks.entries.set(path, "Original source\n");
    await renameEditorFile(
      {
        path,
        name: "research.md",
        document: markdownToDocument("Original source\n"),
      },
      "renamed.md",
    );
    expect(mocks.invoke).toHaveBeenCalledWith("allow_document_rename", {
      source: path,
      target,
    });
    expect(mocks.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.exists.mock.invocationCallOrder[0],
    );
    expect(mocks.exists.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.renameEntry.mock.invocationCallOrder[0],
    );
  });

  it("leaves the document intact when the target cannot be authorized", async () => {
    mocks.entries.set(path, "Original source\n");
    mocks.invoke.mockRejectedValueOnce(new Error("Rename scope denied"));
    await expect(
      renameEditorFile(
        {
          path,
          name: "research.md",
          document: markdownToDocument("Original source\n"),
        },
        "renamed.md",
      ),
    ).rejects.toThrow("Rename scope denied");
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.renameEntry).not.toHaveBeenCalled();
    expect(mocks.entries.get(path)).toBe("Original source\n");
    expect(mocks.entries.has(target)).toBe(false);
  });

  it("replaces the old filename in recent history only after the rename completes", async () => {
    const unrelated = { path: "/notes/other.md", name: "other.md" };
    mocks.entries.set(path, "Original source\n");
    mocks.storeGet.mockImplementation(async (key: string) =>
      key === "recentFiles" ? [{ path, name: "research.md" }, unrelated] : [],
    );
    await renameEditorFile(
      {
        path,
        name: "research.md",
        document: markdownToDocument("Original source\n"),
      },
      "renamed.md",
    );
    expect(mocks.storeSet).toHaveBeenCalledWith("recentFiles", [
      { path: target, name: "renamed.md" },
      unrelated,
    ]);
    expect(mocks.renameEntry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.storeSet.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["note.markdown", "note.markdown.md", "note.markdown.assets"],
    ["note.md", "note.MD", "note.assets"],
  ])(
    "retains the shared companion folder when renaming %s to %s",
    async (oldName, newName, assets) => {
      const sourcePath = `/notes/${oldName}`;
      const targetPath = `/notes/${newName}`;
      const source = `![Diagram](${assets}/diagram.svg)\n`;
      mocks.entries.set(sourcePath, source);
      mocks.entries.set(`/notes/${assets}`, null);
      mocks.entries.set(`/notes/${assets}/diagram.svg`, "image bytes");
      const renamed = await renameEditorFile(
        {
          path: sourcePath,
          name: oldName,
          sourceMarkdown: source,
          document: markdownToDocument(source),
        },
        newName,
      );
      expect(renamed.path).toBe(targetPath);
      expect(renamed.sourceMarkdown).toBe(source);
      expect(mocks.renameEntry).toHaveBeenCalledExactlyOnceWith(
        sourcePath,
        targetPath,
      );
      expect(mocks.entries.get(targetPath)).toBe(source);
      expect(mocks.entries.get(`/notes/${assets}/diagram.svg`)).toBe(
        "image bytes",
      );
      expect(documentToPortableMarkdown(renamed.document)).toContain(
        `${assets}/diagram.svg`,
      );
    },
  );

  it("leaves an unchanged uppercase Markdown filename alone", async () => {
    const file = {
      path: "/notes/Research.MD",
      name: "Research.MD",
      document: markdownToDocument("Original source\n"),
    };
    mocks.entries.set(file.path, "Original source\n");
    expect(await renameEditorFile(file, file.name)).toBe(file);
    expect(mocks.renameEntry).not.toHaveBeenCalled();
    expect(mocks.writeMarkdown).not.toHaveBeenCalled();
  });

  it.each([
    ["Reading.MD", "Reading.MD"],
    ["Reading.markdown", "Reading.markdown"],
    ["Reading.MARKDOWN", "Reading.MARKDOWN"],
    ["Reading", "Reading.md"],
  ])(
    "keeps the requested supported extension when naming an unnamed draft: %s",
    async (requested, expected) => {
      const file = {
        name: "Untitled.md",
        document: markdownToDocument("Draft source\n"),
      };
      const renamed = await renameEditorFile(file, requested);
      expect(renamed.name).toBe(expected);
      expect(renamed.document).toBe(file.document);
      expect(mocks.renameEntry).not.toHaveBeenCalled();
    },
  );

  it("retains the supported .markdown extension when renaming a saved document and its assets", async () => {
    const sourceMarkdown = "![Diagram](research.assets/diagram.png)\n";
    mocks.entries.set(path, sourceMarkdown);
    mocks.entries.set("/notes/research.assets", null);
    mocks.entries.set("/notes/research.assets/diagram.png", "image bytes");
    const renamed = await renameEditorFile(
      {
        path,
        name: "research.md",
        sourceMarkdown,
        document: markdownToDocument(sourceMarkdown),
      },
      "reading.markdown",
    );
    expect(renamed.path).toBe("/notes/reading.markdown");
    expect(renamed.name).toBe("reading.markdown");
    expect(mocks.entries.get("/notes/reading.markdown")).toBe(
      "![Diagram](reading.markdown.assets/diagram.png)\n",
    );
    expect(
      mocks.entries.get("/notes/reading.markdown.assets/diagram.png"),
    ).toBe("image bytes");
  });

  it("keeps disk source, cache and rendered images consistent while preserving literal paths and comments", async () => {
    const body =
      '# research.assets/\n\nLiteral `research.assets/` and [Download](research.assets/download.png).\n\n![Diagram](./research%2Eassets/diagram.png)\n\n![Reference][image]\n\n[image]: research.assets/reference.png "research.assets/title"\n\n<div data-src="research.assets/literal.png"><img src="research.assets/html.png"></div>\n\n![Remote](https://example.com/research.assets/remote.png)\n';
    const comment = createMarkdownComment(
      body,
      { kind: "position", offset: 0 },
      "research.assets/comment text",
    );
    const sourceMarkdown = serializeMarkdownWithComments(body, [comment]);
    mocks.entries.set(path, sourceMarkdown);
    mocks.entries.set("/notes/research.assets", null);
    mocks.entries.set("/notes/research.assets/diagram.png", "image bytes");
    const expectedBody = body
      .replace(
        "./research%2Eassets/diagram.png",
        "./renamed.assets/diagram.png",
      )
      .replace("research.assets/reference.png", "renamed.assets/reference.png")
      .replace("research.assets/html.png", "renamed.assets/html.png");
    const renamed = await renameEditorFile(
      {
        path,
        name: "research.md",
        document: markdownToDocument(body),
        sourceMarkdown,
        comments: [comment],
      },
      "renamed.md",
    );

    const diskSource = mocks.entries.get(target) as string;
    const parsed = parseMarkdownComments(diskSource);
    expect(parsed.body).toBe(expectedBody);
    expect(parsed.comments[0].content).toBe("research.assets/comment text");
    expect(parsed.comments[0].target).toEqual(comment.target);
    expect(parsed.comments[0].bodyFingerprint).toBe(
      markdownFingerprint(expectedBody),
    );
    expect(mocks.entries.has(path)).toBe(false);
    expect(mocks.entries.get("/notes/renamed.assets/diagram.png")).toBe(
      "image bytes",
    );
    expect(renamed.sourceMarkdown).toBe(diskSource);
    expect(renamed.comments?.[0]).toEqual(
      expect.objectContaining({
        content: comment.content,
        target: comment.target,
        status: "active",
        bodyFingerprint: markdownFingerprint(
          documentToPortableMarkdown(renamed.document),
        ),
      }),
    );
    const images = renamed.document.content?.filter(
      (node) => node.type === "image",
    );
    expect(images?.[0]?.attrs).toEqual(
      expect.objectContaining({
        src: "asset:/notes/renamed.assets/diagram.png",
        originalSrc: "./renamed.assets/diagram.png",
      }),
    );
    expect(images?.[1]?.attrs?.originalSrc).toBe(
      "renamed.assets/reference.png",
    );
    expect(JSON.stringify(renamed.document)).toContain(
      '<img src=\\"renamed.assets/html.png\\">',
    );
    expect(mocks.writeMarkdown).toHaveBeenCalledOnce();
  });

  it("does not rewrite disk bytes when only prose/code/remote URLs mention the old asset folder", async () => {
    const sourceMarkdown =
      "# research.assets/\r\n\r\n`![literal](research.assets/image.png)`\r\n\r\n![Remote](https://example.com/research.assets/image.png)\r\n";
    mocks.entries.set(path, sourceMarkdown);
    const renamed = await renameEditorFile(
      {
        path,
        name: "research.md",
        document: markdownToDocument(sourceMarkdown),
        sourceMarkdown,
      },
      "renamed.md",
    );
    expect(mocks.entries.get(target)).toBe(sourceMarkdown);
    expect(renamed.sourceMarkdown).toBe(sourceMarkdown);
    expect(mocks.writeMarkdown).not.toHaveBeenCalled();
  });

  it("returns the completed rename when persisting recent history fails", async () => {
    const sourceMarkdown =
      "# Reading\n\n![Diagram](research.assets/diagram.png)\n";
    const expectedSource = sourceMarkdown.replace(
      "research.assets/",
      "renamed.assets/",
    );
    mocks.entries.set(path, sourceMarkdown);
    mocks.entries.set("/notes/research.assets", null);
    mocks.entries.set("/notes/research.assets/diagram.png", "image bytes");
    mocks.storeSet.mockRejectedValueOnce(new Error("Settings write failed"));

    const renamed = await renameEditorFile(
      {
        path,
        name: "research.md",
        document: markdownToDocument(sourceMarkdown),
        sourceMarkdown,
      },
      "renamed.md",
    );

    expect(mocks.entries.has(path)).toBe(false);
    expect(mocks.entries.get(target)).toBe(expectedSource);
    expect(mocks.entries.get("/notes/renamed.assets/diagram.png")).toBe(
      "image bytes",
    );
    expect(renamed).toEqual(
      expect.objectContaining({
        path: target,
        name: "renamed.md",
        sourceMarkdown: expectedSource,
      }),
    );
    expect(
      renamed.document.content?.find((node) => node.type === "image")?.attrs,
    ).toEqual(
      expect.objectContaining({
        src: "asset:/notes/renamed.assets/diagram.png",
        originalSrc: "renamed.assets/diagram.png",
      }),
    );
    expect(mocks.storeSet).toHaveBeenCalledOnce();
  });

  it("recovers original bytes and both paths when an atomic rewrite rejects", async () => {
    const sourceMarkdown =
      "# Original\n\n![Diagram](research.assets/diagram.png)\n";
    mocks.entries.set(path, sourceMarkdown);
    mocks.entries.set("/notes/research.assets", null);
    mocks.entries.set("/notes/research.assets/diagram.png", "image bytes");
    mocks.writeMarkdown.mockRejectedValueOnce(new Error("Disk write failed"));
    await expect(
      renameEditorFile(
        {
          path,
          name: "research.md",
          document: markdownToDocument(sourceMarkdown),
          sourceMarkdown,
        },
        "renamed.md",
      ),
    ).rejects.toThrow("Disk write failed");
    expect(mocks.entries.get(path)).toBe(sourceMarkdown);
    expect(mocks.entries.get("/notes/research.assets/diagram.png")).toBe(
      "image bytes",
    );
    expect(mocks.entries.has(target)).toBe(false);
    expect(mocks.entries.has("/notes/renamed.assets")).toBe(false);
    expect(mocks.writeMarkdown).toHaveBeenCalledOnce();
    expect(mocks.storeSet).not.toHaveBeenCalled();
  });

  it("restores the file name if moving the asset directory fails before any source rewrite", async () => {
    const sourceMarkdown = "![Diagram](research.assets/diagram.png)\n";
    mocks.entries.set(path, sourceMarkdown);
    mocks.entries.set("/notes/research.assets", null);
    mocks.renameEntry
      .mockImplementationOnce(async (from: string, to: string) => {
        mocks.entries.set(to, mocks.entries.get(from)!);
        mocks.entries.delete(from);
      })
      .mockRejectedValueOnce(new Error("Directory move failed"));
    await expect(
      renameEditorFile(
        {
          path,
          name: "research.md",
          document: markdownToDocument(sourceMarkdown),
        },
        "renamed.md",
      ),
    ).rejects.toThrow("Directory move failed");
    expect(mocks.entries.get(path)).toBe(sourceMarkdown);
    expect(mocks.entries.has("/notes/research.assets")).toBe(true);
    expect(mocks.writeMarkdown).not.toHaveBeenCalled();
  });

  it.each([target, "/notes/renamed.assets"])(
    "rejects a destination collision before changing files: %s",
    async (collision) => {
      mocks.entries.set(path, "Original source");
      mocks.entries.set("/notes/research.assets", null);
      mocks.entries.set(collision, null);
      await expect(
        renameEditorFile(
          { path, name: "research.md", document: { type: "doc" } },
          "renamed.md",
        ),
      ).rejects.toThrow();
      expect(mocks.entries.get(path)).toBe("Original source");
      expect(mocks.renameEntry).not.toHaveBeenCalled();
      expect(mocks.writeMarkdown).not.toHaveBeenCalled();
    },
  );

  it.each([target, "/notes/renamed.assets"])(
    "preserves an entry created after the collision check: %s",
    async (collision) => {
      const sourceMarkdown = "![Diagram](research.assets/diagram.png)\n";
      mocks.entries.set(path, sourceMarkdown);
      mocks.entries.set("/notes/research.assets", null);
      mocks.entries.set("/notes/research.assets/diagram.png", "original image");
      let collided = false;
      mocks.exists.mockImplementation(async (checked: string) => {
        const present = mocks.entries.has(checked);
        if (checked === collision && !present && !collided) {
          collided = true;
          mocks.entries.set(collision, "new competing entry");
        }
        return present;
      });
      await expect(renameEditorFile({ path, name: "research.md", document: markdownToDocument(sourceMarkdown) }, "renamed.md")).rejects.toThrow("Path already exists");
      expect(mocks.entries.get(collision)).toBe("new competing entry");
      expect(mocks.entries.get(path)).toBe(sourceMarkdown);
      expect(mocks.entries.get("/notes/research.assets/diagram.png")).toBe("original image");
      expect(mocks.writeMarkdown).not.toHaveBeenCalled();
      expect(mocks.storeSet).not.toHaveBeenCalled();
      expect(mocks.invoke).toHaveBeenCalledWith("rename_document_entry", expect.any(Object));
    },
  );
});
