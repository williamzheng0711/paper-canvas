import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import DOMPurify from "dompurify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlPreview, InlineHtmlPreview } from "./HtmlPreview";
import { maximumCanvasNodes } from "./canvasCapacity";
import { commentDecorationsPluginKey, createCommentDecorationsExtension } from "./commentDecorations";
import {
  clearDocumentSearch,
  documentSearchPluginKey,
  DocumentSearch,
  findDocumentMatches,
  findTextMatches,
  getSelectedDocumentText,
  resolveActiveMatch,
  searchDocument,
} from "./search";

const editors: Editor[] = [];
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  vi.restoreAllMocks();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

describe("document search", () => {
  it("bounds dense highlight DOM while preserving every match, wraparound, editing, and history", () => {
    const text = "x ".repeat(25_000);
    const editor = new Editor({
      extensions: [StarterKit, DocumentSearch], content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
      editorProps: { handleScrollToSelection: () => true },
    });
    editors.push(editor);
    const before = editor.getJSON();
    expect(searchDocument(editor, "x", "reset")).toEqual({ current: 1, total: 25_000, highlightsLimited: true });
    expect(documentSearchPluginKey.getState(editor.state)?.matches).toHaveLength(25_000);
    const nodes = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let renderedNodes = 1;
    while (nodes.nextNode()) renderedNodes += 1;
    expect(renderedNodes).toBeLessThanOrEqual(maximumCanvasNodes);

    expect(searchDocument(editor, "x", "previous")).toEqual({ current: 25_000, total: 25_000, highlightsLimited: true });
    expect(editor.state.selection.from).toBe(49_999);
    expect(editor.view.dom.querySelector(".document-search-match--active")?.textContent).toBe("x");
    expect(searchDocument(editor, "x", "next")).toEqual({ current: 1, total: 25_000, highlightsLimited: true });
    expect(editor.state.selection.from).toBe(1);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.can().undo()).toBe(false);
    editor.commands.insertContentAt(1, "x ");
    expect(searchDocument(editor, "x", "refresh").total).toBe(25_001);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(searchDocument(editor, "x", "refresh").total).toBe(25_000);
    expect(editor.commands.redo()).toBe(true);
    expect(searchDocument(editor, "x", "refresh").total).toBe(25_001);
    clearDocumentSearch(editor);
    expect(editor.view.dom.querySelectorAll(".document-search-match")).toHaveLength(0);
    expect(documentSearchPluginKey.getState(editor.state)?.highlightsLimited).toBe(false);
  });

  it("does not limit repeated matches that share one rendered HTML atom", () => {
    const editor = new Editor({
      extensions: [StarterKit, HtmlPreview, DocumentSearch],
      content: { type: "doc", content: [{ type: "htmlPreview", attrs: { source: `<p>${"x ".repeat(5_000)}</p>` } }] },
      editorProps: { handleScrollToSelection: () => true },
    });
    editors.push(editor);
    expect(searchDocument(editor, "x", "reset")).toEqual({ current: 1, total: 5_000 });
    expect(searchDocument(editor, "x", "previous")).toEqual({ current: 5_000, total: 5_000 });
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(documentSearchPluginKey.getState(editor.state)?.decorations.find()).toHaveLength(1);
  });

  it("shares the highlight budget with comment widgets and refreshes it on metadata changes", () => {
    const editor = new Editor({
      extensions: [StarterKit, createCommentDecorationsExtension({ current: undefined }), DocumentSearch],
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x ".repeat(5_000) }] }] },
      editorProps: { handleScrollToSelection: () => true },
    });
    editors.push(editor);
    searchDocument(editor, "x", "reset");
    const withoutComments = documentSearchPluginKey.getState(editor.state)!.decorations.find().length;
    const positions = Array.from({ length: 1_000 }, (_, index) => ({
      id: `point-${index}`, kind: "position", from: 1, to: 1, status: "active", number: index + 1,
    }));
    editor.view.dispatch(editor.state.tr.setMeta(commentDecorationsPluginKey, positions));
    const withComments = documentSearchPluginKey.getState(editor.state)!.decorations.find().length;
    expect(withComments).toBeLessThan(withoutComments);
    expect(withComments * 3 + positions.length * 3 + 3).toBeLessThanOrEqual(maximumCanvasNodes);
    expect(documentSearchPluginKey.getState(editor.state)?.matches).toHaveLength(5_000);
    expect(editor.view.dom.querySelector(".document-search-match--active")?.textContent).toBe("x");
    editor.view.dispatch(editor.state.tr.setMeta(commentDecorationsPluginKey, []));
    expect(documentSearchPluginKey.getState(editor.state)?.decorations.find()).toHaveLength(withoutComments);
    expect(editor.can().undo()).toBe(false);
  });

  it("reserves newly collapsed range widgets before rendering a document edit", () => {
    const editor = new Editor({
      extensions: [StarterKit, createCommentDecorationsExtension({ current: undefined }), DocumentSearch],
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x ".repeat(5_000) }] }] },
      editorProps: { handleScrollToSelection: () => true },
    });
    editors.push(editor);
    const positions = Array.from({ length: 1_000 }, (_, index) => ({
      id: `range-${index}`, kind: "range", from: 1, to: 2, status: "active", number: index + 1,
    }));
    editor.view.dispatch(editor.state.tr.setMeta(commentDecorationsPluginKey, positions));
    searchDocument(editor, "x", "reset");
    const previousCount = documentSearchPluginKey.getState(editor.state)!.decorations.find().length;
    editor.view.dispatch(editor.state.tr.delete(1, 2));
    const current = documentSearchPluginKey.getState(editor.state)!;
    expect(editor.view.dom.querySelectorAll("[data-comment-marker]")).toHaveLength(1_000);
    expect(current.matches).toHaveLength(4_999);
    expect(current.decorations.find().length).toBeLessThan(previousCount);
    expect(current.decorations.find().length * 3 + 3_000 + 3).toBeLessThanOrEqual(maximumCanvasNodes);
  });

  it("finds readable inline HTML and selects its atom range without changing the document", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineHtmlPreview, DocumentSearch],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Press " },
              {
                type: "inlineHtmlPreview",
                attrs: { source: "<kbd>Command</kbd>" },
              },
              { type: "text", text: " to continue." },
            ],
          },
        ],
      },
    });
    editors.push(editor);
    const documentBefore = editor.getJSON();
    expect(findDocumentMatches(editor.state.doc, "command")).toEqual([
      { from: 7, to: 8 },
    ]);
    expect(searchDocument(editor, "command", "reset")).toEqual({
      current: 1,
      total: 1,
    });
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.toJSON()).toMatchObject({
      anchor: 7,
      head: 8,
    });
    expect(getSelectedDocumentText(editor)).toBe("Command");
    expect(
      editor.view.dom
        .querySelector(".html-preview--inline")
        ?.closest(".document-search-match--active"),
    ).not.toBeNull();
    expect(editor.getJSON()).toEqual(documentBefore);
  });

  it("searches block HTML with node selection and keeps repeated matches coherent across refresh and edits", () => {
    const editor = new Editor({
      extensions: [StarterKit, HtmlPreview, DocumentSearch],
      content: {
        type: "doc",
        content: [
          {
            type: "htmlPreview",
            attrs: { source: "<div><p>Command</p><p>Command</p></div>" },
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "A final Command." }],
          },
        ],
      },
    });
    editors.push(editor);
    expect(findDocumentMatches(editor.state.doc, "Command")).toEqual([
      { from: 0, to: 1 },
      { from: 0, to: 1 },
      { from: 10, to: 17 },
    ]);
    expect(searchDocument(editor, "Command", "reset")).toEqual({
      current: 1,
      total: 3,
    });
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node.type.name).toBe(
      "htmlPreview",
    );
    expect(getSelectedDocumentText(editor)).toBe("Command\nCommand");
    expect(
      editor.view.dom
        .querySelector(".html-preview--block")
        ?.classList.contains("document-search-match--active"),
    ).toBe(true);
    expect(
      documentSearchPluginKey.getState(editor.state)?.decorations.find(),
    ).toHaveLength(2);
    expect(searchDocument(editor, "Command", "next")).toEqual({
      current: 2,
      total: 3,
    });
    const selection = editor.state.selection.toJSON();
    expect(searchDocument(editor, "Command", "refresh")).toEqual({
      current: 2,
      total: 3,
    });
    expect(editor.state.selection.toJSON()).toEqual(selection);
    editor.view.dispatch(
      editor.state.tr.insertText("More ", editor.state.doc.content.size - 1),
    );
    expect(searchDocument(editor, "Command", "refresh")).toEqual({
      current: 2,
      total: 3,
    });
    expect(searchDocument(editor, "Command", "next")).toEqual({
      current: 3,
      total: 3,
    });
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(searchDocument(editor, "Command", "next")).toEqual({
      current: 1,
      total: 3,
    });
    expect(searchDocument(editor, "Command", "previous")).toEqual({
      current: 3,
      total: 3,
    });
  });

  it("ignores hidden comments and attribute source while searching the actual blocked-source fallback", () => {
    const editor = new Editor({
      extensions: [StarterKit, HtmlPreview, InlineHtmlPreview, DocumentSearch],
      content: {
        type: "doc",
        content: [
          {
            type: "htmlPreview",
            attrs: {
              source: "<!-- HiddenSecret <script>CommentScript</script> -->",
            },
          },
          {
            type: "htmlPreview",
            attrs: {
              source:
                '<!-- CommentSecret --><p><a title="TitleSecret" href="https://example.com/UrlSecret" onclick="EventSecret()">Visible <b> body</b></a><img src="figure.png" alt="AltSecret"></p>',
            },
          },
          {
            type: "htmlPreview",
            attrs: { source: "<script>BlockedScript</script>" },
          },
        ],
      },
    });
    editors.push(editor);
    for (const query of [
      "HiddenSecret",
      "CommentScript",
      "CommentSecret",
      "TitleSecret",
      "UrlSecret",
      "EventSecret",
      "AltSecret",
    ]) {
      expect(findDocumentMatches(editor.state.doc, query)).toEqual([]);
      expect(searchDocument(editor, query, "reset")).toEqual({
        current: 0,
        total: 0,
      });
    }
    expect(searchDocument(editor, "Visible body", "reset")).toEqual({
      current: 1,
      total: 1,
    });
    expect(searchDocument(editor, "BlockedScript", "reset")).toEqual({
      current: 1,
      total: 1,
    });
    expect(editor.view.dom.querySelector("script")).toBeNull();
  });

  it("caches sanitized atom text by immutable node identity and refreshes replaced HTML", () => {
    const editor = new Editor({
      extensions: [StarterKit, HtmlPreview, DocumentSearch],
      content: {
        type: "doc",
        content: [
          { type: "htmlPreview", attrs: { source: "<p>Command Command</p>" } },
        ],
      },
    });
    editors.push(editor);
    const sanitize = vi.spyOn(DOMPurify, "sanitize");
    expect(searchDocument(editor, "Command", "reset")).toEqual({
      current: 1,
      total: 2,
    });
    expect(sanitize).toHaveBeenCalledTimes(1);
    searchDocument(editor, "Command", "next");
    searchDocument(editor, "Command", "previous");
    searchDocument(editor, "Command", "refresh");
    expect(sanitize).toHaveBeenCalledTimes(1);
    editor.view.dispatch(
      editor.state.tr.setNodeAttribute(
        0,
        "source",
        "<p>Changed Changed Changed</p>",
      ),
    );
    expect(findDocumentMatches(editor.state.doc, "Command")).toEqual([]);
    expect(searchDocument(editor, "Changed", "reset")).toEqual({
      current: 1,
      total: 3,
    });
  });

  it("finds case-insensitive, non-overlapping string matches", () => {
    expect(findTextMatches("Alpha alpha ALPHA", "alpha")).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ]);
    expect(findTextMatches("aaaa", "aa")).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
    expect(findTextMatches("anything", "")).toEqual([]);
    expect(findTextMatches("a.b A.B", "a.b")).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
    ]);
  });

  it("searches backward from the caret at EOF, before the first match, and inside a match", () => {
    const matches = findTextMatches("one two one", "one");
    expect(resolveActiveMatch(matches, "one", "previous", "", -1, 11)).toBe(1);
    expect(resolveActiveMatch(matches, "one", "previous", "", -1, 0)).toBe(1);
    expect(resolveActiveMatch(matches, "one", "previous", "", -1, 2)).toBe(0);
    // Existing navigation still moves from the active occurrence, even if
    // another editor action has moved the caret since that selection.
    expect(resolveActiveMatch(matches, "one", "previous", "one", 0, 11)).toBe(
      1,
    );
    expect(resolveActiveMatch(matches, "one", "previous", "one", 1, 0)).toBe(0);
  });

  it("selects the final canvas occurrence when backward search begins at the end of the document", () => {
    const editor = new Editor({
      extensions: [StarterKit, DocumentSearch],
      content: "<p>one</p><p>two one</p><p>last one</p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(searchDocument(editor, "one", "previous")).toEqual({
      current: 3,
      total: 3,
    });
    expect(getSelectedDocumentText(editor)).toBe("one");
    expect(editor.state.selection.$from.parent.textContent).toBe("last one");
  });

  it("searches across formatting marks but not across block boundaries", () => {
    const editor = new Editor({
      extensions: [StarterKit, DocumentSearch],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Research " },
              { type: "text", marks: [{ type: "bold" }], text: "Notes" },
            ],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Research Notes" }],
          },
        ],
      },
    });
    editors.push(editor);

    expect(searchDocument(editor, "research notes", "reset")).toEqual({
      current: 1,
      total: 2,
    });
    expect(
      editor.state.doc.textBetween(
        editor.state.selection.from,
        editor.state.selection.to,
      ),
    ).toBe("Research Notes");
    expect(
      documentSearchPluginKey.getState(editor.state)?.matches,
    ).toHaveLength(2);
    expect(documentSearchPluginKey.getState(editor.state)?.active).toBe(0);
    expect(searchDocument(editor, "NotesResearch", "reset")).toEqual({
      current: 0,
      total: 0,
    });
  });

  it("finds visible phrases that cross inline HTML without selecting unrelated atoms", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineHtmlPreview, DocumentSearch],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Press " },
              {
                type: "inlineHtmlPreview",
                attrs: { source: "<kbd>Command</kbd>" },
              },
              { type: "text", text: " to continue." },
            ],
          },
        ],
      },
    });
    editors.push(editor);
    const before = editor.getJSON();
    expect(findDocumentMatches(editor.state.doc, "Press Command")).toEqual([
      { from: 1, to: 8 },
    ]);
    expect(findDocumentMatches(editor.state.doc, "Command to")).toEqual([
      { from: 7, to: 11 },
    ]);
    expect(findDocumentMatches(editor.state.doc, "continue")).toEqual([
      { from: 12, to: 20 },
    ]);
    expect(searchDocument(editor, "Press Command to", "reset")).toEqual({
      current: 1,
      total: 1,
    });
    expect(editor.state.selection.toJSON()).toMatchObject({
      anchor: 1,
      head: 11,
    });
    expect(getSelectedDocumentText(editor)).toBe("Press Command to");
    expect(editor.getJSON()).toEqual(before);
  });

  it("keeps search text continuous across hidden inline comments and separates hard breaks", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineHtmlPreview, DocumentSearch],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Alpha" },
              {
                type: "inlineHtmlPreview",
                attrs: { source: "<!-- Invisible -->" },
              },
              { type: "text", text: "Beta" },
              { type: "hardBreak" },
              { type: "text", text: "Gamma" },
            ],
          },
        ],
      },
    });
    editors.push(editor);
    expect(findDocumentMatches(editor.state.doc, "AlphaBeta")).toEqual([
      { from: 1, to: 11 },
    ]);
    expect(findDocumentMatches(editor.state.doc, "BetaGamma")).toEqual([]);
    expect(findDocumentMatches(editor.state.doc, "Beta\nGamma")).toEqual([
      { from: 7, to: 17 },
    ]);
    editor.commands.setTextSelection({ from: 1, to: 17 });
    expect(getSelectedDocumentText(editor)).toBe("AlphaBeta\nGamma");
  });

  it("preserves visible spaces at inline HTML edges and UTF-16 positions around emoji", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineHtmlPreview, DocumentSearch],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "😀before" },
              {
                type: "inlineHtmlPreview",
                attrs: { source: "<b> after </b>" },
              },
              { type: "text", text: "next 😀target" },
            ],
          },
        ],
      },
    });
    editors.push(editor);
    expect(findDocumentMatches(editor.state.doc, "before after next")).toEqual([
      { from: 3, to: 14 },
    ]);
    expect(findDocumentMatches(editor.state.doc, "beforeafter")).toEqual([]);
    expect(searchDocument(editor, "😀target", "reset")).toEqual({
      current: 1,
      total: 1,
    });
    expect(editor.state.selection.toJSON()).toMatchObject({
      anchor: 15,
      head: 23,
    });
  });

  it("keeps selected paragraph boundaries so Find does not prefill a nonexistent phrase", () => {
    const editor = new Editor({
      extensions: [StarterKit, DocumentSearch],
      content: "<p>First</p><p>Second</p>",
    });
    editors.push(editor);
    editor.commands.setTextSelection({ from: 1, to: 14 });
    expect(getSelectedDocumentText(editor)).toBe("First\nSecond");
    expect(findDocumentMatches(editor.state.doc, "First Second")).toEqual([]);
  });

  it("refreshes matches after editing without selecting or scrolling", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const editor = new Editor({
      extensions: [StarterKit, DocumentSearch],
      content: "<p>one two one</p>",
    });
    editors.push(editor);
    searchDocument(editor, "one", "reset");
    editor.commands.setTextSelection(5);
    editor.commands.insertContent("typing ");
    const selection = editor.state.selection.toJSON();
    scrollIntoView.mockClear();
    expect(searchDocument(editor, "one", "refresh")).toEqual({
      current: 2,
      total: 2,
    });
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(
      documentSearchPluginKey.getState(editor.state)?.matches,
    ).toHaveLength(2);
  });

  it("moves forward and backward with wraparound and clears its decorations", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const editor = new Editor({
      extensions: [StarterKit, DocumentSearch],
      content: "<p>one two one</p>",
    });
    editors.push(editor);

    expect(searchDocument(editor, "one", "reset")).toEqual({
      current: 1,
      total: 2,
    });
    expect(scrollIntoView).toHaveBeenLastCalledWith({
      block: "center",
      inline: "nearest",
    });
    expect(searchDocument(editor, "one", "next")).toEqual({
      current: 2,
      total: 2,
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(editor.state.selection.from).toBeGreaterThan(1);
    expect(searchDocument(editor, "one", "next")).toEqual({
      current: 1,
      total: 2,
    });
    expect(searchDocument(editor, "one", "previous")).toEqual({
      current: 2,
      total: 2,
    });

    clearDocumentSearch(editor);
    expect(
      editor.view.dom.querySelectorAll(".document-search-match"),
    ).toHaveLength(0);
  });
});
