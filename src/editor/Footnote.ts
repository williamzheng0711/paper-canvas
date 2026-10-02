import {
  Node,
  mergeAttributes,
  type NodeViewRendererProps,
} from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView, ViewMutationRecord } from "@tiptap/pm/view";

interface FootnoteOptions {
  referenceLabel: (number: string) => string;
  backlinkLabel: (number: string) => string;
}

interface ActiveReference {
  identifier: string;
  pos: number;
}

const navigationKey = new PluginKey<ReadonlyMap<string, number>>(
  "footnoteNavigation",
);
interface FootnoteIndex {
  numbers: Map<string, number>;
  references: Map<string, number[]>;
  definitions: Map<string, number[]>;
}
const indices = new WeakMap<ProseMirrorNode, FootnoteIndex>();

/** Markdown labels match irrespective of casing or collapsed whitespace. */
function identifierKey(identifier: unknown): string {
  return String(identifier ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Display numbers are derived, never written into the document or source. */
export function footnoteNumbers(doc: ProseMirrorNode): Map<string, number> {
  return footnoteIndex(doc).numbers;
}

function footnoteIndex(doc: ProseMirrorNode): FootnoteIndex {
  const cached = indices.get(doc);
  if (cached) return cached;
  const index: FootnoteIndex = {
    numbers: new Map(),
    references: new Map(),
    definitions: new Map(),
  };
  doc.descendants((node, pos) => {
    if (
      node.type.name !== "footnoteReference" &&
      node.type.name !== "footnoteDefinition"
    )
      return;
    const identifier = identifierKey(node.attrs.identifier);
    const positions =
      node.type.name === "footnoteReference"
        ? index.references
        : index.definitions;
    const existing = positions.get(identifier);
    if (existing) existing.push(pos);
    else positions.set(identifier, [pos]);
    if (
      node.type.name === "footnoteReference" &&
      !index.numbers.has(identifier)
    ) {
      index.numbers.set(identifier, index.numbers.size + 1);
    }
  });
  index.definitions.forEach((_, identifier) => {
    if (!index.numbers.has(identifier))
      index.numbers.set(identifier, index.numbers.size + 1);
  });
  indices.set(doc, index);
  return index;
}

function matchingPositions(
  doc: ProseMirrorNode,
  name: string,
  identifier: string,
): number[] {
  const index = footnoteIndex(doc);
  return (
    (name === "footnoteReference" ? index.references : index.definitions).get(
      identifier,
    ) ?? []
  );
}

function revealFootnote(view: EditorView, pos: number): void {
  const target = view.nodeDOM(pos);
  if (!(target instanceof HTMLElement)) return;
  const viewport = view.dom.closest<HTMLElement>(".canvas-area");
  if (viewport && typeof viewport.scrollTo === "function") {
    viewport.scrollTo({
      top: Math.max(
        0,
        viewport.scrollTop +
          target.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top -
          20,
      ),
      behavior: "smooth",
    });
  } else target.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}

function definitionTextSelection(
  doc: ProseMirrorNode,
  pos: number,
): TextSelection | undefined {
  let textPosition: number | undefined;
  doc.nodeAt(pos)?.descendants((node, offset) => {
    if (textPosition !== undefined || node.type.name === "footnoteDefinition")
      return false;
    if (node.isTextblock && !node.isAtom) {
      textPosition = pos + offset + 2;
      return false;
    }
  });
  return textPosition === undefined
    ? undefined
    : TextSelection.create(doc, textPosition);
}

function activateFootnote(
  props: NodeViewRendererProps,
  backlink: boolean,
): boolean {
  const identifier = identifierKey(props.node.attrs.identifier);
  const view = props.view;
  const targetType = backlink ? "footnoteReference" : "footnoteDefinition";
  const positions = matchingPositions(view.state.doc, targetType, identifier);
  const activePosition = navigationKey.getState(view.state)?.get(identifier);
  const pos =
    backlink &&
    activePosition !== undefined &&
    positions.includes(activePosition)
      ? activePosition
      : positions[0];
  if (pos === undefined) return false;
  const ownPos = props.getPos();
  // Selecting a leading image or formula would make the next keystroke delete
  // it. Prefer editable text in this note; an atom-only note is scroll-only.
  const selection = backlink
    ? Selection.near(view.state.doc.resolve(pos + 1), -1)
    : definitionTextSelection(view.state.doc, pos);
  const transaction = view.state.tr.setMeta("skipTrailingNode", true);
  if (selection) transaction.setSelection(selection);
  if (!backlink && ownPos !== undefined)
    transaction.setMeta(navigationKey, { identifier, pos: ownPos });
  view.dispatch(transaction);
  view.focus();
  revealFootnote(view, pos);
  return true;
}

export function updateFootnoteLabels(view: EditorView, options: FootnoteOptions): void {
  const index = footnoteIndex(view.state.doc);
  view.dom
    .querySelectorAll<HTMLElement>(
      "[data-footnote-reference], [data-footnote-definition]",
    )
    .forEach((element) => {
      const identifier = identifierKey(element.dataset.footnoteIdentifier);
      const number = String(
        index.numbers.get(identifier) ??
          element.dataset.footnoteLabel ??
          identifier,
      );
      const backlink = element.hasAttribute("data-footnote-definition");
      const marker = element.querySelector<HTMLButtonElement>(
        "[data-footnote-marker]",
      );
      if (!marker) return;
      const label = backlink
        ? options.backlinkLabel(number)
        : options.referenceLabel(number);
      marker.textContent = backlink ? `${number} ↩` : number;
      marker.setAttribute("aria-label", label);
      marker.title = label;
      const enabled = (backlink ? index.references : index.definitions).has(
        identifier,
      );
      if (enabled) marker.removeAttribute("aria-disabled");
      else marker.setAttribute("aria-disabled", "true");
    });
}

const footnoteAttributes = {
  identifier: {
    default: "",
    rendered: false,
    parseHTML: (element: HTMLElement) =>
      element.getAttribute("data-footnote-identifier") ?? "",
  },
  label: {
    default: "",
    rendered: false,
    parseHTML: (element: HTMLElement) =>
      element.getAttribute("data-footnote-label") ??
      element.getAttribute("data-footnote-identifier") ??
      "",
  },
};

function footnoteHTMLAttributes(
  attrs: Record<string, unknown>,
): Record<string, string> {
  return {
    "data-footnote-identifier": String(attrs.identifier ?? ""),
    "data-footnote-label": String(attrs.label ?? ""),
  };
}

function defaultOptions(): FootnoteOptions {
  return {
    referenceLabel: (number) => `Footnote ${number}`,
    backlinkLabel: (number) => `Return to reference ${number}`,
  };
}

class FootnoteView {
  readonly dom: HTMLElement;
  readonly contentDOM?: HTMLElement;
  private readonly marker: HTMLButtonElement;
  private props: NodeViewRendererProps;

  constructor(
    props: NodeViewRendererProps,
    private readonly backlink: boolean,
    private readonly options: FootnoteOptions,
  ) {
    this.props = props;
    this.dom = document.createElement(backlink ? "div" : "sup");
    this.dom.className = backlink
      ? "footnote-definition"
      : "footnote-reference";
    this.dom.setAttribute(
      backlink ? "data-footnote-definition" : "data-footnote-reference",
      "",
    );
    this.marker = document.createElement("button");
    this.marker.type = "button";
    this.marker.className = backlink
      ? "footnote-backlink"
      : "footnote-reference-link";
    this.marker.setAttribute("data-footnote-marker", "");
    this.marker.contentEditable = "false";
    this.marker.addEventListener("mousedown", this.preventSelection);
    this.marker.addEventListener("click", this.activate);
    this.marker.addEventListener("keydown", this.handleKey);
    this.dom.append(this.marker);
    if (backlink) {
      this.contentDOM = document.createElement("div");
      this.contentDOM.className = "footnote-content";
      this.dom.append(this.contentDOM);
    } else this.dom.contentEditable = "false";
    this.render();
  }

  update(node: NodeViewRendererProps["node"]): boolean {
    if (node.type !== this.props.node.type) return false;
    this.props = { ...this.props, node };
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
      event.target instanceof globalThis.Node &&
      this.marker.contains(event.target)
    );
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    return !this.contentDOM || !this.contentDOM.contains(mutation.target);
  }

  destroy(): void {
    this.marker.removeEventListener("mousedown", this.preventSelection);
    this.marker.removeEventListener("click", this.activate);
    this.marker.removeEventListener("keydown", this.handleKey);
  }

  private readonly preventSelection = (event: Event): void => {
    event.preventDefault();
  };
  private readonly activate = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    activateFootnote(this.props, this.backlink);
  };
  private readonly handleKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") this.activate(event);
  };

  private render(): void {
    const attrs = footnoteHTMLAttributes(this.props.node.attrs);
    Object.entries(attrs).forEach(([name, value]) =>
      this.dom.setAttribute(name, value),
    );
    const number = String(
      footnoteNumbers(this.props.view.state.doc).get(
        identifierKey(this.props.node.attrs.identifier),
      ) ?? this.props.node.attrs.label,
    );
    this.marker.textContent = this.backlink ? `${number} ↩` : number;
    this.marker.setAttribute(
      "aria-label",
      this.backlink
        ? this.options.backlinkLabel(number)
        : this.options.referenceLabel(number),
    );
  }
}

