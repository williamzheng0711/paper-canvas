import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, flushSettings, loadDraft, saveDraft, type EditorFile } from "./files";
import { markdownToDocument } from "../editor/markdown";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  entries: new Map<string, unknown>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ Store: { load: mocks.load } }));

const store = {
  save: mocks.save,
  get: async (key: string) => mocks.entries.get(key),
  set: async (key: string, value: unknown) => {
    mocks.entries.set(key, value);
  },
  delete: async (key: string) => {
    mocks.entries.delete(key);
  },
};
const latest: EditorFile = {
  name: "Latest draft.md",
  document: markdownToDocument("# Latest draft\n\nLiteral  unfinished * source.\n"),
  comments: [],
  sourceMarkdown: "# Latest draft\n\nLiteral  unfinished * source.\n",
};

async function flushAsyncLoading() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ordered draft persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.entries.clear();
    mocks.load.mockResolvedValue(store);
  });

  it("retains the new draft when an earlier clear is delayed while loading the native store", async () => {
    let finishClearLoad!: (value: typeof store) => void;
    mocks.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishClearLoad = resolve;
        }),
    );
    const clearing = clearDraft();
    const saving = saveDraft(latest);
    await flushAsyncLoading();
    finishClearLoad(store);
    await Promise.all([clearing, saving]);
    await expect(loadDraft()).resolves.toEqual(latest);
  });

  it("does not resurrect an older draft after a later clear when the older native store load finishes last", async () => {
    let finishSaveLoad!: (value: typeof store) => void;
    mocks.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSaveLoad = resolve;
        }),
    );
    const saving = saveDraft(latest);
    const clearing = clearDraft();
    await flushAsyncLoading();
    finishSaveLoad(store);
    await Promise.all([saving, clearing]);
    await expect(loadDraft()).resolves.toBeNull();
  });

  it("continues with the later draft after an earlier mutation fails", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Store unavailable"));
    const clearing = clearDraft();
    const saving = saveDraft(latest);
    await expect(clearing).rejects.toThrow("Store unavailable");
    await saving;
    await expect(loadDraft()).resolves.toEqual(latest);
  });

  it("flushes the native store only after the queued recovery draft reaches it", async () => {
    let releaseLoad!: (value: typeof store) => void;
    mocks.load.mockImplementationOnce(() => new Promise((resolve) => { releaseLoad = resolve; }));
    mocks.save.mockImplementation(async () => {
      expect(mocks.entries.get("unsavedDraft")).toEqual(latest);
    });
    const saving = saveDraft(latest);
    const flushing = flushSettings();
    await flushAsyncLoading();
    expect(mocks.save).not.toHaveBeenCalled();
    releaseLoad(store);
    await Promise.all([saving, flushing]);
    expect(mocks.save).toHaveBeenCalledOnce();
  });

  it("reports native settings flush failures so closing can retain the recovery data", async () => {
    mocks.save.mockRejectedValueOnce(new Error("Settings disk full"));
    await expect(flushSettings()).rejects.toThrow("Settings disk full");
    await saveDraft(latest);
    await flushSettings();
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
});
