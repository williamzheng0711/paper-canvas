import { describe, expect, it } from 'vitest';
import { normalizeFontSize } from './fontSize';

describe('font size control', () => {
  it('normalizes a completed numeric value and retains the prior value for an empty draft', () => {
    expect(normalizeFontSize('17', 18)).toBe(17);
    expect(normalizeFontSize('1', 18)).toBe(13);
    expect(normalizeFontSize('', 18)).toBe(18);
  });

  it('keeps the editor size within readable bounds on commit', () => {
    expect(normalizeFontSize('7', 18)).toBe(13);
    expect(normalizeFontSize('31', 18)).toBe(30);
    expect(normalizeFontSize('22.6', 18)).toBe(23);
  });
});
