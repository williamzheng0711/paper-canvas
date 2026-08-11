import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type TauriConfig = {
  app?: {
    windows?: Array<{
      dragDropEnabled?: boolean;
    }>;
  };
};

describe('Tauri desktop configuration', () => {
  it('lets HTML5 image drops reach the editor', () => {
    const config = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
    ) as TauriConfig;

    expect(config.app?.windows?.[0]?.dragDropEnabled).toBe(false);
  });
});
