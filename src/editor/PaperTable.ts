import { TableCell, TableHeader } from "@tiptap/extension-table";
import { tableCellPositions } from "./tableGeometry";

function pixelWidth(value: string | null): number {
  if (!value || !/^\d+(?:\.\d+)?(?:px)?$/i.test(value.trim())) return 0;
  const width = Number.parseFloat(value);
  return Number.isFinite(width) && width > 0 ? Math.round(width) : 0;
}

function htmlRowspan(cell: HTMLTableCellElement): number {
  if (cell.rowSpan !== 0) return cell.rowSpan;
  // HTML zero spans every remaining row in this group; the editor stores the
  // effective positive span so table geometry and recovery use the same value.
  const row = cell.parentElement as HTMLTableRowElement | null;
  const group = row?.parentElement as HTMLTableSectionElement | null;
  return Math.max(1, Math.min(65534, (group?.rows?.length ?? 1) - (row?.sectionRowIndex ?? 0)));
}

/** Resolve standard colgroup widths once before the clipboard is parsed. */
export function applyTableColumnWidths(root: ParentNode): void {
  for (const table of root.querySelectorAll<HTMLTableElement>("table")) {
    const columns = [...table.children]
      .filter((child) => child.tagName === "COLGROUP")
      .flatMap((group) => [...group.children])
      .filter((child) => child.tagName === "COL")
      .map((column) => pixelWidth(column.getAttribute("width")));
    if (!columns.some((width) => width > 0)) continue;
    for (const { cell, column, colspan } of tableCellPositions<HTMLTableCellElement>(
      [...table.rows].map((row) => [...row.cells]),
      (cell) => ({ colspan: cell.colSpan, rowspan: htmlRowspan(cell) }),
    )) {
      // Native clipboard metadata takes precedence over a standard colgroup.
      if (cell.getAttribute("colwidth")) continue;
      const widths = Array.from({ length: colspan }, (_, index) => columns[column + index] ?? 0);
      cell.setAttribute("colwidth", widths.join(","));
    }
  }
}

const colwidth = {
  default: null,
  validate: (value: unknown) => {
    if (value !== null && (!Array.isArray(value) || value.length > 1000 || value.some((width) => typeof width !== "number" || !Number.isFinite(width) || width < 0))) {
      throw new RangeError("Invalid table column widths");
    }
  },
  parseHTML: (element: HTMLElement): number[] | null => {
    const native = element.getAttribute("colwidth");
    if (native) {
      const widths = native.split(",", (element as HTMLTableCellElement).colSpan).map(pixelWidth);
      return widths.some((width) => width > 0) ? widths : null;
    }
    const table = element.closest<HTMLTableElement>("table");
    if (!table) return null;
    const columns = [...table.children]
      .filter((child) => child.tagName === "COLGROUP")
      .flatMap((group) => [...group.children])
      .filter((child) => child.tagName === "COL")
      .map((column) => pixelWidth(column.getAttribute("width")));
    if (!columns.some((width) => width > 0)) return null;

    // cellIndex counts cells rather than table columns and ignores a preceding
    // rowspan. Track the occupied columns so merged cells get every width.
    for (const {
      cell,
      column,
      colspan,
    } of tableCellPositions<HTMLTableCellElement>(
      [...table.rows].map((row) => [...row.cells]),
      (cell) => ({ colspan: cell.colSpan, rowspan: htmlRowspan(cell) }),
    )) {
      if (cell === element) {
        const widths = Array.from(
          { length: colspan },
          (_, index) => columns[column + index] ?? 0,
        );
        return widths.some((width) => width > 0) ? widths : null;
      }
    }
    return null;
  },
};

function validateSpan(maximum: number) {
  return (value: unknown) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
      throw new RangeError("Invalid table cell span");
    }
  };
}

const colspan = { default: 1, validate: validateSpan(1000), parseHTML: (cell: HTMLElement) => (cell as HTMLTableCellElement).colSpan };
const rowspan = { default: 1, validate: validateSpan(65534), parseHTML: (cell: HTMLElement) => htmlRowspan(cell as HTMLTableCellElement) };

const textAlign = {
  default: null,
  parseHTML: (element: HTMLElement) => {
    const value = element.style.textAlign || element.getAttribute("align");
    return value === "left" || value === "center" || value === "right"
      ? value
      : null;
  },
  renderHTML: (attributes: Record<string, unknown>) => {
    const value = attributes.textAlign;
    return value === "left" || value === "center" || value === "right"
      ? { style: `text-align: ${value}` }
      : {};
  },
};

export const PaperTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), colspan, rowspan, colwidth, textAlign };
  },
});

export const PaperTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), colspan, rowspan, colwidth, textAlign };
  },
});
