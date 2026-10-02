import { getSchema } from "@tiptap/core";
import { DOMParser } from "@tiptap/pm/model";
import { TableMap } from "@tiptap/pm/tables";
import StarterKit from "@tiptap/starter-kit";
import { Table, TableRow } from "@tiptap/extension-table";
import { describe, expect, it } from "vitest";
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
