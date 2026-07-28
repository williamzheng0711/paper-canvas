/* eslint-disable react-refresh/only-export-components */
import {
  InputRule,
  Node,
  mergeAttributes,
  type NodeViewRendererProps,
} from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import katex from "katex";
import {
  displayFormulaFromDelimitedLine,
  latexEnvironmentClosure,
  shouldCompleteRawLatexEnvironment,
  shouldCreateBlockFormula,
} from "./formulaInput";
import { getMessages } from "../i18n";

export type FormulaKind = "inline" | "block";

export function formulaBoundaryTarget(
  selection: { from: number; to: number; nodeType: string } | null,
  key: "ArrowLeft" | "ArrowRight",
): number | null {
  if (
    !selection ||
    !["inlineFormula", "blockFormula"].includes(selection.nodeType)
  )
    return null;
  return key === "ArrowLeft" ? selection.from : selection.to;
}

export function formulaSourceBoundaryAction(input: {
  key: string;
  selectionStart: number;
  selectionEnd: number;
  sourceLength: number;
}): "before" | "after" | "remove" | null {
  if (input.selectionStart !== input.selectionEnd) return null;
  if (input.key === "ArrowLeft" && input.selectionStart === 0) return "before";
  if (input.key === "ArrowRight" && input.selectionEnd === input.sourceLength)
    return "after";
  if (
    input.sourceLength === 0 &&
    ((input.key === "Backspace" && input.selectionStart === 0) ||
      (input.key === "Delete" && input.selectionEnd === 0))
  ) {
    return "remove";
  }
  return null;
}

export function validateLatex(
  latex: string,
  displayMode = false,
): string | null {
  try {
    katex.renderToString(latex, {
      displayMode,
      strict: "warn",
      throwOnError: true,
      trust: false,
    });
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : getMessages().formulaParseFailed;
  }
}

export function completeFormulaSourceInput(
  value: string,
  caret: number,
): { value: string; caret: number } {
  const beforeCaret = value.slice(0, caret);
  const closure = latexEnvironmentClosure(beforeCaret);
  if (!closure) return { value, caret };
  return {
    value: `${beforeCaret}${closure}${value.slice(caret)}`,
    caret,
  };
}

class FormulaNodeView {
  dom: HTMLElement;
  private readonly kind: FormulaKind;
  private readonly view: NodeViewRendererProps["view"];
  private readonly getPos: NodeViewRendererProps["getPos"];
  private node: NodeViewRendererProps["node"];
  private editing = false;
  private source: HTMLTextAreaElement | null = null;
  private sourceInput: (() => void) | null = null;
  private sourceKeyDown: ((event: KeyboardEvent) => void) | null = null;
  private sourceBlur: ((event: FocusEvent) => void) | null = null;

  constructor(props: NodeViewRendererProps, kind: FormulaKind) {
    this.node = props.node;
    this.view = props.view;
    this.getPos = props.getPos;
    this.kind = kind;
    this.dom = document.createElement(kind === "block" ? "div" : "span");
    this.dom.className = `formula-node formula-node--${kind}`;
    this.dom.contentEditable = "false";
    this.dom.dataset.formulaKind = kind;
    this.render();
  }

