import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, flushSettings, hideRecentFile, loadDraft, loadPreferences, rememberRecent, savePreferences, type AppPreferences } from './files';

const harness = vi.hoisted(() => ({
  disk: '', recovery: 'null', readonly: false, loaded: false, autoSave: true,
  cache: new Map<string, unknown>(), invoke: vi.fn(), load: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, convertFileSrc: (path: string) => path, invoke: harness.invoke }));
vi.mock('@tauri-apps/plugin-store', () => ({ Store: { load: harness.load } }));

const preferences: AppPreferences = { theme: 'light', font: 'system', fontSize: 15, lineSpacing: 1.62, sidebarOpen: true, recentFilesExpanded: true, language: 'en', compactLayoutVersion: 1 };
const recent = { path: '/notes/retained.md', name: 'retained.md' };
const original = () => JSON.stringify({ preferences, recentFiles: [recent], retainedCustomKey: { writing: 'Leave this key intact' } });

function validateDisk(): void {
  const parsed: unknown = JSON.parse(harness.disk);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid settings object');
}
function writeDisk(): void {
  if (harness.readonly) throw new Error('Settings are read-only');
  harness.disk = JSON.stringify(Object.fromEntries(harness.cache));
}
function scheduleLegacyAutoSave(): void {
  if (!harness.autoSave) return;
  setTimeout(() => { try { writeDisk(); } catch { /* The installed plugin discards automatic-save errors. */ } }, 200);
}
const store = {
  get: async (key: string) => structuredClone(harness.cache.get(key)),
  set: async (key: string, value: unknown) => { harness.cache.set(key, structuredClone(value)); scheduleLegacyAutoSave(); },
  delete: async (key: string) => { harness.cache.delete(key); scheduleLegacyAutoSave(); },
  save: async () => writeDisk(),
};

beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks();
  harness.disk = original(); harness.recovery = 'null'; harness.readonly = false; harness.loaded = false; harness.autoSave = true; harness.cache.clear();
  harness.load.mockImplementation(async (_path: string, options: { autoSave?: boolean | number }) => {
    if (!harness.loaded) {
      harness.cache = new Map(Object.entries(JSON.parse(harness.disk)));
      harness.autoSave = options.autoSave !== false; harness.loaded = true;
    }
    return store;
  });
  harness.invoke.mockImplementation(async (command: string) => {
    if (command === 'validate_settings_file') validateDisk();
    if (command === 'write_settings_store') { validateDisk(); writeDisk(); }
    if (command === 'clear_recovery_draft') harness.recovery = 'null';
    if (command === 'read_recovery_draft') return harness.recovery;
  });
});
afterEach(() => vi.useRealTimers());

describe('durable settings mutations', () => {
  it('reports a failed preference commit before its caller can claim success and retains original disk bytes', async () => {
    harness.readonly = true;
    await expect(savePreferences({ ...preferences, fontSize: 22 })).rejects.toThrow('Settings are read-only');
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.disk).toBe(original());
  });

  it('commits a preference change and unknown keys before returning', async () => {
    await savePreferences({ ...preferences, fontSize: 22 });
    expect(JSON.parse(harness.disk)).toEqual({ preferences: { ...preferences, fontSize: 22 }, recentFiles: [recent], retainedCustomKey: { writing: 'Leave this key intact' } });
  });

  it('never leaves a delayed plugin write that can overwrite settings damaged after a completed change', async () => {
    await savePreferences({ ...preferences, fontSize: 22 });
    harness.disk = '{ Original externally damaged settings';
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.disk).toBe('{ Original externally damaged settings');
    await expect(flushSettings()).rejects.toThrow();
    expect(harness.disk).toBe('{ Original externally damaged settings');
  });

  it('commits recent additions and hidden-file keys before returning while retaining supplementary keys', async () => {
    const second = { path: '/notes/new.md', name: 'new.md' };
    await rememberRecent(second);
    expect(JSON.parse(harness.disk).recentFiles).toEqual([second, recent]);
    await hideRecentFile(recent.path);
    expect(JSON.parse(harness.disk)).toMatchObject({ recentFiles: [second], hiddenRecentFiles: [recent.path], retainedCustomKey: { writing: 'Leave this key intact' } });
  });

  it('retains a durable recovery clear when legacy settings cleanup cannot be committed', async () => {
    harness.disk = JSON.stringify({ ...JSON.parse(original()), unsavedDraft: { name: 'Old.md', sourceMarkdown: 'Old writing' } });
    const originalBytes = harness.disk;
    harness.recovery = JSON.stringify({ name: 'New.md', sourceMarkdown: 'New writing' }); harness.readonly = true;
    await expect(clearDraft()).rejects.toThrow('Settings are read-only');
    expect(harness.recovery).toBe('null');
    expect(harness.disk).toBe(originalBytes);
    await expect(loadDraft()).resolves.toBeNull();
  });

  it('commits a startup typography migration before returning and preserves unknown settings', async () => {
    harness.disk = JSON.stringify({ preferences: { theme: 'dark', fontSize: 12 }, retainedCustomKey: 'Keep this value' });
    const loaded = await loadPreferences();
    expect(JSON.parse(harness.disk)).toEqual({ preferences: loaded, retainedCustomKey: 'Keep this value' });
  });
});
