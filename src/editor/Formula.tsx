/* eslint-disable react-refresh/only-export-components */
import { InputRule, Node, mergeAttributes, type NodeViewRendererProps } from '@tiptap/core';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import katex from 'katex';
import type { MathfieldElement } from 'mathlive';
import {
  displayFormulaFromDelimitedLine,
  latexEnvironmentClosure,
  shouldCompleteRawLatexEnvironment,
  shouldCreateBlockFormula,
} from './formulaInput';

export type FormulaKind = 'inline' | 'block';

export function formulaBoundaryTarget(
  selection: { from: number; to: number; nodeType: string } | null,
  key: 'ArrowLeft' | 'ArrowRight',
): number | null {
  if (!selection || !['inlineFormula', 'blockFormula'].includes(selection.nodeType)) return null;
  return key === 'ArrowLeft' ? selection.from : selection.to;
}

export function formulaFieldBoundaryAction(input: {
  key: string;
  selectionIsCollapsed: boolean;
  position: number;
  lastOffset: number;
  latex: string;
}): 'before' | 'after' | 'remove' | null {
  if (!input.selectionIsCollapsed) return null;
  if (input.key === 'ArrowLeft' && input.position === 0) return 'before';
  if (input.key === 'ArrowRight' && input.position === input.lastOffset) return 'after';
  if (
    input.latex === '' &&
    ((input.key === 'Backspace' && input.position === 0) ||
      (input.key === 'Delete' && input.position === input.lastOffset))
  ) {
    return 'remove';
  }
  return null;
}

export function validateLatex(latex: string, displayMode = false): string | null {
  try {
    katex.renderToString(latex, { displayMode, strict: 'warn', throwOnError: true, trust: false });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : '無法解析公式';
  }
}

type FormulaInputField = Pick<MathfieldElement, 'getValue' | 'insert'>;

/**
 * Adds the matching close command at a MathLive caret and returns the value
 * that should be persisted to the ProseMirror node.
 */
export function completeFormulaFieldInput(field: FormulaInputField): string {
  const latex = field.getValue('latex');
  const closure = latexEnvironmentClosure(latex);
  if (!closure) return latex;
  // MathLive keeps the caret immediately before the inserted close command,
  // so the user can continue writing the environment body without moving
  // through `\\end{…}` by hand. Silence the nested event; the caller persists
  // the complete value once after this function returns.
  field.insert(closure, {
    format: 'latex',
    selectionMode: 'before',
    silenceNotifications: true,
  });
  return field.getValue('latex');
}

class FormulaNodeView {
  dom: HTMLElement;
  private readonly kind: FormulaKind;
  private readonly view: NodeViewRendererProps['view'];
  private readonly getPos: NodeViewRendererProps['getPos'];
  private node: NodeViewRendererProps['node'];
  private editing = false;
  private field: MathfieldElement | null = null;
  private fieldInput: (() => void) | null = null;
  private fieldKeyDown: ((event: KeyboardEvent) => void) | null = null;
  private fieldBlur: (() => void) | null = null;

  constructor(props: NodeViewRendererProps, kind: FormulaKind) {
    this.node = props.node;
    this.view = props.view;
    this.getPos = props.getPos;
    this.kind = kind;
    this.dom = document.createElement(kind === 'block' ? 'div' : 'span');
    this.dom.className = `formula-node formula-node--${kind}`;
    this.dom.contentEditable = 'false';
    this.dom.dataset.formulaKind = kind;
    this.render();
  }

