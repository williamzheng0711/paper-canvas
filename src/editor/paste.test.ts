import { describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Table, TableRow } from "@tiptap/extension-table";
import { FootnoteDefinition, FootnoteReference } from "./Footnote";
import { PaperOrderedList } from "./PaperOrderedList";
import { PaperImage } from "./PaperImage";
import { PaperTableCell, PaperTableHeader } from "./PaperTable";
import { markdownToDocument } from "./markdown";
import { BlockFormula, InlineFormula } from "./Formula";
import { HtmlPreview } from "./HtmlPreview";
import {
  insertPastedFormula,
  insertPastedMarkdown,
  markdownDocumentFromClipboard,
  sanitizePastedHtml,
} from "./paste";

describe("HTML paste sanitization", () => {
  function clipboardEditor(content: ReturnType<typeof markdownToDocument>) {
    return new Editor({
      extensions: [
        StarterKit.configure({
          orderedList: false,
          trailingNode: { notAfter: ["footnoteDefinition"] },
        }),
        PaperOrderedList,
        TaskList,
        TaskItem.configure({ nested: true }),
        FootnoteReference,
        FootnoteDefinition,
        InlineFormula,
        BlockFormula,
        PaperImage,
        Table,
        TableRow,
        PaperTableCell,
        PaperTableHeader,
      ],
      editorProps: { transformPastedHTML: sanitizePastedHtml },
      content,
    });
  }
  // jsdom has no ClipboardEvent constructor; an explicit event still exercises
  // ProseMirror's production HTML parsing and transformPastedHTML pipeline.
  function pasteHtml(editor: Editor, html: string) {
    return editor.view.pasteHTML(html, new Event("paste") as ClipboardEvent);
  }

  it("retains footnote references and editable bodies through the actual HTML paste path", () => {
    const original = clipboardEditor(
      markdownToDocument("Text[^note].\n\n[^note]: A note with $x^2$."),
    );
    const copied = original.getHTML();
    const destination = clipboardEditor(markdownToDocument("replace me"));
    destination.commands.selectAll();
    expect(pasteHtml(destination, copied)).toBe(true);
    const json = destination.getJSON() as JSONContent;
    expect(json.content?.[0].content?.[1]).toMatchObject({
      type: "footnoteReference",
      attrs: { identifier: "note" },
    });
    expect(json.content?.[1]).toMatchObject({
      type: "footnoteDefinition",
      attrs: { identifier: "note" },
    });
    expect(JSON.stringify(json.content?.[1])).toContain("A note with ");
    expect(JSON.stringify(json.content?.[1])).toContain("inlineFormula");
    original.destroy();
    destination.destroy();
  });

  it("retains non-one numbering and mixed checkbox states through HTML paste", () => {
    const original = clipboardEditor(
      markdownToDocument("7. [x] Done\n8. Ordinary\n9. [ ] Pending\n\nEnd."),
    );
    const destination = clipboardEditor(markdownToDocument("replace me"));
    destination.commands.selectAll();
    expect(pasteHtml(destination, original.getHTML())).toBe(true);
    const list = (destination.getJSON() as JSONContent).content?.[0];
    expect(list).toMatchObject({ type: "orderedList", attrs: { start: 7 } });
    expect(list?.content?.map((item) => item.type)).toEqual([
      "taskItem",
      "listItem",
      "taskItem",
    ]);
    expect(list?.content?.[0].attrs?.checked).toBe(true);
    expect(list?.content?.[2].attrs?.checked).toBe(false);
    original.destroy();
    destination.destroy();
  });

  it("removes preview checkbox labels only when native task metadata renders the checkbox", () => {
    const sanitized = sanitizePastedHtml(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><span data-papercanvas-task-marker="">[x] </span><div><p>Done</p></div></li></ul>' +
        '<p><span data-papercanvas-task-marker="">Keep this text</span></p><script>discard()</script>',
    );
    const editor = clipboardEditor(markdownToDocument("replace me"));
    editor.commands.selectAll();
    pasteHtml(editor, sanitized);
    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "taskList",
      content: [
        {
          type: "taskItem",
          attrs: { checked: true },
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Done" }] },
          ],
        },
      ],
    });
    expect(editor.state.doc.textContent).toBe("DoneKeep this text");
    expect(sanitized).not.toContain("discard");
    editor.destroy();
  });

  it("retains merged cell geometry, alignment, and image dimensions through HTML paste", () => {
    const destination = clipboardEditor(markdownToDocument("replace me"));
    destination.commands.selectAll();
    pasteHtml(
      destination,
      '<table><tr><th colspan="2" align="right"><p>Header</p></th></tr><tr><td><p>Left</p></td><td><p>Right</p></td></tr></table><img src="diagram.png" width="240" height="120">',
    );
    const json = destination.getJSON() as JSONContent;
    expect(json.content?.[0].content?.[0].content?.[0]).toMatchObject({
      attrs: { colspan: 2, textAlign: "right" },
    });
    expect(json.content?.[1]).toMatchObject({
      type: "image",
      attrs: { width: 240, height: 120 },
    });
    destination.destroy();
  });
  it("retains common document markup but removes executable content and unsafe URLs", () => {
    const sanitized = sanitizePastedHtml(
      '<h2>研究</h2><p><a href="javascript:alert(1)" onclick="alert(2)">link</a></p><img src="x" onerror="alert(3)"><script>alert(4)</script>',
    );

    expect(sanitized).toContain("<h2>研究</h2>");
    expect(sanitized).toContain('<img src="x">');
    expect(sanitized).not.toMatch(/script|onclick|onerror|javascript:/i);
  });

  it('promotes only local-file image sources without broadening URL protocols or overriding origin metadata', () => {
    const sanitized = sanitizePastedHtml(
      '<a href="file:///tmp/private.txt">Local link</a>' +
      '<img src="file:///tmp/safe.svg" onerror="execute()">' +
      '<img src="file:///tmp/runtime.svg" data-image-original-src="/tmp/original.svg">' +
      '<img src="file://remote.example/share/a.svg">' +
      '<img src="javascript:execute()"><img src="file://invalid:port/a.svg">' +
      '<script>execute()</script><iframe src="file:///tmp/private.html"></iframe>',
    );
    const template = document.createElement('template');
    template.innerHTML = sanitized;
    const images = [...template.content.querySelectorAll('img')];
    expect(images[0].getAttribute('data-image-original-src')).toBe('file:///tmp/safe.svg');
    expect(images[1].getAttribute('data-image-original-src')).toBe('/tmp/original.svg');
    expect(images[2].getAttribute('data-image-original-src')).toBe('file://remote.example/share/a.svg');
    expect(images.slice(3).every((image) => !image.hasAttribute('data-image-original-src'))).toBe(true);
    expect(images.every((image) => !image.hasAttribute('src'))).toBe(true);
    expect(template.content.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(sanitized).not.toMatch(/script|iframe|onerror|javascript:|execute\(/i);
  });

  it('preserves formula line endings when local image metadata is enriched in the same paste', () => {
    const sanitized = sanitizePastedHtml('<img src="file:///tmp/a.svg"><span data-formula-kind="inline" data-latex="x&#13;&#10;y&#13;z"></span>');
    const template = document.createElement('template');
    template.innerHTML = sanitized;
    const formula = template.content.querySelector('[data-formula-kind]');
    expect(JSON.parse(formula!.getAttribute('data-latex-json')!)).toBe('x\r\ny\rz');
  });

  it.each([
    '<img alt="Final pasted image" width="240">',
    '<img src="javascript:execute()" alt="Final pasted image" onerror="execute()">',
    '<img data-image-original-src="javascript:execute()" alt="Final pasted image">',
  ])('preserves orphan image alt text through actual HTML paste and Undo/Redo: %s', (html) => {
    const destination = clipboardEditor(markdownToDocument('replace me'));
    const before = destination.getJSON();
    try {
      destination.commands.selectAll();
      expect(pasteHtml(destination, html)).toBe(true);
      expect(destination.getText()).toBe('Final pasted image');
      expect(destination.getJSON().content?.[0]).toMatchObject({ type: 'paragraph', content: [{ type: 'text', text: 'Final pasted image' }] });
      expect(destination.view.dom.querySelector('img')).toBeNull();
      expect(destination.commands.undo()).toBe(true);
      expect(destination.getJSON()).toEqual(before);
      expect(destination.commands.redo()).toBe(true);
      expect(destination.getText()).toBe('Final pasted image');
    } finally { destination.destroy(); }
  });

  it('keeps orphan image alt inert and leaves valid image origin metadata available', () => {
    const sanitized = sanitizePastedHtml('<p>Before<img alt="&lt;img src=x onerror=execute()&gt;">After</p><img data-image-original-src="/tmp/a.svg" alt="Actual image">');
    const template = document.createElement('template');
    template.innerHTML = sanitized;
    expect(template.content.querySelector('p')?.textContent).toBe('Before<img src=x onerror=execute()>After');
    expect(template.content.querySelector('script')).toBeNull();
    expect(template.content.querySelector('img')?.getAttribute('data-image-original-src')).toBe('/tmp/a.svg');
    expect(template.content.querySelectorAll('img')).toHaveLength(1);
  });

  it("preserves safe PaperCanvas formula nodes during editor-to-editor copy", () => {
    const sanitized = sanitizePastedHtml(
      '<p>Before <span latex="x^2" data-formula-kind="inline" data-latex="x^2"></span> after.</p>' +
        '<div latex="y=\\frac{1}{2}" data-formula-kind="block" data-latex="y=\\frac{1}{2}"></div>',
    );
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: sanitized,
    });

    const json = editor.getJSON();
    expect(json.content?.[0].content?.[1]).toMatchObject({
      type: "inlineFormula",
      attrs: { latex: "x^2" },
    });
    expect(json.content?.[1]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "y=\\frac{1}{2}" },
    });
    expect(sanitized).not.toMatch(/on\w+=|style=/i);
    editor.destroy();
  });

  it("preserves exact formula source through native HTML clipboard serialization and repeated paste", () => {
    const latex = "x\r\ny\rz\0\\alpha\uD800";
    const original = clipboardEditor({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "inlineFormula", attrs: { latex } }],
        },
        { type: "blockFormula", attrs: { latex } },
      ],
    });
    const destination = clipboardEditor(markdownToDocument("replace me"));
    try {
      for (const html of [
        original.getHTML(),
        sanitizePastedHtml(sanitizePastedHtml(original.getHTML())),
      ]) {
        destination.commands.selectAll();
        expect(pasteHtml(destination, html)).toBe(true);
        expect(destination.getJSON().content?.[0].content?.[0]).toMatchObject({
          type: "inlineFormula",
          attrs: { latex },
        });
        expect(destination.getJSON().content?.[1]).toMatchObject({
          type: "blockFormula",
          attrs: { latex },
        });
      }
    } finally {
      original.destroy();
      destination.destroy();
    }
  });

  it("preserves formula CRLF from rich HTML previews when the preview body is copied", () => {
    const latex = "x\r\ny\rz";
    const source =
      '<ol start="7"><li><div data-formula-kind="block" latex="x&#13;&#10;y&#13;z" data-latex="x&#13;&#10;y&#13;z"><pre>$$&#10;x&#13;&#10;y&#13;z&#10;$$</pre></div></li></ol>';
    const original = new Editor({
      extensions: [StarterKit, HtmlPreview],
      content: {
        type: "doc",
        content: [{ type: "htmlPreview", attrs: { source } }],
      },
    });
    const destination = clipboardEditor(markdownToDocument("replace me"));
    try {
      destination.commands.selectAll();
      expect(pasteHtml(destination, original.getHTML())).toBe(true);
      let copiedSource: string | undefined;
      destination.state.doc.descendants((node) => {
        if (node.type.name === "blockFormula")
          copiedSource = node.attrs.latex as string;
      });
      expect(copiedSource).toBe(latex);
      expect(destination.getJSON().content?.[0].attrs?.start).toBe(7);
    } finally {
      original.destroy();
      destination.destroy();
    }
  });

  it("falls back to plain formula metadata when encoded source is malformed or not a string", () => {
    const destination = clipboardEditor(markdownToDocument("replace me"));
    try {
      for (const encoded of ["invalid-json", "123"]) {
        destination.commands.selectAll();
        expect(
          pasteHtml(
            destination,
            `<div data-formula-kind="block" data-latex-json="${encoded}" latex="retained"></div>`,
          ),
        ).toBe(true);
        expect(destination.getJSON().content?.[0]).toMatchObject({
          type: "blockFormula",
          attrs: { latex: "retained" },
        });
      }
    } finally {
      destination.destroy();
    }
  });

  it("includes LaTeX delimiters when a formula selection is copied as plain text", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Before " },
              { type: "inlineFormula", attrs: { latex: "x^2" } },
              { type: "text", text: " after." },
            ],
          },
          { type: "blockFormula", attrs: { latex: "y=\\frac{1}{2}" } },
        ],
      },
    });
    editor.commands.selectAll();

    const clipboardText = editor.view.someProp(
      "clipboardTextSerializer",
      (serializer) => serializer(editor.state.selection.content(), editor.view),
    );

    expect(clipboardText).toContain("Before $x^2$ after.");
    expect(clipboardText).toContain("$$\ny=\\frac{1}{2}\n$$");
    editor.destroy();
  });
});

