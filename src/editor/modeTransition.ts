export type ViewportSnapshot = {
  progress: number;
};

type ScrollViewport = Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>;

export function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

/** Capture a document-relative location instead of a mode-specific pixel offset. */
export function captureViewport(viewport: ScrollViewport): ViewportSnapshot {
  const maximumScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return {
    progress: maximumScroll === 0 ? 0 : clampProgress(viewport.scrollTop / maximumScroll),
  };
}

/** Restore the same relative document location after the editor layout changes. */
export function restoreViewport(viewport: ScrollViewport, snapshot: ViewportSnapshot): number {
  const maximumScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  const scrollTop = clampProgress(snapshot.progress) * maximumScroll;
  viewport.scrollTop = scrollTop;
  return scrollTop;
}

export function offsetAtProgress(length: number, progress: number): number {
  return Math.round(Math.max(0, length) * clampProgress(progress));
}