  update(node: NodeViewRendererProps['node']): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (this.editing && this.field) {
      // Attribute updates occur on every MathLive input. Never reset an active
      // field, because doing so loses its caret and breaks IME composition.
      if (!this.field.hasFocus()) this.field.value = this.latex;
      return true;
    }
    this.render();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('is-selected');
  }

  deselectNode(): void {
    this.dom.classList.remove('is-selected');
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof HTMLElement && this.dom.contains(event.target);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.cleanupField();
  }

  private get latex(): string {
    return String(this.node.attrs.latex ?? '');
  }

  private position(): number | null {
    if (typeof this.getPos !== 'function') return null;
    const position = this.getPos();
    return typeof position === 'number' ? position : null;
  }

  private render(): void {
    if (this.editing) return;
    this.dom.textContent = '';
    const latex = this.latex;
    const error = validateLatex(latex, this.kind === 'block');
    const formula = document.createElement('span');
    formula.className = `formula-render ${error ? 'formula-render--error' : ''}`;
    formula.setAttribute('role', 'button');
    formula.tabIndex = 0;
    formula.title = error ? `公式錯誤：${error}` : '點擊編輯公式';
    formula.addEventListener('click', () => this.enterEditing());
    formula.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.enterEditing();
      }
    });

    if (error) {
      const source = document.createElement('code');
      source.textContent = latex || '空公式';
      const warning = document.createElement('small');
      warning.textContent = '公式無法渲染，原始 LaTeX 已保留';
      formula.append(source, warning);
    } else {
      const rendered = document.createElement('span');
      rendered.innerHTML = katex.renderToString(latex || '\\;', {
        displayMode: this.kind === 'block',
        throwOnError: false,
        trust: false,
      });
      formula.appendChild(rendered);
    }

    const copy = document.createElement('button');
    copy.className = 'formula-copy';
    copy.type = 'button';
    copy.setAttribute('aria-label', '複製 LaTeX');
    copy.textContent = 'LaTeX';
    copy.addEventListener('mousedown', (event) => event.preventDefault());
    copy.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const result = navigator.clipboard?.writeText(latex);
      void result?.catch(() => undefined);
    });
    this.dom.append(formula, copy);
  }

  private enterEditing(): void {
    if (this.editing) return;
    this.editing = true;
    this.dom.classList.add('is-editing');
    this.dom.textContent = '';
    const field = document.createElement('math-field') as MathfieldElement;
    field.setAttribute('aria-label', `${this.kind === 'block' ? '區塊' : '行內'}公式`);
    field.setAttribute('virtual-keyboard-mode', 'manual');
    field.value = this.latex;
    field.smartMode = true;
    this.field = field;
    this.fieldInput = () => this.handleFieldInput(field);
    this.fieldKeyDown = (event) => this.handleFieldKeyDown(event, field);
    this.fieldBlur = () => this.finishEditing();
    field.addEventListener('input', this.fieldInput);
    field.addEventListener('keydown', this.fieldKeyDown);
    field.addEventListener('blur', this.fieldBlur);
    this.dom.appendChild(field);
    requestAnimationFrame(() => {
      if (this.field === field) field.focus();
    });
  }

  private finishEditing(): void {
    if (!this.editing) return;
    this.editing = false;
    this.dom.classList.remove('is-editing');
    this.cleanupField();
    this.render();
  }

  private cleanupField(): void {
    if (!this.field) return;
    if (this.fieldInput) this.field.removeEventListener('input', this.fieldInput);
    if (this.fieldKeyDown) this.field.removeEventListener('keydown', this.fieldKeyDown);
    if (this.fieldBlur) this.field.removeEventListener('blur', this.fieldBlur);
    this.field = null;
    this.fieldInput = null;
    this.fieldKeyDown = null;
    this.fieldBlur = null;
  }

  private updateLatex(latex: string): void {
    const position = this.position();
    if (position === null) return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(position, undefined, { ...this.node.attrs, latex }),
    );
  }

  private handleFieldInput(field: MathfieldElement): void {
    this.updateLatex(completeFormulaFieldInput(field));
  }

  private handleFieldKeyDown(event: KeyboardEvent, field: MathfieldElement): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      field.blur();
      return;
    }
    const boundary = formulaFieldBoundaryAction({
      key: event.key,
      selectionIsCollapsed: field.selectionIsCollapsed,
      position: field.position,
      lastOffset: field.lastOffset,
      latex: field.getValue('latex'),
    });
    if (!boundary) return;
    event.preventDefault();
    if (boundary === 'remove') {
      this.removeEmptyFormula();
    } else {
      this.moveToText(boundary);
    }
  }

  private moveToText(side: 'before' | 'after'): void {
    const position = this.position();
    if (position === null) return;
    const target = side === 'before' ? position : position + this.node.nodeSize;
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
      this.view.dispatch(transaction.setSelection(TextSelection.create(transaction.doc, position)));
      this.view.focus();
    });
  }
}

function createFormulaNode(name: 'inlineFormula' | 'blockFormula', kind: FormulaKind) {
  return Node.create({
    name,
    group: kind === 'inline' ? 'inline' : 'block',
    inline: kind === 'inline',
    atom: true,
    selectable: true,
    defining: true,

    addAttributes() {
      return { latex: { default: '' } };
    },

    parseHTML() {
      return [{ tag: `${kind === 'inline' ? 'span' : 'div'}[data-formula-kind="${kind}"]` }];
    },

    renderHTML({ HTMLAttributes }) {
      return [
        kind === 'inline' ? 'span' : 'div',
        mergeAttributes(HTMLAttributes, {
          'data-formula-kind': kind,
          'data-latex': HTMLAttributes.latex,
        }),
      ];
    },

    addNodeView() {
      return (props) => new FormulaNodeView(props, kind);
    },

    addInputRules() {
      if (kind === 'block') {
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
              const virtualParentText = `${$from.parent.textContent}${source.at(-1) ?? ''}`;
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
              state.tr.replaceWith($from.before(), $from.after(), this.type.create({ latex }));
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
            const virtualParentText = `${$from.parent.textContent}${begin.at(-1) ?? ''}`;
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
              .insertText(`${begin.at(-1) ?? ''}${closure}`, range.to)
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
            state.tr.replaceWith(range.from, range.to, this.type.create({ latex }));
          },
        }),
      ];
    },

    addKeyboardShortcuts() {
      return {
        'Mod-Alt-m': () => this.editor.commands.insertContent({ type: name, attrs: { latex: '' } }),
        ArrowLeft: () => {
          const selection = this.editor.state.selection;
          if (!(selection instanceof NodeSelection)) return false;
          const target = formulaBoundaryTarget(
            { from: selection.from, to: selection.to, nodeType: selection.node.type.name },
            'ArrowLeft',
          );
          if (target === null) return false;
          return this.editor.commands.setTextSelection(target);
        },
        ArrowRight: () => {
          const selection = this.editor.state.selection;
          if (!(selection instanceof NodeSelection)) return false;
          const target = formulaBoundaryTarget(
            { from: selection.from, to: selection.to, nodeType: selection.node.type.name },
            'ArrowRight',
          );
          if (target === null) return false;
          return this.editor.commands.setTextSelection(target);
        },
        Backspace: () => {
          const selection = this.editor.state.selection;
          return selection instanceof NodeSelection &&
            ['inlineFormula', 'blockFormula'].includes(selection.node.type.name)
            ? this.editor.commands.deleteSelection()
            : false;
        },
        Delete: () => {
          const selection = this.editor.state.selection;
          return selection instanceof NodeSelection &&
            ['inlineFormula', 'blockFormula'].includes(selection.node.type.name)
            ? this.editor.commands.deleteSelection()
            : false;
        },
      };
    },
  });
}

export const InlineFormula = createFormulaNode('inlineFormula', 'inline');
export const BlockFormula = createFormulaNode('blockFormula', 'block');
