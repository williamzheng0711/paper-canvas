import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commentDecorationsPluginKey,
  createCommentDecorationsExtension,
  type CanvasCommentPosition,
} from './commentDecorations';

describe('canvas comment decorations', () => {
  const editors: Editor[] = [];

  afterEach(() => {
    editors.forEach((editor) => editor.destroy());
    editors.length = 0;
    document.body.replaceChildren();
  });

  function createEditor(text = 'alpha beta', onLimit = () => undefined) {
    const host = document.createElement('div');
    document.body.append(host);
    const onCommentClick = vi.fn();
    const markerClickRef = { current: onCommentClick };
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, createCommentDecorationsExtension(markerClickRef, onLimit)],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text }],
          },
        ],
      },
    });
    editors.push(editor);
    return { editor, host, onCommentClick };
  }

  function setPositions(editor: Editor, positions: CanvasCommentPosition[]) {
    editor.view.dispatch(editor.state.tr.setMeta(commentDecorationsPluginKey, positions));
  }

  it('renders range highlights and clickable position markers', () => {
    const { editor, host, onCommentClick } = createEditor();
    setPositions(editor, [
      {
        id: 'range',
        kind: 'range',
        from: 1,
        to: 6,
        status: 'active',
        number: 1,
      },
      {
        id: 'position',
        kind: 'position',
        from: 7,
        to: 7,
        status: 'active',
        number: 2,
      },
    ]);

    expect(host.querySelector('[data-comment-id="range"]')).not.toBeNull();
    expect(host.querySelector('.comment-highlight')).not.toBeNull();
    const marker = host.querySelector<HTMLButtonElement>('[data-comment-marker=""]');
    expect(marker?.textContent).toBe('2');

    marker?.click();
    expect(onCommentClick).toHaveBeenCalledWith('position');
  });

  it('maps positions through document edits and marks deleted anchors for review', () => {
    const { editor } = createEditor();
    setPositions(editor, [
      {
        id: 'range',
        kind: 'range',
        from: 1,
        to: 6,
        status: 'active',
        number: 1,
      },
    ]);

    editor.view.dispatch(editor.state.tr.insertText('new ', 1, 1));
    const afterInsert = commentDecorationsPluginKey.getState(editor.state)?.positions[0];
    expect(afterInsert?.to).toBeGreaterThan(6);
    expect(afterInsert?.status).toBe('active');

    editor.view.dispatch(editor.state.tr.delete(afterInsert!.from, afterInsert!.to));
    const afterDelete = commentDecorationsPluginKey.getState(editor.state)?.positions[0];
    expect(afterDelete?.status).toBe('needs-review');
    expect(afterDelete?.from).toBe(afterDelete?.to);
  });

  it('refreshes point marker numbering without changing the document or history', () => {
    const { editor, host, onCommentClick } = createEditor();
    const position: CanvasCommentPosition = {
      id: 'point', kind: 'position', from: 7, to: 7, status: 'active', number: 2,
    };
    setPositions(editor, [position]);
    const before = editor.getJSON();

    setPositions(editor, [{ ...position, number: 1 }]);

    const marker = host.querySelector<HTMLButtonElement>('[data-comment-marker]');
    expect(marker?.textContent).toBe('1');
    expect(marker?.getAttribute('aria-label')).toBe('Comment 1');
    marker?.click();
    expect(onCommentClick).toHaveBeenCalledOnce();
    expect(onCommentClick).toHaveBeenCalledWith('point');
    expect(editor.getJSON()).toEqual(before);
    expect(editor.can().undo()).toBe(false);
  });

  it('refreshes the review appearance of retained point markers in both directions', () => {
    const { editor, host } = createEditor();
    const position: CanvasCommentPosition = {
      id: 'point', kind: 'position', from: 7, to: 7, status: 'active', number: 1,
    };
    setPositions(editor, [position]);

    setPositions(editor, [{ ...position, status: 'needs-review' }]);
    expect(host.querySelector('.comment-marker--needs-review')?.textContent).toBe('1');

    setPositions(editor, [position]);
    expect(host.querySelector('[data-comment-marker]')?.textContent).toBe('1');
    expect(host.querySelector('.comment-marker--needs-review')).toBeNull();
  });

  it('rejects excessive point decorations before building their DOM', () => {
    const onLimit = vi.fn();
    const { editor, host } = createEditor('alpha beta', onLimit);
    const positions: CanvasCommentPosition[] = Array.from({ length: 12_000 }, (_, index) => ({
      id: `point-${index}`, kind: 'position', from: 1, to: 1, status: 'active', number: index + 1,
    }));
    const before = editor.getJSON();

    setPositions(editor, positions);

    expect(onLimit).toHaveBeenCalledOnce();
    expect(commentDecorationsPluginKey.getState(editor.state)?.positions).toEqual([]);
    expect(host.querySelectorAll('[data-comment-marker]')).toHaveLength(0);
    expect(editor.getJSON()).toEqual(before);
    expect(positions).toHaveLength(12_000);
    expect(editor.can().undo()).toBe(false);
  });

  it('rejects a range deletion that would create excessive widgets and preserves usable history', () => {
    const onLimit = vi.fn();
    const { editor, host } = createEditor('alpha beta', onLimit);
    const positions: CanvasCommentPosition[] = Array.from({ length: 12_000 }, (_, index) => ({
      id: `range-${index}`, kind: 'range', from: 1, to: 6, status: 'active', number: index + 1,
    }));
    setPositions(editor, positions);
    const before = editor.getJSON();

    editor.view.dispatch(editor.state.tr.delete(1, 6));

    expect(onLimit).toHaveBeenCalledOnce();
    expect(editor.getJSON()).toEqual(before);
    expect(commentDecorationsPluginKey.getState(editor.state)?.positions).toEqual(positions);
    expect(host.querySelectorAll('[data-comment-marker]')).toHaveLength(0);
    expect(editor.can().undo()).toBe(false);
    editor.view.dispatch(editor.state.tr.insertText('new ', 1));
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getJSON()).toEqual(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.textContent).toBe('new alpha beta');
  });

  it('keeps repeated edits bounded with a large comment decoration set', () => {
    const { editor, host } = createEditor('x'.repeat(20_000));
    const count = 750;
    setPositions(
      editor,
      Array.from({ length: count }, (_, index) => ({
        id: `comment-${index}`,
        kind: 'position' as const,
        from: 1 + index * 20,
        to: 1 + index * 20,
        status: 'active' as const,
        number: index + 1,
      })),
    );

    const started = performance.now();
    for (let index = 0; index < 120; index += 1) {
      editor.view.dispatch(editor.state.tr.insertText('x', 1, 1));
    }
    const elapsed = performance.now() - started;
    console.info(`750 comment decorations × 120 edits: ${elapsed.toFixed(1)} ms`);

    expect(host.querySelectorAll('[data-comment-marker]').length).toBe(count);
    expect(elapsed).toBeLessThan(1_500);
  });

  it('keeps point anchors at the displayed marker when text is inserted at their position', () => {
    const { editor } = createEditor();
    setPositions(editor, [
      {
        id: 'point',
        kind: 'position',
        from: 7,
        to: 7,
        status: 'active',
        number: 1,
      },
    ]);

    editor.view.dispatch(editor.state.tr.insertText('new ', 7, 7));

    const state = commentDecorationsPluginKey.getState(editor.state)!;
    expect(state.positions[0].from).toBe(state.decorations.find()[0].from);
    expect(state.positions[0].from).toBe(11);
    expect(state.positions[0].to).toBe(11);
  });

  it('keeps persisted range bounds consistent with the highlight after boundary insertions', () => {
    const { editor, host } = createEditor();
    setPositions(editor, [
      {
        id: 'range',
        kind: 'range',
        from: 7,
        to: 11,
        status: 'active',
        number: 1,
      },
    ]);

    editor.view.dispatch(editor.state.tr.insertText('new ', 7, 7));
    editor.view.dispatch(editor.state.tr.insertText(' ending', 15, 15));

    const state = commentDecorationsPluginKey.getState(editor.state)!;
    const decoration = state.decorations.find()[0];
    expect(state.positions[0].from).toBe(decoration.from);
    expect(state.positions[0].to).toBe(decoration.to);
    expect(host.querySelector('.comment-highlight')?.textContent).toBe('beta');
    expect(state.positions[0].status).toBe('active');
  });

  it('keeps a range active when adjacent text is deleted', () => {
    const { editor } = createEditor();
    setPositions(editor, [
      {
        id: 'range',
        kind: 'range',
        from: 7,
        to: 11,
        status: 'active',
        number: 1,
      },
    ]);

    editor.view.dispatch(editor.state.tr.delete(1, 7));

    expect(commentDecorationsPluginKey.getState(editor.state)?.positions[0]).toMatchObject({
      from: 1,
      to: 5,
      status: 'active',
    });
  });

  it('keeps a collapsed range aligned with its marker on later insertion', () => {
    const { editor } = createEditor();
    setPositions(editor, [
      {
        id: 'range',
        kind: 'range',
        from: 7,
        to: 11,
        status: 'active',
        number: 1,
      },
    ]);
    editor.view.dispatch(editor.state.tr.delete(7, 11));

    editor.view.dispatch(editor.state.tr.insertText('new ', 7, 7));

    const state = commentDecorationsPluginKey.getState(editor.state)!;
    expect(state.positions[0]).toMatchObject({
      from: 11,
      to: 11,
      status: 'needs-review',
    });
    expect(state.decorations.find()[0].from).toBe(11);
  });

  it('retains a review highlight when its entire range is replaced again', () => {
    const { editor, host } = createEditor();
    setPositions(editor, [
      {
        id: 'range',
        kind: 'range',
        from: 7,
        to: 11,
        status: 'needs-review',
        number: 1,
      },
    ]);

    editor.view.dispatch(editor.state.tr.insertText('replacement', 7, 11));

    const state = commentDecorationsPluginKey.getState(editor.state)!;
    expect(state.positions[0]).toMatchObject({
      from: 7,
      to: 18,
      status: 'needs-review',
    });
    expect(host.querySelector('.comment-highlight')?.textContent).toBe('replacement');
  });

  it('maps each step in a compound edit using the updated range bounds', () => {
    const { editor, host } = createEditor();
    setPositions(editor, [{ id: 'range', kind: 'range', from: 7, to: 11, status: 'active', number: 1 }]);

    editor.view.dispatch(editor.state.tr.insertText('replacement', 7, 11).insertText('new ', 7, 7));

    const state = commentDecorationsPluginKey.getState(editor.state)!;
    expect(state.positions[0]).toMatchObject({ from: 11, to: 22, status: 'needs-review' });
    expect(host.querySelector('.comment-highlight')?.textContent).toBe('replacement');
  });

  it('keeps a deleted range collapsed through later steps in the same transaction', () => {
    const { editor, host } = createEditor();
    setPositions(editor, [{ id: 'range', kind: 'range', from: 7, to: 11, status: 'active', number: 1 }]);

    editor.view.dispatch(editor.state.tr.delete(7, 11).insertText('new ', 7, 7));

    const state = commentDecorationsPluginKey.getState(editor.state)!;
    expect(state.positions[0]).toMatchObject({ from: 11, to: 11, status: 'needs-review' });
    expect(host.querySelector('.comment-highlight')).toBeNull();
    expect(state.decorations.find()[0].from).toBe(11);
  });
});
