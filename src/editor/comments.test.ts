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
  it('keeps oversized stale or legacy comment metadata as exact source without a full contextual parse', () => {
    const body = '\\('.repeat(Math.ceil(5 * 1024 * 1024 / 2));
    const comment = createMarkdownComment(body, { kind: 'position', offset: body.length }, 'Review', '', 'id');
    const valid = serializeMarkdownWithComments(body, [comment]);
    expect(parseMarkdownComments(valid)).toEqual({ body, comments: [comment], status: 'valid' });
    for (const source of [valid.replace('\\(', 'changed'), body + '\n<!-- papercanvas-comments:v1\n{"version":1,"comments":[]}\n-->']) {
      const started = performance.now();
      expect(parseMarkdownComments(source)).toEqual({ body: source, comments: [], status: 'invalid' });
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it.each(['\n', '\r\n', '\r'])(
    'reads valid comment metadata with %j separators without adding a newline to the authored body',
    (ending) => {
      const body = 'hello';
      const comment = createMarkdownComment(body, { kind: 'range', from: 0, to: 5 }, 'Review', 'hello', 'id');
      const source = serializeMarkdownWithComments(body, [comment]).replaceAll('\n', ending);
      expect(parseMarkdownComments(source)).toEqual({ body, comments: [comment], status: 'valid' });
    },
  );

  it.each(['\n', '\r\n', '\r'])(
    'keeps an authored trailing %j line ending when comment metadata uses the same separator',
    (ending) => {
      const body = 'hello' + ending;
      const comment = createMarkdownComment(body, { kind: 'range', from: 0, to: 5 }, 'Review', 'hello', 'id');
      const original = serializeMarkdownWithComments(body, [comment]);
      expect(parseMarkdownComments(original)).toEqual({ body, comments: [comment], status: 'valid' });
      const source = body + original.slice(body.length).replaceAll('\n', ending);
      expect(parseMarkdownComments(source)).toEqual({ body, comments: [comment], status: 'valid' });
    },
  );

  it('retains literal CR-only comment metadata inside fenced source and accepts a standalone externally edited body', () => {
    const legacy = '<!-- papercanvas-comments:v1\r{"version":1,"comments":[]}\r-->';
    const literal = '```markdown\r' + legacy;
    expect(parseMarkdownComments(literal)).toEqual({ body: literal, comments: [], status: 'invalid' });
    const body = 'original';
    const comment = createMarkdownComment(body, { kind: 'position', offset: 0 }, 'Review', '', 'id');
    const edited = serializeMarkdownWithComments(body, [comment]).replaceAll('\n', '\r').replace(body, 'changed');
    expect(parseMarkdownComments(edited)).toEqual({ body: 'changed\r', comments: [comment], status: 'valid' });
  });

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
      {
        kind: 'range',
        from: rangeStart,
        to: rangeStart + '選區文字 😀'.length,
      },
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

  it.each([
    { kind: 'position' },
    { kind: 'position', offset: 'garbage' },
    { kind: 'position', offset: null },
    { kind: 'range', from: {}, to: 13 },
    { kind: 'range', from: 7, to: null },
  ])('preserves damaged numeric comment targets instead of silently relocating them: %j', (target) => {
    const body = 'Before target after\n';
    const comment = createMarkdownComment(body, { kind: 'range', from: 7, to: 13 }, 'Review', 'target', 'id');
    const damaged = serializeMarkdownWithComments(body, [{ ...comment, target: target as typeof comment.target }]);
    expect(parseMarkdownComments(damaged)).toEqual({ body: damaged, comments: [], status: 'invalid' });
    expect(serializeMarkdownWithComments(damaged, [])).toBe(damaged);
  });

  it('continues clamping real numeric comment offsets after external body changes', () => {
    const body = 'Before target after\n';
    const comment = createMarkdownComment(body, { kind: 'position', offset: body.length }, 'Review', '', 'id');
    const source = serializeMarkdownWithComments(body, [comment]).replace(body, 'short\n');
    const parsed = parseMarkdownComments(source);
    expect(parsed.status).toBe('valid');
    expect(parsed.comments[0].target).toEqual({ kind: 'position', offset: 'short\n'.length });
  });

  it.each(['```markdown\n', '<pre>\n', '<div>\n', '> ', '    '])(
    'preserves literal metadata inside %j',
    (prefix) => {
      const markdown = `${prefix}<!-- papercanvas-comments:v1\n{"version":1,"comments":[]}\n-->`;

      expect(parseMarkdownComments(markdown)).toEqual({ body: markdown, comments: [], status: 'invalid' });
      expect(serializeMarkdownWithComments(markdown, [])).toBe(markdown);
    },
  );

  it.each(['```markdown\nbody', '<pre>\nbody', '<div>\nbody', 'body'])(
    'round-trips generated comments after an unclosed or newline-free body %j',
    (body) => {
      const comment = createMarkdownComment(body, { kind: 'position', offset: body.length }, 'Review', '', 'id');
      const serialized = serializeMarkdownWithComments(body, [comment]);

      expect(parseMarkdownComments(serialized)).toEqual({ body, comments: [comment], status: 'valid' });
      expect(serializeMarkdownWithComments(serialized, [comment])).toBe(serialized);
    },
  );

  it('accepts older standalone metadata and externally edited bodies', () => {
    const legacy = 'body\n<!-- papercanvas-comments:v1\n{"version":1,"comments":[]}\n-->';
    expect(parseMarkdownComments(legacy)).toEqual({ body: 'body\n', comments: [], status: 'valid' });
    const body = 'original\n';
    const comment = createMarkdownComment(body, { kind: 'position', offset: 0 }, 'Review', '', 'id');
    const edited = serializeMarkdownWithComments(body, [comment]).replace('original', 'changed');
    expect(parseMarkdownComments(edited)).toEqual({ body: 'changed\n', comments: [comment], status: 'valid' });
  });

  it('reads a final valid block after many damaged blocks without rescanning suffixes', () => {
    const body = '<!-- papercanvas-comments:v1\n{}\n-->\n'.repeat(30_000) + 'text';
    const comment = createMarkdownComment(body, { kind: 'position', offset: body.length }, 'Review', '', 'id');
    const started = performance.now();
    expect(parseMarkdownComments(body + 'x').status).toBe('invalid');
    expect(parseMarkdownComments(serializeMarkdownWithComments(body, [comment]))).toEqual({
      body,
      comments: [comment],
      status: 'valid',
    });
    expect(performance.now() - started).toBeLessThan(1000);
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
      {
        kind: 'range',
        from: source.indexOf('target'),
        to: source.indexOf('target') + 6,
      },
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

  it.each(['much longer replacement', 'x', ''])(
    'uses both context boundaries when selected text changes to %j',
    (replacement) => {
      const source = 'Before [old text] after\n';
      const from = source.indexOf('old text');
      const comment = createMarkdownComment(
        source,
        { kind: 'range', from, to: from + 8 },
        'Review',
        undefined,
        'range',
      );
      const target = `Before [${replacement}] after\n`;

      const [relocated] = relocateMarkdownComments([comment], source, target);

      expect(relocated.target).toEqual({
        kind: 'range',
        from,
        to: from + replacement.length,
      });
      expect(relocated.anchorText).toBe(replacement);
    },
  );

  it('treats overlapping anchor matches as ambiguous', () => {
    const source = 'Before ana after';
    const comment = createMarkdownComment(source, { kind: 'range', from: 7, to: 10 }, 'Review', undefined, 'range');

    const [relocated] = relocateMarkdownComments([comment], source, 'banana');

    expect(relocated.status).toBe('needs-review');
  });

  it('marks repeated context boundaries as ambiguous without building every possible range', () => {
    const source = 'aOLDa';
    const comment = createMarkdownComment(source, { kind: 'range', from: 1, to: 4 }, 'Review', undefined, 'range');
    const started = performance.now();
    const [relocated] = relocateMarkdownComments([comment], source, 'a'.repeat(10_000));

    expect(relocated.status).toBe('needs-review');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('relocates many comments on repetitive source without enumerating every repeated anchor or rehashing each record', () => {
    const source = 'a'.repeat(160_000);
    const target = source + 'b';
    const base = createMarkdownComment(source, { kind: 'range', from: 72, to: 73 }, 'Review', 'a', 'base');
    const comments = Array.from({ length: 1000 }, (_, index) => ({ ...base, id: String(index) }));
    const started = performance.now();
    const relocated = relocateMarkdownComments(comments, source, target);
    const elapsed = performance.now() - started;
    const expectedFingerprint = markdownFingerprint(target);

    expect(relocated).toHaveLength(comments.length);
    expect(relocated.every((comment) => comment.status === 'needs-review')).toBe(true);
    expect(relocated.every((comment) => comment.target.kind === 'range' && comment.target.from === 72 && comment.target.to === 73)).toBe(true);
    expect(relocated.every((comment) => comment.bodyFingerprint === expectedFingerprint)).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });
});
