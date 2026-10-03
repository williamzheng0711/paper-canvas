import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownComment } from '../editor/comments';
import { CommentsPanel } from './CommentsPanel';

describe('large comment panels', () => {
  let host: HTMLDivElement;
  let root: Root;
  const base = createMarkdownComment('hello\n', { kind: 'range', from: 0, to: 5 }, 'Note', 'hello', 'base');
  const comments = Array.from({ length: 12_000 }, (_, index) => ({ ...base, id: `comment-${index}`, content: `Note ${index}` }));
  let props: React.ComponentProps<typeof CommentsPanel>;

  beforeAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
  afterAll(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false }));
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    props = { language: 'en', comments, onClose: vi.fn(), onCreate: vi.fn(), onCancelNew: vi.fn(), onUpdate: vi.fn(), onDelete: vi.fn(), onLocate: vi.fn() };
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

  async function render(changes: Partial<typeof props> = {}) {
    props = { ...props, ...changes };
    await act(async () => root.render(<CommentsPanel {...props} />));
  }
  function button(text: string): HTMLButtonElement {
    return Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent === text)!;
  }
  async function change(input: HTMLTextAreaElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('bounds mounted cards while retaining all comments and original numbering across pages', async () => {
    await render();
    expect(host.querySelectorAll('.comment-card')).toHaveLength(100);
    expect(host.querySelector('.comments-panel__pagination')?.textContent).toContain('1–100 of 12000');
    expect(button('Previous').disabled).toBe(true);
    await act(async () => button('Next').click());
    expect(host.querySelectorAll('.comment-card')).toHaveLength(100);
    expect(host.querySelector('.comment-card__number')?.textContent).toBe('101');
    expect(host.querySelector('.comment-card__content')?.textContent).toBe('Note 100');
    expect(props.comments).toHaveLength(12_000);
    expect(comments[0].content).toBe('Note 0');
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('opens the page containing an activated comment and edits its exact original identity', async () => {
    await render({ activeCommentId: 'comment-11950' });
    expect(host.querySelectorAll('.comment-card')).toHaveLength(100);
    expect(host.querySelector('.comments-panel__pagination')?.textContent).toContain('11901–12000 of 12000');
    expect(button('Next').disabled).toBe(true);
    const card = host.querySelector<HTMLElement>('[data-comment-card="comment-11950"]')!;
    await act(async () => Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent === 'Edit')!.click());
    await change(card.querySelector('textarea')!, 'Updated 中文 🧪\nExact note');
    await act(async () => card.querySelector<HTMLButtonElement>('.comment-primary')!.click());
    expect(props.onUpdate).toHaveBeenCalledWith('comment-11950', 'Updated 中文 🧪\nExact note');
    expect(comments[11950].content).toBe('Note 11950');
  });

  it('retains an unfinished comment edit when navigating away and back', async () => {
    await render({ comments: comments.slice(0, 205) });
    await act(async () => button('Edit').click());
    await change(host.querySelector('textarea')!, 'Unfinished writing');
    await act(async () => button('Next').click());
    expect(host.querySelector('textarea')).toBeNull();
    await act(async () => button('Previous').click());
    expect(host.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('Unfinished writing');
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it('clamps a removed final page without hiding surviving comments', async () => {
    await render({ comments: comments.slice(0, 205) });
    await act(async () => button('Next').click());
    await act(async () => button('Next').click());
    expect(host.querySelectorAll('.comment-card')).toHaveLength(5);
    await render({ comments: comments.slice(0, 200) });
    expect(host.querySelectorAll('.comment-card')).toHaveLength(100);
    expect(host.querySelector('.comment-card__number')?.textContent).toBe('101');
    expect(button('Next').disabled).toBe(true);
    await render({ comments: comments.slice(0, 3) });
    expect(host.querySelectorAll('.comment-card')).toHaveLength(3);
    expect(host.querySelector('.comments-panel__pagination')).toBeNull();
  });
});
