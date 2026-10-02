import { TableCell, TableHeader } from "@tiptap/extension-table";

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
    return { ...this.parent?.(), textAlign };
  },
});

export const PaperTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), textAlign };
  },
});
