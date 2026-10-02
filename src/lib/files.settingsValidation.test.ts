import { beforeEach, describe, expect, it, vi } from "vitest";
import { markdownToDocument } from "../editor/markdown";
import { getMessages } from "../i18n";
import {
  clearDraft, flushSettings, loadDraft, loadPreferences, loadRecent,
  rememberRecent, saveDraft, savePreferences, type AppPreferences, type EditorFile,
} from "./files";

const harness = vi.hoisted(() => ({
  native: true,
  settings: null as string | null,
  recovery: null as string | null,
  loaded: false,
  entries: new Map<string, unknown>(),
  invoke: vi.fn(),
  load: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => harness.native,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: harness.invoke,
}));
vi.mock("@tauri-apps/plugin-store", () => ({ Store: { load: harness.load } }));

const preferences: AppPreferences = {
  theme: "light", font: "system", fontSize: 15, lineSpacing: 1.62,
  sidebarOpen: true, recentFilesExpanded: true, language: "en", compactLayoutVersion: 1,
};
const draft: EditorFile = {
  name: "Independent.md", sourceMarkdown: "Independent exact writing.\r\n",
  document: markdownToDocument("Independent exact writing.\r\n"), comments: [],
};
const store = {
  get: async (key: string) => harness.entries.get(key),
  set: harness.set,
  save: harness.save,
  delete: harness.delete,
};
function persistSettings(): void {
  harness.settings = JSON.stringify(Object.fromEntries(harness.entries));
}
async function invokeNative(command: string, args?: { contents: string }): Promise<unknown> {
  if (command === "validate_settings_file" && harness.settings !== null) {
    const parsed: unknown = JSON.parse(harness.settings);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid native settings object");
  }
  if (command === "read_recovery_draft") return harness.recovery;
  if (command === "write_recovery_draft") harness.recovery = args!.contents;
  if (command === "clear_recovery_draft") harness.recovery = "null";
}

describe("native settings preflight", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    harness.native = true;
    harness.settings = null;
    harness.recovery = null;
    harness.loaded = false;
    harness.entries.clear();
    localStorage.clear();
    harness.invoke.mockImplementation(invokeNative);
    // Model plugin-store's real behavior: its initial malformed-file load is
    // swallowed, and subsequent loads reuse the same cached empty store.
    harness.load.mockImplementation(async () => {
      if (!harness.loaded) {
        try { harness.entries = new Map(Object.entries(JSON.parse(harness.settings ?? "{}"))); }
        catch { harness.entries.clear(); }
        harness.loaded = true;
      }
      return store;
    });
    harness.set.mockImplementation(async (key: string, value: unknown) => { harness.entries.set(key, value); persistSettings(); });
    harness.delete.mockImplementation(async (key: string) => { harness.entries.delete(key); persistSettings(); });
    harness.save.mockImplementation(async () => persistSettings());
  });

  it.each(["{ damaged settings", "[]", "null", '"unexpected"'])('preserves malformed native settings without loading or writing over them: %s', async (original) => {
    harness.settings = original;
    const results = await Promise.allSettled([
      loadRecent(), loadPreferences(), savePreferences(preferences),
      rememberRecent({ path: "/notes/new.md", name: "new.md" }), flushSettings(),
    ]);
    expect(results).toEqual(Array.from({ length: 5 }, () => ({ status: "rejected", reason: new Error(getMessages().settingsReadFailed) })));
    expect(harness.settings).toBe(original);
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.set).not.toHaveBeenCalled();
    expect(harness.save).not.toHaveBeenCalled();
  });

  it("waits for disk validation before parallel startup reads can load or migrate settings", async () => {
    const releaseValidations: Array<() => void> = [];
    harness.invoke.mockImplementation(async (command: string, args?: { contents: string }) => {
      if (command === "validate_settings_file") await new Promise<void>((resolve) => { releaseValidations.push(resolve); });
      return invokeNative(command, args);
    });
    const startup = Promise.all([loadPreferences(), loadRecent()]);
    await vi.waitFor(() => expect(releaseValidations).toHaveLength(2));
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.set).not.toHaveBeenCalled();
    releaseValidations.forEach((release) => release());
    await startup;
    expect(harness.load).toHaveBeenCalledTimes(2);
    expect(harness.set).toHaveBeenCalledOnce();
  });

  it("accepts an absent settings file and later validates before every cached-store access", async () => {
    await savePreferences(preferences);
    expect(JSON.parse(harness.settings!)).toEqual({ preferences });
    await loadRecent();
    await flushSettings();
    expect(harness.invoke.mock.calls.filter(([command]) => command === "validate_settings_file")).toHaveLength(3);
  });

  it("detects corruption introduced after a healthy cached store was loaded", async () => {
    await savePreferences(preferences);
    harness.settings = "{ externally damaged";
    harness.load.mockClear();
    harness.set.mockClear();
    await expect(rememberRecent({ path: "/notes/new.md", name: "new.md" })).rejects.toThrow(getMessages().settingsReadFailed);
    await expect(flushSettings()).rejects.toThrow(getMessages().settingsReadFailed);
    expect(harness.settings).toBe("{ externally damaged");
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.set).not.toHaveBeenCalled();
  });

  it("permits retry after the original settings file has been repaired", async () => {
    harness.settings = "{ damaged";
    await expect(loadPreferences()).rejects.toThrow(getMessages().settingsReadFailed);
    harness.settings = JSON.stringify({ preferences });
    await expect(loadPreferences()).resolves.toEqual(preferences);
    expect(harness.load).toHaveBeenCalledOnce();
  });

  it("continues recovering and saving independent writing when settings cannot be read", async () => {
    harness.settings = "{ damaged settings";
    harness.recovery = JSON.stringify(draft);
    await expect(loadPreferences()).rejects.toThrow(getMessages().settingsReadFailed);
    await expect(loadDraft()).resolves.toEqual(draft);
    await saveDraft({ ...draft, sourceMarkdown: "Later exact writing.\r\n" });
    await expect(loadDraft()).resolves.toEqual(expect.objectContaining({ sourceMarkdown: "Later exact writing.\r\n" }));
    expect(harness.settings).toBe("{ damaged settings");
    expect(harness.load).not.toHaveBeenCalled();
  });

  it("retains durable clear while preserving unreadable legacy settings", async () => {
    harness.settings = "{ damaged settings";
    harness.recovery = JSON.stringify(draft);
    await expect(clearDraft()).rejects.toThrow(getMessages().settingsReadFailed);
    expect(harness.recovery).toBe("null");
    expect(harness.settings).toBe("{ damaged settings");
    expect(harness.delete).not.toHaveBeenCalled();
    await expect(loadDraft()).resolves.toBeNull();
  });

  it("does not invoke the native preflight in a browser", async () => {
    harness.native = false;
    await savePreferences(preferences);
    await loadRecent();
    await flushSettings();
    expect(harness.invoke).not.toHaveBeenCalled();
  });
});
