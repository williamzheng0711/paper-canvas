import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForRenderedImages } from './renderedImages';

afterEach(() => vi.useRealTimers());

function canvasImage(): { container: HTMLElement; image: HTMLImageElement } {
  const container = document.createElement('div');
  const image = document.createElement('img');
  image.src = 'data:image/png;base64,dGVzdA==';
  container.append(image);
  return { container, image };
}

describe('rendered image PDF readiness', () => {
  it('waits for decode even when the image load is already complete', async () => {
    const { container, image } = canvasImage();
    Object.defineProperty(image, 'complete', { value: true });
    let finishDecode!: () => void;
    image.decode = vi.fn(() => new Promise<void>((resolve) => { finishDecode = resolve; }));
    let ready = false;
    const waiting = waitForRenderedImages(container)!.then(() => { ready = true; });
    await Promise.resolve();
    expect(image.decode).toHaveBeenCalledOnce();
    expect(ready).toBe(false);
    finishDecode();
    await waiting;
    expect(ready).toBe(true);
  });

  it.each(['load', 'error'])('waits for %s on browsers without decode', async (event) => {
    const { container, image } = canvasImage();
    let ready = false;
    const waiting = waitForRenderedImages(container)!.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    image.dispatchEvent(new Event(event));
    await waiting;
    expect(ready).toBe(true);
  });

  it('accepts already broken images and does not wait on completed fallback images', async () => {
    const { container, image } = canvasImage();
    image.decode = vi.fn(async () => { throw new Error('Broken image'); });
    await expect(waitForRenderedImages(container)).resolves.toBeUndefined();
    image.decode = undefined as unknown as HTMLImageElement['decode'];
    Object.defineProperty(image, 'complete', { value: true });
    expect(waitForRenderedImages(container)).toBeUndefined();
  });

  it('rejects a stalled image instead of capturing it prematurely or waiting indefinitely', async () => {
    vi.useFakeTimers();
    const { container } = canvasImage();
    const rejected = expect(waitForRenderedImages(container, 100)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });
});
