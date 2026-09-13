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

  function createEditor() {
    const host = document.createElement('div');
    document.body.append(host);
    const onCommentClick = vi.fn();
    const markerClickRef = { current: onCommentClick };
    const editor = new Editor({
      element: host,
      extensions: [StarterKit, createCommentDecorationsExtension(markerClickRef)],
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'alpha beta' }],
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
});
