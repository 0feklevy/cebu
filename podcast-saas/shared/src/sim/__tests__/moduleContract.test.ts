/**
 * The SHARED-SIDE packaging contract for src/sim/**.
 *
 * ── HOW THIS SUITE RELATES TO client-web/__tests__ ────────────────────────────────────────────
 * client-web already tests most of these modules' BEHAVIOUR, and does it well. Nothing in
 * shared/src/sim/__tests__ duplicates that work; this suite exists because client-web structurally
 * cannot cover two things:
 *
 *   1. Resolution. client-web reaches these modules as `shared/src/sim/x` — extensionless, through
 *      the package `exports` map, resolved by a bundler that will happily find `x.ts` for a
 *      specifier that names no extension at all. The backend reaches the SAME modules as compiled
 *      Node16 ESM out of `dist/`, where a relative import without an explicit `.js` is a runtime
 *      ERR_MODULE_NOT_FOUND. A dropped extension inside `shared` is therefore invisible to
 *      client-web's suite forever, and fatal on the server.
 *   2. Environment. client-web's vitest project is jsdom. This one is node, so the branches these
 *      modules take on the SERVER (real WebCrypto, no `document`, no DOM globals) are the branches
 *      under test here.
 *
 * Where a behaviour is already well covered in client-web, the file here says so and tests the
 * cases that suite does not reach rather than restating it. The zero-coverage modules — judgeLeak,
 * parsePosterVariants, variantKeyFor/variantParamOf, POSTER_SIZES, DEFAULT_PLATEAUS,
 * posterRootPrefix — are tested here in full, because here is the only place they are tested at all.
 *
 * ── WHY THIS PARTICULAR FILE IS A TEST AND NOT A LINT RULE ────────────────────────────────────
 * `tsc --noEmit` under `moduleResolution: Node16` already rejects an extensionless relative import,
 * so this file is not the only guard. It is here because the failure it prevents is silent in every
 * OTHER runner: vitest/vite resolve `./sha256` just fine, so a suite that merely imports the modules
 * proves nothing about the specifier shape the backend needs. Reading the source text is the only
 * way a RUNTIME test can assert it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIM_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '');

const simSources = readdirSync(SIM_DIR)
  .filter((f) => f.endsWith('.ts'))
  .sort();

/** `from './x'`, `from "./x"` — the specifier of every static import/export in a module. */
const SPECIFIER_RE = /\bfrom\s+['"]([^'"]+)['"]/g;

/**
 * Block comments are removed before scanning. These files carry long design rationales, and the
 * word "from" followed by a quoted phrase occurs in that prose — matching it produced a specifier
 * that was really a sentence fragment. Line comments are dropped only when the line is entirely a
 * comment, because a naive `//` strip would also cut the `'http://x'` URL base in simIdentity.ts.
 */
function specifiersOf(file: string): string[] {
  const text = readFileSync(join(SIM_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  const out: string[] = [];
  for (const m of text.matchAll(SPECIFIER_RE)) out.push(m[1]);
  return out;
}

describe('src/sim is a Node16 ESM module graph', () => {
  it('has sources to check at all — an empty sweep must not read as a pass', () => {
    expect(simSources.length).toBeGreaterThanOrEqual(8);
  });

  it('gives every relative import an explicit .js extension', () => {
    const offenders: string[] = [];
    for (const file of simSources) {
      for (const spec of specifiersOf(file)) {
        if (!spec.startsWith('.')) continue;
        if (!spec.endsWith('.js')) offenders.push(`${file} → ${spec}`);
      }
    }
    // A bundler resolves './sha256' to './sha256.ts'; Node, loading the emitted dist/, does not.
    expect(offenders).toEqual([]);
  });

  it('never imports a bare .ts specifier, which Node16 refuses outright', () => {
    const offenders: string[] = [];
    for (const file of simSources) {
      for (const spec of specifiersOf(file)) {
        if (spec.endsWith('.ts')) offenders.push(`${file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps src/sim free of runtime dependencies on any workspace or DOM-only package', () => {
    // These modules are imported by the backend (node), the player (browser) and the generated
    // child bridge (neither has a package manager). A third-party import here would have to be
    // installable in all three, so the rule is simply: none.
    const external: string[] = [];
    for (const file of simSources) {
      for (const spec of specifiersOf(file)) {
        if (spec.startsWith('.') || spec.startsWith('node:')) continue;
        external.push(`${file} → ${spec}`);
      }
    }
    expect(external).toEqual([]);
  });
});

describe('the environment these tests run in is the SERVER environment', () => {
  it('has no DOM — so any accidental DOM dependency in src/sim fails here rather than in production', () => {
    expect((globalThis as { document?: unknown }).document).toBeUndefined();
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
  });

  it('has real WebCrypto, which is the branch simIdentity takes on the server', () => {
    expect(typeof globalThis.crypto?.getRandomValues).toBe('function');
  });
});
