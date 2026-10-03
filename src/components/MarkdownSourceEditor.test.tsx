import { act, createRef } from "react";
import {
  indentLess,
  indentMore,
  deleteTrailingWhitespace,
  isolateHistory,
  redo,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SwitchableEditorHandle } from "../editor/search";
import { MarkdownSourceEditor } from "./MarkdownSourceEditor";
import * as documentSearch from "../editor/search";
import {
  maximumHighlightedSourceCharacters,
  maximumHighlightedSourceLineLength,
} from "../editor/sourceSyntax";
import {
  imagePathSourceChanges,
  rebaseMarkdownImageAssets,
  renameMarkdownImageAssets,
} from "../editor/markdownAssetReferences";

describe("MarkdownSourceEditor search", () => {
  let host: HTMLDivElement;
  let root: Root;
  const rangeGeometry = ["getClientRects", "getBoundingClientRect"].map(
    (name) => ({
      name,
      descriptor: Object.getOwnPropertyDescriptor(Range.prototype, name),
    }),
  );

  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    // JSDOM has no text layout. CodeMirror may measure in an animation frame
    // while these tests exercise source transactions and selection offsets.
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
  });
  afterAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
    for (const { name, descriptor } of rangeGeometry) {
      if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
      else Reflect.deleteProperty(Range.prototype, name);
    }
  });

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it.each(["\n", "\r\n", "\r\n\r"])("rebases deleted image history after Save As with %j separators", async (ending) => {
    const oldPath = "/notes/research.md";
    const newPath = "/exports/copy.md";
    const removed = "![Deleted](images/a.png)";
    const initial = `${removed}${ending}![Kept](images/b.png)${ending}Body`;
    let value = initial;
    const onChange = (next: string) => { value = next; };
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={initial} valueRevision={0} assetSourcePath={oldPath} onChange={onChange} />));
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    editor.dispatch({ changes: { from: 0, to: removed.length }, annotations: isolateHistory.of("full") });
    const deleted = value;
    const saved = rebaseMarkdownImageAssets(deleted, oldPath, newPath);
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={saved} valueRevision={1} assetSourcePath={newPath} externalChanges={imagePathSourceChanges(deleted, saved, oldPath, newPath)} onChange={onChange} />));
    expect(undo(editor)).toBe(true);
    expect(value).toBe(rebaseMarkdownImageAssets(initial, oldPath, newPath));
    expect(value).not.toContain("../../notes");
    expect(redo(editor)).toBe(true);
    expect(value).toBe(saved);
    expect(undo(editor)).toBe(true);
    expect(value).toBe(rebaseMarkdownImageAssets(initial, oldPath, newPath));
    expect(redo(editor)).toBe(true);
    editor.dispatch({ changes: { from: editor.state.doc.length, insert: " after" }, annotations: isolateHistory.of("full") });
    expect(value).toBe(saved + " after");
    expect(undo(editor)).toBe(true);
    expect(value).toBe(saved);
    expect(redo(editor)).toBe(true);
    expect(value).toBe(saved + " after");
  });

  it("keeps deleted image undo when Save As changes only its asset origin", async () => {
    const initial = "![Image](images/a.png)\nBody";
    let value = initial;
    const onChange = vi.fn((next: string) => { value = next; });
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={initial} valueRevision={0} assetSourcePath="/notes/research.md" onChange={onChange} />));
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    editor.dispatch({ changes: { from: 0, to: initial.indexOf("\n") } });
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={value} valueRevision={0} assetSourcePath="/exports/copy.md" onChange={onChange} />));
    onChange.mockClear();
    expect(undo(editor)).toBe(true);
    expect(value).toBe("![Image](../notes/images/a.png)\nBody");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(redo(editor)).toBe(true);
    expect(value).toBe("\nBody");
  });

  it("retains document and undo when restoring an image exceeds the path rewrite budget", async () => {
    const image = "![Image](images/a.png)";
    const initial = image + "\n" + "x".repeat(250_000);
    let value = initial;
    const onError = vi.fn();
    const onChange = (next: string) => { value = next; };
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={initial} valueRevision={0} assetSourcePath="/notes/research.md" onError={onError} onChange={onChange} />));
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    editor.dispatch({ changes: { from: 0, to: image.length } });
    const deleted = value;
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={deleted} valueRevision={0} assetSourcePath="/exports/copy.md" onError={onError} onChange={onChange} />));
    expect(undo(editor)).toBe(true);
    expect(value).toBe(deleted);
    expect(editor.state.doc.toString()).toBe(deleted);
    expect(undoDepth(editor.state)).toBe(1);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("keeps old and new image origins in separate history groups around Save As", async () => {
    const oldImage = "![Old](images/old.png)";
    let value = oldImage + "\nBody";
    const onChange = (next: string) => { value = next; };
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={value} valueRevision={0} assetSourcePath="/notes/research.md" onChange={onChange} />));
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    editor.dispatch({ changes: { from: 0, to: oldImage.length }, userEvent: "delete" });
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={value} valueRevision={0} assetSourcePath="/exports/copy.md" onChange={onChange} />));
    editor.dispatch({ changes: { from: 0, insert: "![New](images/new.png)" }, userEvent: "input.type" });
    expect(undo(editor)).toBe(true);
    expect(value).toBe("\nBody");
    expect(undo(editor)).toBe(true);
    expect(value).toBe("![Old](../notes/images/old.png)\nBody");
    expect(redo(editor)).toBe(true);
    expect(redo(editor)).toBe(true);
    expect(value).toBe("![New](images/new.png)\nBody");
  });

  it("maps a deleted image through rename and successive Save As transitions", async () => {
    const initial = "![Image](./research.assets/a.svg)\r\nBody";
    let value = initial;
    const onChange = (next: string) => { value = next; };
    const render = (path: string, operation: "rebase" | "rename" = "rebase") => root.render(<MarkdownSourceEditor language="en" value={value} valueRevision={0} assetSourcePath={path} assetSourceOperation={operation} onChange={onChange} />);
    await act(async () => render("/notes/research.md"));
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    editor.dispatch({ changes: { from: 0, to: initial.indexOf("\r") } });
    await act(async () => render("/notes/renamed.md", "rename"));
    await act(async () => render("/exports/copy.md"));
    await act(async () => render("/archive/final.md"));
    const expected = rebaseMarkdownImageAssets(rebaseMarkdownImageAssets(renameMarkdownImageAssets(initial, "/notes/research.md", "/notes/renamed.md"), "/notes/renamed.md", "/exports/copy.md"), "/exports/copy.md", "/archive/final.md");
    expect(undo(editor)).toBe(true);
    expect(value).toBe(expected);
    expect(redo(editor)).toBe(true);
    expect(value).toBe("\r\nBody");
    expect(undo(editor)).toBe(true);
    expect(value).toBe(expected);
  });

  it.each(["/notes/research.md", "/notes/renamed.md"])("restores moved companion assets when rename recovery leaves %s", async (survivingPath) => {
    const initial = "![Image](research.assets/a.svg)\r\nBody";
    let value = initial;
    const onChange = (next: string) => { value = next; };
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={value} valueRevision={0} assetSourcePath="/notes/research.md" onChange={onChange} />));
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    editor.dispatch({ changes: { from: 0, to: initial.indexOf("\r") } });
    const transition = { oldPath: "/notes/research.md", newPath: "/notes/renamed.md", operation: "rename" as const };
    const renderRecovery = () => root.render(<MarkdownSourceEditor language="en" value={value} valueRevision={0} assetSourcePath={survivingPath} assetSourceOperation="rename" assetSourceTransition={transition} onChange={onChange} />);
    await act(async () => renderRecovery());
    await act(async () => renderRecovery());
    expect(undo(editor)).toBe(true);
    expect(value).toBe("![Image](renamed.assets/a.svg)\r\nBody");
    expect(redo(editor)).toBe(true);
    expect(value).toBe("\r\nBody");
    await act(async () => root.render(<MarkdownSourceEditor language="en" value={value} valueRevision={0} assetSourcePath={survivingPath} onChange={onChange} />));
    expect(undo(editor)).toBe(true);
    expect(value).toBe("![Image](renamed.assets/a.svg)\r\nBody");
  });

  it.each(["A\r \nB", "First\nA\r \nB", "First\r\nA\r \nB"])(
    "preserves two line breaks when deleting between separate CR and LF in %j",
    async (before) => {
      let value = before;
      await act(async () => root.render(
        <MarkdownSourceEditor language="en" value={before} valueRevision={0} onChange={(next) => { value = next; }} />,
      ));
      const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
      const from = editor.state.doc.toString().indexOf(" ");
      editor.dispatch({ changes: { from, to: from + 1 } });
      const after = before.replace("\r \n", "\r\r\n");
      expect(value).toBe(after);
      expect(editor.state.doc.toString()).toBe(after.replace(/\r\n?/g, "\n"));
      expect(undo(editor)).toBe(true);
      expect(value).toBe(before);
      expect(redo(editor)).toBe(true);
      expect(value).toBe(after);
    },
  );

  it("retains blank lines through whitespace cleanup and its undo and redo", async () => {
    const before = "A\r \nB";
    let value = before;
    await act(async () => root.render(
      <MarkdownSourceEditor language="en" value={before} valueRevision={0} onChange={(next) => { value = next; }} />,
    ));
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    expect(deleteTrailingWhitespace(editor)).toBe(true);
    expect(value).toBe("A\r\r\nB");
    expect(editor.state.doc.toString()).toBe("A\n\nB");
    expect(undo(editor)).toBe(true);
    expect(value).toBe(before);
    expect(redo(editor)).toBe(true);
    expect(value).toBe("A\r\r\nB");
  });

  it.each(["![Image](images/a.png)\nA\r \nB", "A\r \nB\n![Image](images/a.png)"])(
    "maps adjacent separator repairs through an external image rebase for %j",
    async (before) => {
      const onChange = vi.fn();
      const render = (value: string, revision: number, previous?: string) => root.render(
        <MarkdownSourceEditor language="en" value={value} valueRevision={revision}
          externalChanges={previous ? imagePathSourceChanges(previous, value, "/notes/research.md", "/exports/copy.md") : undefined}
          onChange={onChange} />,
      );
      await act(async () => render(before, 0));
      const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
      const from = editor.state.doc.toString().indexOf(" ");
      editor.dispatch({ changes: { from, to: from + 1 } });
      const edited = before.replace("\r \n", "\r\r\n");
      expect(onChange).toHaveBeenLastCalledWith(edited);
      const rebased = rebaseMarkdownImageAssets(edited, "/notes/research.md", "/exports/copy.md");
      await act(async () => render(rebased, 1, edited));
      expect(undo(editor)).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(rebaseMarkdownImageAssets(before, "/notes/research.md", "/exports/copy.md"));
      expect(redo(editor)).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(rebased);
    },
  );

  it("retains exact mixed separators and native undo/redo while its source pane is hidden", async () => {
    const original = "# Original\r\n\r\nBody\nEnd\r";
    let value = original;
    const onChange = vi.fn((next: string) => {
      value = next;
    });
    const render = (visible: boolean, revision: number, session = 1) =>
      root.render(
        <div hidden={!visible}>
          <MarkdownSourceEditor
            key={session}
            language="en"
            value={value}
            valueRevision={revision}
            onChange={onChange}
          />
        </div>,
      );
    await act(async () => render(true, 0));
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    await act(async () =>
      editor.dispatch({
        changes: { from: 2, to: 10, insert: "Edited" },
        annotations: isolateHistory.of("full"),
      }),
    );
    const first = value;
    const text = editor.state.doc.toString();
    await act(async () =>
      editor.dispatch({
        changes: {
          from: text.indexOf("Body"),
          to: text.indexOf("End") + 3,
          insert: "中文\nNext",
        },
        annotations: isolateHistory.of("full"),
      }),
    );
    const second = value;
    expect(second).toBe("# Edited\r\n\r\n中文\r\nNext\r");
    for (let revision = 1; revision <= 3; revision += 1) {
      await act(async () => render(false, revision));
      await act(async () => render(true, revision));
      expect(EditorView.findFromDOM(host.querySelector(".cm-editor")!)).toBe(
        editor,
      );
      expect(value).toBe(second);
    }
    await act(async () => {
      expect(undo(editor)).toBe(true);
    });
    expect(value).toBe(first);
    await act(async () => {
      expect(undo(editor)).toBe(true);
    });
    expect(value).toBe(original);
    await act(async () => {
      expect(redo(editor)).toBe(true);
    });
    expect(value).toBe(first);
    await act(async () => {
      expect(redo(editor)).toBe(true);
    });
    expect(value).toBe(second);

    value = "# Another file\r\n";
    await act(async () => render(true, 4, 2));
    const replacement = EditorView.findFromDOM(
      host.querySelector(".cm-editor")!,
    )!;
    expect(replacement).not.toBe(editor);
    expect(undo(replacement)).toBe(false);
    expect(value).toBe("# Another file\r\n");
  });

  it("clears stale source undo and separator effects when a canvas snapshot replaces the text", async () => {
    let value = "A\nB\r\nC\n";
    const onChange = vi.fn((next: string) => {
      value = next;
    });
    const render = (revision: number) =>
      root.render(
        <MarkdownSourceEditor
          language="zh-Hant"
          value={value}
          valueRevision={revision}
          onChange={onChange}
        />,
      );
    await act(async () => render(0));
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    await act(async () => editor.dispatch({ changes: { from: 3, to: 4 } }));
    expect(value).toBe("A\nBC\n");
    const emitted = onChange.mock.calls.length;
    value = "\nnew\n";
    await act(async () => render(1));
    expect(EditorView.findFromDOM(host.querySelector(".cm-editor")!)).toBe(
      editor,
    );
    expect(onChange).toHaveBeenCalledTimes(emitted);
    expect(undo(editor)).toBe(false);
    expect(editor.contentDOM.getAttribute("aria-label")).toBe("原始 Markdown");
    await act(async () => editor.dispatch({ changes: { from: 0, to: 1 } }));
    expect(value).toBe("new\n");
    await act(async () => {
      expect(undo(editor)).toBe(true);
    });
    expect(value).toBe("\nnew\n");
  });

  it.each(["long line", "total length"] as const)(
    "bounds source parsing for %s in the original edit and restores highlighting through undo",
    async (limit) => {
      const original = "# Header\r\n\r\n**bold**\nTail\r";
      let value = original;
      const onChange = vi.fn((next: string) => {
        value = next;
      });
      await act(async () =>
        root.render(
          <MarkdownSourceEditor
            language="en"
            value={value}
            valueRevision={0}
            onChange={onChange}
          />,
        ),
      );
      const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
      expect(syntaxTree(editor.state).length).toBeGreaterThan(0);
      const from = editor.state.doc.line(3).from;
      const inserted =
        limit === "long line"
          ? "x".repeat(maximumHighlightedSourceLineLength + 1)
          : ("x".repeat(500) + "\n").repeat(
              Math.ceil(maximumHighlightedSourceCharacters / 501),
            );
      await act(async () => {
        editor.dispatch({ selection: { anchor: from } });
        editor.dispatch({
          changes: { from, insert: inserted },
          selection: { anchor: from + inserted.length },
          annotations: isolateHistory.of("full"),
        });
      });
      expect(syntaxTree(editor.state).length).toBe(0);
      expect(editor.state.selection.main.head).toBe(from + inserted.length);
      const rawInserted = inserted.replaceAll("\n", "\r\n");
      const changed = "# Header\r\n\r\n" + rawInserted + "**bold**\nTail\r";
      expect(value).toBe(changed);
      await act(async () => {
        expect(undo(editor)).toBe(true);
      });
      expect(value).toBe(original);
      expect(editor.state.selection.main.head).toBe(from);
      expect(syntaxTree(editor.state).length).toBeGreaterThan(0);
      await act(async () => {
        expect(redo(editor)).toBe(true);
      });
      expect(value).toBe(changed);
      expect(syntaxTree(editor.state).length).toBe(0);
      expect(EditorView.findFromDOM(host.querySelector(".cm-editor")!)).toBe(
        editor,
      );
    },
  );

  it("initializes a huge flat HTML source without token DOM expansion and keeps its exact raw bytes undoable", async () => {
    const original = "# Header\r\n<div>" + "<br>".repeat(40_000) + "</div>\r\n";
    let value = original;
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={value}
          valueRevision={0}
          onChange={(next) => {
            value = next;
          }}
        />,
      ),
    );
    const editor = EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
    expect(syntaxTree(editor.state).length).toBe(0);
    expect(host.querySelectorAll(".cm-content span").length).toBeLessThan(10);
    await act(async () =>
      editor.dispatch({ changes: { from: 1, insert: "z" } }),
    );
    expect(value).toBe(original.slice(0, 1) + "z" + original.slice(1));
    await act(async () => {
      expect(undo(editor)).toBe(true);
    });
    expect(value).toBe(original);
    await act(async () => {
      expect(redo(editor)).toBe(true);
    });
    expect(value).toBe(original.slice(0, 1) + "z" + original.slice(1));
  });

  it("highlights, selects, navigates, clears, and restores focus", async () => {
    const search = createRef<SwitchableEditorHandle>();
    await act(async () => {
      root.render(
        <MarkdownSourceEditor
          ref={search}
          language="en"
          value={"# Alpha\n\nalpha and ALPHA"}
          valueRevision={0}
          onChange={vi.fn()}
        />,
      );
    });

    expect(search.current?.search("alpha", "reset")).toEqual({
      current: 1,
      total: 3,
    });
    expect(search.current?.getSelectedText()).toBe("Alpha");
    expect(host.querySelectorAll(".cm-document-search-match")).toHaveLength(3);
    expect(
      host.querySelectorAll(".cm-document-search-match--active"),
    ).toHaveLength(1);
    expect(search.current?.search("alpha", "next")).toEqual({
      current: 2,
      total: 3,
    });
    expect(search.current?.search("alpha", "previous")).toEqual({
      current: 1,
      total: 3,
    });

    search.current?.setMarkdownOffset?.(10);
    expect(search.current?.search("alpha", "refresh")).toEqual({
      current: 2,
      total: 3,
    });
    expect(search.current?.getMarkdownOffset?.()).toBe(10);
    expect(search.current?.getSelectedText()).toBe("");

    search.current?.clearSearch();
    expect(host.querySelectorAll(".cm-document-search-match")).toHaveLength(0);
    expect(search.current?.setMarkdownOffset?.(17)).toBe(true);
    expect(search.current?.getMarkdownOffset?.()).toBe(17);
    search.current?.focus();
    expect(document.activeElement).toBe(host.querySelector(".cm-content"));
  });

  it("applies revision-only replacements after the user has edited the source", async () => {
    const render = (valueRevision: number) =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value="Original document"
          valueRevision={valueRevision}
          onChange={vi.fn()}
        />,
      );
    await act(async () => render(0));
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: "Locally edited document",
      },
    });

    await act(async () => render(1));

    expect(editor.state.doc.toString()).toBe("Original document");
  });

  it("does not let undo restore a different externally opened document", async () => {
    const render = (value: string, valueRevision: number) =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={value}
          valueRevision={valueRevision}
          onChange={vi.fn()}
        />,
      );
    await act(async () => render("First document", 0));
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    editor.dispatch({
      changes: { from: editor.state.doc.length, insert: " local edits" },
    });

    await act(async () => render("Second document", 1));
    undo(editor);

    expect(editor.state.doc.toString()).toBe("Second document");
  });

  it.each(["KEEP BETWEEN", "After several URLs"])(
    "keeps the source selection on %s when Save As rebases multiple image destinations",
    async (label) => {
      const before =
        "![First](images/a.png) KEEP BETWEEN ![Second](images/b.png)\n\n![Reference][image]\n\n[image]: images/reference.png\n\nAfter several URLs stays readable.\n";
      const after = rebaseMarkdownImageAssets(
        before,
        "/notes/research.md",
        "/exports/copy.md",
      );
      const onChange = vi.fn();
      await act(async () =>
        root.render(
          <MarkdownSourceEditor
            language="en"
            value={before}
            valueRevision={0}
            onChange={onChange}
          />,
        ),
      );
      const editor = EditorView.findFromDOM(
        host.querySelector<HTMLElement>(".cm-editor")!,
      )!;
      editor.dispatch({
        selection: {
          anchor: before.indexOf(label),
          head: before.indexOf(label) + label.length,
        },
      });
      await act(async () =>
        root.render(
          <MarkdownSourceEditor
            language="en"
            value={after}
            valueRevision={1}
            externalChanges={imagePathSourceChanges(
              before,
              after,
              "/notes/research.md",
              "/exports/copy.md",
            )}
            onChange={onChange}
          />,
        ),
      );
      expect(editor.state.doc.toString()).toBe(after);
      expect(editor.state.selection.main.anchor).toBe(after.indexOf(label));
      expect(editor.state.selection.main.head).toBe(
        after.indexOf(label) + label.length,
      );
      expect(
        editor.state.sliceDoc(
          editor.state.selection.main.from,
          editor.state.selection.main.to,
        ),
      ).toBe(label);
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("keeps user typing undoable without undoing an external image path rebase", async () => {
    const before = "![Image](images/a.png)\n\nText";
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={before}
          valueRevision={0}
          onChange={vi.fn()}
        />,
      ),
    );
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    editor.dispatch({ changes: { from: before.length, insert: " typed" } });
    const edited = editor.state.doc.toString();
    const after = rebaseMarkdownImageAssets(
      edited,
      "/notes/research.md",
      "/exports/copy.md",
    );
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={after}
          valueRevision={1}
          externalChanges={imagePathSourceChanges(
            edited,
            after,
            "/notes/research.md",
            "/exports/copy.md",
          )}
          onChange={vi.fn()}
        />,
      ),
    );
    undo(editor);
    expect(editor.state.doc.toString()).toBe(
      "![Image](../notes/images/a.png)\n\nText",
    );
  });

  it("falls back to the full external value if its supplied changes do not reproduce it", async () => {
    const before = "Original text";
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={before}
          valueRevision={0}
          onChange={vi.fn()}
        />,
      ),
    );
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value="Replacement text"
          valueRevision={1}
          externalChanges={{
            previousValue: before,
            changes: [{ from: 0, to: 1, value: "Incomplete" }],
          }}
          onChange={vi.fn()}
        />,
      ),
    );
    expect(editor.state.doc.toString()).toBe("Replacement text");
  });

  it("maps clean CRLF offsets and selections through exact external image edits", async () => {
    const before =
      "# Reading\r\n\r\n![First](images/a.png) KEEP BETWEEN ![Second](images/b.png)\r\n\r\nAfter several URLs stays readable.\r\nLone CR follows.\rFinal line";
    const after = rebaseMarkdownImageAssets(
      before,
      "/notes/research.md",
      "/exports/copy.md",
    );
    const normalize = (value: string) => value.replace(/\r\n?/g, "\n");
    const handle = createRef<SwitchableEditorHandle>();
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          ref={handle}
          language="en"
          value={before}
          valueRevision={0}
          onChange={onChange}
        />,
      ),
    );
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    expect(editor.state.doc.toString()).toBe(normalize(before));
    for (const label of ["KEEP BETWEEN", "After several URLs", "Final line"]) {
      const offset = before.indexOf(label) + 3;
      expect(handle.current?.setMarkdownOffset?.(offset)).toBe(true);
      expect(editor.state.selection.main.head).toBe(
        normalize(before).indexOf(label) + 3,
      );
      expect(handle.current?.getMarkdownOffset?.()).toBe(offset);
    }
    const label = "KEEP BETWEEN";
    expect(
      handle.current?.setMarkdownSelection?.({
        from: before.indexOf(label),
        to: before.indexOf(label) + label.length,
      }),
    ).toBe(true);
    expect(handle.current?.getSelectedText()).toBe(label);
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          ref={handle}
          language="en"
          value={after}
          valueRevision={1}
          externalChanges={imagePathSourceChanges(
            before,
            after,
            "/notes/research.md",
            "/exports/copy.md",
          )}
          onChange={onChange}
        />,
      ),
    );
    expect(editor.state.doc.toString()).toBe(normalize(after));
    expect(editor.state.selection.main.anchor).toBe(
      normalize(after).indexOf(label),
    );
    expect(handle.current?.getSelectedText()).toBe(label);
    expect(handle.current?.getMarkdownOffset?.()).toBe(
      after.indexOf(label) + label.length,
    );
    expect(onChange).not.toHaveBeenCalled();
    editor.dispatch({
      changes: { from: editor.state.doc.length, insert: " typed" },
    });
    expect(onChange).toHaveBeenLastCalledWith(after + " typed");
    expect(handle.current?.getMarkdownOffset?.()).toBe(
      after.indexOf(label) + label.length,
    );
  });

  it("preserves untouched mixed line endings through actual source edits, undo and redo", async () => {
    const before = "First\r\nSecond\nThird\rLast";
    const onChange = vi.fn();
    const handle = createRef<SwitchableEditorHandle>();
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          ref={handle}
          language="en"
          value={before}
          valueRevision={0}
          onChange={onChange}
        />,
      ),
    );
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    const from = editor.state.doc.toString().indexOf("Second");
    editor.dispatch({
      changes: {
        from,
        to: from + "Second".length,
        insert: "Changed\nInserted",
      },
    });
    const edited = "First\r\nChanged\r\nInserted\nThird\rLast";
    expect(onChange).toHaveBeenLastCalledWith(edited);
    handle.current?.setMarkdownOffset?.(edited.indexOf("Last") + 2);
    expect(handle.current?.getMarkdownOffset?.()).toBe(
      edited.indexOf("Last") + 2,
    );
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(before);
    expect(redo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(edited);
  });

  it("maps external image edits and later undo to raw CRLF bytes after local typing", async () => {
    const before = "![Image](images/a.png)\r\n\r\nText\nLast\r";
    const onChange = vi.fn();
    const handle = createRef<SwitchableEditorHandle>();
    const render = (value: string, valueRevision: number, previous?: string) =>
      root.render(
        <MarkdownSourceEditor
          ref={handle}
          language="en"
          value={value}
          valueRevision={valueRevision}
          externalChanges={
            previous
              ? imagePathSourceChanges(
                  previous,
                  value,
                  "/notes/research.md",
                  "/exports/copy.md",
                )
              : undefined
          }
          onChange={onChange}
        />,
      );
    await act(async () => render(before, 0));
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    editor.dispatch({
      changes: { from: editor.state.doc.length, insert: " typed" },
    });
    const edited = before + " typed";
    expect(onChange).toHaveBeenLastCalledWith(edited);
    const after = rebaseMarkdownImageAssets(
      edited,
      "/notes/research.md",
      "/exports/copy.md",
    );
    handle.current?.setMarkdownSelection?.({
      from: edited.indexOf("Last"),
      to: edited.indexOf("Last") + 4,
    });
    await act(async () => render(after, 1, edited));
    expect(handle.current?.getSelectedText()).toBe("Last");
    expect(handle.current?.getMarkdownOffset?.()).toBe(
      after.indexOf("Last") + 4,
    );
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(after.slice(0, -" typed".length));
    expect(redo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(after);
  });

  it.each(["\r\n", "\n", "\r"])(
    "applies multiple source ranges using the established %j separator",
    async (separator) => {
      const before = `First${separator}Second\nThird\rLast`;
      const onChange = vi.fn();
      await act(async () =>
        root.render(
          <MarkdownSourceEditor
            language="en"
            value={before}
            valueRevision={0}
            onChange={onChange}
          />,
        ),
      );
      const editor = EditorView.findFromDOM(
        host.querySelector<HTMLElement>(".cm-editor")!,
      )!;
      const third = editor.state.doc.toString().indexOf("Third");
      editor.dispatch({
        changes: [
          { from: 0, to: "First".length, insert: "Start" },
          { from: third, to: third + "Third".length, insert: "New\nLine" },
        ],
      });
      const edited = `Start${separator}Second\nNew${separator}Line\rLast`;
      expect(onChange).toHaveBeenLastCalledWith(edited);
      expect(undo(editor)).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(before);
    },
  );

  it("restores deleted mixed line separators exactly through native undo and redo", async () => {
    const before = "First\nSecond\r\nThird\rLast";
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={before}
          valueRevision={0}
          onChange={onChange}
        />,
      ),
    );
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    editor.dispatch({ changes: { from: 12, to: 19, insert: "" } });
    const deleted = "First\nSecondLast";
    expect(onChange).toHaveBeenLastCalledWith(deleted);
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(before);
    expect(redo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(deleted);
  });

  it("retains ordinary edit grouping around isolated mixed-separator deletions", async () => {
    const before = "A\nB\r\nC\rD";
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={before}
          valueRevision={0}
          onChange={onChange}
        />,
      ),
    );
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    editor.dispatch({ changes: { from: 0, to: 1, insert: "Start" } });
    editor.dispatch({ changes: { from: 5, insert: "!" } });
    expect(undoDepth(editor.state)).toBe(1);
    editor.dispatch({ changes: { from: 8, to: 10, insert: "" } });
    editor.dispatch({ changes: { from: 8, to: 9, insert: "" } });
    expect(undoDepth(editor.state)).toBe(3);
    expect(onChange).toHaveBeenLastCalledWith("Start!\nBD");
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("Start!\nB\rD");
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("Start!\nB\r\nC\rD");
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(before);
    expect(redo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("Start!\nB\r\nC\rD");
    expect(redo(editor)).toBe(true);
    expect(redo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("Start!\nBD");
  });

  it.each([
    "![Image](images/a.png)\nSecond\r\nThird\rLast",
    "First\nSecond\r\nA long deleted line\r![Image](images/a.png)",
  ])(
    "retains an external image rebase before restoring deleted separators in %j",
    async (before) => {
      const onChange = vi.fn();
      const render = (
        value: string,
        valueRevision: number,
        previous?: string,
      ) =>
        root.render(
          <MarkdownSourceEditor
            language="en"
            value={value}
            valueRevision={valueRevision}
            externalChanges={
              previous
                ? imagePathSourceChanges(
                    previous,
                    value,
                    "/notes/research.md",
                    "/exports/copy.md",
                  )
                : undefined
            }
            onChange={onChange}
          />,
        );
      await act(async () => render(before, 0));
      const editor = EditorView.findFromDOM(
        host.querySelector<HTMLElement>(".cm-editor")!,
      )!;
      const normalized = editor.state.doc.toString();
      const from = normalized.indexOf("\n", normalized.indexOf("Second"));
      const to = normalized.indexOf("\n", from + 1) + 1;
      editor.dispatch({ changes: { from, to, insert: "" } });
      const deleted = before.replace(/\r\n[^\r]+\r/, "");
      expect(onChange).toHaveBeenLastCalledWith(deleted);
      const after = rebaseMarkdownImageAssets(
        deleted,
        "/notes/research.md",
        "/exports/copy.md",
      );
      await act(async () => render(after, 1, deleted));
      expect(undo(editor)).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(
        rebaseMarkdownImageAssets(
          before,
          "/notes/research.md",
          "/exports/copy.md",
        ),
      );
      expect(redo(editor)).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(after);
    },
  );

  it("retains the established insertion style when the first separator is deleted before an image rebase", async () => {
    const before = "First\nSecond\r\n![Image](images/a.png)";
    const onChange = vi.fn();
    const render = (value: string, valueRevision: number, previous?: string) =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={value}
          valueRevision={valueRevision}
          externalChanges={
            previous
              ? imagePathSourceChanges(
                  previous,
                  value,
                  "/notes/research.md",
                  "/exports/copy.md",
                )
              : undefined
          }
          onChange={onChange}
        />,
      );
    await act(async () => render(before, 0));
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    editor.dispatch({ changes: { from: 5, to: 6, insert: "" } });
    const deleted = before.replace("\n", "");
    const after = rebaseMarkdownImageAssets(
      deleted,
      "/notes/research.md",
      "/exports/copy.md",
    );
    await act(async () => render(after, 1, deleted));
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(
      rebaseMarkdownImageAssets(
        before,
        "/notes/research.md",
        "/exports/copy.md",
      ),
    );
    expect(redo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(after);
  });

  it("uses final separator positions when a view update contains multiple transactions", async () => {
    const before = "First\nSecond\r\nThird\rLast";
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={before}
          valueRevision={0}
          onChange={onChange}
        />,
      ),
    );
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    const deletion = editor.state.update({
      changes: [
        { from: 5, to: 6, insert: "" },
        { from: 18, to: 19, insert: "" },
      ],
    });
    const insertion = deletion.state.update({
      changes: { from: 0, insert: "New\n" },
    });
    editor.update([deletion, insertion]);
    expect(onChange).toHaveBeenLastCalledWith("New\nFirstSecond\r\nThirdLast");
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("FirstSecond\r\nThirdLast");
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(before);
    expect(redo(editor)).toBe(true);
    expect(redo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith("New\nFirstSecond\r\nThirdLast");
  });

  it("reuses source search matches for navigation and refreshes them after typing", async () => {
    const handle = createRef<SwitchableEditorHandle>();
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          ref={handle}
          language="en"
          value="target and target"
          valueRevision={0}
          onChange={vi.fn()}
        />,
      ),
    );
    const find = vi.spyOn(documentSearch, "findTextMatches");
    try {
      expect(handle.current?.search("target", "reset")).toEqual({
        current: 1,
        total: 2,
      });
      expect(handle.current?.search("target", "next")).toEqual({
        current: 2,
        total: 2,
      });
      expect(handle.current?.search("target", "previous")).toEqual({
        current: 1,
        total: 2,
      });
      expect(find).toHaveBeenCalledOnce();
      const editor = EditorView.findFromDOM(
        host.querySelector<HTMLElement>(".cm-editor")!,
      )!;
      editor.dispatch({
        changes: { from: editor.state.doc.length, insert: " target" },
      });
      expect(handle.current?.search("target", "refresh")).toEqual({
        current: 1,
        total: 3,
      });
      expect(find).toHaveBeenCalledTimes(2);
    } finally {
      find.mockRestore();
    }
  });

  it.each([1, 29, 730, 4501, 99173])(
    "preserves arbitrary edits and complete undo/redo with mixed separators (seed %s)",
    async (seed) => {
      let randomState = seed;
      const random = (limit: number) => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState % limit;
      };
      const initial = "Start\r\nEmoji 😀 e\u0301\nNUL \0\r中文\r\nEnd";
      const normalize = (value: string) => value.replace(/\r\n?/g, "\n");
      const rawPosition = (value: string, normalizedPosition: number) => {
        let sourcePosition = 0;
        for (let index = 0; index < normalizedPosition; index += 1) {
          sourcePosition +=
            value.slice(sourcePosition, sourcePosition + 2) === "\r\n" ? 2 : 1;
        }
        return sourcePosition;
      };
      const onChange = vi.fn();
      await act(async () =>
        root.render(
          <MarkdownSourceEditor
            language="en"
            value={initial}
            valueRevision={0}
            onChange={onChange}
          />,
        ),
      );
      const editor = EditorView.findFromDOM(
        host.querySelector<HTMLElement>(".cm-editor")!,
      )!;
      const snapshots = [initial];
      const inserts = [
        "",
        "\n",
        "\n\n",
        "A\nB",
        "😀",
        "\0",
        "中文",
        "e\u0301",
        "\r\n",
        "\r",
        "\u2028",
      ];
      for (let index = 0; index < 60; index += 1) {
        const before = snapshots.at(-1)!;
        const length = normalize(before).length;
        const start = random(length + 1);
        const end = Math.min(length, start + random(8));
        const inserted = normalize(inserts[random(inserts.length)]);
        if (start === end && !inserted) continue;
        const expected =
          before.slice(0, rawPosition(before, start)) +
          inserted.replace(/\n/g, "\r\n") +
          before.slice(rawPosition(before, end));
        editor.dispatch({
          changes: { from: start, to: end, insert: inserted },
          annotations: isolateHistory.of("full"),
        });
        expect(onChange.mock.lastCall?.[0], `edit ${index}`).toBe(expected);
        expect(editor.state.doc.toString(), `edit ${index}`).toBe(
          normalize(expected),
        );
        snapshots.push(expected);
      }
      for (let index = snapshots.length - 2; index >= 0; index -= 1) {
        expect(undo(editor), `undo ${index}`).toBe(true);
        expect(onChange.mock.lastCall?.[0], `undo ${index}`).toBe(
          snapshots[index],
        );
      }
      expect(undo(editor)).toBe(false);
      for (let index = 1; index < snapshots.length; index += 1) {
        expect(redo(editor), `redo ${index}`).toBe(true);
        expect(onChange.mock.lastCall?.[0], `redo ${index}`).toBe(
          snapshots[index],
        );
      }
      expect(redo(editor)).toBe(false);
    },
  );

  it("indents a large source selection without a stall and retains mixed separators through undo", async () => {
    const before = "Plain text\r\nNext line\n".repeat(20_000);
    const indented = before.replace(/[^\r\n]+/g, "  $&");
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <MarkdownSourceEditor
          language="en"
          value={before}
          valueRevision={0}
          onChange={onChange}
        />,
      ),
    );
    const editor = EditorView.findFromDOM(
      host.querySelector<HTMLElement>(".cm-editor")!,
    )!;
    editor.dispatch({
      selection: { anchor: 0, head: editor.state.doc.length },
    });
    const started = performance.now();
    expect(indentMore(editor)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect(onChange).toHaveBeenLastCalledWith(indented);
    expect(undo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(before);
    expect(redo(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(indented);
    expect(indentLess(editor)).toBe(true);
    expect(onChange).toHaveBeenLastCalledWith(before);
  }, 20_000);
});
