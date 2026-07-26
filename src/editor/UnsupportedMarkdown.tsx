import { Node, mergeAttributes, type NodeViewRendererProps } from '@tiptap/core';

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
    this.dom.textContent = '';
    const title = document.createElement('strong');
    title.textContent = '未支援的 Markdown 已保留';
    const reason = document.createElement('span');
    reason.textContent = String(
      this.node.attrs.reason ?? '此內容未納入 PaperCanvas Markdown 子集。',
    );
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

  renderHTML({ HTMLAttributes }) {
    return ['aside', mergeAttributes(HTMLAttributes, { 'data-unsupported-markdown': '' }), 0];
  },

  addNodeView() {
    return (props) => new UnsupportedMarkdownView(props);
  },
});
