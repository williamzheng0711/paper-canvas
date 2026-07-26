import DOMPurify from 'dompurify';

/**
 * Keep the HTML path deliberately small. ProseMirror will turn this into its
 * own document model afterwards, so neither executable markup nor arbitrary
 * browser attributes need to survive a paste.
 */
export function sanitizePastedHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      's',
      'del',
      'code',
      'pre',
      'a',
      'ul',
      'ol',
      'li',
      'blockquote',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'img',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
    ALLOW_DATA_ATTR: false,
  });
}
