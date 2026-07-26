import { describe, expect, it } from 'vitest';
import { documentToMarkdown, markdownToDocument } from './markdown';

describe('50,000-character local document performance', () => {
  it('parses and serializes a Chinese plain-text document without a multi-second stall', () => {
    const source = '研究筆記與數學推導。'.repeat(5_000); // 50,000 Unicode characters
    const started = performance.now();
    const document = markdownToDocument(source);
    const serialized = documentToMarkdown(document);
    const elapsed = performance.now() - started;

    console.info(`50k Chinese Markdown parse + serialize: ${elapsed.toFixed(1)} ms`);
    expect(serialized).toBe(source + '\n');
    expect(elapsed).toBeLessThan(1_500);
  });
});
