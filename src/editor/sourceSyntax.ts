import {
  Compartment,
  EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";

export const maximumHighlightedSourceCharacters = 250_000;
export const maximumHighlightedSourceLineLength = 20_000;

function sourceSyntaxSupported(document: Text): boolean {
  if (document.length > maximumHighlightedSourceCharacters) return false;
  for (const line of document.iterLines()) {
    if (line.length > maximumHighlightedSourceLineLength) return false;
  }
  return true;
}

/** Keep extreme source editable without unbounded parsing or token DOM work. */
export function boundedSourceSyntax(
  document: Text,
  syntax: Extension,
): Extension {
  const compartment = new Compartment();
  const plain: Extension = [];
  return [
    compartment.of(sourceSyntaxSupported(document) ? syntax : plain),
    EditorState.transactionExtender.of((transaction) => {
      if (!transaction.docChanged) return null;
      const next = sourceSyntaxSupported(transaction.newDoc) ? syntax : plain;
      if (compartment.get(transaction.startState) === next) return null;
      // Reconfigure within the edit itself so history, composition and caret
      // remain in the same editor state and Undo can restore ordinary syntax.
      return { effects: compartment.reconfigure(next) };
    }),
  ];
}
