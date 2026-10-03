/* eslint-disable react-refresh/only-export-components */
import { Node, mergeAttributes, type NodeViewRendererProps } from '@tiptap/core';
import { getMessages } from '../i18n';

export function updateUnsupportedMarkdownLabels(view: NodeViewRendererProps['view'], title: string): void {
  view.dom.querySelectorAll<HTMLElement>('.unsupported-markdown > strong').forEach((label) => {
    label.textContent = title;
  });
}

class UnsupportedMarkdownView {
  dom: HTMLElement;
  private node: NodeViewRendererProps['node'];

  constructor(props: NodeViewRendererProps) {
    this.node = props.node;
    this.dom = document.createElement('aside');
    this.dom.className = 'unsupported-markdown';
    this.dom.contentEditable = 'false';
    this.render();
  }

  update(node: NodeViewRendererProps['node']): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof HTMLElement && this.dom.contains(event.target);
  }

  ignoreMutation(): boolean {
    return true;
  }

  private render(): void {
    const text = getMessages();
    this.dom.textContent = '';
    const title = document.createElement('strong');
    title.textContent = text.unsupportedMarkdownTitle;
    const reason = document.createElement('span');
    reason.textContent = String(this.node.attrs.reason ?? text.unsupportedMarkdownReason);
    const source = document.createElement('pre');
    source.textContent = String(this.node.attrs.source ?? '');
    this.dom.append(title, reason, source);
  }
}

export const UnsupportedMarkdown = Node.create({
  name: 'unsupportedMarkdown',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      source: { default: '' },
      reason: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-unsupported-markdown]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-unsupported-markdown': '' }),
      ['pre', {}, String(node.attrs.source ?? '')]];
  },

  renderText({ node }) {
    return String(node.attrs.source ?? '');
  },

  addNodeView() {
    return (props) => new UnsupportedMarkdownView(props);
  },
});
