/**
 * That the synthetic seeder CALLS its storage guard — not merely that the guard works.
 *
 * `seedStorageGuard.test.ts` pins `assertLocalStorageOnly`'s accept/reject behaviour, which is a
 * different claim from "the seeder is guarded": deleting the single call in
 * `seed-sim-pool-synthetic.ts` left that suite, and the entire repo, green while the seeder wrote
 * synthetic packages, HLS ladders and posters into whatever `STORAGE_BACKEND` resolved to.
 *
 * The seeder runs `main()` at import time (it is a script, not a module), so it cannot be imported
 * to observe the call. Its SOURCE is read instead — the same technique `trustProxyWiring.test.ts`
 * uses to prove `TRUST_PROXY_HOPS` reaches Fastify. Comments are stripped first, so a mention of
 * the guard in prose cannot satisfy the assertion.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = join(__dirname, '..', 'scripts');

/** Source with block and line comments removed, so prose can never satisfy an assertion. */
const codeOf = (file: string): string =>
  readFileSync(join(SCRIPTS, file), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('seed-sim-pool-synthetic.ts is actually guarded', () => {
  const code = codeOf('seed-sim-pool-synthetic.ts');

  it('imports the shared guard', () => {
    expect(code, 'the seeder no longer imports assertLocalStorageOnly')
      .toMatch(/import\s*\{[^}]*assertLocalStorageOnly[^}]*\}\s*from\s*'\.\/seedGuards\.js'/);
  });

  it('CALLS the guard on the adapter it is about to write through', () => {
    expect(code, 'the guard is imported but never called — the seeder is unguarded')
      .toMatch(/assertLocalStorageOnly\(\s*storage\s*\)/);
  });

  it('calls it BEFORE any storage write or delete', () => {
    const guardAt = code.indexOf('assertLocalStorageOnly(');
    expect(guardAt, 'no guard call at all').toBeGreaterThan(-1);
    for (const write of ['uploadFile(', 'deleteFile(', 'deleteWithPrefix(']) {
      const at = code.indexOf(write);
      if (at === -1) continue;
      expect(at, `${write} happens before the storage guard runs`).toBeGreaterThan(guardAt);
    }
  });
});

describe('the production-data seeder cannot load its data modules before its gate', () => {
  // Static `import` declarations are HOISTED and evaluated before any statement of the module
  // body — including the refusal — so a static db import would construct the pool even on a
  // refused run. The gate is only worth what the module graph does before it.
  const code = codeOf('seed-sim-pool-from-production.DO-NOT-USE-IN-E2E.ts');

  it('gates on the explicit opt-in and exits non-zero', () => {
    expect(code).toMatch(/ALLOW_PRODUCTION_DATA_SEEDER/);
    expect(code).toMatch(/process\.exit\(2\)/);
  });

  it('has NO hoisted import of the db, schema or storage', () => {
    const hoisted = code.match(/^\s*import\s+(?!type\b)[^;]*from\s*'[^']*'/gm) ?? [];
    const dataImports = hoisted.filter((l) =>
      /db\/index|db\/schema|drizzle-orm|getStorageAdapter/.test(l));
    expect(dataImports, `hoisted data imports run before the gate: ${dataImports.join(' | ')}`)
      .toEqual([]);
  });

  it('loads them dynamically instead, so a refused run touches nothing', () => {
    expect(code).toMatch(/await import\(\s*'\.\.\/db\/index\.js'\s*\)/);
  });
});
