import type { JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { documentsEqual } from './documentSync';
import { parseMarkdownComments } from './comments';
import { documentToMarkdown, markdownToDocument } from './markdown';

export type DocumentSelectionAnchor =
  | { kind: 'formula'; path: number[]; offset: number }
  | {
      kind: 'text';
      /** Child indexes from the document root to the containing text block. */
      path: number[];
      /** ProseMirror content offset inside that text block. */
      offset: number;
    }
  | {
      kind: 'boundary';
      /** Child indexes from the document root to the containing block. */
      path: number[];
      /** Boundary between children in the containing block. */
      index: number;
      affinity: -1 | 1;
    };

export type MarkdownSelection = {
  markdown: string;
  offset: number;
};

export type MarkdownRange = {
  from: number;
  to: number;
};

export type ParsedMarkdownSelection = {
  document: JSONContent;
  anchor?: DocumentSelectionAnchor;
};

/** Private-use text that survives remark parsing/stringifying without escaping. */
export const selectionMarker = '\uE000\uE001\uE002';

const textBlockTypes = new Set(['paragraph', 'heading', 'codeBlock']);

function clampOffset(length: number, offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.min(Math.max(0, Math.round(offset)), Math.max(0, length));
}

function markerRatio(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const index = value.indexOf(selectionMarker);
    if (index < 0) return undefined;
    const cleanLength = Math.max(1, value.length - selectionMarker.length);
    return Math.min(1, Math.max(0, index / cleanLength));
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ratio = markerRatio(item);
      if (ratio !== undefined) return ratio;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const ratio = markerRatio(item);
      if (ratio !== undefined) return ratio;
    }
  }
  return undefined;
}

function inlineNodeSize(node: JSONContent): number {
  if (node.type === 'text') return (node.text ?? '').replace(selectionMarker, '').length;
  return 1;
}

function locateSelectionMarker(
  node: JSONContent,
  path: number[] = [],
  parentPath: number[] = [],
  index = 0,
  textContext?: { path: number[]; offset: number },
): DocumentSelectionAnchor | undefined {
  if (node.type === 'text') {
    const markerIndex = (node.text ?? '').indexOf(selectionMarker);
    if (markerIndex >= 0 && textContext) {
      return {
        kind: 'text',
        path: textContext.path,
        offset: textContext.offset + markerIndex,
      };
    }

    const markRatio = markerRatio(node.marks);
    if (markRatio !== undefined && textContext) {
      return {
        kind: 'text',
        path: textContext.path,
        offset: textContext.offset + Math.round((node.text?.length ?? 0) * markRatio),
      };
    }
  }

  if (['inlineFormula', 'blockFormula'].includes(node.type ?? '') && typeof node.attrs?.latex === 'string') {
    const offset = node.attrs.latex.indexOf(selectionMarker);
    if (offset >= 0) return { kind: 'formula', path, offset };
  }
  const attributeRatio = markerRatio(node.attrs);
  if (attributeRatio !== undefined) {
    if (textBlockTypes.has(node.type ?? '')) {
      return { kind: 'text', path, offset: 0 };
    }
    if (textContext) {
      return {
        kind: 'text',
        path: textContext.path,
        offset: textContext.offset + (attributeRatio > 0.5 ? 1 : 0),
      };
    }
    const after = attributeRatio > 0.5;
    return {
      kind: 'boundary',
      path: parentPath,
      index: index + (after ? 1 : 0),
      affinity: after ? -1 : 1,
    };
  }

  const children = node.content ?? [];
  if (textBlockTypes.has(node.type ?? '')) {
    let offset = 0;
    for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
      const child = children[childIndex];
      const located = locateSelectionMarker(child, [...path, childIndex], path, childIndex, { path, offset });
      if (located) return located;
      offset += inlineNodeSize(child);
    }
    return undefined;
  }

  for (let childIndex = 0; childIndex < children.length; childIndex += 1) {
    const located = locateSelectionMarker(children[childIndex], [...path, childIndex], path, childIndex);
    if (located) return located;
  }
  return undefined;
}

function stripMarkerFromValue(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(selectionMarker, '');
  if (Array.isArray(value)) return value.map(stripMarkerFromValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripMarkerFromValue(item)]));
  }
  return value;
}

function stripSelectionMarker(node: JSONContent): JSONContent | null {
  const strippedText = node.text?.replace(selectionMarker, '');
  if (node.type === 'text' && strippedText === '') return null;

  const stripped: JSONContent = {
    ...node,
    ...(node.text !== undefined ? { text: strippedText } : {}),
    ...(node.attrs ? { attrs: stripMarkerFromValue(node.attrs) as Record<string, unknown> } : {}),
    ...(node.marks ? { marks: stripMarkerFromValue(node.marks) as JSONContent['marks'] } : {}),
  };
  if (node.content) {
    const content = node.content.flatMap((child) => {
      const cleaned = stripSelectionMarker(child);
      return cleaned ? [cleaned] : [];
    });
    if (content.length > 0) stripped.content = content;
    else delete stripped.content;
  }
  return stripped;
}

