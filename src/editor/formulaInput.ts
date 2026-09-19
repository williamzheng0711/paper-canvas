import type { FormulaKind } from "./Formula";
import katex from "katex";

const displayLatexEnvironments = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "aligned",
  "alignedat",
  "alignat",
  "alignat*",
  "gather",
  "gather*",
  "gathered",
  "split",
  "cases",
  "dcases",
  "rcases",
  "drcases",
  "array",
  "darray",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "matrix*",
  "pmatrix*",
  "bmatrix*",
  "Bmatrix*",
  "vmatrix*",
  "Vmatrix*",
  "smallmatrix",
  "subarray",
]);

export function isDisplayLatexEnvironment(name: string): boolean {
  return displayLatexEnvironments.has(name);
}

/** Returns a complete standalone display environment, including its wrappers. */
export function displayFormulaFromLatexEnvironment(
  text: string,
): string | null {
  const latex = text.trim();
  const opening = /^\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}/.exec(latex);
  if (!opening || !isDisplayLatexEnvironment(opening[1])) return null;
  return latex.endsWith(`\\end{${opening[1]}}`) ? latex : null;
}

export function shouldCreateBlockFormula(input: {
  text: string;
  parentType: string;
  parentText: string;
  parentOffset: number;
}): boolean {
  return (
    input.parentType === "paragraph" &&
    input.parentText === input.text &&
    input.parentOffset === input.text.length &&
    (displayFormulaFromDelimitedLine(input.text) !== null ||
      displayFormulaFromBracketedLine(input.text) !== null)
  );
}

export function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === "\\";
    cursor -= 1
  )
    backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Returns the TeX held by a complete, standalone `$$...$$` line. Keeping
 * this strict is deliberate: users can write the delimiters naturally, and
 * the editor does not turn the second `$` into an atom before they finish.
 */
export function displayFormulaFromDelimitedLine(text: string): string | null {
  if (!text.startsWith("$$") || !text.endsWith("$$") || text.length <= 4)
    return null;
  const source = text.slice(2, -2);
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "$" && !isEscaped(source, index)) return null;
  }
  const latex = source.trim();
  return latex || null;
}

/** Returns the TeX held by a complete, standalone `\\[...\\]` line. */
export function displayFormulaFromBracketedLine(text: string): string | null {
  if (!text.startsWith("\\[") || !text.endsWith("\\]") || text.length <= 4)
    return null;
  const source = text.slice(2, -2);
  if (source.includes("\\[") || source.includes("\\]")) return null;
  const latex = source.trim();
  return latex || null;
}

/**
 * Finds a completed display formula after an insertion anywhere in one plain
 * paragraph. This is needed when the closing `$$` already exists to the right
 * of the caret, so an end-anchored input rule cannot see it.
 */
export function displayFormulaAfterTextInsertion(input: {
  parentText: string;
  from: number;
  to: number;
  insertedText: string;
}): { latex: string; caret: number } | null {
  const nextText = `${input.parentText.slice(0, input.from)}${input.insertedText}${input.parentText.slice(input.to)}`;
  const latex =
    displayFormulaFromDelimitedLine(nextText) ??
    displayFormulaFromBracketedLine(nextText) ??
    displayFormulaFromLatexEnvironment(nextText);
  if (latex === null) return null;

  const wrapped = nextText.startsWith("$$") || nextText.startsWith("\\[");
  const caret = input.from + input.insertedText.length - (wrapped ? 2 : 0);
  return {
    latex,
    caret: Math.max(0, Math.min(latex.length, caret)),
  };
}

export type InlineFormulaMatch = {
  from: number;
  to: number;
  latex: string;
  caret: number;
};

/**
 * Finds a complete inline formula around the caret. Unlike an end-anchored
 * input rule, this also sees a closing delimiter that was written first.
 */
