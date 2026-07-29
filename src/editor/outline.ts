const headingSelector = ':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6';

export function scrollToOutlineHeading(editorRoot: HTMLElement, index: number): boolean {
  const heading = editorRoot.querySelectorAll<HTMLElement>(headingSelector).item(index);
  if (!heading) return false;
  const scrollContainer = editorRoot.closest<HTMLElement>('.canvas-area');
  if (scrollContainer) {
    const containerTop = scrollContainer.getBoundingClientRect().top;
    const headingTop = heading.getBoundingClientRect().top;
    scrollContainer.scrollTo({
      top: Math.max(0, scrollContainer.scrollTop + headingTop - containerTop - 20),
      behavior: 'smooth',
    });
  } else {
    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  return true;
}
