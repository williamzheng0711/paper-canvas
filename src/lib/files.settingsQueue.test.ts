import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hideRecentFile,
  loadPreferences,
  loadRecent,
  rememberRecent,
  removeRecentFile,
  savePreferences,
  type AppPreferences,
} from "./files";

const mocks = vi.hoisted(() => ({
  native: true,
  load: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  values: new Map<string, unknown>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => mocks.native,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ Store: { load: mocks.load } }));

const store = { get: mocks.get, set: mocks.set };
const preferences: AppPreferences = {
  theme: "light",
  font: "system",
  fontSize: 15,
  lineSpacing: 1.62,
  sidebarOpen: true,
  recentFilesExpanded: true,
  language: "en",
  compactLayoutVersion: 1,
};
const first = { path: "/notes/first.md", name: "first.md" };
const second = { path: "/notes/second.md", name: "second.md" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.native = true;
  mocks.values.clear();
  localStorage.clear();
  mocks.load.mockResolvedValue(store);
  mocks.get.mockImplementation(async (key: string) =>
    structuredClone(mocks.values.get(key)),
  );
  mocks.set.mockImplementation(async (key: string, value: unknown) => {
    mocks.values.set(key, structuredClone(value));
  });
});

describe("settings mutation ordering", () => {
  it("keeps the newest reading preferences when an earlier Store.load is delayed", async () => {
    let release: (() => void) | undefined;
    mocks.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(store);
        }),
    );
    const older = savePreferences({ ...preferences, fontSize: 14 });
    const newest = savePreferences({ ...preferences, fontSize: 22 });
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await Promise.all([older, newest]);
    expect(mocks.values.get("preferences")).toMatchObject({ fontSize: 22 });
  });

  it("does not overwrite a new preference save with a delayed legacy migration", async () => {
    let release: (() => void) | undefined;
    mocks.get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ fontSize: 12 });
        }),
    );
    const migration = loadPreferences();
    const newest = savePreferences({ ...preferences, fontSize: 22 });
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await Promise.all([migration, newest]);
    expect(mocks.values.get("preferences")).toMatchObject({ fontSize: 22 });
  });

  it.each(["native", "browser"])(
    "retains overlapping additions to %s recent history",
    async (platform) => {
      mocks.native = platform === "native";
      await Promise.all([rememberRecent(first), rememberRecent(second)]);
      expect(await loadRecent()).toEqual([second, first]);
    },
  );

  it.each(["native", "browser"])(
    "retains overlapping hidden-file removals in %s recent history",
    async (platform) => {
      mocks.native = platform === "native";
      await rememberRecent(first);
      await rememberRecent(second);
      await Promise.all([
        hideRecentFile(first.path),
        hideRecentFile(second.path),
      ]);
      expect(await loadRecent()).toEqual([]);
      const hidden = mocks.native
        ? mocks.values.get("hiddenRecentFiles")
        : JSON.parse(localStorage.getItem("hiddenRecentFiles") ?? "[]");
      expect(hidden).toEqual([first.path, second.path]);
    },
  );

  it.each(["native", "browser"])(
    "does not resurrect a removed entry during an overlapping %s addition",
    async (platform) => {
      mocks.native = platform === "native";
      await rememberRecent(first);
      await Promise.all([removeRecentFile(first.path), rememberRecent(second)]);
      expect(await loadRecent()).toEqual([second]);
    },
  );

  it("reports a failed settings write and still completes subsequent mutations", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Cannot load settings"));
    const failure = savePreferences({ ...preferences, fontSize: 14 });
    const history = rememberRecent(first);
    await expect(failure).rejects.toThrow("Cannot load settings");
    await history;
    expect(await loadRecent()).toEqual([first]);
    await savePreferences({ ...preferences, fontSize: 22 });
    expect(mocks.values.get("preferences")).toMatchObject({ fontSize: 22 });
  });
});