  update(node: NodeViewRendererProps["node"]): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.editing && this.source) {
      // Attribute updates occur on every source input. Never reset an active
      // textarea, because doing so loses its caret and breaks IME composition.
      if (document.activeElement !== this.source)
        this.source.value = this.latex;
      return true;
    }
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("is-selected");
  }

  deselectNode(): void {
    this.dom.classList.remove("is-selected");
  }

  stopEvent(event: Event): boolean {
    return (
      event.target instanceof HTMLElement && this.dom.contains(event.target)
    );
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.cleanupSource();
  }

  private get latex(): string {
    return String(this.node.attrs.latex ?? "");
  }

  private position(): number | null {
    if (typeof this.getPos !== "function") return null;
    const position = this.getPos();
    return typeof position === "number" ? position : null;
  }

  private render(): void {
    if (this.editing) return;
    const text = getMessages();
    this.dom.textContent = "";
    const latex = this.latex;
    const formula = document.createElement("span");
    formula.className = "formula-render";
    formula.setAttribute("role", "button");
    formula.tabIndex = 0;
    formula.title = text.formulaInspect;
    formula.addEventListener("click", () => this.enterEditing());
    formula.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.enterEditing();
      }
    });

    this.renderPreview(formula, latex);

    const copy = document.createElement("button");
    copy.className = "formula-copy";
    copy.type = "button";
    copy.setAttribute("aria-label", text.copyLatex);
    copy.textContent = "LaTeX";
    copy.addEventListener("mousedown", (event) => event.preventDefault());
    copy.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const result = navigator.clipboard?.writeText(latex);
      void result?.catch(() => undefined);
    });
    this.dom.append(formula, copy);
  }

  private enterEditing(): void {
    if (this.editing) return;
    const text = getMessages();
    this.editing = true;
    this.dom.classList.add("is-editing");
    this.dom.textContent = "";

    const panel = document.createElement("span");
    panel.className = "formula-editor";
    panel.addEventListener("mousedown", (event) => {
      if (
        event.target !== this.source &&
        !(event.target instanceof HTMLButtonElement)
      ) {
        event.preventDefault();
      }
    });

    const header = document.createElement("span");
    header.className = "formula-editor__header";
    const label = document.createElement("span");
    label.textContent =
      this.kind === "block" ? text.blockMath : text.inlineMath;
    const done = document.createElement("button");
    done.className = "formula-editor__done";
    done.type = "button";
    done.setAttribute("aria-label", text.finishFormula);
    done.title = text.finishFormulaShortcut;
    done.textContent = "✓";
    done.addEventListener("click", () => this.finishEditing());
    header.append(label, done);

    const sourceBox = document.createElement("span");
    sourceBox.className = "formula-editor__source";
    const opening = document.createElement("code");
    const closing = document.createElement("code");
    opening.className = "formula-editor__delimiter";
    closing.className = "formula-editor__delimiter";
    opening.textContent = this.kind === "block" ? "$$" : "$";
    closing.textContent = opening.textContent;
    opening.setAttribute("aria-hidden", "true");
    closing.setAttribute("aria-hidden", "true");

    const source = document.createElement("textarea");
    source.className = "formula-editor__textarea";
    source.setAttribute("aria-label", text.formulaSource(this.kind));
    source.spellcheck = false;
    source.wrap = "off";
    source.value = this.latex;
    this.resizeSource(source);

    const preview = document.createElement("span");
    preview.className = "formula-live-preview";
    preview.setAttribute("aria-label", text.formulaPreview);
    this.renderPreview(preview, source.value);

    this.source = source;
    this.sourceInput = () => this.handleSourceInput(source, preview);
    this.sourceKeyDown = (event) => this.handleSourceKeyDown(event, source);
    this.sourceBlur = (event) => {
      if (
        event.relatedTarget instanceof globalThis.Node &&
        this.dom.contains(event.relatedTarget)
      ) {
        return;
      }
      this.finishEditing();
    };
    source.addEventListener("input", this.sourceInput);
    source.addEventListener("keydown", this.sourceKeyDown);
    source.addEventListener("blur", this.sourceBlur);
    sourceBox.append(opening, source, closing);
    panel.append(header, sourceBox, preview);
    this.dom.appendChild(panel);
    requestAnimationFrame(() => {
      if (this.source === source) {
        source.focus();
        source.setSelectionRange(source.value.length, source.value.length);
      }
    });
  }

  private finishEditing(): void {
    if (!this.editing) return;
    this.editing = false;
    this.dom.classList.remove("is-editing");
    this.cleanupSource();
    this.render();
  }

  private cleanupSource(): void {
    if (!this.source) return;
    if (this.sourceInput)
      this.source.removeEventListener("input", this.sourceInput);
    if (this.sourceKeyDown)
      this.source.removeEventListener("keydown", this.sourceKeyDown);
    if (this.sourceBlur)
      this.source.removeEventListener("blur", this.sourceBlur);
    this.source = null;
    this.sourceInput = null;
    this.sourceKeyDown = null;
    this.sourceBlur = null;
  }

  private updateLatex(latex: string): void {
    const position = this.position();
    if (position === null) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, {
        ...this.node.attrs,
        latex,
      }),
    );
  }

  private renderPreview(container: HTMLElement, latex: string): void {
    const text = getMessages();
    const error = validateLatex(latex, this.kind === "block");
    container.textContent = "";
    container.classList.toggle("formula-render--error", Boolean(error));
    if (error) {
      const source = document.createElement("code");
      source.textContent = latex || text.emptyFormula;
      const warning = document.createElement("small");
      warning.textContent = text.formulaRenderFailed(error);
      container.append(source, warning);
      return;
    }

    const rendered = document.createElement("span");
    rendered.innerHTML = katex.renderToString(latex || "\\;", {
      displayMode: this.kind === "block",
      throwOnError: false,
      trust: false,
    });
    container.appendChild(rendered);
  }

  private resizeSource(source: HTMLTextAreaElement): void {
    const lines = source.value.split("\n").length;
    source.rows = this.kind === "block" ? Math.min(10, Math.max(2, lines)) : 1;
  }

  private handleSourceInput(
    source: HTMLTextAreaElement,
    preview: HTMLElement,
  ): void {
    const completed = completeFormulaSourceInput(
      source.value,
      source.selectionStart,
    );
    if (completed.value !== source.value) {
      source.value = completed.value;
      source.setSelectionRange(completed.caret, completed.caret);
    }
    this.resizeSource(source);
    this.renderPreview(preview, source.value);
    this.updateLatex(source.value);
  }

  private handleSourceKeyDown(
    event: KeyboardEvent,
    source: HTMLTextAreaElement,
  ): void {
    if (
      event.key === "Escape" ||
      (event.key === "Enter" && (event.metaKey || event.ctrlKey))
    ) {
      event.preventDefault();
      this.finishEditing();
      return;
    }
    const boundary = formulaSourceBoundaryAction({
      key: event.key,
      selectionStart: source.selectionStart,
      selectionEnd: source.selectionEnd,
      sourceLength: source.value.length,
    });
    if (!boundary) return;
    event.preventDefault();
    if (boundary === "remove") {
      this.removeEmptyFormula();
    } else {
      this.moveToText(boundary);
    }
  }

  private moveToText(side: "before" | "after"): void {
    const position = this.position();
    if (position === null) return;
    const target = side === "before" ? position : position + this.node.nodeSize;
    this.finishEditing();
    requestAnimationFrame(() => {
      const transaction = this.view.state.tr.setSelection(
        TextSelection.create(this.view.state.doc, target),
      );
      this.view.dispatch(transaction);
      this.view.focus();
    });
  }

  private removeEmptyFormula(): void {
    const position = this.position();
    if (position === null) return;
    const size = this.node.nodeSize;
    this.finishEditing();
    requestAnimationFrame(() => {
      const transaction = this.view.state.tr.delete(position, position + size);
      this.view.dispatch(
        transaction.setSelection(
          TextSelection.create(transaction.doc, position),
        ),
      );
      this.view.focus();
    });
  }
}

