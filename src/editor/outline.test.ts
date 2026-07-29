import { describe, expect, it, vi } from 'vitest';
import { scrollToOutlineHeading } from './outline';

describe('outline navigation', () => {
  it('scrolls to the heading at the same document-order index', () => {
    const editor = document.createElement('article');
    editor.innerHTML = '<h1>First</h1><p>Body</p><h3>Second</h3><section><h2>Nested non-editor heading</h2></section>';
    const secondHeading = editor.querySelector('h3');
    const scrollIntoView = vi.fn();
    Object.defineProperty(secondHeading, 'scrollIntoView', {
      value: scrollIntoView,
    });

    expect(scrollToOutlineHeading(editor, 1)).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
    expect(scrollToOutlineHeading(editor, 2)).toBe(false);
  });

  it('scrolls only the canvas and leaves room above the target heading', () => {
    const canvas = document.createElement('section');
    canvas.className = 'canvas-area';
    const editor = document.createElement('article');
    editor.innerHTML = '<h2>Target</h2>';
    canvas.append(editor);
    Object.defineProperty(canvas, 'scrollTop', { value: 100, writable: true });
    Object.defineProperty(canvas, 'scrollTo', { value: vi.fn() });
    canvas.getBoundingClientRect = () => ({ top: 44 }) as DOMRect;
    const heading = editor.querySelector<HTMLElement>('h2');
    if (heading) heading.getBoundingClientRect = () => ({ top: 500 }) as DOMRect;

    expect(scrollToOutlineHeading(editor, 0)).toBe(true);
    expect(canvas.scrollTo).toHaveBeenCalledWith({ top: 536, behavior: 'smooth' });
  });
});
