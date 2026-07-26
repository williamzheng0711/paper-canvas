import { ResizableNodeView } from '@tiptap/core';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

const globals = ['document', 'window', 'HTMLElement', 'KeyboardEvent', 'MouseEvent'] as const;
const originalGlobals = new Map(globals.map((name) => [name, globalThis[name]]));

afterEach(() => {
  originalGlobals.forEach((value, name) => {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = value;
  });
});

function resizeWithShift(shiftKey: boolean): { height: number; width: number } {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
  });

  const image = document.createElement('img');
  Object.defineProperties(image, {
    offsetWidth: { get: () => Number.parseInt(image.style.width, 10) || 100 },
    offsetHeight: { get: () => Number.parseInt(image.style.height, 10) || 50 },
  });
  const committed: Array<{ height: number; width: number }> = [];
  const nodeView = new ResizableNodeView({
    element: image,
    editor: { isEditable: true, on: () => undefined, off: () => undefined } as never,
    node: { attrs: { height: 50, width: 100 }, type: { isInline: false, name: 'image' } } as never,
    getPos: () => 0,
    onCommit: (width, height) => committed.push({ width, height }),
    onUpdate: () => true,
    options: {
      directions: ['bottom-right'],
      min: { height: 60, width: 80 },
      preserveAspectRatio: false,
    },
  });
  const handle = nodeView.dom.querySelector('[data-resize-handle="bottom-right"]');
  expect(handle).not.toBeNull();

  handle?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }));
  if (shiftKey) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
  document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 10 }));
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  nodeView.destroy();
  return committed.at(-1) ?? { height: 0, width: 0 };
}

describe('image resize interaction', () => {
  it('allows independent dimensions during normal corner dragging', () => {
    expect(resizeWithShift(false)).toEqual({ width: 200, height: 60 });
  });

  it('preserves the original ratio while Shift is held during corner dragging', () => {
    expect(resizeWithShift(true)).toEqual({ width: 200, height: 100 });
  });
});
