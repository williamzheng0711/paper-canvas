// Bound parsing and the editable Canvas DOM while retaining complete source.
export const maximumCanvasNodes = 10_000;
export const maximumCanvasCharacters = 250_000;

// KaTeX expands a single editable formula atom into many presentation tags.
// Budget these separately so ordinary mathematics papers fit in Canvas without
// increasing the limits on editable content, HTML previews, tables, or comments.
export const maximumCanvasFormulaNodes = 50_000;
export const maximumCanvasFormulaMarkup = 5_000_000;
