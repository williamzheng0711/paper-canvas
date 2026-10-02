import type { JSONContent } from '@tiptap/core';
import { unified } from 'unified';
import remarkParse from 'remark-parse';

export const commentsMetadataVersion = 1;
export const commentsMetadataMarker = 'papercanvas-comments';

export type CommentStatus = 'active' | 'needs-review';

export type CommentTarget =
  | {
      kind: 'range';
      from: number;
      to: number;
    }
  | {
      kind: 'position';
      offset: number;
    };

export type MarkdownComment = {
  id: string;
  content: string;
  target: CommentTarget;
  excerpt: string;
  contextBefore: string;
  contextAfter: string;
  /** The Markdown substring used as a conservative relocation anchor. */
  anchorText: string;
  bodyFingerprint: string;
  status: CommentStatus;
};

export type CommentPlacement = {
  target: CommentTarget;
  /** Visible text from the live canvas selection, when available. */
  excerpt?: string;
};

export type ParsedComments = {
  body: string;
  comments: MarkdownComment[];
  status: 'none' | 'valid' | 'invalid' | 'unknown-version';
};

const metadataOpeningPattern = new RegExp(`<!--\\s*${commentsMetadataMarker}:v\\d+\\r?\\n`, 'g');
const metadataPattern = new RegExp(`^<!--\\s*${commentsMetadataMarker}:v(\\d+)\\r?\\n([\\s\\S]*?)\\r?\\n-->\\s*$`);
const metadataContextParser = unified().use(remarkParse);

function clampOffset(value: unknown, length: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(0, Math.round(number)), Math.max(0, length));
}

