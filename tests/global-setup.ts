/**
 * Runs once before the tests. The recording scripts (capture, compare,
 * sanitize) import the built daemon from dist/, and their tests run them, so
 * dist/ must match the source: on a fresh clone it does not exist yet, and
 * after an edit it is older than src/. Either way it is built here first
 * (the same `tsc` as `npm run build`), so `npx vitest run` and `npm test`
 * never test scripts against stale code.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The newest modification time (ms) of any .ts file under `dir`. */
function newestSource(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSource(path));
    } else if (entry.name.endsWith('.ts')) {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}

/** Why dist/ must be built, or null when it is current. `tsc` rewrites every output, so dist/index.js dates the build. */
export function staleBecause(root: string = ROOT): string | null {
  const built = join(root, 'dist', 'index.js');
  if (!existsSync(built)) { return 'dist/ has not been built'; }
  return newestSource(join(root, 'src')) > statSync(built).mtimeMs ? 'src/ changed since dist/ was built' : null;
}

export default function setup(): void {
  const why = staleBecause();
  if (why === null) { return; }
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  process.stdout.write(`${why}: building it (tsc) before the tests\n`);
  try {
    execFileSync(process.execPath, [tsc, '-p', ROOT], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    // tsc still writes dist/ when the source has type errors; the tests say what fails.
    const out = (e as { stdout?: Buffer }).stdout?.toString() ?? String(e);
    process.stderr.write(`tsc reported problems (npx tsc --noEmit -p . lists them):\n${out.slice(0, 4000)}\n`);
  }
}
