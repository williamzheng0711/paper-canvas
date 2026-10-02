import type { JSONContent } from '@tiptap/core';
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core';
import { confirm, open, save } from '@tauri-apps/plugin-dialog';
import { exists, mkdir, readFile, rename, writeFile } from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';
import {
  parseMarkdownComments,
  relocateMarkdownComments,
  serializeMarkdownWithComments,
  type MarkdownComment,
} from '../editor/comments';
import { documentToMarkdown, markdownToDocument } from '../editor/markdown';
import { isValidCanvasDocument } from '../editor/canvasSchema';
import { detectLanguage, getMessages, isLanguage, type Language } from '../i18n';
import { normalizeLineSpacing } from './lineSpacing';
import { normalizeFontSize } from './fontSize';
import { encodeLocalAssetPath, isWindowsFilePath, localAssetUrl } from './localAssets';
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

/** A failed rename whose rollback could not restore every original entry. */
export class FileRenameRecoveryError extends Error {
  constructor(
    error: unknown,
    readonly originalPath: string,
    readonly targetPath: string,
    readonly path: string,
    readonly assetsRenamed: boolean,
  ) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'FileRenameRecoveryError';
  }

  /** Apply the surviving disk paths to the latest edits, including mid-rename typing. */
  recover(file: EditorFile): EditorFile {
    return editorFileAfterRename(file, this.path, this.assetsRenamed ? this.originalPath : undefined, this.assetsRenamed ? this.targetPath : undefined);
  }
}

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

let settingsMutationQueue: Promise<unknown> = Promise.resolve();

function queueSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = settingsMutationQueue.then(operation);
  settingsMutationQueue = result.catch(() => undefined);
  return result;
}

function separator(path: string) {
  return isWindowsFilePath(path) && path.includes('\\') ? '\\' : '/';
}

export function fileName(path: string): string {
  return path.split(path.startsWith('/') ? /\// : /[\\/]/).at(-1) || 'Untitled.md';
}

export function isMarkdownFilePath(path: string): boolean {
  return /\.(md|markdown)$/i.test(fileName(path));
}

function parentPath(path: string): string {
  const index = path.startsWith('/') ? path.lastIndexOf('/') : Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (index < 0) return '.';
  const parent = path.slice(0, index);
  return /^[A-Za-z]:$/.test(parent) ? parent + path[index] : parent || separator(path);
}

function joinPath(base: string, child: string): string {
  return `${base.replace(separator(base) === '/' ? /\/$/ : /[\\/]$/, '')}${separator(base)}${child}`;
}

function isCaseOnlyPathChange(source: string, target: string): boolean {
  return source !== target && source.toLowerCase() === target.toLowerCase();
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
  const mime = /^data:([^;]+)/.exec(dataUrl)?.[1].toLowerCase() ?? 'image/png';
  const extensions: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-ms-bmp': 'bmp',
    'image/tiff': 'tiff',
  };
  return extensions[mime] ?? 'png';
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
  const batchId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await invoke('allow_document_assets', { path });
  await mkdir(targetDirectory, { recursive: true });
  await Promise.all(
    assets.map(async ({ node, src }, index) => {
      const bytes = dataUrlBytes(src);
      if (!bytes) return;
      const relative = `${fileName(path).replace(/\.md$/i, '')}.assets/image-${batchId}-${index}.${extensionForDataUrl(src)}`;
      await writeFile(joinPath(parentPath(path), relative), bytes, { createNew: true });
      node.attrs = { ...node.attrs, src: encodeLocalAssetPath(relative, isWindowsFilePath(path)) };
    }),
  );
  return prepared;
}

