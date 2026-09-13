import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { MutableRefObject } from 'react';
import type { CommentStatus } from './comments';

export type CanvasCommentPosition = {
  id: string;
  kind: 'range' | 'position';
  from: number;
  to: number;
  status: CommentStatus;
  number: number;
};

type CommentDecorationsState = {
  positions: CanvasCommentPosition[];
  decorations: DecorationSet;
};

export const commentDecorationsPluginKey = new PluginKey<CommentDecorationsState>('paperCanvasComments');

function clampPosition(position: number, document: ProseMirrorNode): number {
  return Math.min(Math.max(0, Math.round(position)), document.content.size);
}

function targetWasChanged(position: CanvasCommentPosition, transaction: Transaction): boolean {
  let from = position.from;
  let to = position.to;
  let touched = false;
  const { mapping } = transaction;

  for (let index = mapping.from; index < mapping.to; index += 1) {
    mapping.maps[index].forEach((oldStart, oldEnd) => {
      if (oldEnd === oldStart) return;
      if (position.kind === 'position' ? oldStart <= from && from < oldEnd : oldStart < to && from < oldEnd) {
        // A replacement or deletion touched the anchored Markdown content.
        // Insertions have oldStart === oldEnd and intentionally do not orphan it.
        touched = true;
      }
    });
    from = mapping.maps[index].map(from, -1);
    to = mapping.maps[index].map(to, 1);
  }

  return touched;
}

function mapPosition(position: CanvasCommentPosition, transaction: Transaction): CanvasCommentPosition {
  const fromResult = transaction.mapping.mapResult(position.from, -1);
  const toResult = transaction.mapping.mapResult(position.to, 1);
  const contentChanged = targetWasChanged(position, transaction);
  return {
    ...position,
    from: clampPosition(fromResult.pos, transaction.doc),
    to: clampPosition(toResult.pos, transaction.doc),
    status:
      position.status === 'needs-review' || fromResult.deleted || toResult.deleted || contentChanged
        ? 'needs-review'
        : 'active',
  };
}

function createMarker(
  position: CanvasCommentPosition,
  markerClickRef: MutableRefObject<((id: string) => void) | undefined>,
): HTMLElement {
  const marker = document.createElement('button');
  marker.type = 'button';
  marker.className =
    position.status === 'needs-review' ? 'comment-marker comment-marker--needs-review' : 'comment-marker';
  marker.dataset.commentId = position.id;
  marker.dataset.commentMarker = '';
  marker.textContent = String(position.number);
  marker.setAttribute('aria-label', `Comment ${position.number}`);
  marker.addEventListener('mousedown', (event) => event.preventDefault());
  marker.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    markerClickRef.current?.(position.id);
  });
  return marker;
}

function buildDecorations(
  document: ProseMirrorNode,
  positions: CanvasCommentPosition[],
  markerClickRef: MutableRefObject<((id: string) => void) | undefined>,
): DecorationSet {
  const decorations: Decoration[] = [];
  positions.forEach((position) => {
    const from = clampPosition(position.from, document);
    const to = clampPosition(position.to, document);
    if (position.kind === 'range' && from < to) {
      decorations.push(
        Decoration.inline(from, to, {
          class:
            position.status === 'needs-review'
              ? 'comment-highlight comment-highlight--needs-review'
              : 'comment-highlight',
          'data-comment-id': position.id,
        }),
      );
      return;
    }
    decorations.push(
      Decoration.widget(from, () => createMarker(position, markerClickRef), {
        side: 1,
        key: `comment-marker-${position.id}`,
      }),
    );
  });
  return decorations.length > 0 ? DecorationSet.create(document, decorations) : DecorationSet.empty;
}

export function createCommentDecorationsExtension(
  markerClickRef: MutableRefObject<((id: string) => void) | undefined>,
): Extension {
  return Extension.create({
    name: 'paperCanvasComments',
    addProseMirrorPlugins() {
      return [
        new Plugin<CommentDecorationsState>({
          key: commentDecorationsPluginKey,
          state: {
            init: () => ({
              positions: [],
              decorations: DecorationSet.empty,
            }),
            apply: (transaction, current) => {
              const requested = transaction.getMeta(commentDecorationsPluginKey) as CanvasCommentPosition[] | undefined;
              if (requested) {
                return {
                  positions: requested,
                  decorations: buildDecorations(transaction.doc, requested, markerClickRef),
                };
              }
              if (!transaction.docChanged) return current;
              const positions = current.positions.map((position) => mapPosition(position, transaction));
              const statusChanged = positions.some((position, index) => position.status !== current.positions[index]?.status);
              return {
                positions,
                decorations: statusChanged
                  ? buildDecorations(transaction.doc, positions, markerClickRef)
                  : current.decorations.map(transaction.mapping, transaction.doc),
              };
            },
          },
          props: {
            decorations: (state) => commentDecorationsPluginKey.getState(state)?.decorations ?? DecorationSet.empty,
            handleClick: (_view, _position, event) => {
              const target =
                event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-comment-id]') : null;
              const id = target?.dataset.commentId;
              if (!id) return false;
              markerClickRef.current?.(id);
              return true;
            },
          },
        }),
      ];
    },
  });
}
