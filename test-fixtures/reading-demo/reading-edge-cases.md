# Reading checks · 閱讀測試

This document checks reading, navigation, and repeated switches between Canvas and Markdown source. Jump through the contents below, scroll to the formula and table, and return to the beginning.

- [Formatting and links](#formatting-and-links)
- [`Code examples`](#code-examples)
- [Research formula · 研究公式](#research-formula--研究公式)
- [Aligned table](#aligned-table)
- [Lists and images](#lists-and-images)
- [Source preservation](#source-preservation)

## Formatting and links

English and 中文 should be comfortable to read together. **Strong text**, *emphasis*, ~~obsolete text~~, and `inline code` should remain distinct. Press <kbd>Command</kbd> to test inline HTML; a superscript x<sup>2</sup> should stay attached to its base.

[A reference-style link][documentation] and [a linked `code span`](https://github.com/remarkjs/remark-gfm) should still work after switching modes. The reference link has a title tooltip.

> A quoted paragraph should be readable without taking over the entire page.
>
> - This nested item belongs to the quotation.

## Code examples

The formula delimiters below are literal code. Three blank lines inside the block must remain intact after a Canvas edit and save.

```tex
$$x^2$$


\(not a formula here\)
```

```typescript
const document = { title: "Reading test", ready: true };
console.log(document.title);
```

## Research formula · 研究公式

Let $x$ be a real number and let $f(x)=x^2$. Its derivative is $f'(x)=2x$.

\[
\int_0^1 x^2\,\mathrm{d}x = \frac{1}{3}.
\]

Let $a$ and $b$ also be real numbers.

\begin{align*}
(a+b)^2 &= a^2 + 2ab + b^2, \\
(a-b)^2 &= a^2 - 2ab + b^2.
\end{align*}

This paragraph comes after the display environment and must not become part of the formula.

## Aligned table

| Symbol | Value | Meaning |
| :--- | ---: | :---: |
| $x$ | 42 | Centered |
| $f(x)$ | 1764 | Squared value |

The first row is a header. The first, second, and third columns are aligned left, right, and center.

## Lists and images

- An ordinary bullet before the tasks.
- [x] A completed task.
- [ ] A remaining task.
- An ordinary bullet after the tasks.

![Local sample image](../papercanvas-sample-image.svg "Local SVG reading fixture")

[![Linked local sample image](../papercanvas-sample-image.svg "Local linked image")](https://github.com/remarkjs/remark-gfm "Open the documentation")

![Intentionally missing image: its alt text must remain visible](missing-reading-image.png)

## Source preservation

Footnotes are currently preserved as source: a note[^reading]. Its reference and definition must survive a Canvas edit. Ordered task lists also retain their source numbering.

3. [x] A task numbered three.
4. The ordinary item numbered four must not disappear.

[^reading]: This footnote definition must remain recoverable in Markdown source.

<!-- This comment is preserved in Markdown source and invisible on Canvas. -->

[documentation]: https://github.com/remarkjs/remark-gfm "Official remark-gfm documentation"
