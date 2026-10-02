import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  documentToPortableMarkdown,
  hydrateDocumentAssets,
  saveEditorFile,
} from "./files";
import { markdownToDocument } from "../editor/markdown";
import { localAssetPath } from "./localAssets";

const mocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  rename: vi.fn(),
  writeFile: mocks.writeFile,
  writeTextFile: mocks.writeTextFile,
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: async () => ({ get: async () => [], set: async () => undefined }),
  },
}));

describe("saved embedded image formats", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    "/notes/Literal %20 #?.md",
    "/notes/研究 (100%).md",
    "C:\\notes\\Literal %20 #.md",
  ])(
    "reloads the physical embedded image when its document name contains URL characters: %s",
    async (path) => {
      const saved = await saveEditorFile({
        path,
        name: path.split(/[\\/]/).at(-1)!,
        document: {
          type: "doc",
          content: [
            {
              type: "image",
              attrs: {
                src: "data:image/png;base64,AAECAw==",
                alt: "Embedded diagram",
                width: 240,
                height: 120,
                linkHref: "https://example.com/guide",
                linkTitle: "Guide",
              },
            },
          ],
        },
      });
      const [writtenPath] = mocks.writeFile.mock.calls[0];
      expect(
        String(writtenPath)
          .replace(/\\/g, "/")
          .startsWith(path.replace(/\.md$/i, ".assets/").replace(/\\/g, "/")),
      ).toBe(true);
      const physicalPath = path.includes("\\")
        ? String(writtenPath).replace(/\//g, "\\")
        : writtenPath;
      expect(saved.document.content?.[0].attrs?.src).toBe(
        `asset:${physicalPath}`,
      );
      const markdown = documentToPortableMarkdown(saved.document);
      const reopened = hydrateDocumentAssets(
        markdownToDocument(markdown),
        path,
      );
      expect(reopened.content?.[0].attrs).toMatchObject({
        src: `asset:${physicalPath}`,
        width: 240,
        height: 120,
        linkHref: "https://example.com/guide",
        linkTitle: "Guide",
      });
      const parent = path.slice(
        0,
        Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")),
      );
      expect(
        localAssetPath(parent, reopened.content?.[0].attrs?.originalSrc),
      ).toEqual({ path: physicalPath, suffix: "" });
      expect(mocks.writeTextFile).toHaveBeenCalledWith(path, markdown);
    },
  );

  it("saves an embedded SVG diagram with its own image type and reloads the same asset", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="10"/></svg>';
    const src = `data:image/svg+xml;base64,${btoa(svg)}`;
    const path = "/notes/diagram.md";
    const saved = await saveEditorFile({
      path,
      name: "diagram.md",
      document: {
        type: "doc",
        content: [{ type: "image", attrs: { src, alt: "Diagram" } }],
      },
    });
    const [assetPath, bytes] = mocks.writeFile.mock.calls[0];
    expect(assetPath).toMatch(/^\/notes\/diagram\.assets\/image-.*\.svg$/);
    expect(Array.from(bytes as Uint8Array)).toEqual(
      Array.from(new TextEncoder().encode(svg)),
    );
    const markdown = documentToPortableMarkdown(saved.document);
    expect(markdown).toContain(".svg)");
    expect(markdown).not.toContain("data:");
    expect(mocks.writeTextFile).toHaveBeenCalledWith(path, markdown);
    const reopened = hydrateDocumentAssets(markdownToDocument(markdown), path);
    expect(reopened.content?.[0].attrs?.src).toBe(`asset:${assetPath}`);
    expect(reopened.content?.[0].attrs?.originalSrc).toMatch(/\.svg$/);
  });

  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
    ["image/avif", "avif"],
    ["image/bmp", "bmp"],
    ["image/tiff", "tiff"],
  ])(
    "retains the declared %s type when writing the companion asset",
    async (mime, extension) => {
      // Persistence must preserve the supplied bytes; decoding belongs to the
      // browser image loader rather than the Markdown save path.
      await saveEditorFile({
        path: "/notes/image.md",
        name: "image.md",
        document: {
          type: "doc",
          content: [
            { type: "image", attrs: { src: `data:${mime};base64,AAECAw==` } },
          ],
        },
      });
      const [assetPath, bytes] = mocks.writeFile.mock.calls[0];
      expect(assetPath).toMatch(new RegExp(`\\.${extension}$`));
      expect(bytes).toEqual(new Uint8Array([0, 1, 2, 3]));
      expect(mocks.writeTextFile.mock.calls[0][1]).toContain(`.${extension})`);
    },
  );
});
