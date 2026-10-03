import { getSchema } from "@tiptap/core";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableRow } from "@tiptap/extension-table";
import { describe, expect, it, vi } from "vitest";
import { PaperTableCell, PaperTableHeader } from "./PaperTable";
import { sanitizePastedHtml } from "./paste";

const schema = getSchema([
  StarterKit,
  Table,
  TableRow,
  PaperTableCell,
  PaperTableHeader,
]);

function parse(html: string) {
  const element = document.createElement("div");
  element.innerHTML = sanitizePastedHtml(html);
  return DOMParser.fromSchema(schema).parse(element);
}

describe("table widths from standard clipboard HTML", () => {
  it("retains native cell alignment through sanitized HTML copy and repeated paste", () => {
    const original = parse(
      '<table><tr><th align="center"><p>Heading</p></th><th align="right"><p>Value</p></th></tr>' +
      '<tr><td align="left"><p>Writing</p></td><td align="right"><p>12</p></td></tr></table>',
    );
    const serializer = DOMSerializer.fromSchema(schema);
    const host = document.createElement("div");
    host.append(serializer.serializeFragment(original.content));
    const pasted = parse(host.innerHTML);
    expect(pasted.toJSON()).toEqual(original.toJSON());
    const repeated = parse(sanitizePastedHtml(host.innerHTML));
    expect(repeated.toJSON()).toEqual(original.toJSON());
  });

  it("parses thousands of clipboard cells without repeatedly scanning the complete table", () => {
    const rows = 140;
    const columns = 20;
    const html = '<table><colgroup>' + '<col width="80">'.repeat(columns) + '</colgroup>' +
      Array.from({ length: rows }, (_, row) => '<tr>' +
        Array.from({ length: columns }, (_, column) => `<td><p>${row},${column}</p></td>`).join("") +
        '</tr>').join("") + '</table>';
    const rowReads = vi.spyOn(HTMLTableElement.prototype, "rows", "get");
    try {
      const doc = parse(html);
      const table = doc.firstChild!;
      expect(table.childCount).toBe(rows);
      expect(table.lastChild?.lastChild?.textContent).toBe("139,19");
      expect(TableMap.get(table).problems).toBeNull();
      table.forEach((row) => row.forEach((cell) => expect(cell.attrs.colwidth).toEqual([80])));
      // A DOM table's rows collection must not be rebuilt for each cell.
      expect(rowReads.mock.calls.length).toBeLessThan(10);
    } finally { rowReads.mockRestore(); }
  });

  it("ignores surplus native widths beyond a cell's actual colspan and remains recoverable", () => {
    const doc = parse('<table><tr><td colspan="2" colwidth="140,260,' + '80,'.repeat(2_000) + '80"><p>Retained writing</p></td></tr></table>');
    expect(doc.firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([140, 260]);
    expect(doc.textContent).toBe("Retained writing");
    expect(() => doc.check()).not.toThrow();
    expect(TableMap.get(doc.firstChild!).problems).toBeNull();
  });

  it("does not reuse stale colgroup widths between clipboard parses", () => {
    const html = '<table><colgroup><col width="80"></colgroup><tr><td><p>Writing</p></td></tr></table>';
    expect(parse(html).firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([80]);
    expect(parse(html.replace('width="80"', 'width="160"')).firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([160]);
  });

  it("expands merged-cell widths and accounts for cells spanning previous rows", () => {
    const doc = parse(
      '<table><colgroup><col width="100"><col width="160"><col width="240"></colgroup>' +
        '<tr><th colspan="3"><p>Merged header</p></th></tr>' +
        '<tr><td colspan="2" rowspan="2"><p>Spanning body</p></td><td><p>Right</p></td></tr>' +
        "<tr><td><p>Following right</p></td></tr></table>",
    );
    const cells: unknown[] = [];
    doc.descendants((node) => {
      if (["tableCell", "tableHeader"].includes(node.type.name))
        cells.push(node.attrs.colwidth);
    });
    expect(cells).toEqual([[100, 160, 240], [100, 160], [240], [240]]);
    expect(TableMap.get(doc.firstChild!).problems).toBeNull();
  });

  it("prioritizes explicit native width metadata over the table colgroup", () => {
    const doc = parse(
      '<table><colgroup><col width="50"><col width="80"></colgroup>' +
        '<tr><th colspan="2" colwidth="140,260"><p>Header</p></th></tr></table>',
    );
    expect(doc.firstChild?.firstChild?.firstChild?.attrs.colwidth).toEqual([
      140, 260,
    ]);
  });

  it("keeps nested table column widths independent of the enclosing table", () => {
    const doc = parse(
      '<table><colgroup><col width="300"></colgroup><tr><td><p>Outer</p>' +
        '<table><colgroup><col width="90"><col width="110"></colgroup>' +
        "<tr><td><p>Nested first</p></td><td><p>Nested second</p></td></tr></table>" +
        "</td></tr></table>",
    );
    const widths: unknown[] = [];
    doc.descendants((node) => {
      if (node.type.name === "tableCell") widths.push(node.attrs.colwidth);
    });
    expect(widths).toEqual([[300], [90], [110]]);
  });
});
