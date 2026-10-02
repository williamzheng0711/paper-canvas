import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSchema } from "@tiptap/core";
import { canvasNodesAndMarks } from "../editor/canvasSchema";
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
  invoke: vi.fn(async () => undefined),
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

  it.each([
    { type: "doc", content: "damaged" },
    { type: "doc", content: [{ type: "paragraph", content: [null] }] },
    { type: "doc", content: [{ type: "unknownFutureNode" }] },
    { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "stale cache" }] }] },
  ])("rebuilds from exact source when a document cache is corrupt or stale: %j", async (document) => {
    const sourceMarkdown = "# Exact recovery\r\n\r\nA *complete* draft.\r\n";
    store({ name: "Recovered.md", document, sourceMarkdown, comments: { corrupt: true } });
    const draft = await loadDraft();
    expect(draft?.sourceMarkdown).toBe(sourceMarkdown);
    expect(draft?.document).toEqual(markdownToDocument(sourceMarkdown));
    expect(draft?.comments).toEqual([]);
  });

  it("never adopts a stored path when restoring an unsaved source draft", async () => {
    const sourceMarkdown = "Recover without overwriting an earlier file.\n";
    store({ name: "Recovered.md", path: "/notes/earlier.md", sourceMarkdown });
    expect((await loadDraft())?.path).toBeUndefined();
  });

  it("restores a canvas-only cache accepted by the exact production schema", async () => {
    const document = markdownToDocument("# Recovery\n\nA **bold** $x^2$ paragraph.\n\n- [x] Done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nFootnote[^note].\n\n[^note]: Saved note.\n");
    store({ name: "Canvas.md", document });
    const draft = await loadDraft();
    expect(draft?.document).toEqual(document);
    const node = getSchema(canvasNodesAndMarks()).nodeFromJSON(draft!.document);
    expect(() => node.check()).not.toThrow();
  });

  it("returns normalized comment offsets from a canvas-only recovery cache", async () => {
    const body = "Recovered canvas text.\n";
    const comment = createMarkdownComment(body, { kind: "range", from: 0, to: body.length }, "Recovered note");
    store({ name: "Canvas.md", document: markdownToDocument(body), comments: [{ ...comment, target: { kind: "range", from: -99, to: 99999 } }] });
    const draft = await loadDraft();
    expect(draft?.comments?.[0].target).toEqual({ kind: "range", from: 0, to: body.length });
  });

  it.each([null, {}, [null], [{ id: "damaged", content: "Original comment text" }]].map((comments) => ({ comments })))("recovers canvas writing when supplementary comments are damaged: %j", async ({ comments }) => {
    const document = markdownToDocument("Recoverable canvas writing.\n");
    const original = { name: "Canvas.md", document, comments };
    store(original);
    const serialized = localStorage.getItem("unsavedDraft");
    const draft = await loadDraft();
    expect(draft).toEqual({ name: "Canvas.md", document, comments: [], commentWarning: getMessages().commentDataWarning });
    expect(harness.draft).toEqual(original);
    expect(localStorage.getItem("unsavedDraft")).toBe(serialized);
  });

  it.each([{ sourceMarkdown: 123 }, { sourceMarkdown: {} }, { commentWarning: {} }, { name: "   " }])("strips malformed supplementary fields from a valid canvas draft: %j", async (fields) => {
    const document = markdownToDocument("Recoverable canvas writing.\n");
    store({ name: "Canvas.md", document, ...fields });
    const draft = await loadDraft();
    expect(draft?.document).toEqual(document);
    expect(draft?.sourceMarkdown).toBeUndefined();
    expect(draft?.commentWarning).toBeUndefined();
    expect(draft?.name).toBe(fields.name === "   " ? getMessages().untitledFilename : "Canvas.md");
  });

  it.each([
    null, "legacy", [], { name: "Broken.md" },
    { document: { type: "doc", content: "damaged" } },
    { document: { type: "doc", content: [{ type: "paragraph", content: [null] }] } },
    { document: { type: "doc", content: [{ type: "unknownFutureNode" }] } },
    { document: { type: "doc", content: [{ type: "paragraph", attrs: [], content: [{ type: "text", text: "Lost" }] }] } },
    { document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "table", content: [] }] }] } },
    { document: { type: "doc", content: [{ type: "text", text: "Wrong position" }] } },
    { document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "", marks: [] }] }] } },
    { document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Invalid mark", marks: [{ type: "unknownFutureMark" }] }] }] } },
    { document: { type: "doc", content: [{ type: "codeBlock", attrs: { language: {} }, content: [{ type: "text", text: "Retained original code" }] }] } },
    { document: { type: "doc", content: [{ type: "codeBlock", attrs: { language: 123 }, content: [{ type: "text", text: "Retained original code" }] }] } },
    { document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Retained original link", marks: [{ type: "link", attrs: { href: {} } }] }] }] } },
    { document: { type: "doc", content: [{ type: "heading", attrs: { level: 7 }, content: [{ type: "text", text: "Retained original heading" }] }] } },
    { document: { type: "doc", content: [{ type: "heading", attrs: { level: 1.5 }, content: [{ type: "text", text: "Retained original heading" }] }] } },
    { document: { type: "doc", content: [{ type: "heading", attrs: { level: {} }, content: [{ type: "text", text: "Retained original heading" }] }] } },
  ])(
    "reports a damaged recovery record while keeping its original data: %j",
    async (value) => {
      store(value);
      if (value === null) await expect(loadDraft()).resolves.toBeNull();
      else await expect(loadDraft()).rejects.toThrow(getMessages().draftRecoveryFailed);
      expect(harness.draft).toBe(value);
      expect(localStorage.getItem("unsavedDraft")).toBe(JSON.stringify(value));
    },
  );

  it.each([
    { colspan: 1000000000 }, { colspan: 0 }, { colspan: 1.5 }, { colspan: "2" },
    { rowspan: -1 }, { rowspan: 1000000000 }, { colwidth: {} }, { colwidth: "damaged" }, { colwidth: [-1] }, { colwidth: ["80"] },
  ])("rejects corrupt table attributes before serializing a recovery cache: %j", async (attrs) => {
    const document = markdownToDocument("| A | B |\n| - | - |\n| 1 | 2 |\n");
    document.content![0].content![0].content![0].attrs = attrs;
    const original = { name: "Table.md", document };
    store(original);
    await expect(loadDraft()).rejects.toThrow(getMessages().draftRecoveryFailed);
    expect(harness.draft).toBe(original);
    expect(localStorage.getItem("unsavedDraft")).toBe(JSON.stringify(original));
  });
});

it("reports malformed browser recovery JSON without deleting its original bytes", async () => {
  harness.native = false;
  localStorage.setItem("unsavedDraft", '{"sourceMarkdown":"unfinished');
  await expect(loadDraft()).rejects.toThrow(getMessages().draftRecoveryFailed);
  expect(localStorage.getItem("unsavedDraft")).toBe('{"sourceMarkdown":"unfinished');
});
