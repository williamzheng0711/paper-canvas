import { invoke, isTauri } from '@tauri-apps/api/core';
import { renderedHeadingText, renderedOutlineHeadings, scrollToOutlineHeading } from './outline';

type DocumentLinkTarget = { kind: 'fragment'; fragment: string } | { kind: 'external'; url: string };

/** Keep navigation out of the editable webview and reject executable URL schemes. */
export function documentLinkTarget(href: string): DocumentLinkTarget | undefined {
  const normalized = href.trim();
  if (normalized.startsWith('#')) return { kind: 'fragment', fragment: normalized.slice(1) };
  try {
    const url = new URL(normalized);
    if (url.protocol === 'mailto:' || ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname)) {
      return { kind: 'external', url: url.href };
    }
  } catch {
    // Relative file links remain editable until a document-relative open exists.
  }
  return undefined;
}

function headingSlug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').trim().replace(/\s/g, '-');
}

/** Resolve Markdown heading fragments, including Unicode and repeated headings. */
export function scrollToDocumentFragment(editorRoot: HTMLElement, fragment: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return false;
  }
  const viewport = editorRoot.closest<HTMLElement>('.canvas-area');
  if (decoded === '') {
    if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' });
    return Boolean(viewport);
  }
  const explicitTarget = [...editorRoot.querySelectorAll<HTMLElement>('[id]')].find((node) => node.id === decoded);
  if (explicitTarget) {
    if (viewport) {
      viewport.scrollTo({
        top: Math.max(0, viewport.scrollTop + explicitTarget.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 20),
        behavior: 'smooth',
      });
    } else explicitTarget.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    return true;
  }
  const headings = renderedOutlineHeadings(editorRoot);
  const usedSlugs = new Set<string>();
  const nextSuffix = new Map<string, number>();
  for (let index = 0; index < headings.length; index += 1) {
    const base = headingSlug(renderedHeadingText(headings[index]));
    let slug = base;
    let suffix = nextSuffix.get(base) ?? 1;
    while (usedSlugs.has(slug)) slug = `${base}-${suffix++}`;
    nextSuffix.set(base, suffix);
    usedSlugs.add(slug);
    if (slug === decoded) return scrollToOutlineHeading(editorRoot, index);
  }
  return false;
}

export async function activateDocumentLink(editorRoot: HTMLElement, href: string): Promise<boolean> {
  const target = documentLinkTarget(href);
  if (!target) return false;
  if (target.kind === 'fragment') return scrollToDocumentFragment(editorRoot, target.fragment);
  if (isTauri()) await invoke('open_external_url', { url: target.url });
  else window.open(target.url, '_blank', 'noopener,noreferrer');
  return true;
}
