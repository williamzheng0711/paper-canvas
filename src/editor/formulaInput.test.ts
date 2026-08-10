import { describe, expect, it } from 'vitest';
import {
  displayFormulaFromBracketedLine,
  displayFormulaFromDelimitedLine,
  displayFormulaAfterTextInsertion,
  displayFormulaFromLatexEnvironment,
  formulaFromClipboard,
  inlineFormulaAroundCaret,
  latexEnvironmentClosure,
  shouldCompleteRawLatexEnvironment,
  shouldCreateBlockFormula,
} from './formulaInput';

describe('formula text entry and clipboard recognition', () => {
  it('recognizes only a completed, standalone display formula line', () => {
    expect(
      shouldCreateBlockFormula({
        text: '$$f(x)=x^2$$',
        parentType: 'paragraph',
        parentText: '$$f(x)=x^2$$',
        parentOffset: 12,
      }),
    ).toBe(true);
    expect(
      shouldCreateBlockFormula({
        text: '$$f(x)=x^2$$',
        parentType: 'paragraph',
        parentText: 'price $$f(x)=x^2$$',
        parentOffset: 18,
      }),
    ).toBe(false);
    expect(displayFormulaFromDelimitedLine('$$f(x)=x^2$$')).toBe('f(x)=x^2');
    expect(displayFormulaFromDelimitedLine('$$')).toBeNull();
    expect(displayFormulaFromDelimitedLine('$$1+1=2')).toBeNull();
  });

  it('recognizes content inserted between pre-existing display delimiters', () => {
    expect(
      displayFormulaAfterTextInsertion({
        parentText: '$$$$',
        from: 2,
        to: 2,
        insertedText: 'f(x)',
      }),
    ).toEqual({ latex: 'f(x)', caret: 4 });
    expect(
      displayFormulaAfterTextInsertion({
        parentText: '\\[\\]',
        from: 2,
        to: 2,
        insertedText: '\\theta',
      }),
    ).toEqual({ latex: '\\theta', caret: 6 });
  });

  it('accepts multiline display source and escaped dollar signs without swallowing prose delimiters', () => {
    expect(displayFormulaFromDelimitedLine('$$\\begin{aligned}\na&=b\\\\\nc&=d\n\\end{aligned}$$')).toContain(
      '\\begin{aligned}',
    );
    expect(displayFormulaFromDelimitedLine('$$\\text{price: \\$5}$$')).toBe('\\text{price: \\$5}');
    expect(displayFormulaFromDelimitedLine('$$x$$ and $$y$$')).toBeNull();
    expect(displayFormulaFromBracketedLine('\\[x^2 + y^2\\]')).toBe('x^2 + y^2');
    expect(displayFormulaFromBracketedLine('\\[x\\] and \\[y\\]')).toBeNull();
  });

  it('finds inline source when its closing delimiter was written before the content', () => {
    expect(inlineFormulaAroundCaret('Before $x$ after', 9)).toEqual({
      from: 7,
      to: 10,
      latex: 'x',
      caret: 1,
    });
    expect(inlineFormulaAroundCaret('Before \\(x\\) after', 10)).toEqual({
      from: 7,
      to: 12,
      latex: 'x',
      caret: 1,
    });
    expect(inlineFormulaAroundCaret('$$x$$', 3)).toBeNull();
  });

  it('recognizes supported standalone LaTeX display environments', () => {
    const equation = '\\begin{equation}f(x)\\end{equation}';
    expect(displayFormulaFromLatexEnvironment(equation)).toBe(equation);
    expect(formulaFromClipboard('\\begin{align}a&=b\\\\c&=d\\end{align}')).toMatchObject({ kind: 'block' });
    expect(formulaFromClipboard('\\begin{equation}')).toEqual({
      kind: 'block',
      latex: '\\begin{equation}\\end{equation}',
      sourceCaret: '\\begin{equation}'.length,
    });
    expect(formulaFromClipboard('\\begin{array}{cc}a&b\\\\c&d\\end{array}')).toEqual({
      kind: 'block',
      latex: '\\begin{array}{cc}a&b\\\\c&d\\end{array}',
    });
    expect(displayFormulaFromLatexEnvironment('\\begin{unknown}f(x)\\end{unknown}')).toBeNull();
  });

  it('closes a freshly typed LaTeX environment inside a raw inline formula only', () => {
    const begin = '\\begin{equation}';
    expect(latexEnvironmentClosure(begin)).toBe('\\end{equation}');
    expect(latexEnvironmentClosure(`${begin}x`)).toBeNull();
    expect(
      shouldCompleteRawLatexEnvironment({
        parentText: `$${begin}`,
        parentOffset: begin.length + 1,
        begin,
      }),
    ).toBe(true);
    expect(
      shouldCompleteRawLatexEnvironment({
        parentText: `plain ${begin}`,
        parentOffset: begin.length + 6,
        begin,
      }),
    ).toBe(false);
  });

  it('turns delimited or unmistakable pasted TeX into a formula node request', () => {
    expect(formulaFromClipboard('$x^2$')).toEqual({
      kind: 'inline',
      latex: 'x^2',
    });
    expect(formulaFromClipboard('$$\\begin{matrix}a\\end{matrix}$$')).toEqual({
      kind: 'block',
      latex: '\\begin{matrix}a\\end{matrix}',
    });
    expect(formulaFromClipboard('\\frac{a}{b}')).toEqual({
      kind: 'inline',
      latex: '\\frac{a}{b}',
    });
    expect(formulaFromClipboard('\\mathcal{L}(\\theta)')).toEqual({
      kind: 'inline',
      latex: '\\mathcal{L}(\\theta)',
    });
    expect(formulaFromClipboard('\\begin{aligned}a&=b\\\\c&=d\\end{aligned}')).toEqual({
      kind: 'block',
      latex: '\\begin{aligned}a&=b\\\\c&=d\\end{aligned}',
    });
    expect(formulaFromClipboard('\\(x^2 + y^2\\)')).toEqual({
      kind: 'inline',
      latex: 'x^2 + y^2',
    });
    expect(formulaFromClipboard('\\[x^2 + y^2\\]')).toEqual({
      kind: 'block',
      latex: 'x^2 + y^2',
    });
    expect(formulaFromClipboard('ordinary plain text')).toBeNull();
  });

  it('never turns prose or a Markdown document containing LaTeX commands into one formula', () => {
    expect(formulaFromClipboard('A citation \\cite{paper} in prose.')).toBeNull();
    expect(formulaFromClipboard('\\cite{paper}')).toBeNull();
    expect(formulaFromClipboard('First paragraph with \\cite{paper}.\n\nSecond paragraph with $x^2$.')).toBeNull();
  });
});
