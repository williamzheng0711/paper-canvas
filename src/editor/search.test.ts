import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import DOMPurify from "dompurify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlPreview, InlineHtmlPreview } from "./HtmlPreview";
import {
  clearDocumentSearch,
  documentSearchPluginKey,
  DocumentSearch,
  findDocumentMatches,
  findTextMatches,
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
