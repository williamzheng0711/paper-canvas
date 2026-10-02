import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMarkdownComment,
  serializeMarkdownWithComments,
} from "../editor/comments";
import { markdownToDocument } from "../editor/markdown";
import { openMarkdownFile } from "./files";

const harness = vi.hoisted(() => ({
  read: vi.fn(),
  load: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset://${encodeURIComponent(path)}`,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: harness.read,
  exists: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ Store: { load: harness.load } }));

describe("opening Markdown when history persistence fails", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    harness.load.mockResolvedValue({ get: async () => [], set: harness.set });
  });

  it.each(["load", "write"] as const)(
    "opens successfully after a history %s error, retaining source and comments",
    async (failure) => {
      const body = "# Research\n\nA selected phrase and $x^2$.\n";
      const from = body.indexOf("selected phrase");
      const comment = createMarkdownComment(
        body,
        { kind: "range", from, to: from + 15 },
        "Keep this note",
      );
      const sourceMarkdown = serializeMarkdownWithComments(body, [comment]);
      harness.read.mockResolvedValue(new TextEncoder().encode(sourceMarkdown));
      if (failure === "load")
        harness.load.mockRejectedValueOnce(new Error("Settings unavailable"));
      else harness.set.mockRejectedValueOnce(new Error("Settings unavailable"));
      const file = await openMarkdownFile("/tmp/Research.md");
      expect(file).toEqual(
        expect.objectContaining({
          path: "/tmp/Research.md",
          name: "Research.md",
          sourceMarkdown,
          document: markdownToDocument(body),
        }),
      );
      expect(file.comments).toEqual([
        expect.objectContaining({ id: comment.id, content: "Keep this note" }),
      ]);
    },
  );

  it("preserves the document read error before updating history", async () => {
    const failure = new Error("Read denied");
    harness.read.mockRejectedValueOnce(failure);
    await expect(openMarkdownFile("/tmp/Research.md")).rejects.toBe(failure);
    expect(harness.load).not.toHaveBeenCalled();
  });
});
