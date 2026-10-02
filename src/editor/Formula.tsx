/* eslint-disable react-refresh/only-export-components */
import {
  InputRule,
  Node,
  mergeAttributes,
  type NodeViewRendererProps,
} from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { Plugin } from "@tiptap/pm/state";
import { isHistoryTransaction } from "@tiptap/pm/history";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import katex from "katex";
import {
  displayFormulaFromBracketedLine,
  displayFormulaFromDelimitedLine,
  displayFormulaAfterTextInsertion,
  inlineFormulaAroundCaret,
  isEscaped,
  isDisplayLatexEnvironment,
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
  // When editing an existing environment, its matching close command is often
  // already to the right of the caret. Do not duplicate it as soon as the
  // opening command becomes complete again.
  if (value.slice(caret).includes(closure)) return { value, caret };
  return {
    value: `${beforeCaret}${closure}${value.slice(caret)}`,
    caret,
  };
}

const formulaViews = new WeakMap<HTMLElement, FormulaNodeView>();

export function focusedFormulaSelection(
  view: NodeViewRendererProps["view"],
): { position: number; offset: number; top: number } | undefined {
  const active = view.dom.ownerDocument.activeElement;
  if (!(active instanceof HTMLTextAreaElement) || !view.dom.contains(active))
    return undefined;
  const dom = active.closest<HTMLElement>(".formula-node");
  return dom ? formulaViews.get(dom)?.sourceSelection() : undefined;
}

