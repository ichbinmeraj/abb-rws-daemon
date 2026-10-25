import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleBecause } from './global-setup.js';

describe('the test run builds dist/ when the scripts would run stale code', () => {
  it('on a fresh clone, after a source edit, and not when dist/ is current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daemon-setup-'));
    try {
      await mkdir(join(root, 'src', 'recording'), { recursive: true });
      await writeFile(join(root, 'src', 'recording', 'mask.ts'), 'export {};\n');
      expect(staleBecause(root)).toBe('dist/ has not been built');

      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'dist', 'index.js'), 'export {};\n');
      const built = new Date('2026-10-04T12:00:00Z');
      await utimes(join(root, 'src', 'recording', 'mask.ts'), new Date('2026-10-04T11:00:00Z'), new Date('2026-10-04T11:00:00Z'));
      await utimes(join(root, 'dist', 'index.js'), built, built);
      expect(staleBecause(root)).toBeNull();

      const edited = new Date('2026-10-04T12:05:00Z');
      await utimes(join(root, 'src', 'recording', 'mask.ts'), edited, edited);
      expect(staleBecause(root)).toBe('src/ changed since dist/ was built');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
