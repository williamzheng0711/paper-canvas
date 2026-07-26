import { describe, expect, it } from 'vitest';
import { sanitizePastedHtml } from './paste';

describe('HTML paste sanitization', () => {
  it('retains common document markup but removes executable content and unsafe URLs', () => {
    const sanitized = sanitizePastedHtml(
      '<h2>研究</h2><p><a href="javascript:alert(1)" onclick="alert(2)">link</a></p><img src="x" onerror="alert(3)"><script>alert(4)</script>',
    );

    expect(sanitized).toContain('<h2>研究</h2>');
    expect(sanitized).toContain('<img src="x">');
    expect(sanitized).not.toMatch(/script|onclick|onerror|javascript:/i);
  });
});
