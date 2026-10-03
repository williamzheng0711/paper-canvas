import { Extension } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { MutableRefObject } from 'react';
import type { CommentStatus } from './comments';
import { canvasDocumentSupported } from './canvasCapacity';

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

function mapPosition(
  position: CanvasCommentPosition,
  transaction: Transaction,
): { position: CanvasCommentPosition; targetChanged: boolean } {
  let from = position.from;
  let to = position.to;
  let touched = false;
  const { mapping } = transaction;

  for (let index = mapping.from; index < mapping.to; index += 1) {
    mapping.maps[index].forEach((oldStart, oldEnd) => {
      if (oldEnd === oldStart) return;
      if (
        position.kind === 'position' || from === to ? oldStart <= from && from < oldEnd : oldStart < to && from < oldEnd
      ) {
        // A replacement or deletion touched the anchored Markdown content.
        // Insertions have oldStart === oldEnd and intentionally do not orphan it.
        touched = true;
      }
    });
    // Match Decoration.inline's exclusive endpoints and the marker widget's
    // right affinity. A deleted range becomes a point for all later steps.
    const endAffinity = position.kind === 'position' || from === to ? 1 : -1;
    const fromResult = mapping.maps[index].mapResult(from, 1);
    const toResult = mapping.maps[index].mapResult(to, endAffinity);
    touched ||= fromResult.deleted || toResult.deleted;
    from = Math.min(fromResult.pos, toResult.pos);
    to = Math.max(fromResult.pos, toResult.pos);
  }

  return {
    position: {
      ...position,
      from: clampPosition(from, transaction.doc),
      to: clampPosition(to, transaction.doc),
      status: position.status === 'needs-review' || touched ? 'needs-review' : 'active',
    },
    targetChanged: touched,
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
        key: JSON.stringify(['comment-marker', position.id, position.number, position.status]),
      }),
    );
  });
  return decorations.length > 0 ? DecorationSet.create(document, decorations) : DecorationSet.empty;
}

export function createCommentDecorationsExtension(
  markerClickRef: MutableRefObject<((id: string) => void) | undefined>,
  onLimit: () => void = () => undefined,
): Extension {
  return Extension.create({
    name: 'paperCanvasComments',
    addProseMirrorPlugins() {
      return [
        new Plugin<CommentDecorationsState>({
          key: commentDecorationsPluginKey,
          filterTransaction: (transaction, state) => {
            const requested = transaction.getMeta(commentDecorationsPluginKey) as CanvasCommentPosition[] | undefined;
            if (!requested && !transaction.docChanged) return true;
            const current = requested ?? commentDecorationsPluginKey.getState(state)?.positions ?? [];
            if (!current.length) return true;
            const positions = transaction.docChanged && !requested
              ? current.map((position) => mapPosition(position, transaction).position)
              : current;
            const comments = positions.map((position) => ({
              target: position.kind === 'position'
                ? { kind: 'position' as const }
                : { kind: 'range' as const, from: position.from, to: position.to },
            }));
            if (canvasDocumentSupported(transaction.doc, comments)) return true;
            onLimit();
            return false;
          },
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
              const mapped = current.positions.map((position) => mapPosition(position, transaction));
              const positions = mapped.map((result) => result.position);
              const targetChanged = mapped.some((result) => result.targetChanged);
              return {
                positions,
                decorations:
                  targetChanged
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