function canonicalDocument(node: JSONContent): JSONContent {
  const canonical: JSONContent = {
    type: node.type,
    ...(node.attrs ? { attrs: node.attrs } : {}),
    ...(node.marks ? { marks: node.marks } : {}),
    ...(node.text ? { text: node.text } : {}),
  };
  const children = (node.content ?? []).map(canonicalDocument);
  const merged: JSONContent[] = [];
  for (const child of children) {
    const previous = merged.at(-1);
    if (
      previous?.type === 'text' &&
      child.type === 'text' &&
      JSON.stringify(previous.marks ?? []) === JSON.stringify(child.marks ?? [])
    ) {
      previous.text = `${previous.text ?? ''}${child.text ?? ''}`;
    } else if (child.type !== 'text' || child.text) {
      merged.push(child);
    }
  }
  if (merged.length > 0) canonical.content = merged;
  return canonical;
}

function documentsSemanticallyEqual(left: JSONContent, right: JSONContent): boolean {
  return documentsEqual(canonicalDocument(left), canonicalDocument(right));
}

function nearbyOffsets(markdown: string, requestedOffset: number): number[] {
  const requested = clampOffset(markdown.length, requestedOffset);
  const candidates = [requested];
  for (let distance = 1; distance <= 8; distance += 1) {
    candidates.push(requested - distance, requested + distance);
  }

  const lineStart = markdown.lastIndexOf('\n', Math.max(0, requested - 1)) + 1;
  const lineBreak = markdown.indexOf('\n', requested);
  const lineEnd = lineBreak < 0 ? markdown.length : lineBreak;
  candidates.push(lineStart, lineEnd);

  return [...new Set(candidates.map((candidate) => clampOffset(markdown.length, candidate)))];
}

/**
 * Parse Markdown while carrying its source caret into the resulting document.
 * A caret on Markdown punctuation is snapped to the nearest source offset that
 * preserves the exact parsed document.
 */
export function markdownToDocumentWithSelection(markdown: string, requestedOffset?: number): ParsedMarkdownSelection {
  const source = parseMarkdownComments(markdown).body;
  const document = markdownToDocument(source);
  if (requestedOffset === undefined || source.includes(selectionMarker)) return { document };

  for (const offset of nearbyOffsets(source, requestedOffset)) {
    const markedMarkdown = `${source.slice(0, offset)}${selectionMarker}${source.slice(offset)}`;
    const markedDocument = markdownToDocument(markedMarkdown);
    const anchor = locateSelectionMarker(markedDocument);
    const strippedDocument = stripSelectionMarker(markedDocument);
    if (anchor && strippedDocument && documentsSemanticallyEqual(strippedDocument, document)) {
      return { document, anchor };
    }
  }
  return { document };
}

/** Resolve a UTF-16 Markdown offset to a live ProseMirror position. */
export function positionFromMarkdownOffset(
  document: ProseMirrorNode,
  markdown: string,
  offset: number,
): { position: number; affinity: -1 | 1 } | undefined {
  const mapped = markdownToDocumentWithSelection(markdown, offset);
  if (!mapped.anchor) return undefined;
  return positionFromDocumentAnchor(document, mapped.anchor);
}

/** Convert a non-dispatched ProseMirror marker transaction into a source caret. */
export function markdownSelectionFromMarkedDocument(
  document: JSONContent,
  markedDocument: JSONContent,
): MarkdownSelection | undefined {
  const markdown = documentToMarkdown(document);
  if (markdown.includes(selectionMarker)) return undefined;
  // A temporary marker must not widen table columns and shift their padding.
  const markedMarkdown = documentToMarkdown(markedDocument, (value) => value.replace(selectionMarker, '').length);
  const offset = markedMarkdown.indexOf(selectionMarker);
  if (offset < 0) return undefined;
  if (markedMarkdown.replace(selectionMarker, '') !== markdown) return undefined;
  return { markdown, offset };
}

function childStart(node: ProseMirrorNode, contentStart: number, index: number): number | undefined {
  if (index < 0 || index >= node.childCount) return undefined;
  let position = contentStart;
  for (let childIndex = 0; childIndex < index; childIndex += 1) {
    position += node.child(childIndex).nodeSize;
  }
  return position;
}

/** Resolve a stable JSON tree anchor against the live ProseMirror document. */
export function positionFromDocumentAnchor(
  document: ProseMirrorNode,
  anchor: DocumentSelectionAnchor,
): { position: number; affinity: -1 | 1 } | undefined {
  let node = document;
  let contentStart = 0;

  for (const index of anchor.path) {
    const start = childStart(node, contentStart, index);
    if (start === undefined) return undefined;
    node = node.child(index);
    contentStart = start + 1;
  }

  if (anchor.kind === 'formula') {
    if (!['inlineFormula', 'blockFormula'].includes(node.type.name)) return undefined;
    return { position: contentStart - 1, affinity: 1 };
  }

  if (anchor.kind === 'text') {
    if (!node.isTextblock) return undefined;
    return {
      position: contentStart + clampOffset(node.content.size, anchor.offset),
      affinity: 1,
    };
  }

  if (anchor.index < 0 || anchor.index > node.childCount) return undefined;
  let position = contentStart;
  for (let index = 0; index < anchor.index; index += 1) {
    position += node.child(index).nodeSize;
  }
  return {
    position: clampOffset(document.content.size, position),
    affinity: anchor.affinity,
  };
}
