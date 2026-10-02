import { TableCell, TableHeader } from "@tiptap/extension-table";
import { tableCellPositions } from "./tableGeometry";

function pixelWidth(value: string | null): number {
  if (!value || !/^\d+(?:\.\d+)?(?:px)?$/i.test(value.trim())) return 0;
  const width = Number.parseFloat(value);
  return Number.isFinite(width) && width > 0 ? Math.round(width) : 0;
}

const colwidth = {
  default: null,
  parseHTML: (element: HTMLElement): number[] | null => {
    const native = element.getAttribute("colwidth");
    if (native) {
      const widths = native.split(",").map(pixelWidth);
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
      (cell) => ({ colspan: cell.colSpan, rowspan: cell.rowSpan }),
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
    return { ...this.parent?.(), colwidth, textAlign };
  },
});

export const PaperTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), colwidth, textAlign };
  },
});
