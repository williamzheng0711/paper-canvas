import { getMessages } from '../i18n';

/** Wait for the canvas images to settle before native PDF captures the DOM. */
export function waitForRenderedImages(container: ParentNode, timeoutMs = 15_000): Promise<void> | undefined {
  const images = Array.from(container.querySelectorAll<HTMLImageElement>('img[src]'))
    .filter((image) => !image.complete || typeof image.decode === 'function');
  if (images.length === 0) return undefined;
  const cleanups: (() => void)[] = [];
  const ready = Promise.all(images.map((image) => {
    if (typeof image.decode === 'function') {
      // A decode rejection is a settled broken image; export may retain its
      // placeholder, but must not capture a valid image before decoding ends.
      return Promise.resolve().then(() => image.decode()).catch(() => undefined);
    }
    return new Promise<void>((resolve) => {
      const settled = () => resolve();
      image.addEventListener('load', settled, { once: true });
      image.addEventListener('error', settled, { once: true });
      cleanups.push(() => {
        image.removeEventListener('load', settled);
        image.removeEventListener('error', settled);
      });
      if (image.complete) settled();
    });
  })).then(() => undefined);
  let timer: number;
  const timeout = new Promise<void>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(getMessages().pdfExportFailed)), timeoutMs);
  });
  return Promise.race([ready, timeout]).finally(() => {
    window.clearTimeout(timer);
    cleanups.forEach((cleanup) => cleanup());
  });
}
