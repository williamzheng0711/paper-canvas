import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchableEditorHandle } from '../editor/search';
import { MarkdownSourceEditor } from './MarkdownSourceEditor';

describe('MarkdownSourceEditor search', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
  afterAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false }));

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('highlights, selects, navigates, clears, and restores focus', async () => {
    const search = createRef<SwitchableEditorHandle>();
    await act(async () => {
      root.render(
        <MarkdownSourceEditor
          ref={search}
          language="en"
          value={'# Alpha\n\nalpha and ALPHA'}
          valueRevision={0}
          onChange={vi.fn()}
        />,
      );
    });

    expect(search.current?.search('alpha', 'reset')).toEqual({
      current: 1,
      total: 3,
    });
    expect(search.current?.getSelectedText()).toBe('Alpha');
    expect(host.querySelectorAll('.cm-document-search-match')).toHaveLength(3);
    expect(host.querySelectorAll('.cm-document-search-match--active')).toHaveLength(1);
    expect(search.current?.search('alpha', 'next')).toEqual({
      current: 2,
      total: 3,
    });
    expect(search.current?.search('alpha', 'previous')).toEqual({
      current: 1,
      total: 3,
    });

    search.current?.clearSearch();
    expect(host.querySelectorAll('.cm-document-search-match')).toHaveLength(0);
    expect(search.current?.setMarkdownOffset?.(17)).toBe(true);
    expect(search.current?.getMarkdownOffset?.()).toBe(17);
    search.current?.focus();
    expect(document.activeElement).toBe(host.querySelector('.cm-content'));
  });
});
