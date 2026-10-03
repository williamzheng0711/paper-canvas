import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CommentPlacement, MarkdownComment } from '../editor/comments';
import { getMessages, type Language } from '../i18n';

type Props = {
  language: Language;
  comments: readonly MarkdownComment[];
  newTarget?: CommentPlacement | null;
  activeCommentId?: string;
  onClose: () => void;
  onCreate: (content: string, placement: CommentPlacement) => void;
  onCancelNew: () => void;
  onUpdate: (id: string, content: string) => void;
  onDelete: (id: string) => void;
  onLocate: (comment: MarkdownComment) => void;
};

const commentsPerPage = 100;

function targetOffset(comment: MarkdownComment): number {
  return comment.target.kind === 'position' ? comment.target.offset : comment.target.from;
}

function targetPreview(comment: MarkdownComment): string {
  if (comment.target.kind === 'range' && comment.excerpt) return comment.excerpt;
  const before = comment.contextBefore.slice(-46);
  const after = comment.contextAfter.slice(0, 46);
  if (before || after) return `${before ? `…${before}` : ''}${after ? `${after}…` : ''}`;
  return comment.excerpt || '…';
}

export const CommentsPanel = memo(function CommentsPanel({
  language,
  comments,
  newTarget,
  activeCommentId,
  onClose,
  onCreate,
  onCancelNew,
  onUpdate,
  onDelete,
  onLocate,
}: Props) {
  const text = getMessages(language);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [page, setPage] = useState(0);
  const newInput = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!newTarget) return;
    setDraft('');
    setEditingId(null);
    requestAnimationFrame(() => newInput.current?.focus());
  }, [newTarget]);

  useEffect(() => {
    if (editingId && !comments.some((comment) => comment.id === editingId)) {
      setEditingId(null);
      setEditingValue('');
    }
  }, [comments, editingId]);

  const orderedComments = useMemo(
    () => [...comments].sort((left, right) => targetOffset(left) - targetOffset(right)),
    [comments],
  );
  const lastPage = Math.max(0, Math.ceil(orderedComments.length / commentsPerPage) - 1);
  const currentPage = Math.min(page, lastPage);
  const firstComment = currentPage * commentsPerPage;
  const visibleComments = orderedComments.slice(firstComment, firstComment + commentsPerPage);

  useEffect(() => {
    const activeIndex = orderedComments.findIndex((comment) => comment.id === activeCommentId);
    if (activeIndex >= 0) setPage(Math.floor(activeIndex / commentsPerPage));
  }, [activeCommentId, orderedComments]);

  useEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
  }, [currentPage]);

  const startEditing = (comment: MarkdownComment) => {
    setEditingId(comment.id);
    setEditingValue(comment.content);
  };

  return (
    <aside ref={panel} className="comments-panel" aria-label={text.comments}>
      <header className="comments-panel__header">
        <div className="comments-panel__title">
          <strong>{text.commentsCount(comments.length)}</strong>
          <span>{text.commentNearbyText}</span>
        </div>
        <button type="button" className="comments-panel__close" aria-label={text.closeComments} onClick={onClose}>
          ×
        </button>
      </header>

      {lastPage > 0 && (
        <nav className="comments-panel__pagination" aria-label={text.comments}>
          <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{text.commentPreviousPage}</button>
          <span aria-live="polite">{text.commentPageRange(firstComment + 1, Math.min(firstComment + commentsPerPage, orderedComments.length), orderedComments.length)}</span>
          <button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>{text.commentNextPage}</button>
        </nav>
      )}

      {newTarget && (
        <form
          className="comment-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft.trim()) return;
            onCreate(draft, newTarget);
            setDraft('');
          }}
        >
          <div className="comment-card__eyebrow">
            {newTarget.target.kind === 'range' ? text.commentRange : text.commentPosition}
          </div>
          <blockquote className="comment-card__quote">
            {newTarget.excerpt || (newTarget.target.kind === 'range' ? '…' : text.commentNearbyText)}
          </blockquote>
          <textarea
            ref={newInput}
            value={draft}
            placeholder={text.commentPlaceholder}
            aria-label={text.commentPlaceholder}
            rows={4}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <div className="comment-composer__actions">
            <button type="submit" className="comment-primary" disabled={!draft.trim()}>
              {text.commentSave}
            </button>
            <button type="button" onClick={onCancelNew}>
              {text.commentCancel}
            </button>
          </div>
          {!draft.trim() && draft.length > 0 && <div className="comment-error">{text.commentEmpty}</div>}
        </form>
      )}

      {orderedComments.length === 0 && !newTarget ? (
        <p className="comments-panel__empty">{text.commentNoComments}</p>
      ) : (
        <div className="comments-list">
          {visibleComments.map((comment, index) => {
            const editing = editingId === comment.id;
            return (
              <article
                key={comment.id}
                className={activeCommentId === comment.id ? 'comment-card is-active' : 'comment-card'}
                data-comment-card={comment.id}
              >
                <div className="comment-card__header">
                  <span className="comment-card__number">{String(firstComment + index + 1).padStart(2, '0')}</span>
                  <span>{comment.target.kind === 'range' ? text.commentRange : text.commentPosition}</span>
                  {comment.status === 'needs-review' && (
                    <span className="comment-card__status">{text.commentNeedsReview}</span>
                  )}
                </div>
                <blockquote className="comment-card__quote">{targetPreview(comment)}</blockquote>
                {editing ? (
                  <textarea
                    className="comment-card__editor"
                    value={editingValue}
                    aria-label={text.commentEdit}
                    rows={4}
                    autoFocus
                    onChange={(event) => setEditingValue(event.currentTarget.value)}
                  />
                ) : (
                  <p className="comment-card__content">{comment.content}</p>
                )}
                <div className="comment-card__actions">
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="comment-primary"
                        disabled={!editingValue.trim()}
                        onClick={() => {
                          if (!editingValue.trim()) return;
                          onUpdate(comment.id, editingValue);
                          setEditingId(null);
                          setEditingValue('');
                        }}
                      >
                        {text.commentSave}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(null);
                          setEditingValue('');
                        }}
                      >
                        {text.commentCancel}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" onClick={() => startEditing(comment)}>
                        {text.commentEdit}
                      </button>
                      <button type="button" onClick={() => onLocate(comment)}>
                        {text.commentLocate}
                      </button>
                      <button type="button" className="comment-danger" onClick={() => onDelete(comment.id)}>
                        {text.commentDelete}
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </aside>
  );
});
