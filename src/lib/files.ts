import type { JSONContent } from '@tiptap/core';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import {
  exists,
  mkdir,
  readTextFile,
  rename,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';
import { documentToMarkdown, markdownToDocument } from '../editor/markdown';

export type RecentFile = { path: string; name: string };
export type EditorFile = {
  path?: string;
  name: string;
  document: JSONContent;
};

export type AppPreferences = {
  theme: 'light' | 'dark';
  font: 'system' | 'serif' | 'mono';
  fontSize: number;
  sidebarOpen: boolean;
};

const settingsKey = 'papercanvas.settings.v1';
const recentKey = 'recentFiles';
const draftKey = 'unsavedDraft';

function separator(path: string) {
  return path.includes('\\') ? '\\' : '/';
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || 'Untitled.md';
}

export function isMarkdownFilePath(path: string): boolean {
  return /\.(md|markdown)$/i.test(fileName(path));
}

function parentPath(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : '.';
}

function joinPath(base: string, child: string): string {
  return `${base.replace(/[\\/]$/, '')}${separator(base)}${child}`;
}

function assetDirectory(path: string): string {
  return joinPath(parentPath(path), fileName(path).replace(/\.md$/i, '') + '.assets');
}

function isExternalImage(src: string): boolean {
  return /^(https?:|data:|blob:|asset:|tauri:)/i.test(src);
}

function cloneDocument(document: JSONContent): JSONContent {
  return JSON.parse(JSON.stringify(document)) as JSONContent;
}

function visit(node: JSONContent, visitor: (node: JSONContent) => void): void {
  visitor(node);
  node.content?.forEach((child) => visit(child, visitor));
}

function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  const binary = atob(match[2]);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function extensionForDataUrl(dataUrl: string): string {
  const mime = /^data:([^;]+)/.exec(dataUrl)?.[1] ?? 'image/png';
  return mime === 'image/jpeg'
    ? 'jpg'
    : mime === 'image/gif'
      ? 'gif'
      : mime === 'image/webp'
        ? 'webp'
        : 'png';
}

async function persistEmbeddedImages(document: JSONContent, path: string): Promise<JSONContent> {
  const prepared = cloneDocument(document);
  const targetDirectory = assetDirectory(path);
  const assets: Array<{ node: JSONContent; src: string }> = [];
  visit(prepared, (node) => {
    if (
      node.type === 'image' &&
      typeof node.attrs?.src === 'string' &&
      node.attrs.src.startsWith('data:')
    ) {
      assets.push({ node, src: node.attrs.src });
    }
  });
  if (assets.length === 0) return prepared;
  await mkdir(targetDirectory, { recursive: true });
  await Promise.all(
    assets.map(async ({ node, src }, index) => {
      const bytes = dataUrlBytes(src);
      if (!bytes) return;
      const relative = `${fileName(path).replace(/\.md$/i, '')}.assets/image-${Date.now()}-${index}.${extensionForDataUrl(src)}`;
      await writeFile(joinPath(parentPath(path), relative), bytes);
      node.attrs = { ...node.attrs, src: relative };
    }),
  );
  return prepared;
}

function hydrateRelativeImages(document: JSONContent, path: string): JSONContent {
  const hydrated = cloneDocument(document);
  if (!isTauri()) return hydrated;
  visit(hydrated, (node) => {
    const src = node.type === 'image' ? node.attrs?.src : undefined;
    if (typeof src === 'string' && !isExternalImage(src)) {
      node.attrs = {
        ...node.attrs,
        originalSrc: src,
        src: convertFileSrc(joinPath(parentPath(path), src)),
      };
    }
  });
  return hydrated;
}

function restoreRelativeImagePaths(document: JSONContent): JSONContent {
  const restored = cloneDocument(document);
  visit(restored, (node) => {
    if (node.type === 'image' && typeof node.attrs?.originalSrc === 'string') {
      node.attrs = { ...node.attrs, src: node.attrs.originalSrc };
      delete node.attrs.originalSrc;
    }
  });
  return restored;
}

export function renameDocumentAssetReferences(
  document: JSONContent,
  oldPath: string,
  newPath: string,
): JSONContent {
  const oldPrefix = `${fileName(oldPath).replace(/\.md$/i, '')}.assets/`;
  const newPrefix = `${fileName(newPath).replace(/\.md$/i, '')}.assets/`;
  const renamed = restoreRelativeImagePaths(document);
  visit(renamed, (node) => {
    if (node.type !== 'image' || typeof node.attrs?.src !== 'string') return;
    if (node.attrs.src.startsWith(oldPrefix)) {
      node.attrs = { ...node.attrs, src: `${newPrefix}${node.attrs.src.slice(oldPrefix.length)}` };
    }
  });
  return renamed;
}

export async function chooseMarkdownFile(): Promise<EditorFile | null> {
  if (!isTauri()) throw new Error('檔案選擇器只會在桌面 App 中啟用。');
  const selected = await open({
    title: '開啟 Markdown 文件',
    multiple: false,
    directory: false,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  return openMarkdownFile(selected);
}

export async function openMarkdownFile(path: string): Promise<EditorFile> {
  if (!isTauri()) throw new Error('外部文件只會在桌面 App 中啟用。');
  if (!isMarkdownFilePath(path)) throw new Error('PaperCanvas 只能開啟 .md 或 .markdown 文件。');
  const markdown = await readTextFile(path);
  const file = {
    path,
    name: fileName(path),
    document: hydrateRelativeImages(markdownToDocument(markdown), path),
  };
  await rememberRecent({ path: file.path, name: file.name });
  return file;
}

export async function chooseSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri()) throw new Error('另存新檔只會在桌面 App 中啟用。');
  const selected = await save({
    title: '儲存 PaperCanvas 文件',
    defaultPath: defaultName.endsWith('.md') ? defaultName : `${defaultName}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  return selected;
}

export async function saveEditorFile(file: EditorFile, forceSaveAs = false): Promise<EditorFile> {
  let path = file.path;
  if (!path || forceSaveAs) {
    const selected = await chooseSavePath(file.name);
    if (selected) path = selected;
  }
  if (!path) throw new Error('儲存已取消。');
  const portable = restoreRelativeImagePaths(file.document);
  const withAssets = await persistEmbeddedImages(portable, path);
  await writeTextFile(path, documentToMarkdown(withAssets));
  await rememberRecent({ path, name: fileName(path) });
  return { path, name: fileName(path), document: hydrateRelativeImages(withAssets, path) };
}

export async function renameEditorFile(file: EditorFile, newName: string): Promise<EditorFile> {
  const cleanName = newName.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!cleanName) throw new Error('請輸入有效的檔名。');
  if (!file.path)
    return { ...file, name: cleanName.endsWith('.md') ? cleanName : `${cleanName}.md` };
  const target = joinPath(
    parentPath(file.path),
    cleanName.endsWith('.md') ? cleanName : `${cleanName}.md`,
  );
  if (target === file.path) return file;
  if (await exists(target)) throw new Error('目標檔名已存在，請使用另一個名稱。');

  const oldAssets = assetDirectory(file.path);
  const nextAssets = assetDirectory(target);
  const hasAssets = await exists(oldAssets);
  if (hasAssets && (await exists(nextAssets))) {
    throw new Error('目標圖片 assets 目錄已存在，請先選擇另一個檔名。');
  }

  await rename(file.path, target);
  try {
    if (hasAssets) await rename(oldAssets, nextAssets);
    const onDisk = await readTextFile(target);
    const oldPrefix = `${fileName(file.path).replace(/\.md$/i, '')}.assets/`;
    const nextPrefix = `${fileName(target).replace(/\.md$/i, '')}.assets/`;
    if (oldPrefix !== nextPrefix && onDisk.includes(oldPrefix)) {
      await writeTextFile(target, onDisk.replaceAll(oldPrefix, nextPrefix));
    }
  } catch (error) {
    // Recover the original pair when moving the companion directory fails.
    if (hasAssets && (await exists(nextAssets)) && !(await exists(oldAssets))) {
      await rename(nextAssets, oldAssets).catch(() => undefined);
    }
    if ((await exists(target)) && !(await exists(file.path))) {
      await rename(target, file.path).catch(() => undefined);
    }
    throw error;
  }
  await rememberRecent({ path: target, name: fileName(target) });
  return {
    ...file,
    path: target,
    name: fileName(target),
    document: hydrateRelativeImages(
      renameDocumentAssetReferences(file.document, file.path, target),
      target,
    ),
  };
}

async function browserSettings(): Promise<Storage> {
  return localStorage;
}

export async function loadRecent(): Promise<RecentFile[]> {
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    return (await store.get<RecentFile[]>(recentKey)) ?? [];
  }
  const storage = await browserSettings();
  try {
    return JSON.parse(storage.getItem(recentKey) ?? '[]') as RecentFile[];
  } catch {
    return [];
  }
}

export async function rememberRecent(recent: RecentFile): Promise<void> {
  const files = [recent, ...(await loadRecent()).filter((item) => item.path !== recent.path)].slice(
    0,
    12,
  );
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    await store.set(recentKey, files);
    return;
  }
  const storage = await browserSettings();
  storage.setItem(recentKey, JSON.stringify(files));
}

const preferencesKey = 'preferences';
const defaultPreferences: AppPreferences = {
  theme: 'light',
  font: 'system',
  fontSize: 18,
  sidebarOpen: true,
};

export async function loadPreferences(): Promise<AppPreferences> {
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    return { ...defaultPreferences, ...(await store.get<Partial<AppPreferences>>(preferencesKey)) };
  }
  try {
    return {
      ...defaultPreferences,
      ...(JSON.parse(localStorage.getItem(preferencesKey) ?? '{}') as Partial<AppPreferences>),
    };
  } catch {
    return defaultPreferences;
  }
}

export async function savePreferences(preferences: AppPreferences): Promise<void> {
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    await store.set(preferencesKey, preferences);
    return;
  }
  localStorage.setItem(preferencesKey, JSON.stringify(preferences));
}

export async function openRecent(recent: RecentFile): Promise<EditorFile> {
  const markdown = await readTextFile(recent.path);
  return {
    path: recent.path,
    name: recent.name,
    document: hydrateRelativeImages(markdownToDocument(markdown), recent.path),
  };
}

export async function loadDraft(): Promise<EditorFile | null> {
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    return (await store.get<EditorFile>(draftKey)) ?? null;
  }
  try {
    return JSON.parse(localStorage.getItem(draftKey) ?? 'null') as EditorFile | null;
  } catch {
    return null;
  }
}

export async function saveDraft(file: EditorFile): Promise<void> {
  const draft = { ...file, path: undefined };
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    await store.set(draftKey, draft);
    return;
  }
  localStorage.setItem(draftKey, JSON.stringify(draft));
}

export async function clearDraft(): Promise<void> {
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    await store.delete(draftKey);
    return;
  }
  localStorage.removeItem(draftKey);
}

export function newEditorFile(): EditorFile {
  return { name: 'Untitled.md', document: { type: 'doc', content: [{ type: 'paragraph' }] } };
}
