import { beforeEach, describe, expect, it, vi } from "vitest";
import { markdownToDocument } from "../editor/markdown";
import { getMessages } from "../i18n";
import { clearDraft, loadDraft, saveDraft, type EditorFile } from "./files";

const harness = vi.hoisted(() => ({
  recovery: null as string | null,
  legacy: undefined as unknown,
  invoke: vi.fn(),
  load: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  convertFileSrc: (path: string) => `asset:${path}`,
  invoke: harness.invoke,
}));
vi.mock("@tauri-apps/plugin-store", () => ({ Store: { load: harness.load } }));

const draft: EditorFile = {
  name: "Recovery.md",
  document: markdownToDocument("Recoverable writing.\n"),
  sourceMarkdown: "Recoverable writing.\n",
  comments: [],
};
const latest: EditorFile = {
  ...draft,
  document: markdownToDocument("Latest writing.\n"),
  sourceMarkdown: "Latest writing.\n",
};
const store = { get: harness.get, set: harness.set, delete: harness.delete };

function invokeRecovery(command: string, args?: { contents: string }): Promise<unknown> {
  if (command === "read_recovery_draft") return Promise.resolve(harness.recovery);
  if (command === "write_recovery_draft") harness.recovery = args!.contents;
  if (command === "clear_recovery_draft") harness.recovery = "null";
  return Promise.resolve();
}

describe("atomic native draft recovery", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    harness.recovery = null;
    harness.legacy = undefined;
    harness.invoke.mockImplementation(invokeRecovery);
    harness.load.mockResolvedValue(store);
    harness.get.mockImplementation(async () => harness.legacy);
    harness.delete.mockImplementation(async () => { harness.legacy = undefined; });
  });

  it("restores the primary recovery file independently of unavailable settings", async () => {
    harness.recovery = JSON.stringify(draft);
    harness.load.mockRejectedValue(new Error("Settings file was truncated"));
    await expect(loadDraft()).resolves.toEqual(draft);
    expect(harness.load).not.toHaveBeenCalled();
  });

  it("keeps a cleared native tombstone authoritative over stale legacy writing", async () => {
    harness.recovery = "null";
    harness.legacy = draft;
    await expect(loadDraft()).resolves.toBeNull();
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalledWith("write_recovery_draft", expect.anything());
  });

  it("migrates the unchanged legacy record while recovering its writing and warning about damaged comments", async () => {
    const original = { name: "Legacy.md", document: draft.document, comments: { damaged: true }, path: "/notes/old.md" };
    harness.legacy = original;
    await expect(loadDraft()).resolves.toEqual({
      name: original.name,
      document: original.document,
      comments: [],
      commentWarning: getMessages().commentDataWarning,
    });
    expect(harness.recovery).toBe(JSON.stringify(original));
    expect(harness.legacy).toBe(original);
    expect(harness.delete).not.toHaveBeenCalled();
    expect(harness.set).not.toHaveBeenCalled();
  });

  it("still recovers legacy writing when migrating it cannot be written", async () => {
    harness.legacy = draft;
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === "write_recovery_draft") throw new Error("Recovery disk full");
      return null;
    });
    await expect(loadDraft()).resolves.toEqual(draft);
    expect(harness.legacy).toBe(draft);
    expect(harness.recovery).toBeNull();
  });

  it("reports malformed primary JSON without falling back to stale legacy writing or changing the original bytes", async () => {
    harness.recovery = '{"sourceMarkdown":"unfinished';
    harness.legacy = draft;
    await expect(loadDraft()).rejects.toThrow(getMessages().draftRecoveryFailed);
    expect(harness.recovery).toBe('{"sourceMarkdown":"unfinished');
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.invoke).toHaveBeenCalledOnce();
  });

  it("reports a primary recovery read failure without changing recovery or legacy data", async () => {
    harness.legacy = draft;
    harness.invoke.mockRejectedValueOnce(new Error("Recovery access denied"));
    await expect(loadDraft()).rejects.toThrow("Recovery access denied");
    expect(harness.legacy).toBe(draft);
    expect(harness.load).not.toHaveBeenCalled();
  });

  it("saves opaque JSON including lone surrogates without relying on the settings store", async () => {
    const sourceMarkdown = "Unfinished surrogate: \ud800, \udfff.\n";
    const original = { ...draft, path: "/notes/saved.md", sourceMarkdown };
    harness.load.mockRejectedValue(new Error("Settings unavailable"));
    await saveDraft(original);
    expect(harness.recovery).toContain("\\ud800");
    expect(harness.recovery).toContain("\\udfff");
    expect(JSON.parse(harness.recovery!)).toEqual({ ...draft, sourceMarkdown, recoverySourcePath: "/notes/saved.md" });
    expect(harness.load).not.toHaveBeenCalled();
    expect(harness.set).not.toHaveBeenCalled();
    await expect(loadDraft()).resolves.toEqual(expect.objectContaining({ sourceMarkdown, path: undefined }));
  });

  it("preserves the last recovery on a failed write and accepts a later save", async () => {
    harness.recovery = JSON.stringify(draft);
    harness.invoke.mockRejectedValueOnce(new Error("Recovery disk full"));
    await expect(saveDraft(latest)).rejects.toThrow("Recovery disk full");
    expect(harness.recovery).toBe(JSON.stringify(draft));
    await saveDraft(latest);
    await expect(loadDraft()).resolves.toEqual(latest);
  });

  it("does not resurrect a stale legacy draft if deleting it fails after durable clear", async () => {
    harness.legacy = draft;
    harness.recovery = JSON.stringify(draft);
    harness.delete.mockRejectedValueOnce(new Error("Settings save failed"));
    await expect(clearDraft()).rejects.toThrow("Settings save failed");
    expect(harness.recovery).toBe("null");
    expect(harness.legacy).toBe(draft);
    await expect(loadDraft()).resolves.toBeNull();
  });

  it.each(["save", "clear"] as const)("finishes delayed migration before a later %s so old writing cannot win", async (action) => {
    harness.legacy = draft;
    let releaseRead!: () => void;
    harness.invoke.mockImplementationOnce(() => new Promise((resolve) => { releaseRead = () => resolve(null); }));
    const loading = loadDraft();
    const mutation = action === "save" ? saveDraft(latest) : clearDraft();
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.invoke).toHaveBeenCalledOnce();
    releaseRead();
    await expect(loading).resolves.toEqual(draft);
    await mutation;
    await expect(loadDraft()).resolves.toEqual(action === "save" ? latest : null);
  });
});
