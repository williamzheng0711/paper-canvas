import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadPreferences, savePreferences, type AppPreferences } from './files';

const harness = vi.hoisted(() => ({
  native: false,
  stored: new Map<string, unknown>(),
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => harness.native,
  convertFileSrc: (path: string) => path,
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  Store: { load: async () => ({ get: harness.get, set: harness.set }) },
}));

describe.each([
  { name: 'browser', native: false },
  { name: 'native', native: true },
])('Compact preferences in $name storage', ({ native }) => {
  const writeStored = (preferences: Partial<AppPreferences>) => {
    if (native) harness.stored.set('preferences', preferences);
    else localStorage.setItem('preferences', JSON.stringify(preferences));
  };
  const readStored = () => native
    ? harness.stored.get('preferences') as AppPreferences
    : JSON.parse(localStorage.getItem('preferences')!) as AppPreferences;

  beforeEach(() => {
    harness.native = native;
    harness.stored.clear();
    harness.get.mockImplementation(async (key: string) => harness.stored.get(key));
    harness.set.mockClear();
    harness.set.mockImplementation(async (key: string, value: unknown) => { harness.stored.set(key, value); });
    localStorage.clear();
  });

  it('migrates legacy typography once while retaining theme, language, and recent-document preferences', async () => {
    writeStored({
      theme: 'dark', font: 'serif', fontSize: 14, lineSpacing: 1.3,
      sidebarOpen: false, recentFilesExpanded: false, language: 'zh-Hans',
    });
    const migrated = await loadPreferences();
    expect(migrated).toEqual({
      theme: 'dark', font: 'system', fontSize: 15, lineSpacing: 1.62,
      sidebarOpen: true, recentFilesExpanded: false, language: 'zh-Hans', compactLayoutVersion: 1,
    });
    expect(readStored()).toEqual(migrated);
    if (native) harness.set.mockClear();
    expect(await loadPreferences()).toEqual(migrated);
    if (native) expect(harness.set).not.toHaveBeenCalled();
  });

  it('preserves later Aa adjustments even when the saving caller omitted the optional marker', async () => {
    const initial = await loadPreferences();
    const customized: AppPreferences = {
      ...initial, font: 'mono', fontSize: 19, lineSpacing: 1.45, sidebarOpen: false, compactLayoutVersion: undefined,
    };
    await savePreferences(customized);
    expect(await loadPreferences()).toEqual({ ...customized, compactLayoutVersion: 1 });
    expect(readStored().fontSize).toBe(19);
    expect(readStored().lineSpacing).toBe(1.45);
  });

  it('uses the selected Compact defaults for a fresh installation', async () => {
    expect(await loadPreferences()).toEqual(expect.objectContaining({
      font: 'system', fontSize: 15, lineSpacing: 1.62, sidebarOpen: true, compactLayoutVersion: 1,
    }));
    expect(readStored().compactLayoutVersion).toBe(1);
  });

  it('recovers invalid stored reading options while clamping a valid numeric font size', async () => {
    writeStored({
      compactLayoutVersion: 1,
      theme: 'unknown', font: 'unknown', fontSize: 999,
      sidebarOpen: 'false', recentFilesExpanded: null,
    } as unknown as Partial<AppPreferences>);
    expect(await loadPreferences()).toEqual(expect.objectContaining({
      theme: 'light', font: 'system', fontSize: 30,
      sidebarOpen: true, recentFilesExpanded: true,
    }));
    writeStored({ compactLayoutVersion: 1, fontSize: null } as unknown as Partial<AppPreferences>);
    expect((await loadPreferences()).fontSize).toBe(15);
  });
});