function createFormulaNode(
  name: "inlineFormula" | "blockFormula",
  kind: FormulaKind,
) {
  return Node.create({
    name,
    group: kind === "inline" ? "inline" : "block",
    inline: kind === "inline",
    atom: true,
    selectable: true,
    defining: true,

    addAttributes() {
      return { latex: { default: "" } };
    },

    parseHTML() {
      return [
        {
          tag: `${kind === "inline" ? "span" : "div"}[data-formula-kind="${kind}"]`,
        },
      ];
    },

    renderHTML({ HTMLAttributes }) {
      return [
        kind === "inline" ? "span" : "div",
        mergeAttributes(HTMLAttributes, {
          "data-formula-kind": kind,
          "data-latex": HTMLAttributes.latex,
        }),
      ];
    },

    addNodeView() {
      return (props) => new FormulaNodeView(props, kind);
    },

    addInputRules() {
      if (kind === "block") {
        return [
          new InputRule({
            find: /\$\$([^$\n]+)\$\$$/,
            handler: ({ state, range, match }) => {
              const $from = state.doc.resolve(range.to);
              const source = match[0];
              const latex = displayFormulaFromDelimitedLine(source);
              // Input rules run before the final typed character reaches the
              // document. Reconstruct that virtual line for the strict
              // standalone-line check, while replacing the existing paragraph
              // atomically so the trailing `$` never creates a new paragraph.
              const virtualParentText = `${$from.parent.textContent}${source.at(-1) ?? ""}`;
              if (
                !latex ||
                !shouldCreateBlockFormula({
                  text: source,
                  parentType: $from.parent.type.name,
                  parentText: virtualParentText,
                  parentOffset: $from.parentOffset + 1,
                })
              ) {
                return null;
              }
              state.tr.replaceWith(
                $from.before(),
                $from.after(),
                this.type.create({ latex }),
              );
            },
          }),
        ];
      }
      return [
        new InputRule({
          find: /\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}$/,
          handler: ({ state, range, match }) => {
            const begin = match[0];
            const closure = latexEnvironmentClosure(begin);
            const $from = state.doc.resolve(range.to);
            const virtualParentText = `${$from.parent.textContent}${begin.at(-1) ?? ""}`;
            if (
              !closure ||
              !shouldCompleteRawLatexEnvironment({
                parentText: virtualParentText,
                parentOffset: $from.parentOffset + 1,
                begin,
              })
            ) {
              return null;
            }
            state.tr
              .insertText(`${begin.at(-1) ?? ""}${closure}`, range.to)
              .setSelection(TextSelection.create(state.tr.doc, range.to + 1));
          },
        }),
        new InputRule({
          find: /\$([^$\n]+)\$$/,
          handler: ({ state, range, match }) => {
            const latex = match[1]?.trim();
            if (!latex) return null;
            // InputRule handlers must update the transaction handed to them.
            // A normal editor command can create a separate transaction, which
            // leaves the source delimiters visible during real text input.
            state.tr.replaceWith(
              range.from,
              range.to,
              this.type.create({ latex }),
            );
          },
        }),
      ];
    },

    addKeyboardShortcuts() {
      return {
        "Mod-Alt-m": () =>
          this.editor.commands.insertContent({
            type: name,
            attrs: { latex: "" },
          }),
        ArrowLeft: () => {
          const selection = this.editor.state.selection;
          if (!(selection instanceof NodeSelection)) return false;
          const target = formulaBoundaryTarget(
            {
              from: selection.from,
              to: selection.to,
              nodeType: selection.node.type.name,
            },
            "ArrowLeft",
          );
          if (target === null) return false;
          return this.editor.commands.setTextSelection(target);
        },
        ArrowRight: () => {
          const selection = this.editor.state.selection;
          if (!(selection instanceof NodeSelection)) return false;
          const target = formulaBoundaryTarget(
            {
              from: selection.from,
              to: selection.to,
              nodeType: selection.node.type.name,
            },
            "ArrowRight",
          );
          if (target === null) return false;
          return this.editor.commands.setTextSelection(target);
        },
        Backspace: () => {
          const selection = this.editor.state.selection;
          return selection instanceof NodeSelection &&
            ["inlineFormula", "blockFormula"].includes(selection.node.type.name)
            ? this.editor.commands.deleteSelection()
            : false;
        },
        Delete: () => {
          const selection = this.editor.state.selection;
          return selection instanceof NodeSelection &&
            ["inlineFormula", "blockFormula"].includes(selection.node.type.name)
            ? this.editor.commands.deleteSelection()
            : false;
        },
      };
    },
  });
}

export const InlineFormula = createFormulaNode("inlineFormula", "inline");
export const BlockFormula = createFormulaNode("blockFormula", "block");
