import { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import { canvasNodesAndMarks } from "./canvasSchema";
import {
  CanvasCapacity,
  canvasDocumentSupported,
  maximumCanvasCharacters,
} from "./canvasCapacity";
import {
  formulaPreview,
  maximumFormulaPreviewNodes,
  maximumFormulaPreviewSource,
} from "./formulaRendering";
import { flushFormulaSources } from "./Formula";
import { formulaFromClipboard } from "./formulaInput";
import { getMessages } from "../i18n";

describe("bounded formula rendering", () => {
  it("keeps extreme valid formula source intact without expanding its preview DOM", () => {
    const latex = "x+".repeat(40_000);
    const editor = new Editor({
      extensions: [...canvasNodesAndMarks(), CanvasCapacity],
      content: {
        type: "doc",
        content: [{ type: "blockFormula", attrs: { latex } }],
      },
    });
    try {
      expect(editor.state.doc.firstChild?.attrs.latex).toBe(latex);
      expect(
        editor.view.dom.querySelector(".formula-render code")?.textContent,
      ).toBe(latex);
      expect(editor.view.dom.textContent).toContain(
        getMessages().formulaPreviewLimited,
      );
      expect(editor.view.dom.querySelectorAll("*").length).toBeLessThan(20);
      expect(canvasDocumentSupported(editor.getJSON())).toBe(true);
      editor.view.dom.querySelector<HTMLElement>(".formula-render")!.click();
      const source =
        editor.view.dom.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(source.value).toBe(latex);
      source.value = "x+1";
      source.dispatchEvent(new Event("input", { bubbles: true }));
      expect(editor.view.dom.querySelector(".katex")).not.toBeNull();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.firstChild?.attrs.latex).toBe(latex);
      expect(source.value).toBe(latex);
      expect(
        editor.view.dom.querySelector(".formula-live-preview code")
          ?.textContent,
      ).toBe(latex);
      expect(editor.commands.redo()).toBe(true);
      expect(source.value).toBe("x+1");
    } finally {
      editor.destroy();
    }
  });

  it("bounds generated DOM even when the LaTeX source is within the parsing budget", () => {
    const latex = "x+".repeat(5_000);
    expect(latex.length).toBeLessThan(maximumFormulaPreviewSource);
    const preview = formulaPreview(latex, true);
    expect(preview.limited).toBe(true);
    expect(preview.html).toBeNull();
    expect(preview.nodes).toBeLessThan(maximumFormulaPreviewNodes);
  });

  it("bounds custom macro expansion before it can exhaust memory while retaining small definitions", () => {
    const large = "\\def\\a{" + "x+".repeat(500) + "}" + "\\a".repeat(300);
    expect(large.length).toBeLessThan(2_000);
    expect(formulaPreview(large).limited).toBe(true);
    const duplicated =
      "\\def\\a#1{" + "#1".repeat(300) + "}\\a{" + "x".repeat(500) + "}";
    expect(formulaPreview(duplicated).limited).toBe(true);
    expect(
      formulaPreview("\\def\\R{\\mathbb{R}}" + "\\R+".repeat(100)).limited,
    ).toBe(false);
    expect(formulaPreview("\\edef\\a{x}\\a").limited).toBe(true);
  });

  it("counts formula expansion across the entire canvas rather than only model atoms", () => {
    const latex = "x+".repeat(700);
    const formula = { type: "blockFormula", attrs: { latex } };
    expect(canvasDocumentSupported({ type: "doc", content: [formula] })).toBe(
      true,
    );
    expect(
      canvasDocumentSupported({ type: "doc", content: [formula, formula] }),
    ).toBe(false);
  });

  it.each(["source length", "total rendered nodes"] as const)(
    "restores the visible formula when %s makes its edit exceed canvas capacity",
    (limit) => {
      const onLimit = vi.fn();
      const document = {
        type: "doc",
        content:
          limit === "source length"
            ? [{ type: "blockFormula", attrs: { latex: "y" } }]
            : [
                { type: "blockFormula", attrs: { latex: "x+".repeat(700) } },
                { type: "blockFormula", attrs: { latex: "y" } },
              ],
      };
      const editor = new Editor({
        extensions: [
          ...canvasNodesAndMarks(),
          CanvasCapacity.configure({ onLimit }),
        ],
        content: document,
      });
      try {
        const before = editor.getJSON();
        Array.from(
          editor.view.dom.querySelectorAll<HTMLElement>(".formula-render"),
        )
          .at(-1)!
          .click();
        const source =
          editor.view.dom.querySelector<HTMLTextAreaElement>("textarea")!;
        source.value =
          limit === "source length"
            ? "x".repeat(maximumCanvasCharacters + 1)
            : "x+".repeat(700);
        source.dispatchEvent(new Event("input", { bubbles: true }));
        expect(onLimit).toHaveBeenCalledOnce();
        expect(editor.getJSON()).toEqual(before);
        expect(source.value).toBe("y");
        flushFormulaSources(editor.view);
        expect(editor.getJSON()).toEqual(before);
        expect(editor.commands.undo()).toBe(false);
      } finally {
        editor.destroy();
      }
    },
  );

  it("keeps large explicitly delimited clipboard source but leaves large bare TeX as plain text", () => {
    const latex = "\\sum " + "x+".repeat(maximumFormulaPreviewSource);
    expect(formulaFromClipboard(`$$${latex}$$`)).toEqual({
      kind: "block",
      latex,
    });
    expect(formulaFromClipboard(latex)).toBeNull();
  });
});
