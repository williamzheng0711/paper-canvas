import katex from "katex";

export const maximumFormulaPreviewSource = 20_000;
export const maximumFormulaPreviewNodes = 10_000;
export const maximumFormulaPreviewMarkup = 1_000_000;

type FormulaPreview =
  | { html: string; nodes: number; error: null; limited: false }
  | { html: null; nodes: number; error: string | null; limited: boolean };
const previews = new Map<string, FormulaPreview>();
let cachedCharacters = 0;

function macroExpansionBudget(latex: string): number {
  if (/\\(?:edef|xdef|let|futurelet)\b/.test(latex)) return 0;
  if (!/\\(?:def|gdef|newcommand|renewcommand|providecommand)\b/.test(latex))
    return 1000;
  // A custom expansion can duplicate argument groups. Use a conservative
  // source bound before KaTeX builds its token/DOM tree, including parameters.
  const groups: number[] = [];
  let largestGroup = 1;
  for (let index = 0; index < latex.length; index += 1) {
    if (latex[index] === "\\") {
      index += 1;
      continue;
    }
    if (latex[index] === "{") groups.push(index);
    else if (latex[index] === "}") {
      const opening = groups.pop();
      if (opening !== undefined)
        largestGroup = Math.max(largestGroup, index - opening - 1);
    }
  }
  const parameters = latex.match(/#[1-9]/g)?.length ?? 0;
  return Math.min(
    1000,
    Math.floor(maximumFormulaPreviewNodes / (largestGroup * (parameters + 1))),
  );
}

/** Keep formula expansion bounded before any generated HTML reaches the DOM. */
export function formulaPreview(
  latex: string,
  displayMode = false,
): FormulaPreview {
  if (latex.length > maximumFormulaPreviewSource)
    return { html: null, nodes: 3, error: null, limited: true };
  const key = `${displayMode ? "block" : "inline"}:${latex}`;
  const cached = previews.get(key);
  if (cached) return cached;
  let preview: FormulaPreview;
  const maxExpand = macroExpansionBudget(latex);
  if (maxExpand === 0)
    return { html: null, nodes: 3, error: null, limited: true };
  try {
    const html = katex.renderToString(latex || "\\;", {
      displayMode,
      strict: "warn",
      throwOnError: true,
      trust: false,
      maxExpand,
    });
    let nodes = 0;
    const tags = /<[A-Za-z]/g;
    while (tags.exec(html) && nodes <= maximumFormulaPreviewNodes) nodes += 1;
    preview =
      html.length > maximumFormulaPreviewMarkup ||
      nodes > maximumFormulaPreviewNodes
        ? { html: null, nodes: 3, error: null, limited: true }
        : { html, nodes, error: null, limited: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const limited = /Too many expansions/.test(message);
    preview = {
      html: null,
      nodes: 3,
      error: limited ? null : message,
      limited,
    };
  }
  // Capacity checks and live preview share results without retaining unlimited
  // old source while typing or rendering a document containing many formulas.
  const characters = key.length + (preview.html?.length ?? 0);
  if (
    previews.size >= 1024 ||
    cachedCharacters + characters > maximumFormulaPreviewMarkup * 2
  ) {
    previews.clear();
    cachedCharacters = 0;
  }
  cachedCharacters += characters;
  previews.set(key, preview);
  return preview;
}
