import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TauriCore from "@tauri-apps/api/core";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  documentToPortableMarkdown,
  hydrateDocumentAssets,
  rebaseEditorFileAssets,
  saveEditorFile,
} from "./files";
import { markdownToDocument } from "../editor/markdown";
import { PaperImage } from "../editor/PaperImage";
import { sanitizePastedHtml } from "../editor/paste";

const mocks = vi.hoisted(() => ({ writeMarkdown: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset://${encodeURIComponent(path)}`,
  invoke: async (command: string, args?: { path: string; contents: string }) => {
    if (command === 'write_markdown_file') return mocks.writeMarkdown(args!.path, args!.contents);
  },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: async () => ({ get: async () => [], set: async () => undefined }),
  },
}));

describe("native image hydration", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [
      "/Users/example/images/研究%20one.svg#view",
      "/Users/example/images/研究 one.svg",
    ],
    [
      "file:///C:/notes/images/研究%20one.svg#view",
      "C:\\notes\\images\\研究 one.svg",
    ],
    ["C:/notes/images/研究%20one.svg#view", "C:\\notes\\images\\研究 one.svg"],
  ])(
    "hydrates absolute image %s in an unnamed draft while leaving relative images alone",
    (absolute, physicalPath) => {
      const original = markdownToDocument(
        `![Absolute](${absolute})\n\n![Relative](images/relative.svg)\n\n![Remote](https://example.com/remote.png)`,
      );
      const hydrated = hydrateDocumentAssets(original);
      expect(hydrated.content?.[0]?.attrs).toMatchObject({
        src: `asset://${encodeURIComponent(physicalPath)}#view`,
        originalSrc: absolute,
      });
      expect(hydrated.content?.[1]?.attrs).toMatchObject({
        src: "images/relative.svg",
      });
      expect(hydrated.content?.[1]?.attrs?.originalSrc).toBeUndefined();
      expect(hydrated.content?.[2]?.attrs?.src).toBe(
        "https://example.com/remote.png",
      );
      expect(documentToPortableMarkdown(hydrated)).not.toContain("asset:");
      expect(original.content?.[0]?.attrs?.src).toBe(absolute);
    },
  );

  it.each([
    [
      "/Users/example/notes/source.md",
      "/Users/example/exports/pasted.md",
      "/Users/example/final/copy.md",
      "/Users/example/notes/images/研究 %20#?.svg",
    ],
    [
      "C:\\notes\\source.md",
      "D:\\exports\\pasted.md",
      "E:\\final\\copy.md",
      "C:\\notes\\images\\研究 %20#?.svg",
    ],
  ])(
    "preserves the physical origin when a hydrated image from %s is copied into another document and saved",
    async (originPath, destinationPath, savePath, physicalPath) => {
      const markdown =
        '[![Diagram](images/研究%20%2520%23%3F.svg?size=2#view "papercanvas-size:240x120 | Figure title")](https://example.com/guide "Read the guide")';
      const hydrated = hydrateDocumentAssets(
        markdownToDocument(markdown),
        originPath,
      );
      const source = new Editor({
        extensions: [StarterKit, PaperImage],
        content: hydrated,
      });
      const destination = new Editor({
        extensions: [StarterKit, PaperImage],
        content: "<p>replace me</p>",
        editorProps: { transformPastedHTML: sanitizePastedHtml },
      });
      try {
        source.commands.selectAll();
        const clipboard = source.view.serializeForClipboard(
          source.state.selection.content(),
        );
        destination.commands.selectAll();
        destination.view.pasteHTML(
          clipboard.dom.innerHTML,
          new Event("paste") as ClipboardEvent,
        );
        const copiedImage = destination.getJSON().content?.[0];
        expect(copiedImage).toMatchObject({
          type: "image",
          attrs: {
            src: `asset://${encodeURIComponent(physicalPath)}?size=2#view`,
            alt: "Diagram",
            title: "Figure title",
            width: 240,
            height: 120,
            linkHref: "https://example.com/guide",
            linkTitle: "Read the guide",
          },
        });
        const rebased = rebaseEditorFileAssets(
          {
            path: destinationPath,
            name: "pasted.md",
            document: destination.getJSON(),
          },
          destinationPath,
          savePath,
        );
        const saved = await saveEditorFile(rebased);
        const portable = documentToPortableMarkdown(saved.document);
        expect(portable).not.toContain("asset:");
        expect(portable).toContain("?size=2#view");
        expect(mocks.writeMarkdown).toHaveBeenCalledWith(savePath, portable);
        const reopened = hydrateDocumentAssets(
          markdownToDocument(portable),
          savePath,
        );
        expect(reopened.content?.[0]?.attrs?.src).toBe(
          hydrated.content?.[0]?.attrs?.src,
        );
        expect(reopened.content?.[0]?.attrs?.originalSrc).not.toBe(
          "images/研究%20%2520%23%3F.svg?size=2#view",
        );
      } finally {
        source.destroy();
        destination.destroy();
      }
    },
  );

  it("renders the edge-demo parent-relative local image through a canonical native asset path", () => {
    const source = "![Local sample image](../papercanvas-sample-image.svg)";
    const hydrated = hydrateDocumentAssets(
      markdownToDocument(source),
      "/Users/example/test-fixtures/reading-demo/reading-edge-cases.md",
    );
    expect(hydrated.content?.[0]?.attrs).toMatchObject({
      originalSrc: "../papercanvas-sample-image.svg",
      src: `asset://${encodeURIComponent("/Users/example/test-fixtures/papercanvas-sample-image.svg")}`,
    });
    expect(documentToPortableMarkdown(hydrated)).toContain(
      "(../papercanvas-sample-image.svg)",
    );
  });

  it("keeps file URL fragments outside the converted filesystem path", () => {
    const source = "![View](images/Diagram%20one.svg#view)";
    const hydrated = hydrateDocumentAssets(
      markdownToDocument(source),
      "/Users/example/notes/reading.md",
    );
    expect(hydrated.content?.[0]?.attrs?.src).toBe(
      `asset://${encodeURIComponent("/Users/example/notes/images/Diagram one.svg")}#view`,
    );
    expect(documentToPortableMarkdown(hydrated)).toContain(
      "(images/Diagram%20one.svg#view)",
    );
  });
});
