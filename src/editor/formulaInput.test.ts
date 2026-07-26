import { describe, expect, it } from 'vitest';
import {
  displayFormulaFromDelimitedLine,
  formulaFromClipboard,
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
    expect(formulaFromClipboard('$x^2$')).toEqual({ kind: 'inline', latex: 'x^2' });
    expect(formulaFromClipboard('$$\\begin{matrix}a\\end{matrix}$$')).toEqual({
      kind: 'block',
      latex: '\\begin{matrix}a\\end{matrix}',
    });
    expect(formulaFromClipboard('\\frac{a}{b}')).toEqual({ kind: 'inline', latex: '\\frac{a}{b}' });
    expect(formulaFromClipboard('\\mathcal{L}(\\theta)')).toEqual({
      kind: 'inline',
      latex: '\\mathcal{L}(\\theta)',
    });
    expect(formulaFromClipboard('\\begin{aligned}a&=b\\\\c&=d\\end{aligned}')).toEqual({
      kind: 'block',
      latex: '\\begin{aligned}a&=b\\\\c&=d\\end{aligned}',
    });
    expect(formulaFromClipboard('ordinary plain text')).toBeNull();
  });
});