function hashText(value: string): string {
  // A small synchronous fingerprint is sufficient for detecting stale anchors;
  // it is not used as a security primitive.
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}-${value.length}`;
}

export function markdownFingerprint(markdown: string): string {
  return hashText(markdown);
}

function targetBounds(target: CommentTarget, length: number): { from: number; to: number } {
  if (target.kind === 'position') {
    const offset = clampOffset(target.offset, length);
    return { from: offset, to: offset };
  }
  const from = clampOffset(target.from, length);
  const to = clampOffset(target.to, length);
  return from <= to ? { from, to } : { from: to, to: from };
}

function nextCodePoint(markdown: string, offset: number): string {
  return Array.from(markdown.slice(offset, offset + 2))[0] ?? '';
}

export function commentContext(
  markdown: string,
  target: CommentTarget,
  radius = 72,
): { before: string; after: string; anchorText: string } {
  const bounds = targetBounds(target, markdown.length);
  const anchorText =
    target.kind === 'range' ? markdown.slice(bounds.from, bounds.to) : nextCodePoint(markdown, bounds.from);
  return {
    before: markdown.slice(Math.max(0, bounds.from - radius), bounds.from),
    after: markdown.slice(bounds.to, Math.min(markdown.length, bounds.to + radius)),
    anchorText,
  };
}

function normalizeTarget(value: unknown, length: number): CommentTarget | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    kind?: unknown;
    from?: unknown;
    to?: unknown;
    offset?: unknown;
  };
  if (candidate.kind === 'range') {
    const from = clampOffset(candidate.from, length);
    const to = clampOffset(candidate.to, length);
    return from <= to ? { kind: 'range', from, to } : { kind: 'range', from: to, to: from };
  }
  if (candidate.kind === 'position') {
    return { kind: 'position', offset: clampOffset(candidate.offset, length) };
  }
  return null;
}

function normalizeComment(value: unknown, bodyLength: number): MarkdownComment | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MarkdownComment>;
  if (typeof candidate.id !== 'string' || !candidate.id) return null;
  if (typeof candidate.content !== 'string') return null;
  if (typeof candidate.excerpt !== 'string') return null;
  if (typeof candidate.contextBefore !== 'string' || typeof candidate.contextAfter !== 'string') return null;
  if (typeof candidate.anchorText !== 'string' || typeof candidate.bodyFingerprint !== 'string') return null;
  const target = normalizeTarget(candidate.target, bodyLength);
  if (!target) return null;
  const status = candidate.status ?? 'active';
  if (status !== 'active' && status !== 'needs-review') return null;
  return {
    id: candidate.id,
    content: candidate.content,
    target,
    excerpt: candidate.excerpt,
    contextBefore: candidate.contextBefore,
    contextAfter: candidate.contextAfter,
    anchorText: candidate.anchorText,
    bodyFingerprint: candidate.bodyFingerprint,
    status,
  };
}

/**
 * Reads only PaperCanvas's trailing metadata block. Unknown or damaged blocks
 * deliberately remain part of `body`, so opening and saving cannot silently
 * discard user data.
 */
export function parseMarkdownComments(markdown: string): ParsedComments {
  // Start with the final opening header. Trying the entire suffix at every
  // earlier marker makes a file containing many damaged blocks quadratic.
  let metadataStart = -1;
  for (const opening of markdown.matchAll(metadataOpeningPattern)) metadataStart = opening.index;
  const match = metadataStart >= 0 ? metadataPattern.exec(markdown.slice(metadataStart)) : null;
  if (!match) {
    const markerIndex = markdown.lastIndexOf(`<!-- ${commentsMetadataMarker}:v`);
    return {
      body: markdown,
      comments: [],
      status: markerIndex >= 0 ? 'invalid' : 'none',
    };
  }

  const version = Number(match[1]);
  let body = markdown.slice(0, metadataStart);
  if (version !== commentsMetadataVersion) {
    return { body: markdown, comments: [], status: 'unknown-version' };
  }

  try {
    const payload = JSON.parse(match[2]) as {
      version?: unknown;
      bodyFingerprint?: unknown;
      comments?: unknown;
    };
    if (payload.version !== commentsMetadataVersion || !Array.isArray(payload.comments)) {
      return { body: markdown, comments: [], status: 'invalid' };
    }
    const fingerprintMatches = payload.bodyFingerprint === markdownFingerprint(body);
    const insertedSeparator =
      !fingerprintMatches && body.endsWith('\n') && payload.bodyFingerprint === markdownFingerprint(body.slice(0, -1));
    if (insertedSeparator) body = body.slice(0, -1);
    if (!fingerprintMatches && !insertedSeparator) {
      // Examples in a fence, raw HTML, or a quote are user text. A current
      // fingerprint still identifies our own metadata appended to an unclosed
      // construct, while standalone older or externally edited blocks work.
      const root = metadataContextParser.parse(markdown);
      if (!root.children.some((node) => node.type === 'html' && node.position?.start.offset === metadataStart)) {
        return { body: markdown, comments: [], status: 'invalid' };
      }
    }
    const comments = payload.comments.map((comment) => normalizeComment(comment, body.length));
    if (comments.some((comment): comment is null => comment === null)) {
      return { body: markdown, comments: [], status: 'invalid' };
    }
    const normalizedComments = comments as MarkdownComment[];
    if (new Set(normalizedComments.map((comment) => comment.id)).size !== normalizedComments.length) {
      return { body: markdown, comments: [], status: 'invalid' };
    }
    return { body, comments: normalizedComments, status: 'valid' };
  } catch {
    return { body: markdown, comments: [], status: 'invalid' };
  }
}

function encodeCommentJson(value: unknown): string {
  // JSON's unicode escape is decoded back to `-` by JSON.parse, while keeping
  // the surrounding HTML comment valid even when a user writes `-->`.
  return JSON.stringify(value, null, 2).replaceAll('--', '-\\u002d');
}

/** Append readable, versioned comment metadata to one Markdown file. */
export function serializeMarkdownWithComments(markdown: string, comments: readonly MarkdownComment[]): string {
  const existing = parseMarkdownComments(markdown);
  const body = existing.status === 'valid' ? existing.body : markdown;
  if (comments.length === 0) return body;
  const payload = {
    version: commentsMetadataVersion,
    bodyFingerprint: markdownFingerprint(body),
    comments,
  };
  const separator = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
  return `${body}${separator}<!-- ${commentsMetadataMarker}:v${commentsMetadataVersion}\n${encodeCommentJson(payload)}\n-->`;
}

function findOccurrences(text: string, needle: string): number[] {
  if (!needle) return [];
  const occurrences: number[] = [];
  let offset = text.indexOf(needle);
  while (offset >= 0) {
    occurrences.push(offset);
    // Overlapping matches are distinct anchors too (for example, both `ana`
    // substrings in `banana`); skipping them can make a relocation look unique.
    offset = text.indexOf(needle, offset + 1);
  }
  return occurrences;
}

function relocateByContext(comment: MarkdownComment, markdown: string): { from: number; to: number } | undefined {
  const before = comment.contextBefore.slice(-72);
  const after = comment.contextAfter.slice(0, 72);
  if (!before && !after) return undefined;
  const beforeEnds = before ? findOccurrences(markdown, before).map((offset) => offset + before.length) : [0];
  const afterStarts = after ? findOccurrences(markdown, after) : [markdown.length];
  let candidate: { from: number; to: number } | undefined;
  let afterIndex = 0;
  for (const beforeEnd of beforeEnds) {
    while (afterIndex < afterStarts.length && afterStarts[afterIndex] < beforeEnd) afterIndex += 1;
    if (afterIndex === afterStarts.length) continue;
    // Only uniqueness matters. Stop as soon as two possible ranges exist
    // instead of allocating the Cartesian product of repeated contexts.
    if (candidate || afterIndex + 1 < afterStarts.length) return undefined;
    candidate = { from: beforeEnd, to: afterStarts[afterIndex] };
  }
  return candidate;
}

function refreshCommentAnchor(
  comment: MarkdownComment,
  markdown: string,
  target: CommentTarget,
  status: CommentStatus = comment.status,
  excerpt = comment.excerpt,
): MarkdownComment {
  const context = commentContext(markdown, target);
  return {
    ...comment,
    target,
    excerpt,
    contextBefore: context.before,
    contextAfter: context.after,
    anchorText: context.anchorText,
    bodyFingerprint: markdownFingerprint(markdown),
    status,
  };
}

/** Create a complete comment record from a live Markdown target. */
export function createMarkdownComment(
  markdown: string,
  target: CommentTarget,
  content: string,
  excerpt?: string,
  id = createCommentId(),
): MarkdownComment {
  return refreshCommentAnchor(
    {
      id,
      content,
      target,
      excerpt: excerpt ?? '',
      contextBefore: '',
      contextAfter: '',
      anchorText: '',
      bodyFingerprint: '',
      status: 'active',
    },
    markdown,
    target,
    'active',
    excerpt ?? (target.kind === 'range' ? markdown.slice(target.from, target.to) : ''),
  );
}

export function createCommentId(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
  return `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Re-anchor comments after a source change. Exact anchors win; a plain excerpt
 * or a unique before/after context is accepted only when it occurs once.
 */