export function inlineFormulaAroundCaret(
  text: string,
  caret: number,
): InlineFormulaMatch | null {
  const boundedCaret = Math.max(0, Math.min(text.length, caret));

  for (let opening = text.lastIndexOf("\\(", boundedCaret); opening >= 0;) {
    const closing = text.indexOf("\\)", Math.max(boundedCaret, opening + 2));
    if (closing >= 0) {
      const latex = text.slice(opening + 2, closing).trim();
      if (latex) {
        return {
          from: opening,
          to: closing + 2,
          latex,
          caret: Math.max(
            0,
            Math.min(latex.length, boundedCaret - opening - 2),
          ),
        };
      }
    }
    if (opening === 0) break;
    opening = text.lastIndexOf("\\(", opening - 1);
  }

  for (let opening = boundedCaret - 1; opening >= 0; opening -= 1) {
    if (
      text[opening] !== "$" ||
      isEscaped(text, opening) ||
      text[opening - 1] === "$" ||
      text[opening + 1] === "$"
    ) {
      continue;
    }
    for (
      let closing = Math.max(boundedCaret, opening + 1);
      closing < text.length;
      closing += 1
    ) {
      if (
        text[closing] !== "$" ||
        isEscaped(text, closing) ||
        text[closing - 1] === "$" ||
        text[closing + 1] === "$"
      ) {
        continue;
      }
      const latex = text.slice(opening + 1, closing).trim();
      if (!latex) break;
      return {
        from: opening,
        to: closing + 1,
        latex,
        caret: Math.max(0, Math.min(latex.length, boundedCaret - opening - 1)),
      };
    }
  }
  return null;
}

/** Returns the matching closing command after a just-completed TeX environment. */
export function latexEnvironmentClosure(latex: string): string | null {
  const match = /\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}$/.exec(latex);
  return match ? `\\end{${match[1]}}` : null;
}

/**
 * Raw Markdown entry should only receive an automatic `\\end{…}` while the
 * user is actually inside a single-dollar formula. The formula source editor
 * handles its own completion, so ordinary prose with LaTeX remains untouched.
 */
export function shouldCompleteRawLatexEnvironment(input: {
  parentText: string;
  parentOffset: number;
  begin: string;
}): boolean {
  const beforeBegin = input.parentText.slice(
    0,
    input.parentOffset - input.begin.length,
  );
  return (
    input.parentOffset >= input.begin.length &&
    /(^|[^\\])\$(?!\$)[^$\n]*$/.test(beforeBegin)
  );
}

export function formulaFromClipboard(
  text: string,
): { kind: FormulaKind; latex: string; sourceCaret?: number } | null {
  const trimmed = text.trim();
  const block = /^\$\$\s*([\s\S]+?)\s*\$\$$/.exec(trimmed);
  if (block?.[1]) return { kind: "block", latex: block[1] };
  const inline = /^\$([^$\n]+)\$$/.exec(trimmed);
  if (inline?.[1]) return { kind: "inline", latex: inline[1] };
  const bracket = /^\\\[\s*([\s\S]+?)\s*\\\]$/.exec(trimmed);
  if (bracket?.[1]) return { kind: "block", latex: bracket[1] };
  const parenthesized = /^\\\(\s*([^\n]+?)\s*\\\)$/.exec(trimmed);
  if (parenthesized?.[1]) return { kind: "inline", latex: parenthesized[1] };

  const environment = /^\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}/.exec(
    trimmed,
  )?.[1];
  if (environment !== undefined && isDisplayLatexEnvironment(environment)) {
    if (trimmed === `\\begin{${environment}}`) {
      return {
        kind: "block",
        latex: `${trimmed}\\end{${environment}}`,
        sourceCaret: trimmed.length,
      };
    }
    if (displayFormulaFromLatexEnvironment(trimmed)) {
      return { kind: "block", latex: trimmed };
    }
  }

  // Raw formula source remains convenient, but it must be a single standalone,
  // renderable TeX expression. Merely containing a command is not sufficient:
  // prose or a whole Markdown document may legitimately contain \cite, \ref,
  // or other LaTeX snippets and must continue through the normal paste path.
  if (
    !trimmed.includes("\n") &&
    /^\\[A-Za-z]+/.test(trimmed) &&
    isRenderableLatex(trimmed)
  ) {
    return { kind: "inline", latex: trimmed };
  }
  return null;
}

function isRenderableLatex(latex: string): boolean {
  try {
    katex.renderToString(latex, {
      displayMode: false,
      strict: "ignore",
      throwOnError: true,
      trust: false,
    });
    return true;
  } catch {
    return false;
  }
}
