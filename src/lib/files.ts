import type { JSONContent } from '@tiptap/core';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { exists, mkdir, readTextFile, rename, writeFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';
import {
  parseMarkdownComments,
  relocateMarkdownComments,
  serializeMarkdownWithComments,
  type MarkdownComment,
} from '../editor/comments';
import { documentToMarkdown, markdownToDocument } from '../editor/markdown';
import { detectLanguage, getMessages, isLanguage, type Language } from '../i18n';
import { normalizeLineSpacing } from './lineSpacing';
import { localAssetUrl } from './localAssets';
import {
  rebaseHtmlImageAssets,
  rebaseImageDestination,
  rebaseMarkdownImageAssets,
  mapImagePathComments,
  renameHtmlImageAssets,
  renameImageDestination,
  renameMarkdownImageAssets,
} from '../editor/markdownAssetReferences';

export type RecentFile = { path: string; name: string };
export type EditorFile = {
  path?: string;
  name: string;
  document: JSONContent;
  comments?: MarkdownComment[];
  commentWarning?: string;
  /** Exact source for the current document; invalidated by canvas edits. */
  sourceMarkdown?: string;
};

export type AppPreferences = {
  theme: 'light' | 'dark';
  font: 'system' | 'serif' | 'mono';
  fontSize: number;
  lineSpacing: number;
  sidebarOpen: boolean;
  recentFilesExpanded: boolean;
  language: Language;
  /** Records the one-time application of the approved Compact layout defaults. */
  compactLayoutVersion?: number;
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
  if (index < 0) return '.';
  const parent = path.slice(0, index);
  return /^[A-Za-z]:$/.test(parent) ? parent + path[index] : parent || separator(path);
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
  await invoke('allow_document_assets', { path });
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

export function hydrateDocumentAssets(document: JSONContent, path?: string): JSONContent {
  const hydrated = cloneDocument(document);
  if (!path) return hydrated;
  const basePath = parentPath(path);
  const desktop = isTauri();
  visit(hydrated, (node) => {
    if (node.type === 'htmlPreview' || node.type === 'inlineHtmlPreview') {
      node.attrs = { ...node.attrs, basePath };
    }
    const src = node.type === 'image' ? node.attrs?.src : undefined;
    if (desktop && typeof src === 'string' && !isExternalImage(src)) {
      node.attrs = {
        ...node.attrs,
        originalSrc: src,
        src: localAssetUrl(basePath, src, convertFileSrc),
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
export function documentToPortableMarkdown(
  document: JSONContent,
  comments: readonly MarkdownComment[] = [],
): string {
  return serializeMarkdownWithComments(documentToMarkdown(restoreRelativeImagePaths(document)), comments);
}

export function renameDocumentAssetReferences(document: JSONContent, oldPath: string, newPath: string): JSONContent {
  const renamed = restoreRelativeImagePaths(document);
  visit(renamed, (node) => {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') {
      node.attrs = {
        ...node.attrs,
        src: renameImageDestination(node.attrs.src, oldPath, newPath),
      };
    } else if ((node.type === 'htmlPreview' || node.type === 'inlineHtmlPreview') && typeof node.attrs?.source === 'string') {
      node.attrs = { ...node.attrs, source: renameHtmlImageAssets(node.attrs.source, oldPath, newPath) };
    } else if (node.type === 'unsupportedMarkdown' && typeof node.attrs?.source === 'string') {
      node.attrs = { ...node.attrs, source: renameMarkdownImageAssets(node.attrs.source, oldPath, newPath) };
    }
  });
  return renamed;
}

export function rebaseDocumentAssetReferences(document: JSONContent, oldPath: string, newPath: string): JSONContent {
  const rebased = restoreRelativeImagePaths(document);
  visit(rebased, (node) => {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') {
      node.attrs = { ...node.attrs, src: rebaseImageDestination(node.attrs.src, oldPath, newPath) };
    } else if ((node.type === 'htmlPreview' || node.type === 'inlineHtmlPreview') && typeof node.attrs?.source === 'string') {
      node.attrs = { ...node.attrs, source: rebaseHtmlImageAssets(node.attrs.source, oldPath, newPath) };
    } else if (node.type === 'unsupportedMarkdown' && typeof node.attrs?.source === 'string') {
      node.attrs = { ...node.attrs, source: rebaseMarkdownImageAssets(node.attrs.source, oldPath, newPath) };
    }
  });
  return rebased;
}

/** Rebase once before adopting a Save As path, including edits made mid-save. */
export function rebaseEditorFileAssets(file: EditorFile, oldPath: string, newPath: string): EditorFile {
  const portable = rebaseDocumentAssetReferences(file.document, oldPath, newPath);
  const previousMarkdown = documentToPortableMarkdown(file.document);
  const nextMarkdown = documentToMarkdown(portable);
  const comments = previousMarkdown === nextMarkdown
    ? file.comments ?? []
    : mapImagePathComments(file.comments ?? [], previousMarkdown, nextMarkdown, oldPath, newPath);
  const sourceMarkdown = file.sourceMarkdown === undefined ? undefined : rebaseMarkdownImageAssets(file.sourceMarkdown, oldPath, newPath);
  return {
    ...file,
    path: newPath,
    name: fileName(newPath),
    document: hydrateDocumentAssets(portable, newPath),
    comments,
    sourceMarkdown,
  };
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
  const parsed = parseMarkdownComments(markdown);
  const document = hydrateDocumentAssets(markdownToDocument(parsed.body), path);
  const canonicalMarkdown = parsed.comments.length > 0 ? documentToPortableMarkdown(document) : parsed.body;
  const file = {
    path,
    name: fileName(path),
    sourceMarkdown: markdown,
    document,
    comments: relocateMarkdownComments(parsed.comments, parsed.body, canonicalMarkdown),
    ...(parsed.status === 'invalid' || parsed.status === 'unknown-version'
      ? { commentWarning: text.commentDataWarning }
      : {}),
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

export async function saveEditorFile(
  file: EditorFile,
  forceSaveAs = false,
  rawMarkdown?: string,
): Promise<EditorFile> {
  let path = file.path;
  if (!path || forceSaveAs) {
    const selected = await chooseSavePath(file.name);
    if (!selected) throw new Error(getMessages().saveCancelled);
    path = selected;
  }
  if (!path) throw new Error(getMessages().saveCancelled);
  const candidate = { ...file, sourceMarkdown: rawMarkdown ?? file.sourceMarkdown };
  const prepared = file.path && file.path !== path ? rebaseEditorFileAssets(candidate, file.path, path) : candidate;
  const portable = restoreRelativeImagePaths(prepared.document);
  const sourceMarkdown = prepared.sourceMarkdown;
  if (sourceMarkdown !== undefined) {
    await writeTextFile(path, sourceMarkdown);
    // The file is already committed. History failure must not prevent adopting
    // a Save As destination and leave subsequent saves targeting the old path.
    await rememberRecent({ path, name: fileName(path) }).catch(() => undefined);
    return {
      path,
      name: fileName(path),
      document: hydrateDocumentAssets(portable, path),
      comments: prepared.comments ?? [],
      sourceMarkdown,
    };
  }
  const markdownBeforeAssets = documentToMarkdown(portable);
  const withAssets = await persistEmbeddedImages(portable, path);
  const markdown = documentToMarkdown(withAssets);
  const comments = relocateMarkdownComments(prepared.comments ?? [], markdownBeforeAssets, markdown);
  const savedMarkdown = serializeMarkdownWithComments(markdown, comments);
  await writeTextFile(path, savedMarkdown);
  await rememberRecent({ path, name: fileName(path) }).catch(() => undefined);
  return {
    path,
    name: fileName(path),
    document: hydrateDocumentAssets(withAssets, path),
    comments,
    sourceMarkdown: savedMarkdown,
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

  let originalSource: string | undefined;
  let rewriteAttempted = false;
  await rename(file.path, target);
  try {
    if (hasAssets) await rename(oldAssets, nextAssets);
    originalSource = await readTextFile(target);
    const renamedSource = renameMarkdownImageAssets(originalSource, file.path, target);
    if (renamedSource !== originalSource) {
      rewriteAttempted = true;
      await writeTextFile(target, renamedSource);
    }
  } catch (error) {
    // A failed write may already have truncated the file. Recover source bytes
    // before restoring its name, as well as the companion directory.
    if (rewriteAttempted && originalSource !== undefined) {
      await writeTextFile(target, originalSource).catch(() => undefined);
    }
    // Recover the original pair when moving the companion directory fails.
    if (hasAssets && (await exists(nextAssets)) && !(await exists(oldAssets))) {
      await rename(nextAssets, oldAssets).catch(() => undefined);
    }
    if ((await exists(target)) && !(await exists(file.path))) {
      await rename(target, file.path).catch(() => undefined);
    }
    throw error;
  }
  // The file and companion assets have moved successfully; keep the live path
  // consistent with disk even if persisting recent history fails.
  await rememberRecent({ path: target, name: fileName(target) }).catch(() => undefined);
  const document = hydrateDocumentAssets(renameDocumentAssetReferences(file.document, file.path, target), target);
  return {
    ...file,
    path: target,
    name: fileName(target),
    document,
    comments: mapImagePathComments(file.comments ?? [], documentToPortableMarkdown(file.document), documentToPortableMarkdown(document), file.path, target, 'rename'),
    sourceMarkdown: file.sourceMarkdown === undefined ? undefined : renameMarkdownImageAssets(file.sourceMarkdown, file.path, target),
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

export async function removeRecentFile(path: string): Promise<RecentFile[]> {
  const files = (await loadRecent()).filter((item) => item.path !== path);
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    await store.set(recentKey, files);
    return files;
  }
  const storage = await browserSettings();
  storage.setItem(recentKey, JSON.stringify(files));
  return files;
}

export async function hideRecentFile(path: string): Promise<RecentFile[]> {
  const files = await removeRecentFile(path);
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    const hidden = new Set((await store.get<string[]>(hiddenRecentKey)) ?? []);
    hidden.add(path);
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
  storage.setItem(hiddenRecentKey, JSON.stringify([...new Set([...hidden, path])]));
  return files;
}

export async function revealFileInFolder(path: string): Promise<void> {
  if (!isTauri()) throw new Error(getMessages().revealDesktopOnly);
  await invoke('show_in_folder', { path });
}

const preferencesKey = 'preferences';
const currentCompactLayoutVersion = 1;
const defaultPreferences: AppPreferences = {
  theme: 'light',
  font: 'system',
  fontSize: 15,
  lineSpacing: 1.62,
  sidebarOpen: true,
  recentFilesExpanded: true,
  language: detectLanguage(),
  compactLayoutVersion: currentCompactLayoutVersion,
};

function mergePreferences(stored: Partial<AppPreferences> | null | undefined): AppPreferences {
  const appliedCompact = typeof stored?.compactLayoutVersion === 'number' &&
    stored.compactLayoutVersion >= currentCompactLayoutVersion;
  const preferences = {
    ...defaultPreferences,
    ...stored,
    ...(!appliedCompact ? {
      font: defaultPreferences.font,
      fontSize: defaultPreferences.fontSize,
      lineSpacing: defaultPreferences.lineSpacing,
      sidebarOpen: defaultPreferences.sidebarOpen,
    } : {}),
  };
  return {
    ...preferences,
    lineSpacing: normalizeLineSpacing(
      preferences.lineSpacing,
      defaultPreferences.lineSpacing,
    ),
    language: isLanguage(stored?.language) ? stored.language : defaultPreferences.language,
    compactLayoutVersion: appliedCompact ? stored!.compactLayoutVersion : currentCompactLayoutVersion,
  };
}

export async function loadPreferences(): Promise<AppPreferences> {
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    const stored = await store.get<Partial<AppPreferences>>(preferencesKey);
    const preferences = mergePreferences(stored);
    if (stored?.compactLayoutVersion !== preferences.compactLayoutVersion) await store.set(preferencesKey, preferences);
    return preferences;
  }
  let stored: Partial<AppPreferences> | undefined;
  try {
    stored = JSON.parse(localStorage.getItem(preferencesKey) ?? '{}') as Partial<AppPreferences>;
  } catch {
    // Recover malformed settings using the current layout defaults.
  }
  const preferences = mergePreferences(stored);
  if (stored?.compactLayoutVersion !== preferences.compactLayoutVersion) {
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  }
  return preferences;
}

export async function savePreferences(preferences: AppPreferences): Promise<void> {
  const saved = {
    ...preferences,
    compactLayoutVersion: Math.max(currentCompactLayoutVersion, preferences.compactLayoutVersion ?? 0),
  };
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    await store.set(preferencesKey, saved);
    return;
  }
  localStorage.setItem(preferencesKey, JSON.stringify(saved));
}

export async function openRecent(recent: RecentFile): Promise<EditorFile | null> {
  if (!(await exists(recent.path))) return null;

  let markdown: string;
  try {
    markdown = await readTextFile(recent.path);
  } catch (error) {
    // The file may be removed after the existence check. Keep other failures,
    // such as denied access, distinguishable from a genuinely stale entry.
    if (!(await exists(recent.path))) return null;
    throw error;
  }
  const parsed = parseMarkdownComments(markdown);
  const document = hydrateDocumentAssets(markdownToDocument(parsed.body), recent.path);
  const canonicalMarkdown = parsed.comments.length > 0 ? documentToPortableMarkdown(document) : parsed.body;
  return {
    path: recent.path,
    name: recent.name,
    sourceMarkdown: markdown,
    document,
    comments: relocateMarkdownComments(parsed.comments, parsed.body, canonicalMarkdown),
    ...(parsed.status === 'invalid' || parsed.status === 'unknown-version'
      ? { commentWarning: getMessages().commentDataWarning }
      : {}),
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

let draftMutationQueue: Promise<void> = Promise.resolve();

function queueDraftMutation(operation: () => Promise<void>): Promise<void> {
  const result = draftMutationQueue.then(operation);
  draftMutationQueue = result.catch(() => undefined);
  return result;
}

export function saveDraft(file: EditorFile): Promise<void> {
  const draft = { ...file, path: undefined };
  return queueDraftMutation(async () => {
    if (isTauri()) {
      const store = await Store.load(settingsKey, { autoSave: 200 });
      await store.set(draftKey, draft);
      return;
    }
    localStorage.setItem(draftKey, JSON.stringify(draft));
  });
}

export function clearDraft(): Promise<void> {
  return queueDraftMutation(async () => {
    if (isTauri()) {
      const store = await Store.load(settingsKey, { autoSave: 200 });
      await store.delete(draftKey);
      return;
    }
    localStorage.removeItem(draftKey);
  });
}

export function newEditorFile(): EditorFile {
  return {
    name: getMessages().untitledFilename,
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
    comments: [],
  };
}
