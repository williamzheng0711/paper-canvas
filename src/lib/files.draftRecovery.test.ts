import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMarkdownComment,
  serializeMarkdownWithComments,
} from "../editor/comments";
import { documentToMarkdown, markdownToDocument } from "../editor/markdown";
import { getMessages } from "../i18n";
import { loadDraft } from "./files";

const harness = vi.hoisted(() => ({
  native: false,
  draft: undefined as unknown,
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => harness.native,
  convertFileSrc: (path: string) => `asset://${encodeURIComponent(path)}`,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: { load: async () => ({ get: async () => harness.draft }) },
}));

describe.each([false, true])("draft recovery (native=%s)", (native) => {
  const store = (draft: unknown) => {
    harness.draft = draft;
    localStorage.setItem("unsavedDraft", JSON.stringify(draft));
  };

  beforeEach(() => {
    harness.native = native;
    harness.draft = undefined;
    localStorage.clear();
  });

  it("recovers exact source, formulas, and comments when the cached document is missing", async () => {
    const body = "# 研究\r\n\r\nUnderlined <u>note</u> and $x^2$.\r\n";
    const from = body.indexOf("note");
    const comment = createMarkdownComment(
      body,
      { kind: "range", from, to: from + 4 },
      "Recovered comment",
    );
    const sourceMarkdown = serializeMarkdownWithComments(body, [comment]);
    store({ name: "Recovered.md", sourceMarkdown });
    const draft = await loadDraft();
    expect(draft?.name).toBe("Recovered.md");
    expect(draft?.sourceMarkdown).toBe(sourceMarkdown);
    expect(draft?.document).toEqual(markdownToDocument(body));
    expect(draft?.comments).toEqual([
      expect.objectContaining({ id: comment.id, content: "Recovered comment" }),
    ]);
    expect(documentToMarkdown(draft!.document)).toContain("$x^2$");
  });

  it("recovers an empty source draft and defaults a missing filename", async () => {
    store({ sourceMarkdown: "", document: null });
    const draft = await loadDraft();
    expect(draft).toEqual(
      expect.objectContaining({
        name: getMessages().untitledFilename,
        sourceMarkdown: "",
        document: markdownToDocument(""),
      }),
    );
  });

  it("retains a valid cached document with embedded images", async () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "data:image/png;base64,AA==", width: 120 },
        },
      ],
    };
    store({ name: "Image.md", document });
    expect(await loadDraft()).toEqual({ name: "Image.md", document });
  });

  it.each([null, "legacy", [], { name: "Broken.md" }])(
    "ignores a recovery record with no recoverable content: %j",
    async (value) => {
      store(value);
      expect(await loadDraft()).toBeNull();
    },
  );
});