export function focusFormulaSource(
  view: NodeViewRendererProps["view"],
  position: number,
  offset: number,
): boolean {
  const dom = view.nodeDOM(position);
  const nodeView =
    dom instanceof HTMLElement ? formulaViews.get(dom) : undefined;
  if (!nodeView) return false;
  nodeView.enterEditing(offset);
  return true;
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
  private sourceCompositionStart: (() => void) | null = null;
  private sourceCompositionEnd: (() => void) | null = null;
  private sourceIsComposing = false;
  private destroyed = false;

  constructor(props: NodeViewRendererProps, kind: FormulaKind) {
    this.node = props.node;
    this.view = props.view;
    this.getPos = props.getPos;
    this.kind = kind;
    this.dom = document.createElement(kind === "block" ? "div" : "span");
    this.dom.className = `formula-node formula-node--${kind}`;
    this.dom.contentEditable = "false";
    this.dom.dataset.formulaKind = kind;
    formulaViews.set(this.dom, this);
    this.render();
    if (this.node.attrs.autoEdit) {
      requestAnimationFrame(() => {
        if (this.destroyed || !this.node.attrs.autoEdit) return;
        const position = this.position();
        if (position === null) return;
        if (
          this.view.state.selection.from < position ||
          this.view.state.selection.to >
            position + this.node.nodeSize + (this.kind === "block" ? 1 : 0)
        ) {
          this.clearAutomaticEditingRequest();
          return;
        }
        const caret = Number(this.node.attrs.sourceCaret);
        this.enterEditing(Number.isFinite(caret) ? caret : this.latex.length);
        this.clearAutomaticEditingRequest();
      });
    }
  }

  update(node: NodeViewRendererProps["node"]): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.dom.dataset.latex = this.latex;
    if (this.editing && this.source) {
      // Normal typing already updated the textarea. Only synchronize external
      // changes (including undo), preserving the caret and IME composition.
      if (!this.sourceIsComposing && this.source.value !== this.latex) {
        const { selectionStart, selectionEnd } = this.source;
        this.source.value = this.latex;
        this.source.setSelectionRange(
          Math.min(selectionStart, this.latex.length),
          Math.min(selectionEnd, this.latex.length),
        );
        this.resizeSource(this.source);
        const preview = this.dom.querySelector<HTMLElement>(
          ".formula-live-preview",
        );
        if (preview) this.renderPreview(preview, this.latex);
      }
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
    this.destroyed = true;
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
    this.dom.dataset.latex = this.latex;
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

  sourceSelection():
    { position: number; offset: number; top: number } | undefined {
    const position = this.position();
    if (position === null || !this.source) return undefined;
    return {
      position,
      offset: this.source.selectionStart,
      top: this.source.getBoundingClientRect().top,
    };
  }

  enterEditing(initialCaret = this.latex.length): void {
    if (this.editing && this.source) {
      this.source.focus({ preventScroll: true });
      this.source.setSelectionRange(initialCaret, initialCaret);
      return;
    }
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
    done.addEventListener("click", () => this.moveToText("after"));
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
    this.sourceCompositionStart = () => {
      this.sourceIsComposing = true;
    };
    this.sourceCompositionEnd = () => {
      this.sourceIsComposing = false;
      this.handleSourceInput(source, preview);
    };
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
    source.addEventListener("compositionstart", this.sourceCompositionStart);
    source.addEventListener("compositionend", this.sourceCompositionEnd);
    sourceBox.append(opening, source, closing);
    panel.append(header, sourceBox, preview);
    this.dom.appendChild(panel);
    const focusSource = () => {
      if (this.source === source) {
        source.focus();
        const caret = Math.max(0, Math.min(source.value.length, initialCaret));
        source.setSelectionRange(caret, caret);
      }
    };
    // Automatically created formulas already enter editing from a queued
    // animation frame. Focus synchronously once the node view is connected so
    // the next physical keystroke cannot replace the new formula atom.
    if (this.dom.isConnected) focusSource();
    else requestAnimationFrame(focusSource);
  }

  private clearAutomaticEditingRequest(): void {
    const position = this.position();
    if (position === null || !this.node.attrs.autoEdit) return;
    this.view.dispatch(
      this.view.state.tr
        .setNodeMarkup(position, undefined, {
          ...this.node.attrs,
          autoEdit: false,
          sourceCaret: null,
        })
        .setMeta("addToHistory", false),
    );
  }

  private finishEditing(): void {
    if (!this.editing) return;
    if (this.sourceIsComposing && this.source) {
      const preview = this.dom.querySelector<HTMLElement>(
        ".formula-live-preview",
      );
      this.sourceIsComposing = false;
      this.updateLatex(this.source.value);
      if (preview) this.renderPreview(preview, this.source.value);
    }
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
    if (this.sourceCompositionStart)
      this.source.removeEventListener(
        "compositionstart",
        this.sourceCompositionStart,
      );
    if (this.sourceCompositionEnd)
      this.source.removeEventListener(
        "compositionend",
        this.sourceCompositionEnd,
      );
    this.source = null;
    this.sourceInput = null;
    this.sourceKeyDown = null;
    this.sourceBlur = null;
    this.sourceCompositionStart = null;
    this.sourceCompositionEnd = null;
    this.sourceIsComposing = false;
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
    if (this.sourceIsComposing) return;
    // Closing a separately typed $$ line completes multiline Markdown entry.
    if (
      this.kind === "block" &&
      source.selectionStart === source.value.length &&
      /\n\$\$$/.test(source.value)
    ) {
      this.updateLatex(source.value.slice(0, -3).trim());
      this.moveToText("after");
      return;
    }
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
    if (this.sourceIsComposing || event.isComposing || event.keyCode === 229)
      return;
    if (
      event.key === "Escape" ||
      (event.key === "Enter" && (event.metaKey || event.ctrlKey))
    ) {
      event.preventDefault();
      this.moveToText("after");
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
    let target = side === "before" ? position : position + this.node.nodeSize;
    this.finishEditing();
    const transaction = this.view.state.tr;
    if (this.kind === "block") {
      const $target = transaction.doc.resolve(target);
      const neighbor =
        side === "before" ? $target.nodeBefore : $target.nodeAfter;
      if (neighbor?.isTextblock) target += side === "before" ? -1 : 1;
      else {
        transaction.insert(
          target,
          this.view.state.schema.nodes.paragraph.create(),
        );
        target += 1;
      }
    }
    this.view.dispatch(
      transaction.setSelection(TextSelection.create(transaction.doc, target)),
    );
    this.view.focus();
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

function pendingFormulaInputPlugin(nodeName: string): Plugin {
  return new Plugin({
    props: {
      handleTextInput(view, _from, _to, text) {
        const pending: Array<{ position: number; node: ProseMirrorNode }> = [];
        view.state.doc.descendants((node, position) => {
          if (
            pending.length > 0 ||
            node.type.name !== nodeName ||
            !node.attrs.autoEdit ||
            view.state.selection.from < position ||
            view.state.selection.to >
              position + node.nodeSize + (node.isBlock ? 1 : 0)
          )
            return;
          pending.push({ position, node });
          return false;
        });
        const match = pending[0];
        if (!match) return false;

        const { node, position } = match;
        const latex = String(node.attrs.latex ?? "");
        const rawCaret = Number(node.attrs.sourceCaret);
        const caret = Number.isFinite(rawCaret)
          ? Math.max(0, Math.min(latex.length, rawCaret))
          : latex.length;
        view.dispatch(
          view.state.tr.setNodeMarkup(position, undefined, {
            ...node.attrs,
            latex: `${latex.slice(0, caret)}${text}${latex.slice(caret)}`,
            sourceCaret: caret + text.length,
          }),
        );
        return true;
      },
    },
  });
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
      return {
        latex: { default: "" },
        autoEdit: { default: false, rendered: false },
        sourceCaret: { default: null, rendered: false },
      };
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

    renderText({ node }) {
      const latex = String(node.attrs.latex ?? "");
      return kind === "block" ? `$$\n${latex}\n$$` : `$${latex}$`;
    },

    addNodeView() {
      return (props) => new FormulaNodeView(props, kind);
    },

    addInputRules() {
      if (kind === "block") {
        return [
          new InputRule({
            find: /\\begin\{([A-Za-z][A-Za-z0-9_*-]*)\}$/,
            handler: ({ state, range, match }) => {
              const begin = match[0];
              const environment = match[1];
              const closure = latexEnvironmentClosure(begin);
              const $from = state.doc.resolve(range.to);
              const codeMark = state.schema.marks.code;
              const virtualParentText = `${$from.parent.textContent}${begin.at(-1) ?? ""}`;
              if (
                !closure ||
                !isDisplayLatexEnvironment(environment) ||
                (codeMark &&
                  $from.marks().some((mark) => mark.type === codeMark)) ||
                $from.parent.type.name !== "paragraph" ||
                virtualParentText !== begin
              ) {
                return null;
              }
              state.tr.replaceWith(
                $from.before(),
                $from.after(),
                this.type.create({
                  latex: `${begin}${closure}`,
                  autoEdit: true,
                  sourceCaret: begin.length,
                }),
              );
            },
          }),
          new InputRule({
            find: /\$\$([^$\n]+)\$\$$/,
            handler: ({ state, range, match }) => {
              const $from = state.doc.resolve(range.to);
              const source = match[0];
              const latex = displayFormulaFromDelimitedLine(source);
              const codeMark = state.schema.marks.code;
              // Input rules run before the final typed character reaches the
              // document. Reconstruct that virtual line for the strict
              // standalone-line check, while replacing the existing paragraph
              // atomically so the trailing `$` never creates a new paragraph.
              const virtualParentText = `${$from.parent.textContent}${source.at(-1) ?? ""}`;
              if (
                !latex ||
                (codeMark &&
                  $from.marks().some((mark) => mark.type === codeMark)) ||
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
          new InputRule({
            find: /\\\[([^\n]+)\\\]$/,
            handler: ({ state, range, match }) => {
              const $from = state.doc.resolve(range.to);
              const source = match[0];
              const latex = displayFormulaFromBracketedLine(source);
              const codeMark = state.schema.marks.code;
              const virtualParentText =
                $from.parent.textContent + (source.at(-1) ?? "");
              if (
                !latex ||
                (codeMark &&
                  $from.marks().some((mark) => mark.type === codeMark)) ||
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
          find: /\\\(([^\n]+)\\\)$/,
          handler: ({ state, range, match }) => {
            const latex = match[1]?.trim();
            if (!latex) return null;
            const codeMark = state.schema.marks.code;
            if (
              codeMark &&
              state.doc
                .resolve(range.to)
                .marks()
                .some((mark) => mark.type === codeMark)
            ) {
              return null;
            }
            state.tr.replaceWith(
              range.from,
              range.to,
              this.type.create(
                { latex },
                null,
                kind === "inline"
                  ? state.doc.resolve(range.from).marks()
                  : undefined,
              ),
            );
          },
        }),
        new InputRule({
          find: /\$([^$\n]+)\$$/,
          handler: ({ state, range, match }) => {
            const latex = match[1]?.trim();
            if (!latex) return null;
            const $start = state.doc.resolve(range.from);
            const parentText = $start.parent.textBetween(
              0,
              $start.parent.content.size,
              "\n",
              "\ufffc",
            );
            if (
              isEscaped(parentText, $start.parentOffset) ||
              isEscaped(match[0], match[0].length - 1)
            )
              return null;
            const codeMark = state.schema.marks.code;
            if (
              codeMark &&
              state.doc
                .resolve(range.to)
                .marks()
                .some((mark) => mark.type === codeMark)
            ) {
              return null;
            }
            // In `$$...$$`, the inline regexp can see the inner `$...$` one
            // keystroke before the display delimiter is complete. Leave that
            // match alone so the block rule receives the final `$`.
            if (
              $start.parentOffset > 0 &&
              $start.parent.textBetween(
                $start.parentOffset - 1,
                $start.parentOffset,
              ) === "$"
            ) {
              return null;
            }
            // InputRule handlers must update the transaction handed to them.
            // A normal editor command can create a separate transaction, which
            // leaves the source delimiters visible during real text input.
            state.tr.replaceWith(
              range.from,
              range.to,
              this.type.create(
                { latex },
                null,
                kind === "inline"
                  ? state.doc.resolve(range.from).marks()
                  : undefined,
              ),
            );
          },
        }),
      ];
    },

    addProseMirrorPlugins() {
      const pendingInput = pendingFormulaInputPlugin(name);
      if (kind === "inline") {
        return [
          pendingInput,
          new Plugin({
            appendTransaction: (transactions, _oldState, newState) => {
              if (transactions.some(isHistoryTransaction)) return null;
              if (!transactions.some((transaction) => transaction.docChanged))
                return null;
              const selection = newState.selection;
              if (!(selection instanceof TextSelection) || !selection.empty)
                return null;
              const $cursor = selection.$from;
              if (!$cursor.parent.isTextblock || $cursor.parent.type.spec.code)
                return null;
              const parsed = inlineFormulaAroundCaret(
                $cursor.parent.textBetween(
                  0,
                  $cursor.parent.content.size,
                  "\n",
                  "\ufffc",
                ),
                $cursor.parentOffset,
              );
              if (!parsed) return null;
              const codeMark = newState.schema.marks.code;
              if (
                codeMark &&
                $cursor.parent.rangeHasMark(parsed.from, parsed.to, codeMark)
              ) {
                return null;
              }
              const parentStart = $cursor.start();
              return newState.tr.replaceWith(
                parentStart + parsed.from,
                parentStart + parsed.to,
                this.type.create(
                  {
                    latex: parsed.latex,
                    autoEdit: true,
                    sourceCaret: parsed.caret,
                  },
                  null,
                  $cursor.marks(),
                ),
              );
            },
          }),
        ];
      }
      return [
        pendingInput,
        new Plugin({
          appendTransaction: (transactions, _oldState, newState) => {
            if (transactions.some(isHistoryTransaction)) return null;
            if (!transactions.some((transaction) => transaction.docChanged))
              return null;
            const selection = newState.selection;
            if (!(selection instanceof TextSelection) || !selection.empty)
              return null;
            const $cursor = selection.$from;
            if ($cursor.parent.type.name !== "paragraph") return null;
            const codeMark = newState.schema.marks.code;
            if (
              codeMark &&
              $cursor.parent.rangeHasMark(
                0,
                $cursor.parent.content.size,
                codeMark,
              )
            ) {
              return null;
            }
            const parsed = displayFormulaAfterTextInsertion({
              parentText: $cursor.parent.textBetween(
                0,
                $cursor.parent.content.size,
                "\n",
                "\ufffc",
              ),
              from: $cursor.parentOffset,
              to: $cursor.parentOffset,
              insertedText: "",
            });
            if (!parsed) return null;

            // A complete formula whose delimiters were already to the right of
            // the caret must remain editable so the next keystroke continues in
            // the formula instead of replacing the new atom.
            const wrappedSource =
              ($cursor.parent
                .textBetween(0, $cursor.parent.content.size, "\n", "\ufffc")
                .startsWith("$$") &&
                $cursor.parent
                  .textBetween(0, $cursor.parent.content.size, "\n", "\ufffc")
                  .endsWith("$$")) ||
              ($cursor.parent
                .textBetween(0, $cursor.parent.content.size, "\n", "\ufffc")
                .startsWith("\\[") &&
                $cursor.parent
                  .textBetween(0, $cursor.parent.content.size, "\n", "\ufffc")
                  .endsWith("\\]"));
            const insideDelimitedSource =
              wrappedSource &&
              $cursor.parentOffset >= 2 &&
              $cursor.parentOffset <= $cursor.parent.content.size - 2;
            return newState.tr.replaceWith(
              $cursor.before(),
              $cursor.after(),
              this.type.create({
                latex: parsed.latex,
                autoEdit: insideDelimitedSource,
                sourceCaret: insideDelimitedSource ? parsed.caret : null,
              }),
            );
          },
        }),
      ];
    },

    addKeyboardShortcuts() {
      return {
        Enter: () => {
          if (kind !== "block") return false;
          const { state, view } = this.editor;
          const { $from, empty } = state.selection;
          const code = state.schema.marks.code;
          if (
            !empty ||
            $from.parent.type.name !== "paragraph" ||
            $from.parent.textContent !== "$$" ||
            $from.parentOffset !== 2 ||
            (code && $from.parent.rangeHasMark(0, 2, code))
          )
            return false;
          view.dispatch(
            state.tr.replaceWith(
              $from.before(),
              $from.after(),
              this.type.create({ latex: "", autoEdit: true, sourceCaret: 0 }),
            ),
          );
          return true;
        },
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
