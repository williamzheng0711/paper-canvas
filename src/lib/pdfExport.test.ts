import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined),
  isTauri: vi.fn(() => true),
}));

const dialog = vi.hoisted(() => ({
  save: vi.fn<() => Promise<string | null>>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => path,
  invoke: tauri.invoke,
  isTauri: tauri.isTauri,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
  save: dialog.save,
}));

import { exportPdfFile } from './files';

describe('PDF export', () => {
  const originalUserAgent = navigator.userAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    tauri.isTauri.mockReturnValue(true);
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: originalUserAgent,
    });
    vi.restoreAllMocks();
  });

  it('saves through the native macOS command without opening window.print', async () => {
    dialog.save.mockResolvedValue('/tmp/Research.PDF');
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    await expect(exportPdfFile('Research.md')).resolves.toEqual({
      type: 'saved',
      name: 'Research.PDF',
    });
    expect(dialog.save).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultPath: 'Research.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      }),
    );
    expect(tauri.invoke).toHaveBeenCalledWith('export_pdf', { path: '/tmp/Research.PDF' });
    expect(print).not.toHaveBeenCalled();
  });

  it('does nothing when the native save dialog is cancelled', async () => {
    dialog.save.mockResolvedValue(null);

    await expect(exportPdfFile('Research.md')).resolves.toEqual({ type: 'cancelled' });
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('cancels capture when another document opens while the native save dialog is pending', async () => {
    let finishDialog!: (path: string) => void;
    dialog.save.mockImplementationOnce(() => new Promise((resolve) => { finishDialog = resolve; }));
    let currentDocument = true;
    const exporting = exportPdfFile('Research.md', () => currentDocument);
    expect(dialog.save).toHaveBeenCalledOnce();
    currentDocument = false;
    finishDialog('/tmp/Research.pdf');
    await expect(exporting).resolves.toEqual({ type: 'cancelled' });
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('retains the system print fallback outside the macOS desktop app', async () => {
    tauri.isTauri.mockReturnValue(false);
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    await expect(exportPdfFile('Research.md')).resolves.toEqual({ type: 'print' });
    expect(print).toHaveBeenCalledOnce();
    expect(dialog.save).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