export function hydrateDocumentAssets(document: JSONContent, path?: string): JSONContent {
  const hydrated = cloneDocument(document);
  const basePath = path ? parentPath(path) : undefined;
  const desktop = isTauri();
  visit(hydrated, (node) => {
    if (basePath !== undefined && (node.type === 'htmlPreview' || node.type === 'inlineHtmlPreview')) {
      node.attrs = { ...node.attrs, basePath };
    }
    const src = node.type === 'image' ? node.attrs?.src : undefined;
    if (desktop && typeof src === 'string' && !isExternalImage(src) &&
      (basePath !== undefined || /^(?:\/(?!\/)|\\|[A-Za-z]:[\\/]|file:\/\/)/i.test(src))) {
      node.attrs = {
        ...node.attrs,
        originalSrc: src,
        basePath: basePath ?? '',
        src: localAssetUrl(basePath ?? '', src, convertFileSrc),
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

export async function confirmDiscardChanges(message: string): Promise<boolean> {
  return isTauri() ? confirm(message, { kind: 'warning' }) : window.confirm(message);
}

function editorFileFromMarkdown(markdown: string, path?: string, name = path ? fileName(path) : getMessages().untitledFilename): EditorFile {
  const parsed = parseMarkdownComments(markdown);
  const document = hydrateDocumentAssets(markdownToDocument(parsed.body), path);
  const canonicalMarkdown = parsed.comments.length > 0 ? documentToPortableMarkdown(document) : parsed.body;
  return {
    path,
    name,
    sourceMarkdown: markdown,
    document,
    comments: relocateMarkdownComments(parsed.comments, parsed.body, canonicalMarkdown),
    ...(parsed.status === 'invalid' || parsed.status === 'unknown-version'
      ? { commentWarning: getMessages().commentDataWarning }
      : {}),
  };
}

async function readMarkdownFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    // Preserve a UTF-8 BOM and refuse replacement characters that would turn
    // an unchanged save into silent corruption of a differently encoded file.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(getMessages().unsupportedMarkdownEncoding);
  }
}

export async function openMarkdownFile(path: string): Promise<EditorFile> {
  const text = getMessages();
  if (!isTauri()) throw new Error(text.externalFilesDesktopOnly);
  if (!isMarkdownFilePath(path)) throw new Error(text.markdownFilesOnly);
  const markdown = await readMarkdownFile(path);
  const file = editorFileFromMarkdown(markdown, path);
  // History is supplementary. An unavailable settings store must not block a
  // document that was read successfully, including files opened by the OS.
  await rememberRecent({ path, name: file.name }).catch(() => undefined);
  return file;
}

export async function chooseSavePath(defaultName: string): Promise<string | null> {
  const text = getMessages();
  if (!isTauri()) throw new Error(text.saveAsDesktopOnly);
  const selected = await save({
    title: text.saveDocumentDialog,
    defaultPath: isMarkdownFilePath(defaultName) ? defaultName : `${defaultName}.md`,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
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

/** Commit the complete source atomically so a failed write cannot truncate it. */
function writeMarkdownFile(path: string, contents: string): Promise<void> {
  return invoke('write_markdown_file', { path, contents });
}

/** Rename without replacing an entry created after the collision check. */
function renameDocumentEntry(source: string, target: string): Promise<void> {
  return isTauri() ? invoke('rename_document_entry', { source, target }) : rename(source, target);
}

/** Exports a Markdown copy without changing the active document path. */
export async function exportMarkdownFile(markdown: string, defaultName: string, sourcePath?: string): Promise<string | null> {
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
  const exportedMarkdown = sourcePath ? rebaseMarkdownImageAssets(markdown, sourcePath, selected) : markdown;
  await writeMarkdownFile(selected, exportedMarkdown);
  return fileName(selected);
}

export type PdfExportResult = { type: 'saved'; name: string } | { type: 'print' } | { type: 'cancelled' };

/**
 * Saves directly through AppKit on macOS so WKWebView never presents its stale
 * print-preview thumbnail. Other platforms retain their system print flow.
 */
export async function exportPdfFile(
  defaultName: string,
  isCurrentDocument: () => boolean = () => true,
): Promise<PdfExportResult> {
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
  if (!selected || !isCurrentDocument()) return { type: 'cancelled' };

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
    if (!selected) throw new DOMException(getMessages().saveCancelled, 'AbortError');
    path = selected;
  }
  const candidate = { ...file, sourceMarkdown: rawMarkdown ?? file.sourceMarkdown };
  const prepared = file.path && file.path !== path ? rebaseEditorFileAssets(candidate, file.path, path) : candidate;
  const portable = restoreRelativeImagePaths(prepared.document);
  const sourceMarkdown = prepared.sourceMarkdown;
  if (sourceMarkdown !== undefined) {
    await writeMarkdownFile(path, sourceMarkdown);
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
  await writeMarkdownFile(path, savedMarkdown);
  await rememberRecent({ path, name: fileName(path) }).catch(() => undefined);
  return {
    path,
    name: fileName(path),
    document: hydrateDocumentAssets(withAssets, path),
    comments,
    sourceMarkdown: savedMarkdown,
  };
}

function editorFileAfterRename(file: EditorFile, path: string, oldAssetPath?: string, newAssetPath?: string): EditorFile {
  const portable = oldAssetPath && newAssetPath
    ? renameDocumentAssetReferences(file.document, oldAssetPath, newAssetPath)
    : restoreRelativeImagePaths(file.document);
  const document = hydrateDocumentAssets(portable, path);
  return {
    ...file,
    path,
    name: fileName(path),
    document,
    comments: oldAssetPath && newAssetPath
      ? mapImagePathComments(file.comments ?? [], documentToPortableMarkdown(file.document), documentToPortableMarkdown(document), oldAssetPath, newAssetPath, 'rename')
      : file.comments,
    sourceMarkdown: file.sourceMarkdown === undefined || !oldAssetPath || !newAssetPath
      ? file.sourceMarkdown
      : renameMarkdownImageAssets(file.sourceMarkdown, oldAssetPath, newAssetPath),
  };
}

export async function renameEditorFile(file: EditorFile, newName: string): Promise<EditorFile> {
  const text = getMessages();
  const cleanName = newName.trim().replace(/[\\/:*?"<>|]/g, '-');
  if (!cleanName) throw new Error(text.invalidFilename);
  if (!file.path)
    return {
      ...file,
      name: isMarkdownFilePath(cleanName) ? cleanName : `${cleanName}.md`,
    };
  const target = joinPath(parentPath(file.path), isMarkdownFilePath(cleanName) ? cleanName : `${cleanName}.md`);
  if (target === file.path) return file;
  if (isTauri()) await invoke('allow_document_rename', { source: file.path, target });
  if (await exists(target) && !isCaseOnlyPathChange(file.path, target)) throw new Error(text.filenameExists);

  const oldAssets = assetDirectory(file.path);
  const nextAssets = assetDirectory(target);
  const moveAssets = oldAssets !== nextAssets && await exists(oldAssets);
  if (moveAssets && (await exists(nextAssets)) && !isCaseOnlyPathChange(oldAssets, nextAssets)) {
    throw new Error(text.assetsDirectoryExists);
  }

  let assetsMoved = false;
  await renameDocumentEntry(file.path, target);
  try {
    if (moveAssets) {
      await renameDocumentEntry(oldAssets, nextAssets);
      assetsMoved = true;
    }
    const originalSource = await readMarkdownFile(target);
    const renamedSource = renameMarkdownImageAssets(originalSource, file.path, target);
    if (renamedSource !== originalSource) {
      await writeMarkdownFile(target, renamedSource);
    }
  } catch (error) {
    // Atomic source commits retain the original bytes on failure. Restore the
    // document and companion names without replacing newly created entries.
    let assetsRemainRenamed = assetsMoved;
    if (assetsMoved) {
      try {
        await renameDocumentEntry(nextAssets, oldAssets);
        assetsRemainRenamed = false;
      } catch {
        // Keep references pointed at the companion folder that actually moved.
      }
    }
    let recoveredPath = target;
    try {
      await renameDocumentEntry(target, file.path);
      recoveredPath = file.path;
    } catch {
      // A failed or collided rollback must never send the next save to an
      // unrelated entry recreated at the original path.
    }
    if (recoveredPath !== file.path || assetsRemainRenamed) {
      await rememberRecent({ path: recoveredPath, name: fileName(recoveredPath) }, file.path).catch(() => undefined);
      throw new FileRenameRecoveryError(error, file.path, target, recoveredPath, assetsRemainRenamed);
    }
    throw error;
  }
  // The file and companion assets have moved successfully; keep the live path
  // consistent with disk even if persisting recent history fails.
  await rememberRecent({ path: target, name: fileName(target) }, file.path).catch(() => undefined);
  return editorFileAfterRename(file, target, file.path, target);
}

async function browserSettings(): Promise<Storage> {
  return localStorage;
}

function parseRecentValue(value: string | null): unknown {
  try {
    return JSON.parse(value ?? 'null');
  } catch {
    return undefined;
  }
}

function hiddenRecentPaths(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string') : []);
}

function visibleRecentFiles(value: unknown, hiddenValue: unknown): RecentFile[] {
  if (!Array.isArray(value)) return [];
  const hidden = hiddenRecentPaths(hiddenValue);
  const files: RecentFile[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string' || !item.path.trim() || hidden.has(item.path) || seen.has(item.path)) continue;
    seen.add(item.path);
    files.push({
      path: item.path,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : fileName(item.path),
    });
    if (files.length === 12) break;
  }
  return files;
}

export async function loadRecent(): Promise<RecentFile[]> {
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    return visibleRecentFiles(await store.get<unknown>(recentKey), await store.get<unknown>(hiddenRecentKey));
  }
  const storage = await browserSettings();
  return visibleRecentFiles(parseRecentValue(storage.getItem(recentKey)), parseRecentValue(storage.getItem(hiddenRecentKey)));
}

async function updateRecentFiles(update: (files: RecentFile[]) => RecentFile[]): Promise<RecentFile[]> {
  const files = update(await loadRecent());
  if (isTauri()) {
    const store = await Store.load(settingsKey, { autoSave: 200 });
    await store.set(recentKey, files);
  } else {
    const storage = await browserSettings();
    storage.setItem(recentKey, JSON.stringify(files));
  }
  return files;
}

export function rememberRecent(recent: RecentFile, replacedPath?: string): Promise<void> {
  return queueSettingsMutation(async () => {
    await updateRecentFiles((files) => [recent, ...files.filter((item) => item.path !== recent.path && item.path !== replacedPath)].slice(0, 12));
  });
}

export function removeRecentFile(path: string): Promise<RecentFile[]> {
  return queueSettingsMutation(() => updateRecentFiles((files) => files.filter((item) => item.path !== path)));
}

export function hideRecentFile(path: string): Promise<RecentFile[]> {
  return queueSettingsMutation(async () => {
    const files = await updateRecentFiles((items) => items.filter((item) => item.path !== path));
    if (isTauri()) {
      const store = await Store.load(settingsKey, { autoSave: 200 });
      const hidden = hiddenRecentPaths(await store.get<unknown>(hiddenRecentKey));
      hidden.add(path);
      await store.set(hiddenRecentKey, [...hidden]);
    } else {
      const storage = await browserSettings();
      const hidden = hiddenRecentPaths(parseRecentValue(storage.getItem(hiddenRecentKey)));
      hidden.add(path);
      storage.setItem(hiddenRecentKey, JSON.stringify([...hidden]));
    }
    return files;
  });
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
    theme: preferences.theme === 'light' || preferences.theme === 'dark' ? preferences.theme : defaultPreferences.theme,
    font: ['system', 'serif', 'mono'].includes(preferences.font) ? preferences.font : defaultPreferences.font,
    fontSize: normalizeFontSize(
      typeof preferences.fontSize === 'number' || typeof preferences.fontSize === 'string' ? String(preferences.fontSize) : '',
      defaultPreferences.fontSize,
    ),
    sidebarOpen: typeof preferences.sidebarOpen === 'boolean' ? preferences.sidebarOpen : defaultPreferences.sidebarOpen,
    recentFilesExpanded: typeof preferences.recentFilesExpanded === 'boolean' ? preferences.recentFilesExpanded : defaultPreferences.recentFilesExpanded,
    lineSpacing: normalizeLineSpacing(
      typeof preferences.lineSpacing === 'number' || typeof preferences.lineSpacing === 'string' ? preferences.lineSpacing : defaultPreferences.lineSpacing,
      defaultPreferences.lineSpacing,
    ),
    language: isLanguage(stored?.language) ? stored.language : defaultPreferences.language,
    compactLayoutVersion: appliedCompact ? stored!.compactLayoutVersion : currentCompactLayoutVersion,
  };
}

async function readPreferences(): Promise<AppPreferences> {
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

export function loadPreferences(): Promise<AppPreferences> {
  return queueSettingsMutation(readPreferences);
}

export function savePreferences(preferences: AppPreferences): Promise<void> {
  const saved = {
    ...preferences,
    compactLayoutVersion: Math.max(currentCompactLayoutVersion, preferences.compactLayoutVersion ?? 0),
  };
  return queueSettingsMutation(async () => {
    if (isTauri()) {
      const store = await Store.load(settingsKey, { autoSave: 200 });
      await store.set(preferencesKey, saved);
      return;
    }
    localStorage.setItem(preferencesKey, JSON.stringify(saved));
  });
}

export async function openRecent(recent: RecentFile): Promise<EditorFile | null> {
  if (!(await exists(recent.path))) return null;

  let markdown: string;
  try {
    markdown = await readMarkdownFile(recent.path);
  } catch (error) {
    // The file may be removed after the existence check. Keep other failures,
    // such as denied access, distinguishable from a genuinely stale entry.
    if (!(await exists(recent.path))) return null;
    throw error;
  }
  return editorFileFromMarkdown(markdown, recent.path, recent.name);
}

function restoredDraft(value: unknown): EditorFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const draft = value as Partial<EditorFile>;
  const name = typeof draft.name === 'string' && draft.name.trim() ? draft.name : getMessages().untitledFilename;
  // Exact source is authoritative. A stale or damaged cache must not turn a
  // recoverable draft into an empty editor, or carry invalid comments into it.
  if (typeof draft.sourceMarkdown === 'string') {
    return editorFileFromMarkdown(draft.sourceMarkdown, undefined, name);
  }
  if (!isValidCanvasDocument(draft.document)) return null;
  let markdown: string;
  try {
    markdown = documentToPortableMarkdown(draft.document);
  } catch {
    return null;
  }
  let comments = draft.comments;
  let commentWarning = typeof draft.commentWarning === 'string' ? draft.commentWarning : undefined;
  if (comments !== undefined) {
    try {
      const parsed = parseMarkdownComments(serializeMarkdownWithComments(markdown, comments));
      if (parsed.status === 'invalid' || parsed.status === 'unknown-version') throw new Error('Invalid cached comments');
      comments = parsed.comments;
    } catch {
      // Supplementary metadata damage must not abandon recoverable writing.
      comments = [];
      commentWarning = getMessages().commentDataWarning;
    }
  }
  return { name, document: draft.document, ...(comments !== undefined ? { comments } : {}), ...(commentWarning !== undefined ? { commentWarning } : {}) };
}

function restoreDraftOrThrow(value: unknown): EditorFile | null {
  const draft = restoredDraft(value);
  if (!draft && value !== undefined && value !== null) throw new Error(getMessages().draftRecoveryFailed);
  return draft;
}

export function loadDraft(): Promise<EditorFile | null> {
  return queueSettingsMutation(async () => {
    if (isTauri()) {
      const serialized = await invoke<string | null>('read_recovery_draft');
      if (typeof serialized === 'string') {
        try {
          return restoreDraftOrThrow(JSON.parse(serialized));
        } catch {
          throw new Error(getMessages().draftRecoveryFailed);
        }
      }
      const store = await Store.load(settingsKey, { autoSave: 200 });
      const legacy = await store.get<unknown>(draftKey);
      // Copy the original record, including damaged supplementary metadata.
      // Migration failure must not prevent restoring readable legacy writing.
      if (legacy !== undefined && legacy !== null) {
        await invoke('write_recovery_draft', { contents: JSON.stringify(legacy) }).catch(() => undefined);
      }
      return restoreDraftOrThrow(legacy);
    }
    try {
      return restoreDraftOrThrow(JSON.parse(localStorage.getItem(draftKey) ?? 'null'));
    } catch {
      throw new Error(getMessages().draftRecoveryFailed);
    }
  });
}

export function saveDraft(file: EditorFile): Promise<void> {
  const draft = { ...file, path: undefined };
  return queueSettingsMutation(async () => {
    if (isTauri()) {
      await invoke('write_recovery_draft', { contents: JSON.stringify(draft) });
      return;
    }
    localStorage.setItem(draftKey, JSON.stringify(draft));
  });
}

export function clearDraft(): Promise<void> {
  return queueSettingsMutation(async () => {
    if (isTauri()) {
      await invoke('clear_recovery_draft');
      const store = await Store.load(settingsKey, { autoSave: 200 });
      await store.delete(draftKey);
      return;
    }
    localStorage.removeItem(draftKey);
  });
}

/** Finish queued recovery/settings writes before a native window is destroyed. */
export function flushSettings(): Promise<void> {
  return queueSettingsMutation(async () => {
    if (!isTauri()) return;
    const store = await Store.load(settingsKey, { autoSave: 200 });
    await store.save();
  });
}

export function newEditorFile(): EditorFile {
  return {
    name: getMessages().untitledFilename,
    document: { type: 'doc', content: [{ type: 'paragraph' }] },
    comments: [],
  };
}
