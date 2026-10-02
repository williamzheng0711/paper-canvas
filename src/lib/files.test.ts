import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { documentsEqual } from '../editor/documentSync';
import { documentToMarkdown, markdownToDocument } from '../editor/markdown';
import {
  documentToPortableMarkdown,
  hideRecentFile,
  hydrateDocumentAssets,
  isMarkdownFilePath,
  loadPreferences,
  loadRecent,
  rememberRecent,
  removeRecentFile,
  renameDocumentAssetReferences,
} from './files';

describe('preferences', () => {
  it('applies Compact defaults to legacy preferences and normalizes customized spacing afterward', async () => {
    localStorage.setItem(
      'preferences',
      JSON.stringify({
        theme: 'dark',
        font: 'serif',
        fontSize: 20,
        sidebarOpen: false,
      }),
    );
    await expect(loadPreferences()).resolves.toEqual(
      expect.objectContaining({ theme: 'dark', fontSize: 15, lineSpacing: 1.62, recentFilesExpanded: true }),
    );

    localStorage.setItem('preferences', JSON.stringify({ compactLayoutVersion: 1, lineSpacing: 9, recentFilesExpanded: false }));
    await expect(loadPreferences()).resolves.toEqual(
      expect.objectContaining({ lineSpacing: 3, recentFilesExpanded: false }),
    );
  });
});

describe('image asset references', () => {
  it('attaches the opened document directory to block and inline HTML previews', () => {
    const hydrated = hydrateDocumentAssets(
      {
        type: 'doc',
        content: [
          {
            type: 'htmlPreview',
            attrs: { source: '<img src="docs/editor.png">' },
          },
          {
            type: 'paragraph',
            content: [
              {
                type: 'inlineHtmlPreview',
                attrs: { source: '<img src="icon.png">' },
              },
            ],
          },
        ],
      },
      '/Users/example/paper-canvas/README.md',
    );

    expect(hydrated.content?.[0]?.attrs?.basePath).toBe('/Users/example/paper-canvas');
    expect(hydrated.content?.[1]?.content?.[0]?.attrs?.basePath).toBe('/Users/example/paper-canvas');
  });

  it.each(['README.md', 'README.en.md', 'README.zh-CN.md'])(
    'keeps the hydrated %s document stable across a source-mode round trip',
    (file) => {
      const path = resolve(process.cwd(), file);
      const opened = hydrateDocumentAssets(markdownToDocument(readFileSync(path, 'utf8')), path);
      const reopened = hydrateDocumentAssets(markdownToDocument(documentToMarkdown(opened)), path);

      expect(documentsEqual(opened, reopened)).toBe(true);
    },
  );

  it('renames only the companion asset paths when a Markdown file is renamed', () => {
    const document = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '研究圖片' }] },
        { type: 'image', attrs: { src: 'notes.assets/image-1.png' } },
        { type: 'image', attrs: { src: 'https://example.com/remote.png' } },
      ],
    };

    const renamed = renameDocumentAssetReferences(document, '/Users/example/notes.md', '/Users/example/proposal.md');

    expect(renamed.content?.[1]?.attrs?.src).toBe('proposal.assets/image-1.png');
    expect(renamed.content?.[2]?.attrs?.src).toBe('https://example.com/remote.png');
    expect(document.content?.[1]?.attrs?.src).toBe('notes.assets/image-1.png');
  });
});

describe('recent documents', () => {
  it('persists hiding one item while preserving the remaining order', async () => {
    localStorage.clear();
    localStorage.setItem(
      'recentFiles',
      JSON.stringify([
        { path: '/tmp/first.md', name: 'first.md' },
        { path: '/tmp/second.md', name: 'second.md' },
      ]),
    );

    await expect(hideRecentFile('/tmp/first.md')).resolves.toEqual([{ path: '/tmp/second.md', name: 'second.md' }]);
    await expect(loadRecent()).resolves.toEqual([{ path: '/tmp/second.md', name: 'second.md' }]);

    await rememberRecent({ path: '/tmp/first.md', name: 'first.md' });
    await expect(loadRecent()).resolves.toEqual([{ path: '/tmp/second.md', name: 'second.md' }]);
  });

  it('removes a stale entry without permanently hiding its path', async () => {
    localStorage.clear();
    localStorage.setItem(
      'recentFiles',
      JSON.stringify([
        { path: '/tmp/stale.md', name: 'stale.md' },
        { path: '/tmp/current.md', name: 'current.md' },
      ]),
    );

    await expect(removeRecentFile('/tmp/stale.md')).resolves.toEqual([
      { path: '/tmp/current.md', name: 'current.md' },
    ]);
    await rememberRecent({ path: '/tmp/stale.md', name: 'stale.md' });
    await expect(loadRecent()).resolves.toEqual([
      { path: '/tmp/stale.md', name: 'stale.md' },
      { path: '/tmp/current.md', name: 'current.md' },
    ]);
  });
});

describe('Markdown file associations', () => {
  it('recognizes both supported file extensions without accepting lookalikes', () => {
    expect(isMarkdownFilePath('/Users/example/研究筆記.md')).toBe(true);
    expect(isMarkdownFilePath('C:\\notes\\proposal.MARKDOWN')).toBe(true);
    expect(isMarkdownFilePath('/Users/example/notes.md.bak')).toBe(false);
    expect(isMarkdownFilePath('/Users/example/notes.txt')).toBe(false);
  });
});

describe('Markdown export', () => {
  it('uses original relative image paths instead of Tauri display URLs', () => {
    const markdown = documentToPortableMarkdown({
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            src: 'http://asset.localhost/notes.assets/image-1.png',
            originalSrc: 'notes.assets/image-1.png',
            alt: '圖表',
          },
        },
      ],
    });

    expect(markdown).toContain('notes.assets/image-1.png');
    expect(markdown).not.toContain('asset.localhost');
  });
});
