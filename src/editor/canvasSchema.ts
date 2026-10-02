import { getSchema, type JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { Table, TableRow } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { common, createLowlight } from 'lowlight';
import { getMessages } from '../i18n';
import { FootnoteDefinition, FootnoteReference } from './Footnote';
import { InlineFormula, BlockFormula } from './Formula';
import { HtmlPreview, InlineHtmlPreview } from './HtmlPreview';
import { PaperCode, PaperLink } from './PaperLink';
import { PaperImage } from './PaperImage';
import { PaperOrderedList } from './PaperOrderedList';
import { PaperTableCell, PaperTableHeader } from './PaperTable';
import { UnsupportedMarkdown } from './UnsupportedMarkdown';

const lowlight = createLowlight(common);

/** The persisted node/mark schema shared by the canvas and recovery validation. */
export function canvasNodesAndMarks(
  getText: () => ReturnType<typeof getMessages> = getMessages,
  getDocumentPath: () => string | undefined = () => undefined,
) {
  const footnoteLabels = {
    referenceLabel: (number: string) => getText().footnoteReferenceLabel(number),
    backlinkLabel: (number: string) => getText().footnoteBacklinkLabel(number),
  };
  return [
    StarterKit.configure({ code: false, codeBlock: false, link: false, orderedList: false, trailingNode: { notAfter: ['footnoteDefinition', 'unsupportedMarkdown'] } }),
    PaperOrderedList,
    FootnoteReference.configure(footnoteLabels),
    FootnoteDefinition.configure(footnoteLabels),
    PaperCode,
    CodeBlockLowlight.configure({ lowlight }),
    PaperLink.configure({ openOnClick: false, autolink: true, defaultProtocol: 'https' }),
    PaperImage.configure({
      getDocumentPath,
      allowBase64: true,
      resize: {
        enabled: true,
        directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
        minWidth: 80,
        minHeight: 60,
        alwaysPreserveAspectRatio: false,
      },
    }),
    Table.configure({ resizable: true }),
    TableRow,
    PaperTableHeader,
    PaperTableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    InlineFormula,
    BlockFormula,
    HtmlPreview,
    InlineHtmlPreview,
    UnsupportedMarkdown,
  ];
}

let recoverySchema: Schema | undefined;

function isAttributeObject(value: unknown): boolean {
  return value === undefined || (value !== null && typeof value === 'object' && !Array.isArray(value));
}

/** Validate persisted JSON without constructing an editor or running node views. */
export function isValidCanvasDocument(value: unknown): value is JSONContent {
  const pending: unknown[] = [value];
  const visited = new Set<unknown>();
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== 'object' || Array.isArray(node) || visited.has(node)) return false;
    visited.add(node);
    const candidate = node as JSONContent;
    if (typeof candidate.type !== 'string' || !isAttributeObject(candidate.attrs)) return false;
    if (candidate.content !== undefined) {
      if (!Array.isArray(candidate.content)) return false;
      for (const child of candidate.content) pending.push(child);
    }
    if (candidate.marks !== undefined && (!Array.isArray(candidate.marks) || candidate.marks.some((mark) =>
      !mark || typeof mark.type !== 'string' || !isAttributeObject(mark.attrs)))) return false;
  }
  try {
    recoverySchema ??= getSchema(canvasNodesAndMarks());
    const document = recoverySchema.nodeFromJSON(value);
    if (document.type.name !== 'doc') return false;
    document.check();
    return true;
  } catch {
    return false;
  }
}