export const FootnoteReference = Node.create<FootnoteOptions>({
  name: "footnoteReference",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions: defaultOptions,
  addAttributes() {
    return footnoteAttributes;
  },
  parseHTML() {
    return [{ tag: "sup[data-footnote-reference]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "sup",
      mergeAttributes(HTMLAttributes, footnoteHTMLAttributes(node.attrs), {
        "data-footnote-reference": "",
        class: "footnote-reference",
      }),
      String(node.attrs.label || node.attrs.identifier),
    ];
  },
  addNodeView() {
    return (props) => new FootnoteView(props, false, this.options);
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<ReadonlyMap<string, number>>({
        key: navigationKey,
        state: {
          init: () => new Map(),
          apply(transaction, active) {
            const selected = transaction.getMeta(navigationKey) as
              ActiveReference | undefined;
            if (!selected && !transaction.docChanged) return active;
            const origins = new Map<string, number>();
            active.forEach((pos, identifier) => {
              const mapped = transaction.mapping.mapResult(pos, 1);
              const node = transaction.doc.nodeAt(mapped.pos);
              if (
                !mapped.deleted &&
                node?.type.name === "footnoteReference" &&
                identifierKey(node.attrs.identifier) === identifier
              )
                origins.set(identifier, mapped.pos);
            });
            if (selected) origins.set(selected.identifier, selected.pos);
            return origins;
          },
        },
        view(view) {
          updateFootnoteLabels(view, options);
          return {
            update(current, previous) {
              if (current.state.doc !== previous.doc)
                updateFootnoteLabels(current, options);
            },
          };
        },
      }),
    ];
  },
});

export const FootnoteDefinition = Node.create<FootnoteOptions>({
  name: "footnoteDefinition",
  group: "block",
  content: "block+",
  defining: true,
  isolating: true,
  addOptions: defaultOptions,
  addAttributes() {
    return footnoteAttributes;
  },
  parseHTML() {
    return [
      {
        tag: "div[data-footnote-definition]",
        contentElement: ".footnote-content",
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, footnoteHTMLAttributes(node.attrs), {
        "data-footnote-definition": "",
        class: "footnote-definition",
      }),
      [
        "span",
        { class: "footnote-backlink", contenteditable: "false" },
        String(node.attrs.label || node.attrs.identifier),
      ],
      ["div", { class: "footnote-content" }, 0],
    ];
  },
  addNodeView() {
    return (props) => new FootnoteView(props, true, this.options);
  },
});
