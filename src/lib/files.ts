import type { JSONContent } from '@tiptap/core';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { exists, mkdir, readTextFile, rename, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';
import { documentToMarkdown, markdownToDocument } from '../editor/markdown';
import { detectLanguage, getMessages, isLanguage, type Language } from '../i18n';
import { normalizeLineSpacing } from './lineSpacing';

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
  lineSpacing: number;
  sidebarOpen: boolean;
  language: Language;
};

const settingsKey = 'papercanvas.settings.v1';
const recentKey = 'recentFiles';
const hiddenRecentKey = 'hiddenRecentFiles';
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
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : mime === 'image/webp' ? 'webp' : 'png';
}

async function persistEmbeddedImages(document: JSONContent, path: string): Promise<JSONContent> {
  const prepared = cloneDocument(document);
  const targetDirectory = assetDirectory(path);
  const assets: Array<{ node: JSONContent; src: string }> = [];
  visit(prepared, (node) => {
    if (node.type === 'image' && typeof node.attrs?.src === 'string' && node.attrs.src.startsWith('data:')) {
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

/** Serializes the editor document without leaking Tauri asset-protocol URLs. */
export function documentToPortableMarkdown(document: JSONContent): string {
  return documentToMarkdown(restoreRelativeImagePaths(document));
}

export function renameDocumentAssetReferences(document: JSONContent, oldPath: string, newPath: string): JSONContent {
  const oldPrefix = `${fileName(oldPath).replace(/\.md$/i, '')}.assets/`;
  const newPrefix = `${fileName(newPath).replace(/\.md$/i, '')}.assets/`;
  const renamed = restoreRelativeImagePaths(document);
  visit(renamed, (node) => {
    if (node.type !== 'image' || typeof node.attrs?.src !== 'string') return;
    if (node.attrs.src.startsWith(oldPrefix)) {
      node.attrs = {
        ...node.attrs,
        src: `${newPrefix}${node.attrs.src.slice(oldPrefix.length)}`,
      };
    }
  });
  return renamed;
}

export async function chooseMarkdownFile(): Promise<EditorFile | null> {
  const text = getMessages();
  if (!isTauri()) throw new Error(text.filePickerDesktopOnly);
  const selected = await open({
    title: text.openMarkdownDialog,
    multiple: false,
    directory: false,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (!selected || Array.isArray(selected)) return null;
  return openMarkdownFile(selected);
}

export async function openMarkdownFile(path: string): Promise<EditorFile> {
  const text = getMessages();
  if (!isTauri()) throw new Error(text.externalFilesDesktopOnly);
  if (!isMarkdownFilePath(path)) throw new Error(text.markdownFilesOnly);
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
  const text = getMessages();
  if (!isTauri()) throw new Error(text.saveAsDesktopOnly);
  const selected = await save({
    title: text.saveDocumentDialog,
    defaultPath: defaultName.endsWith('.md') ? defaultName : `${defaultName}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  return selected;
}

function markdownExportName(name: string): string {
  return name.replace(/\.(?:md|markdown)$/i, '') + '.md';
}

function pdfExportName(name: string): string {
  return name.replace(/\.(?:md|markdown|pdf)$/i, '') + '.pdf';
}

function downloadTextFile(contents: string, name: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Exports a Markdown copy without changing the active document path. */
export async function exportMarkdownFile(markdown: string, defaultName: string): Promise<string | null> {
  const text = getMessages();
  const name = markdownExportName(defaultName);
  if (!isTauri()) {
    downloadTextFile(markdown, name);
    return name;
  }

  const selected = await save({
    title: text.exportMarkdownDialog,
    defaultPath: name,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (!selected) return null;
  await writeTextFile(selected, markdown);
  return fileName(selected);
}

export type PdfExportResult = { type: 'saved'; name: string } | { type: 'print' } | { type: 'cancelled' };

/**
 * Saves directly through AppKit on macOS so WKWebView never presents its stale
 * print-preview thumbnail. Other platforms retain their system print flow.
 */
export async function exportPdfFile(defaultName: string): Promise<PdfExportResult> {
  const isMacDesktop = isTauri() && /Macintosh|Mac OS X/i.test(navigator.userAgent);
  if (!isMacDesktop) {
    await Promise.resolve(window.print());
    return { type: 'print' };
  }

  const selected = await save({
    title: getMessages().exportPdfDialog,
    defaultPath: pdfExportName(defaultName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (!selected) return { type: 'cancelled' };

  const path = selected.toLowerCase().endsWith('.pdf') ? selected : `${selected}.pdf`;
  await invoke('export_pdf', { path });
  return { type: 'saved', name: fileName(path) };
}

export async function saveEditorFile(file: EditorFile, forceSaveAs = false): Promise<EditorFile> {
  let path = file.path;
  if (!path || forceSaveAs) {
    const selected = await chooseSavePath(file.name);
    if (selected) path = selected;
  }
  if (!path) throw new Error(getMessages().saveCancelled);
  const portable = restoreRelativeImagePaths(file.document);
  const withAssets = await persistEmbeddedImages(portable, path);
  await writeTextFile(path, documentToMarkdown(withAssets));
  await rememberRecent({ path, name: fileName(path) });
  return {
    path,
    name: fileName(path),
    document: hydrateRelativeImages(withAssets, path),
  };
}

export async function renameEditorFile(file: EditorFile, newName: string): Promise<EditorFile> {
  const text = getMessages();
  const cleanName = newName.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!cleanName) throw new Error(text.invalidFilename);
  if (!file.path)
    return {
      ...file,
      name: cleanName.endsWith('.md') ? cleanName : `${cleanName}.md`,
    };
  const target = joinPath(parentPath(file.path), cleanName.endsWith('.md') ? cleanName : `${cleanName}.md`);
  if (target === file.path) return file;
  if (await exists(target)) throw new Error(text.filenameExists);

  const oldAssets = assetDirectory(file.path);
  const nextAssets = assetDirectory(target);
  const hasAssets = await exists(oldAssets);
  if (hasAssets && (await exists(nextAssets))) {
    throw new Error(text.assetsDirectoryExists);
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
    document: hydrateRelativeImages(renameDocumentAssetReferences(file.document, file.path, target), target),
  };
}

async function browserSettings(): Promise<Storage> {
  return localStorage;
}

export async function loadRecent(): Promise<RecentFile[]> {
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    const files = (await store.get<RecentFile[]>(recentKey)) ?? [];
    const hidden = new Set((await store.get<string[]>(hiddenRecentKey)) ?? []);
    return files.filter((item) => !hidden.has(item.path));
  }
  const storage = await browserSettings();
  try {
    const files = JSON.parse(storage.getItem(recentKey) ?? '[]') as RecentFile[];
    const hidden = new Set(JSON.parse(storage.getItem(hiddenRecentKey) ?? '[]') as string[]);
    return files.filter((item) => !hidden.has(item.path));
  } catch {
    return [];
  }
}

export async function rememberRecent(recent: RecentFile): Promise<void> {
  const files = [recent, ...(await loadRecent()).filter((item) => item.path !== recent.path)].slice(0, 12);
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    await store.set(recentKey, files);
    return;
  }
  const storage = await browserSettings();
  storage.setItem(recentKey, JSON.stringify(files));
}

export async function hideRecentFile(path: string): Promise<RecentFile[]> {
  const files = (await loadRecent()).filter((item) => item.path !== path);
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    const hidden = new Set((await store.get<string[]>(hiddenRecentKey)) ?? []);
    hidden.add(path);
    await store.set(recentKey, files);
    await store.set(hiddenRecentKey, [...hidden]);
    return files;
  }
  const storage = await browserSettings();
  let hidden: string[] = [];
  try {
    hidden = JSON.parse(storage.getItem(hiddenRecentKey) ?? '[]') as string[];
  } catch {
    // Replace malformed legacy state with a clean hidden-file list.
  }
  storage.setItem(recentKey, JSON.stringify(files));
  storage.setItem(hiddenRecentKey, JSON.stringify([...new Set([...hidden, path])]));
  return files;
}

export async function revealFileInFolder(path: string): Promise<void> {
  if (!isTauri()) throw new Error(getMessages().revealDesktopOnly);
  await invoke('show_in_folder', { path });
}

const preferencesKey = 'preferences';
const defaultPreferences: AppPreferences = {
  theme: 'light',
  font: 'system',
  fontSize: 18,
  lineSpacing: 1.78,
  sidebarOpen: true,
  language: detectLanguage(),
};

function mergePreferences(stored: Partial<AppPreferences> | null | undefined): AppPreferences {
  return {
    ...defaultPreferences,
    ...stored,
    lineSpacing: normalizeLineSpacing(
      stored?.lineSpacing ?? defaultPreferences.lineSpacing,
      defaultPreferences.lineSpacing,
    ),
    language: isLanguage(stored?.language) ? stored.language : defaultPreferences.language,
  };
}

export async function loadPreferences(): Promise<AppPreferences> {
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    return mergePreferences(await store.get<Partial<AppPreferences>>(preferencesKey));
  }
  try {
    return mergePreferences(JSON.parse(localStorage.getItem(preferencesKey) ?? '{}') as Partial<AppPreferences>);
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
  return {
    name: getMessages().untitledFilename,
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
  };
}
