/** Locate actual columns rather than cell indexes in tables with merged cells. */
export function* tableCellPositions<T>(
  rows: Iterable<Iterable<T>>,
  spans: (cell: T) => { colspan: number; rowspan: number },
): Generator<{ cell: T; column: number; colspan: number }> {
  const occupiedUntil: number[] = [];
  let rowIndex = 0;
  for (const row of rows) {
    let column = 0;
    for (const cell of row) {
      while ((occupiedUntil[column] ?? 0) > rowIndex) column += 1;
      const span = spans(cell);
      const colspan = Number.isFinite(span.colspan)
        ? Math.max(1, Math.trunc(span.colspan))
        : 1;
      const rowspan = Number.isFinite(span.rowspan)
        ? Math.max(1, Math.trunc(span.rowspan))
        : 1;
      yield { cell, column, colspan };
      for (let offset = 0; offset < colspan; offset += 1)
        occupiedUntil[column + offset] = rowIndex + rowspan;
      column += colspan;
    }
    rowIndex += 1;
  }
}
