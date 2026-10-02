import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearDraft, loadDraft, saveDraft, type EditorFile } from "./files";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
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
  readTextFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-store", () => ({ Store: { load: mocks.load } }));

const store = {
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
  document: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "Latest typed content" }],
      },
    ],
  },
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
});
