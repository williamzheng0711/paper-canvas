import { describe, expect, it } from 'vitest';
import { normalizeLineSpacing } from './lineSpacing';

describe('line spacing control', () => {
  it('accepts decimal multipliers and retains the prior value for an empty draft', () => {
    expect(normalizeLineSpacing('1.5', 1.78)).toBe(1.5);
    expect(normalizeLineSpacing('2.25', 1.78)).toBe(2.25);
    expect(normalizeLineSpacing('', 1.78)).toBe(1.78);
  });

  it('keeps line spacing within readable bounds and rounds persisted values', () => {
    expect(normalizeLineSpacing('0.8', 1.78)).toBe(1);
    expect(normalizeLineSpacing('3.4', 1.78)).toBe(3);
    expect(normalizeLineSpacing('1.666', 1.78)).toBe(1.67);
    expect(normalizeLineSpacing('not-a-number', 1.78)).toBe(1.78);
  });
});
