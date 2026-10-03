import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TauriCore from "@tauri-apps/api/core";
import { PaperImage } from "./PaperImage";
import { markdownToDocument } from "./markdown";
import { sanitizePastedHtml } from "./paste";
import {
  documentToPortableMarkdown,
  hydrateDocumentAssets,
  saveEditorFile,
} from "../lib/files";

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

function pasteImage(source: Editor, destination: Editor): void {
  source.commands.selectAll();
  const clipboard = source.view.serializeForClipboard(
    source.state.selection.content(),
  );
  destination.commands.selectAll();
  destination.view.pasteHTML(
    clipboard.dom.innerHTML,
    new Event("paste") as ClipboardEvent,
  );
}

function destination(getDocumentPath: () => string | undefined): Editor {
  return new Editor({
    extensions: [StarterKit, PaperImage.configure({ getDocumentPath })],
    content: "<p>replace me</p>",
    editorProps: { transformPastedHTML: sanitizePastedHtml },
  });
}

describe("portable local-image clipboard destinations", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [
      "/Users/example/notes/source.md",
      "/Users/example/notes/source.md",
      "images/%E7%A0%94%E7%A9%B6%20%2520%23%3F.svg?size=2#view",
    ],
    [
      "/Users/example/notes/source.md",
      "/Users/example/exports/pasted.md",
      "../notes/images/%E7%A0%94%E7%A9%B6%20%2520%23%3F.svg?size=2#view",
    ],
    [
      "C:\\notes\\source.md",
      "C:\\exports\\pasted.md",
      "../notes/images/%E7%A0%94%E7%A9%B6%20%2520%23%3F.svg?size=2#view",
    ],
    [
      "C:\\notes\\source.md",
      "D:\\exports\\pasted.md",
      "file:///C:/notes/images/%E7%A0%94%E7%A9%B6%20%2520%23%3F.svg?size=2#view",
    ],
  ])(
    "preserves the relative physical image when copied from %s into %s, switched, saved and reopened",
    async (originPath, documentPath, expectedSource) => {
      const hydrated = hydrateDocumentAssets(
        markdownToDocument(
          "![Diagram](images/研究%20%2520%23%3F.svg?size=2#view)",
        ),
        originPath,
      );
      const source = new Editor({
        extensions: [StarterKit, PaperImage],
        content: hydrated,
      });
      const pasted = destination(() => documentPath);
      try {
        pasteImage(source, pasted);
        const image = pasted
          .getJSON()
          .content?.find((node) => node.type === "image");
        expect(image?.attrs?.src).toBe(hydrated.content?.[0].attrs?.src);
        expect(image?.attrs?.originalSrc).toBe(expectedSource);

        // A source-mode switch serializes and hydrates the same destination.
        const markdown = documentToPortableMarkdown(pasted.getJSON());
        const switched = hydrateDocumentAssets(
          markdownToDocument(markdown),
          documentPath,
        );
        pasted.commands.setContent(switched);
        expect(pasted.getJSON().content?.[0].attrs?.src).toBe(
          hydrated.content?.[0].attrs?.src,
        );
        const saved = await saveEditorFile({
          path: documentPath,
          name: "pasted.md",
          document: pasted.getJSON(),
        });
        const portable = documentToPortableMarkdown(saved.document);
        expect(portable).toContain(expectedSource);
        expect(portable).not.toContain("asset:");
        expect(mocks.writeMarkdown).toHaveBeenCalledWith(
          documentPath,
          portable,
        );
        expect(
          hydrateDocumentAssets(markdownToDocument(portable), documentPath)
            .content?.[0].attrs?.src,
        ).toBe(hydrated.content?.[0].attrs?.src);
      } finally {
        source.destroy();
        pasted.destroy();
      }
    },
  );

  it("uses the current named document after its path changes without recreating the editor", () => {
    const hydrated = hydrateDocumentAssets(
      markdownToDocument("![Diagram](images/a.png)"),
      "/notes/source.md",
    );
    const source = new Editor({
      extensions: [StarterKit, PaperImage],
      content: hydrated,
    });
    let documentPath: string | undefined;
    const pasted = destination(() => documentPath);
    const next = destination(() => "/final/pasted.md");
    try {
      pasteImage(source, pasted);
      expect(pasted.getJSON().content?.[0].attrs?.originalSrc).toBe(
        "/notes/images/a.png",
      );
      documentPath = "/notes/pasted.md";
      pasteImage(source, pasted);
      expect(pasted.getJSON().content?.[0].attrs?.originalSrc).toBe(
        "images/a.png",
      );
      documentPath = "/exports/pasted.md";
      pasteImage(source, pasted);
      expect(pasted.getJSON().content?.[0].attrs?.originalSrc).toBe(
        "../notes/images/a.png",
      );
      // The second copy resolves the relative source against its destination,
      // rather than losing the physical origin after the first paste.
      pasteImage(pasted, next);
      expect(next.getJSON().content?.[0].attrs?.originalSrc).toBe(
        "../notes/images/a.png",
      );
      expect(next.getJSON().content?.[0].attrs?.src).toBe(
        hydrated.content?.[0].attrs?.src,
      );
      expect(pasted.commands.undo()).toBe(true);
      expect(pasted.commands.redo()).toBe(true);
      expect(pasted.getJSON().content?.[0].attrs?.src).toBe(
        hydrated.content?.[0].attrs?.src,
      );
    } finally {
      source.destroy();
      pasted.destroy();
      next.destroy();
    }
  });

  it.each([
    ['file:///tmp/Project%20%28100%25%29.assets/a.svg', '/tmp/Project (100%).assets/a.svg'],
    ['FILE:///tmp/images/a.svg', '/tmp/images/a.svg'],
    ['file://localhost/tmp/images/a.svg', '/tmp/images/a.svg'],
    ['file://server/share/Project%20%28100%25%29.assets/a.svg', '//server/share/Project (100%).assets/a.svg'],
  ])('pastes a raw local-file HTML image from %s into an unnamed document without losing it', (source, physicalPath) => {
    const pasted = destination(() => undefined);
    const before = pasted.getJSON();
    try {
      pasted.commands.selectAll();
      expect(pasted.view.pasteHTML(`<img src="${source}" alt="Final pasted image" width="240">`, new Event('paste') as ClipboardEvent)).toBe(true);
      const image = pasted.getJSON().content?.find((node) => node.type === 'image');
      expect(image).toMatchObject({ attrs: {
        src: `asset://${encodeURIComponent(physicalPath)}`, originalSrc: source, alt: 'Final pasted image', width: 240,
      } });
      expect(documentToPortableMarkdown(pasted.getJSON())).toContain(source);
      expect(pasted.commands.undo()).toBe(true);
      expect(pasted.getJSON()).toEqual(before);
      expect(pasted.commands.redo()).toBe(true);
      expect(pasted.getJSON().content?.find((node) => node.type === 'image')).toEqual(image);
    } finally { pasted.destroy(); }
  });
});
