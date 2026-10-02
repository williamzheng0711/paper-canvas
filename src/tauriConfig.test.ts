import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type TauriConfig = {
  app?: {
    security?: {
      csp?: string;
    };
    windows?: Array<{
      dragDropEnabled?: boolean;
    }>;
  };
};

describe('Tauri desktop configuration', () => {
  it('allows the native title and close operations used to protect pending saves', () => {
    const capabilities = JSON.parse(readFileSync(resolve(process.cwd(), 'src-tauri/capabilities/default.json'), 'utf8')) as { permissions: string[] };
    expect(capabilities.permissions).toContain('core:window:allow-destroy');
    expect(capabilities.permissions).toContain('core:window:allow-set-title');
  });
  it('lets HTML5 image drops reach the editor', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
    ) as TauriConfig;

    expect(config.app?.windows?.[0]?.dragDropEnabled).toBe(false);
  });

  it('permits HTTPS document images without widening script or connection access', () => {
    const config = JSON.parse(readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')) as TauriConfig;
    const csp = config.app?.security?.csp ?? '';

    expect(csp).toContain("img-src 'self' asset: http://asset.localhost blob: data: https:");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
