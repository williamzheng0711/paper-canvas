import { describe, expect, it } from 'vitest';
import { markdownToDocument } from './markdown';
import {
  createMarkdownComment,
  markdownFingerprint,
  parseMarkdownComments,
  relocateMarkdownComments,
  serializeMarkdownWithComments,
} from './comments';

describe('PaperCanvas Markdown comments metadata', () => {
  it('leaves a comment-free Markdown document unchanged', () => {
    const markdown = '# 標題\n\n中文與 emoji 😀\n';

    expect(serializeMarkdownWithComments(markdown, [])).toBe(markdown);
    expect(parseMarkdownComments(markdown)).toEqual({
      body: markdown,
      comments: [],
      status: 'none',
    });
  });

  it('round-trips readable metadata and escapes an HTML comment terminator in content', () => {
    const body = '# 研究筆記\n\n選區文字 😀\n';
    const rangeStart = body.indexOf('選區');
    const range = createMarkdownComment(
      body,
      { kind: 'range', from: rangeStart, to: rangeStart + '選區文字 😀'.length },
      '請確認這段內容 --> 再補一個來源。',
      undefined,
      'comment-range',
    );
    const position = createMarkdownComment(
      body,
      { kind: 'position', offset: body.indexOf('😀') },
      '這裡需要一個註解。',
      '文字附近',
      'comment-position',
    );

    const serialized = serializeMarkdownWithComments(body, [range, position]);
    const metadataStart = serialized.indexOf('<!-- papercanvas-comments:v1');
    const metadata = serialized.slice(metadataStart, serialized.lastIndexOf('-->'));
    const parsed = parseMarkdownComments(serialized);

    expect(metadata).not.toContain('-->');
    expect(serialized).toContain('"bodyFingerprint"');
    expect(parsed.status).toBe('valid');
    expect(parsed.body).toBe(body);
    expect(parsed.comments).toEqual([range, position]);
    expect(parsed.comments[0].bodyFingerprint).toBe(markdownFingerprint(body));
    expect(serializeMarkdownWithComments(serialized, parsed.comments)).toBe(serialized);
    expect(markdownToDocument(serialized)).toEqual(markdownToDocument(body));
  });

  it('preserves damaged and unknown-version metadata instead of dropping it', () => {
    const damaged = '# 文件\n\n<!-- papercanvas-comments:v1\n{"version":1,"comments":[}\n-->';
    const unknown = '# 文件\n\n<!-- papercanvas-comments:v99\n{"version":99,"comments":[]}\n-->';

    expect(parseMarkdownComments(damaged)).toEqual({
      body: damaged,
      comments: [],
      status: 'invalid',
    });
    expect(parseMarkdownComments(unknown)).toEqual({
      body: unknown,
      comments: [],
      status: 'unknown-version',
    });
  });

  it('rejects duplicate comment identifiers as damaged metadata', () => {
    const body = '# 文件\n';
    const comment = createMarkdownComment(body, { kind: 'position', offset: 0 }, '請確認。', undefined, 'duplicate');
    const serialized = serializeMarkdownWithComments(body, [comment, { ...comment, content: '另一則。' }]);

    expect(parseMarkdownComments(serialized)).toEqual({
      body: serialized,
      comments: [],
      status: 'invalid',
    });
  });

  it('relocates a comment when its anchor becomes unique after a source edit', () => {
    const source = '前文\n\nBefore [old text] after\n';
    const start = source.indexOf('old text');
    const comment = createMarkdownComment(
      source,
      { kind: 'range', from: start, to: start + 'old text'.length },
      '請改寫這句。',
      undefined,
      'comment-edit',
    );
    const target = '前文\n\nBefore [new text] after\n';
    const [relocated] = relocateMarkdownComments([comment], source, target);

    expect(relocated.target).toEqual({
      kind: 'range',
      from: target.indexOf('new text'),
      to: target.indexOf('new text') + 'old text'.length,
    });
    expect(relocated.status).toBe('active');
    expect(relocated.contextBefore).toBe('前文\n\nBefore [');
    expect(relocated.bodyFingerprint).toBe(markdownFingerprint(target));
  });

  it('marks an ambiguous external change for review instead of guessing', () => {
    const source = '這裡有 target。\n';
    const comment = createMarkdownComment(
      source,
      { kind: 'range', from: source.indexOf('target'), to: source.indexOf('target') + 6 },
      '請確認。',
      undefined,
      'comment-ambiguous',
    );
    const target = 'target 出現兩次，target 需要人工確認。\n';
    const [relocated] = relocateMarkdownComments([comment], source, target);

    expect(relocated.status).toBe('needs-review');
    expect(relocated.target).toEqual({
      kind: 'range',
      from: source.indexOf('target'),
      to: source.indexOf('target') + 6,
    });
  });
});
