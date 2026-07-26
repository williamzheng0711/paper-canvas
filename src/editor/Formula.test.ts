import { describe, expect, it } from 'vitest';
import {
  completeFormulaFieldInput,
  formulaBoundaryTarget,
  formulaFieldBoundaryAction,
  validateLatex,
} from './Formula';

describe('formula safety and cursor boundaries', () => {
  it('accepts matrices, cases, aligned equations, and Chinese-adjacent inline math', () => {
    expect(validateLatex('\\begin{matrix}a & b\\\\ c & d\\end{matrix}')).toBeNull();
    expect(validateLatex('f(x)=\\begin{cases}x^2 & x>0\\\\0 & x\\leq0\\end{cases}')).toBeNull();
    expect(validateLatex('\\begin{aligned}a&=b\\\\c&=d\\end{aligned}', true)).toBeNull();
    expect(validateLatex('\\mathbb{E}_{x\\sim p}[f_\\theta(x)]')).toBeNull();
  });

  it('returns a local error for invalid LaTeX instead of throwing', () => {
    expect(validateLatex('\\definitelyNotALatexCommand{')).toMatch(
      /ParseError|Undefined control sequence|KaTeX/,
    );
  });

  it('moves a selected formula node naturally back to the surrounding text', () => {
    const selection = { from: 12, to: 13, nodeType: 'inlineFormula' };
    expect(formulaBoundaryTarget(selection, 'ArrowLeft')).toBe(12);
    expect(formulaBoundaryTarget(selection, 'ArrowRight')).toBe(13);
    expect(formulaBoundaryTarget({ ...selection, nodeType: 'image' }, 'ArrowLeft')).toBeNull();
  });

  it('returns text-boundary actions from an active MathLive field without swallowing edits', () => {
    expect(
      formulaFieldBoundaryAction({
        key: 'ArrowLeft',
        selectionIsCollapsed: true,
        position: 0,
        lastOffset: 4,
        latex: 'x^2',
      }),
    ).toBe('before');
    expect(
      formulaFieldBoundaryAction({
        key: 'ArrowRight',
        selectionIsCollapsed: true,
        position: 4,
        lastOffset: 4,
        latex: 'x^2',
      }),
    ).toBe('after');
    expect(
      formulaFieldBoundaryAction({
        key: 'Backspace',
        selectionIsCollapsed: true,
        position: 0,
        lastOffset: 0,
        latex: '',
      }),
    ).toBe('remove');
    expect(
      formulaFieldBoundaryAction({
        key: 'Delete',
        selectionIsCollapsed: true,
        position: 2,
        lastOffset: 4,
        latex: 'x^2',
      }),
    ).toBeNull();
  });

  it('inserts a matching environment close command in a MathLive field and keeps the caret before it', () => {
    let latex = '\\begin{equation}';
    let insertedOptions: unknown;
    const field = {
      getValue: () => latex,
      insert: (text: string, options: unknown) => {
        latex += text;
        insertedOptions = options;
        return true;
      },
    };

    expect(completeFormulaFieldInput(field)).toBe('\\begin{equation}\\end{equation}');
    expect(insertedOptions).toMatchObject({
      format: 'latex',
      selectionMode: 'before',
      silenceNotifications: true,
    });
  });
});
