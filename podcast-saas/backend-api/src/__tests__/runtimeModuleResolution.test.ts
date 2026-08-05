/**
 * The backend must be able to BOOT from its emitted JavaScript.
 *
 * WHY THIS TEST EXISTS
 * Nothing else in the pipeline executes `dist/`. Vitest transpiles TypeScript, so a source file can
 * import a specifier that only a bundler could resolve and every test still passes; `tsc --noEmit`
 * is satisfied by the package's `types` condition, which may point somewhere entirely different
 * from its `import` condition. The gap between those two is invisible to both.
 *
 * It cost a real release blocker to find: ten non-test files imported `shared/src/sim/*`, whose
 * exports map resolves to raw `.ts`. tsc never rewrites specifiers, so the emitted
 * `dist/services/buildPlayerConfig.js` kept the specifier verbatim and `node dist/server.js` died
 * with ERR_MODULE_NOT_FOUND — the shared sources import `./sha256.js`, and no `.js` exists under
 * `shared/src`. Node's ESM resolver does not remap `.js` to `.ts`; that is a bundler convention.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf-8' });
  return out.split('\n')
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.includes('__tests__') && !f.endsWith('.test.ts'));
}

describe('runtime module resolution', () => {
  it('no production file imports a bundler-only shared subpath', () => {
    // `shared/src/*` maps to .ts. Correct for the Next apps, which resolve through webpack with
    // transpilePackages; wrong for the backend, which runs plain node against dist.
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const body = readFileSync(join(ROOT, f), 'utf-8');
      for (const m of body.matchAll(/from '(shared\/src\/[^']+)'/g)) offenders.push(`${f}: ${m[1]}`);
    }
    expect(
      offenders.join('\n'),
      'these resolve to raw TypeScript at runtime — use shared/sim/* (mapped to dist) instead',
    ).toBe('');
  });

  it('every shared specifier a production file uses actually resolves in node', async () => {
    // The positive control. The rule above is a proxy; this is the property itself.
    const specs = new Set<string>();
    for (const f of sourceFiles()) {
      const body = readFileSync(join(ROOT, f), 'utf-8');
      for (const m of body.matchAll(/from '(shared(?:\/[^']+)?)'/g)) specs.add(m[1]!);
    }
    expect(specs.size, 'no shared imports found — this test would be vacuous').toBeGreaterThan(0);

    const failures: string[] = [];
    for (const spec of specs) {
      try { await import(/* @vite-ignore */ spec); }
      catch (err) { failures.push(`${spec}: ${(err as { code?: string }).code ?? String(err).slice(0, 80)}`); }
    }
    expect(failures.join('\n'), 'node cannot resolve these at runtime').toBe('');
  });
});
