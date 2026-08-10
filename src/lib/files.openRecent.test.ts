import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openRecent } from './files';

const filesystem = vi.hoisted(() => ({
  exists: vi.fn(),
  readTextFile: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: filesystem.exists,
  mkdir: vi.fn(),
  readTextFile: filesystem.readTextFile,
  rename: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
}));

describe('opening recent documents', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a missing result without trying to read a stale path', async () => {
    filesystem.exists.mockResolvedValueOnce(false);

    await expect(openRecent({ path: '/tmp/missing.md', name: 'missing.md' })).resolves.toBeNull();
    expect(filesystem.readTextFile).not.toHaveBeenCalled();
  });

  it('recognizes a file removed between the existence check and read', async () => {
    const readFailure = new Error('path disappeared');
    filesystem.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    filesystem.readTextFile.mockRejectedValueOnce(readFailure);

    await expect(openRecent({ path: '/tmp/moved.md', name: 'moved.md' })).resolves.toBeNull();
  });

  it('preserves read errors while the file still exists', async () => {
    const permissionFailure = new Error('permission denied');
    filesystem.exists.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    filesystem.readTextFile.mockRejectedValueOnce(permissionFailure);

    await expect(openRecent({ path: '/tmp/private.md', name: 'private.md' })).rejects.toBe(permissionFailure);
  });
});
