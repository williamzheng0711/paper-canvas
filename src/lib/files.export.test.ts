import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMarkdownComment,
  parseMarkdownComments,
  serializeMarkdownWithComments,
} from "../editor/comments";
import { exportMarkdownFile } from "./files";

const mocks = vi.hoisted(() => ({
  save: vi.fn<() => Promise<string | null>>(),
  writeTextFile: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: mocks.save,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
  mkdir: vi.fn(),
  readTextFile: vi.fn(),
  rename: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile: mocks.writeTextFile,
}));

describe("Markdown export image paths", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.save.mockResolvedValue("/exports/copy.md");
    mocks.writeTextFile.mockResolvedValue(undefined);
  });

  it("keeps images at their original physical location when exporting to another folder", async () => {
    const source =
      '# Images\r\n\r\n![SVG](notes.assets/a%20b.svg)\r\n\r\n![Reference][diagram]\r\n\r\n[diagram]: images/ref.png "Title"\r\n\r\n<img src="images/html.png?x=1&amp;y=2">\r\n\r\n`![Literal](images/literal.png)`\r\n\r\n[Download](images/download.png)\r\n';
    await expect(
      exportMarkdownFile(source, "notes.md", "/notes/notes.md"),
    ).resolves.toBe("copy.md");
    const expected = source
      .replace("(notes.assets/", "(../notes/notes.assets/")
      .replace(": images/ref.png", ": ../notes/images/ref.png")
      .replace('src="images/html.png', 'src="../notes/images/html.png');
    expect(mocks.writeTextFile).toHaveBeenCalledWith(
      "/exports/copy.md",
      expected,
    );
  });

  it("retains comment anchors while rebasing exported image paths", async () => {
    const body = "![Diagram](notes.assets/a.svg)\n\nA commented sentence.\n";
    const from = body.indexOf("commented");
    const comment = createMarkdownComment(
      body,
      { kind: "range", from, to: from + "commented".length },
      "Keep this point.",
    );
    const source = serializeMarkdownWithComments(body, [comment]);
    await exportMarkdownFile(source, "notes.md", "/notes/notes.md");
    const written = mocks.writeTextFile.mock.calls[0]?.[1] as string;
    const parsed = parseMarkdownComments(written);
    expect(parsed.status).toBe("valid");
    expect(parsed.body).toContain("![Diagram](../notes/notes.assets/a.svg)");
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0].target).toEqual({
      kind: "range",
      from: parsed.body.indexOf("commented"),
      to: parsed.body.indexOf("commented") + "commented".length,
    });
    expect(parsed.comments[0].id).toBe(comment.id);
  });

  it.each(["/notes/notes.md", undefined])(
    "preserves exact source bytes for a same-folder or unnamed export (source=%s)",
    async (path) => {
      mocks.save.mockResolvedValue("/notes/copy.md");
      const source = "# Note\r\n\r\n![SVG](notes.assets/a.svg)\r\n";
      await exportMarkdownFile(source, "notes.md", path);
      expect(mocks.writeTextFile).toHaveBeenCalledWith(
        "/notes/copy.md",
        source,
      );
    },
  );

  it("does not write when the export dialog is cancelled", async () => {
    mocks.save.mockResolvedValue(null);
    await expect(
      exportMarkdownFile("![Image](a.png)\n", "notes.md", "/notes/notes.md"),
    ).resolves.toBeNull();
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });
});
