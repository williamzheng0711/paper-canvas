import { describe, expect, it } from "vitest";
import {
  completeFormulaSourceInput,
  formulaBoundaryTarget,
  formulaSourceBoundaryAction,
  validateLatex,
} from "./Formula";

describe("formula safety and cursor boundaries", () => {
  it("accepts matrices, cases, aligned equations, and Chinese-adjacent inline math", () => {
    expect(
      validateLatex("\\begin{equation}f(x)\\end{equation}", true),
    ).toBeNull();
    expect(
      validateLatex("\\begin{align}a&=b\\\\c&=d\\end{align}", true),
    ).toBeNull();
    expect(
      validateLatex("\\begin{matrix}a & b\\\\ c & d\\end{matrix}"),
    ).toBeNull();
    expect(
      validateLatex("f(x)=\\begin{cases}x^2 & x>0\\\\0 & x\\leq0\\end{cases}"),
    ).toBeNull();
    expect(
      validateLatex("\\begin{aligned}a&=b\\\\c&=d\\end{aligned}", true),
    ).toBeNull();
    expect(validateLatex("\\mathbb{E}_{x\\sim p}[f_\\theta(x)]")).toBeNull();
  });

  it("returns a local error for invalid LaTeX instead of throwing", () => {
    expect(validateLatex("\\definitelyNotALatexCommand{")).toMatch(
      /ParseError|Undefined control sequence|KaTeX/,
    );
  });

  it("moves a selected formula node naturally back to the surrounding text", () => {
    const selection = { from: 12, to: 13, nodeType: "inlineFormula" };
    expect(formulaBoundaryTarget(selection, "ArrowLeft")).toBe(12);
    expect(formulaBoundaryTarget(selection, "ArrowRight")).toBe(13);
    expect(
      formulaBoundaryTarget({ ...selection, nodeType: "image" }, "ArrowLeft"),
    ).toBeNull();
  });

  it("returns text-boundary actions from an active source editor without swallowing edits", () => {
    expect(
      formulaSourceBoundaryAction({
        key: "ArrowLeft",
        selectionStart: 0,
        selectionEnd: 0,
        sourceLength: 3,
      }),
    ).toBe("before");
    expect(
      formulaSourceBoundaryAction({
        key: "ArrowRight",
        selectionStart: 3,
        selectionEnd: 3,
        sourceLength: 3,
      }),
    ).toBe("after");
    expect(
      formulaSourceBoundaryAction({
        key: "Backspace",
        selectionStart: 0,
        selectionEnd: 0,
        sourceLength: 0,
      }),
    ).toBe("remove");
    expect(
      formulaSourceBoundaryAction({
        key: "Delete",
        selectionStart: 1,
        selectionEnd: 2,
        sourceLength: 3,
      }),
    ).toBeNull();
  });

  it("inserts a matching environment close command and keeps the source caret before it", () => {
    const opening = "\\begin{equation}";
    expect(completeFormulaSourceInput(opening, opening.length)).toEqual({
      value: "\\begin{equation}\\end{equation}",
      caret: opening.length,
    });
  });

  it("does not duplicate an existing close command while its opening is edited", () => {
    const opening = "\\begin{equation}";
    const value = `${opening}x^2\\end{equation}`;
    expect(completeFormulaSourceInput(value, opening.length)).toEqual({
      value,
      caret: opening.length,
    });
  });
});
