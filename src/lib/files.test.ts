import { describe, expect, it } from 'vitest';
import {
  documentToPortableMarkdown,
  isMarkdownFilePath,
  renameDocumentAssetReferences,
} from './files';

describe('image asset references', () => {
  it('renames only the companion asset paths when a Markdown file is renamed', () => {
    const document = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '研究圖片' }] },
        { type: 'image', attrs: { src: 'notes.assets/image-1.png' } },
        { type: 'image', attrs: { src: 'https://example.com/remote.png' } },
      ],
    };

    const renamed = renameDocumentAssetReferences(
      document,
      '/Users/example/notes.md',
      '/Users/example/proposal.md',
    );

    expect(renamed.content?.[1]?.attrs?.src).toBe('proposal.assets/image-1.png');
    expect(renamed.content?.[2]?.attrs?.src).toBe('https://example.com/remote.png');
    expect(document.content?.[1]?.attrs?.src).toBe('notes.assets/image-1.png');
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
