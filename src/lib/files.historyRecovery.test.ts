import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hideRecentFile,
  loadDraft,
  loadPreferences,
  loadRecent,
  rememberRecent,
  type EditorFile,
} from "./files";

const harness = vi.hoisted(() => ({
  native: false,
  stored: new Map<string, unknown>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => harness.native,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: async () => ({
      get: async (key: string) => structuredClone(harness.stored.get(key)),
      set: async (key: string, value: unknown) =>
        harness.stored.set(key, structuredClone(value)),
    }),
  },
}));

const valid = { path: "/notes/valid.md", name: "Valid reading.md" };
const unnamed = { path: "/notes/older.md" };
const older = { path: unnamed.path, name: "older.md" };
const hidden = { path: "/notes/hidden.md", name: "hidden.md" };
const draft: EditorFile = {
  name: "Unsaved writing.md",
  document: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Unsaved writing" }],
      },
    ],
  },
  sourceMarkdown: "Unsaved writing\n",
};

function write(key: string, value: unknown): void {
  if (harness.native) harness.stored.set(key, value);
  else localStorage.setItem(key, JSON.stringify(value));
}

function read(key: string): unknown {
  return harness.native
    ? harness.stored.get(key)
    : JSON.parse(localStorage.getItem(key) ?? "null");
}

describe.each([
  { platform: "native", native: true },
  { platform: "browser", native: false },
])("recent history recovery in $platform storage", ({ native }) => {
  beforeEach(() => {
    harness.native = native;
    harness.stored.clear();
    localStorage.clear();
  });

  it("retains valid records, derives older missing names, and skips invalid entries and hidden paths", async () => {
    write("recentFiles", [
      valid,
      null,
      3,
      { path: null },
      { path: "" },
      unnamed,
      hidden,
    ]);
    write("hiddenRecentFiles", [hidden.path, null, 3]);
    expect(await loadRecent()).toEqual([valid, older]);
  });

  it("does not let malformed history prevent recovering valid startup preferences and writing", async () => {
    write("recentFiles", [valid, null, unnamed]);
    write("hiddenRecentFiles", {});
    write("preferences", { compactLayoutVersion: 1, fontSize: 19 });
    write("unsavedDraft", draft);
    const [recent, preferences, recovered] = await Promise.all([
      loadRecent(),
      loadPreferences(),
      loadDraft(),
    ]);
    expect(recent).toEqual([valid, older]);
    expect(preferences.fontSize).toBe(19);
    expect(recovered).toEqual(draft);
  });

  it("preserves recovered history when another file is remembered", async () => {
    write("recentFiles", [valid, null, unnamed]);
    write("hiddenRecentFiles", {});
    const latest = { path: "/notes/new.md", name: "new.md" };
    await rememberRecent(latest);
    expect(read("recentFiles")).toEqual([latest, valid, older]);
  });

  it("replaces invalid hidden-path state while preserving the other recovered files", async () => {
    write("recentFiles", [valid, null, unnamed]);
    write("hiddenRecentFiles", {});
    expect(await hideRecentFile(valid.path)).toEqual([older]);
    expect(await loadRecent()).toEqual([older]);
    expect(read("hiddenRecentFiles")).toEqual([valid.path]);
  });
});

it("retains browser recent files when only the hidden-path JSON is malformed", async () => {
  harness.native = false;
  localStorage.clear();
  localStorage.setItem("recentFiles", JSON.stringify([valid]));
  localStorage.setItem("hiddenRecentFiles", "{");
  expect(await loadRecent()).toEqual([valid]);
  await hideRecentFile(valid.path);
  expect(await loadRecent()).toEqual([]);
});
