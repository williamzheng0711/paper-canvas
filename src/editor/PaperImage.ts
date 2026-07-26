import Image from '@tiptap/extension-image';

export const PaperImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      originalSrc: { default: null, rendered: false },
    };
  },
});
