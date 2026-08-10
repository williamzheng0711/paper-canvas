import { describe, expect, it } from 'vitest';
import { captureViewport, clampProgress, offsetAtProgress, restoreViewport } from './modeTransition';

describe('editor mode transitions', () => {
  it('restores document progress when the two modes have different heights', () => {
    const canvas = {
      clientHeight: 600,
      scrollHeight: 26_600,
      scrollTop: 18_200,
    };
    const source = { clientHeight: 600, scrollHeight: 12_000, scrollTop: 0 };

    const snapshot = captureViewport(canvas);

    expect(snapshot.progress).toBeCloseTo(0.7);
    expect(restoreViewport(source, snapshot)).toBeCloseTo(7_980);
    expect(source.scrollTop).toBeCloseTo(7_980);
  });

  it('keeps the top stable for documents that do not scroll', () => {
    const viewport = { clientHeight: 600, scrollHeight: 400, scrollTop: 200 };

    expect(captureViewport(viewport)).toEqual({ progress: 0 });
    expect(restoreViewport(viewport, { progress: 0.8 })).toBe(0);
    expect(viewport.scrollTop).toBe(0);
  });

  it('clamps invalid progress before mapping a cursor position', () => {
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(offsetAtProgress(200, -1)).toBe(0);
    expect(offsetAtProgress(200, 1.5)).toBe(200);
    expect(offsetAtProgress(200, 0.375)).toBe(75);
  });
});
