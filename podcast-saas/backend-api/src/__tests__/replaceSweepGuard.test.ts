/**
 * That the replace sweep CONSULTS the system-owned predicate — not merely that the predicate works.
 *
 * `shared/src/__tests__/systemOwnedPaths.test.ts` pins `isSystemOwnedKey` itself. That is a
 * different claim from "revisions survive a replace", and a mutation proved the gap: deleting
 * `isSystemOwnedKey(k, prefix) ||` from `isGeneratedKey` in `SimulationService` left the shared
 * suite — and the whole repo — green, while `processReplace` went back to deleting every published
 * revision's bytes and every captured poster.
 *
 * `SimulationService` cannot be instantiated here (storage adapter, LLM client, live db) and
 * `processReplace` is a private method behind an upload pipeline, so the source is read instead,
 * with comments stripped so prose cannot satisfy an assertion — the same technique
 * `trustProxyWiring.test.ts` uses for the proxy hop count.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(
  join(__dirname, '..', 'services', 'simulation', 'SimulationService.ts'), 'utf-8',
)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the replace sweep protects system-owned subtrees', () => {
  it('imports the shared predicate rather than re-deriving the rule', () => {
    expect(SRC, 'SimulationService no longer imports the system-owned predicates')
      .toMatch(/import\s*\{[^}]*isSystemOwnedKey[^}]*\}\s*from\s*'shared\/sim\/simRevision'/);
  });

  // THE REGRESSION. This is the mutation that survived until this test existed.
  it('the stale-delete filter CONSULTS isSystemOwnedKey', () => {
    const m = SRC.match(/const\s+isGeneratedKey\s*=\s*\(k:\s*string\):\s*boolean\s*=>[\s\S]*?;/);
    expect(m, 'could not find the isGeneratedKey predicate').not.toBeNull();
    expect(m![0],
      'isGeneratedKey no longer consults isSystemOwnedKey — an ordinary "replace simulation" now '
      + 'deletes every published revision and every captured poster, while the sim_revisions rows '
      + 'survive and still activate onto a prefix with no bytes')
      .toMatch(/isSystemOwnedKey\(\s*k\s*,\s*prefix\s*\)/);
  });

  it('the upload path REFUSES a bundle entry aimed at a system-owned subtree', () => {
    const m = SRC.match(/function\s+normalizeSimulationPath\([\s\S]*?\n\}/);
    expect(m, 'could not find normalizeSimulationPath').not.toBeNull();
    expect(m![0],
      'a bundle can once again write into revisions/ or posters/ — revision ids are public and '
      + 'revision bytes are served immutable for a year')
      .toMatch(/isSystemOwnedRelPath\(/);
  });
});
