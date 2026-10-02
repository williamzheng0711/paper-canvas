import { describe, expect, it, vi } from "vitest";
import type * as TauriCore from "@tauri-apps/api/core";
import { documentToPortableMarkdown, hydrateDocumentAssets } from "./files";
import { markdownToDocument } from "../editor/markdown";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset://${encodeURIComponent(path)}`,
}));

describe("native image hydration", () => {
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
