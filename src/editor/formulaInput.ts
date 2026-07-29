import type { FormulaKind } from "./Formula";

const displayLatexEnvironments = new Set([
  "equation",
  "equation*",
  "align",
  "align*",
  "aligned",
  "alignedat",
  "gather",
  "gather*",
  "gathered",
  "split",
  "cases",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
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
    displayFormulaFromDelimitedLine(input.text) !== null
  );
}

/**
 * Returns the TeX held by a complete, standalone `$$...$$` line. Keeping
 * this strict is deliberate: users can write the delimiters naturally, and
 * the editor does not turn the second `$` into an atom before they finish.
 */
export function displayFormulaFromDelimitedLine(text: string): string | null {
  const match = /^\$\$([^$\n]+)\$\$$/.exec(text);
  const latex = match?.[1]?.trim();
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
    displayFormulaFromLatexEnvironment(nextText);
  if (latex === null) return null;

  const delimited = nextText.startsWith("$$");
  const caret = input.from + input.insertedText.length - (delimited ? 2 : 0);
  return {
    latex,
    caret: Math.max(0, Math.min(latex.length, caret)),
  };
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
  // A standalone TeX control sequence is far more likely formula source than prose.
  // Do not keep an allow-list here: common research notation such as \mathcal,
  // \sum, and package-neutral operators would otherwise be pasted as plain text.
  if (/\\[A-Za-z]+/.test(trimmed)) {
    const environment = /^\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}/.exec(
      trimmed,
    )?.[1];
    if (
      environment !== undefined &&
      isDisplayLatexEnvironment(environment) &&
      trimmed === `\\begin{${environment}}`
    ) {
      return {
        kind: "block",
        latex: `${trimmed}\\end{${environment}}`,
        sourceCaret: trimmed.length,
      };
    }
    return {
      kind:
        trimmed.includes("\n") ||
        (environment !== undefined && isDisplayLatexEnvironment(environment))
          ? "block"
          : "inline",
      latex: trimmed,
    };
  }
  return null;
}