describe("plain-text Markdown paste", () => {
  it("fills prewritten display delimiters with pasted TeX source", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>$$$$</p>",
    });
    editor.commands.setTextSelection(3);

    expect(insertPastedFormula(editor.view, "\\theta")).toBe(true);

    expect(editor.getJSON().content?.[0]).toMatchObject({
      type: "blockFormula",
      attrs: { latex: "\\theta", sourceCaret: 6 },
    });
    editor.destroy();
  });

  it("keeps mixed prose, lists, and formulas as document structure", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>replace me</p>",
    });
    editor.commands.selectAll();

    const handled = insertPastedMarkdown(
      editor.view,
      [
        "# Notes",
        "",
        "Prose with \\cite{paper}, plus $E=mc^2$.",
        "",
        "$$x^2+y^2$$",
        "",
        "- first",
        "- second",
      ].join("\n"),
    );

    const json = editor.getJSON();
    expect(handled).toBe(true);
    expect(json.content?.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "blockFormula",
      "bulletList",
      // ProseMirror keeps one editable paragraph after a full-selection paste.
      "paragraph",
    ]);
    expect(JSON.stringify(json)).toContain("\\\\cite{paper}");
    expect(JSON.stringify(json)).toContain("inlineFormula");
    expect(JSON.stringify(json)).toContain("blockFormula");
    expect(json.content?.[0].attrs?.latex).toBeUndefined();
    editor.destroy();
  });

  it("leaves ordinary plain text to the default editor paste path", () => {
    expect(
      markdownDocumentFromClipboard("ordinary text\n\nwithout math"),
    ).toBeNull();
  });

  it("merges a mixed inline-math paste into the current paragraph", () => {
    const editor = new Editor({
      extensions: [StarterKit, InlineFormula, BlockFormula],
      content: "<p>before after</p>",
    });
    editor.commands.setTextSelection(8);

    expect(insertPastedMarkdown(editor.view, "middle $x^2$")).toBe(true);

    expect(editor.getJSON().content).toEqual([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "before middle " },
          expect.objectContaining({
            type: "inlineFormula",
            attrs: expect.objectContaining({ latex: "x^2" }),
          }),
          { type: "text", text: "after" },
        ],
      },
    ]);
    editor.destroy();
  });
});