export function relocateMarkdownComments(
  comments: readonly MarkdownComment[],
  sourceMarkdown: string,
  targetMarkdown: string,
): MarkdownComment[] {
  if (sourceMarkdown === targetMarkdown) {
    return comments.map((comment) => ({
      ...comment,
      bodyFingerprint: markdownFingerprint(targetMarkdown),
    }));
  }

  return comments.map((comment) => {
    const oldBounds = targetBounds(comment.target, sourceMarkdown.length);
    const exact = findOccurrences(targetMarkdown, comment.anchorText);
    if (exact.length === 1) {
      const from = exact[0];
      const target: CommentTarget =
        comment.target.kind === 'range'
          ? { kind: 'range', from, to: from + comment.anchorText.length }
          : { kind: 'position', offset: from };
      return refreshCommentAnchor(comment, targetMarkdown, target, comment.status);
    }

    if (comment.target.kind === 'range' && comment.excerpt) {
      const excerptMatches = findOccurrences(targetMarkdown, comment.excerpt);
      if (excerptMatches.length === 1) {
        const from = excerptMatches[0];
        return refreshCommentAnchor(
          comment,
          targetMarkdown,
          { kind: 'range', from, to: from + comment.excerpt.length },
          comment.status,
          comment.excerpt,
        );
      }
    }

    const contextBounds = relocateByContext(comment, targetMarkdown);
    if (contextBounds !== undefined) {
      return refreshCommentAnchor(
        comment,
        targetMarkdown,
        comment.target.kind === 'range'
          ? {
              kind: 'range',
              from: contextBounds.from,
              to: contextBounds.to,
            }
          : { kind: 'position', offset: contextBounds.from },
        comment.status,
      );
    }

    const fallbackOffset = clampOffset(
      comment.target.kind === 'position' ? comment.target.offset : comment.target.from,
      targetMarkdown.length,
    );
    const fallbackTarget: CommentTarget =
      comment.target.kind === 'range'
        ? {
            kind: 'range',
            from: fallbackOffset,
            to: clampOffset(fallbackOffset + Math.max(0, oldBounds.to - oldBounds.from), targetMarkdown.length),
          }
        : { kind: 'position', offset: fallbackOffset };
    return refreshCommentAnchor(comment, targetMarkdown, fallbackTarget, 'needs-review', comment.excerpt);
  });
}

/** Remove editor-only properties before persisting legacy or imported records. */
export function cloneComments(comments: readonly MarkdownComment[]): MarkdownComment[] {
  return JSON.parse(JSON.stringify(comments)) as MarkdownComment[];
}

/** Visible text helper used by tests and non-editor integrations. */
export function plainDocumentText(document: JSONContent): string {
  const walk = (node: JSONContent): string => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'inlineFormula' || node.type === 'blockFormula') return String(node.attrs?.latex ?? '');
    return (node.content ?? []).map(walk).join('');
  };
  return walk(document);
}
