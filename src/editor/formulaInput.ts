import type { FormulaKind } from './Formula';

export function shouldCreateBlockFormula(input: {
  text: string;
  parentType: string;
  parentText: string;
  parentOffset: number;
}): boolean {
  return (
    input.parentType === 'paragraph' &&
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

/** Returns the matching closing command after a just-completed TeX environment. */
export function latexEnvironmentClosure(latex: string): string | null {
  const match = /\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}$/.exec(latex);
  return match ? `\\end{${match[1]}}` : null;
}

/**
 * Raw Markdown entry should only receive an automatic `\\end{…}` while the
 * user is actually inside a single-dollar formula. MathLive fields are handled
 * separately, so ordinary prose such as a LaTeX example remains untouched.
 */
export function shouldCompleteRawLatexEnvironment(input: {
  parentText: string;
  parentOffset: number;
  begin: string;
}): boolean {
  const beforeBegin = input.parentText.slice(0, input.parentOffset - input.begin.length);
  return input.parentOffset >= input.begin.length && /(^|[^\\])\$(?!\$)[^$\n]*$/.test(beforeBegin);
}

export function formulaFromClipboard(text: string): { kind: FormulaKind; latex: string } | null {
  const trimmed = text.trim();
  const block = /^\$\$\s*([\s\S]+?)\s*\$\$$/.exec(trimmed);
  if (block?.[1]) return { kind: 'block', latex: block[1] };
  const inline = /^\$([^$\n]+)\$$/.exec(trimmed);
  if (inline?.[1]) return { kind: 'inline', latex: inline[1] };
  // A standalone TeX control sequence is far more likely formula source than prose.
  // Do not keep an allow-list here: common research notation such as \mathcal,
  // \sum, and package-neutral operators would otherwise be pasted as plain text.
  if (/\\[A-Za-z]+/.test(trimmed)) {
    return {
      kind:
        trimmed.includes('\n') ||
        /\\begin\{(?:aligned|align|cases|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}/.test(trimmed)
          ? 'block'
          : 'inline',
      latex: trimmed,
    };
  }
  return null;
}
