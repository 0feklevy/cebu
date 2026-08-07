/**
 * The rebuilt-package fixture, proven ON THE EMITTED BYTES.
 *
 * WHAT IS ACTUALLY UNDER TEST. gen-rebuilt-fixture.ts exists so client-web/e2e/rebuilt-packages.spec.ts
 * can run without a database or shared storage. That is only worth doing if the dump it produces is
 * genuinely production output — a hand-written imitation of a rebuilt package would let the browser
 * suite pass while the real transform was broken, which is strictly worse than the skip it replaced.
 *
 * So these tests assert the two things that make the fixture load-bearing:
 *
 *   1. IT IS THE REAL TRANSFORM. The emitted bridge is byte-identical to
 *      `wrapBridgeCombined(parseSectionEntries(stored))`, the emitted entry to
 *      `injectBridgeScriptTag(injectRafGate(stored), rel, hash)`, and every section body parses
 *      back out of the emitted bridge unchanged.
 *   2. IT IS SHAPED FOR ITS CONSUMER. The dump on disk is what the browser suite discovers: the
 *      suite's own (stricter) id regex finds every section, at least two packages are
 *      multi-section, and every entry's `?v=` names the bridge.js written beside it.
 *
 * The negative cases matter as much: `verifyDump` is shown FAILING on a corrupted dump, and the
 * overwrite guard is shown refusing a directory this generator did not create.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FIXTURE_MANIFEST,
  REBUILT_FIXTURE_SECTIONS,
  STALE_BRIDGE_HASH,
  SYNTHETIC_PACKAGES,
  buildRebuiltFixture,
  generateRebuiltFixture,
  legacyStoredBridge,
  storagePrefixOf,
  syntheticObjects,
  verifyDump,
} from '../gen-rebuilt-fixture.js';
import { CAPABILITIES } from '../prove-sim-rebuild.js';
import {
  computeBridgeHash,
  deriveEntryRelPath,
  injectBridgeScriptTag,
  injectRafGate,
  parseSectionEntries,
  wrapBridgeCombined,
} from '../../services/simulation/SimulationService.js';

const tmpDirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rebuilt-fixture-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const built = await buildRebuiltFixture();
const fileFor = (rel: string): string => {
  const f = built.files.find((x) => x.relPath === rel);
  if (!f) throw new Error(`the fixture emitted no ${rel} (emitted: ${built.files.map((x) => x.relPath).join(', ')})`);
  return f.contents;
};

describe('gen-rebuilt-fixture — the dump is produced by the REAL rebuild', () => {
  it('proves every synthetic package through the real pre-apply gate', () => {
    expect(built.problems).toEqual([]);
    expect(built.discovered).toBe(SYNTHETIC_PACKAGES.length);
    expect(built.proven).toBe(SYNTHETIC_PACKAGES.length);
  });

  it.each(SYNTHETIC_PACKAGES.map((p) => [p.name, p] as const))(
    '%s: the emitted bridge IS wrapBridgeCombined over the stored bodies',
    (_name, pkg) => {
      const prefix = storagePrefixOf(pkg);
      const stored = syntheticObjects().get(`${prefix}/bridge.js`)!;
      const emitted = fileFor(join(prefix, 'bridge.js'));
      // Not "looks like": the shipping transform applied to the stored bytes must reproduce the
      // dump exactly. Anything less and the browser suite is driving bytes nothing else produces.
      expect(emitted).toBe(wrapBridgeCombined(parseSectionEntries(stored)));
    },
  );

  it.each(SYNTHETIC_PACKAGES.map((p) => [p.name, p] as const))(
    '%s: the emitted bridge parses back to the SAME section bodies, byte for byte',
    (_name, pkg) => {
      const emitted = fileFor(join(storagePrefixOf(pkg), 'bridge.js'));
      const parsed = parseSectionEntries(emitted);
      expect([...parsed.keys()]).toEqual(Object.keys(pkg.sections));
      for (const [id, body] of Object.entries(pkg.sections)) {
        expect(parsed.get(id), `section ${id} did not survive the round trip`).toBe(body);
      }
    },
  );

  it('every round-tripped body is still compilable as a section function', () => {
    for (const pkg of SYNTHETIC_PACKAGES) {
      const parsed = parseSectionEntries(fileFor(join(storagePrefixOf(pkg), 'bridge.js')));
      for (const [id, body] of parsed) {
        // The browser calls each body as `function (params) { … }`. A body that survived the
        // string round trip but no longer parses would fail as a SCRIPT_ERROR three suites later.
        expect(() => new Function('params', body), `section ${id} does not compile`).not.toThrow();
      }
    }
  });

  it('the emitted entry IS the real gate + tag injection over the stored entry', () => {
    for (const pkg of SYNTHETIC_PACKAGES) {
      const prefix = storagePrefixOf(pkg);
      const stored = syntheticObjects().get(`${prefix}/${pkg.entryRel}`)!;
      const bridge = fileFor(join(prefix, 'bridge.js'));
      const depth = pkg.entryRel.split('/').length - 1;
      const rel = (depth > 0 ? '../'.repeat(depth) : './') + 'bridge.js';
      expect(fileFor(join(prefix, pkg.entryRel))).toBe(
        injectBridgeScriptTag(injectRafGate(stored), rel, computeBridgeHash(bridge)),
      );
    }
  });

  it('the stored packages are genuinely PRE-rebuild — the hardened protocol is gained, never present', () => {
    // `no capability gained` is a FAILURE in prove-sim-rebuild, so a fixture whose stored bytes
    // already looked hardened would make the proof reject its own input. Data-driven off the real
    // CAPABILITIES table so a new needle cannot silently stop being covered.
    for (const pkg of SYNTHETIC_PACKAGES) {
      const stored = syntheticObjects().get(`${storagePrefixOf(pkg)}/bridge.js`)!;
      const emitted = fileFor(join(storagePrefixOf(pkg), 'bridge.js'));
      for (const cap of CAPABILITIES) {
        expect(emitted.includes(cap.needle), `rebuilt bridge lacks ${cap.key}`).toBe(true);
        if (cap.key === 'ownPropGuard') continue;   // the old bridge already guarded prototype keys
        expect(stored.includes(cap.needle), `stored bridge already had ${cap.key}`).toBe(false);
      }
    }
  });

  it('exercises both deriveEntryRelPath branches — storage key AND legacy public URL', () => {
    const shapes = SYNTHETIC_PACKAGES.map((p) => {
      const prefix = storagePrefixOf(p);
      const entryFile = p.entryFile(prefix);
      expect(deriveEntryRelPath(entryFile, prefix)).toBe(p.entryRel);
      return entryFile.startsWith(prefix) ? 'key' : 'url';
    });
    // A fixture that only ever fed storage keys would leave the legacy-URL branch — the one every
    // pre-migration row still uses — unreached by the whole dump path.
    expect(new Set(shapes)).toEqual(new Set(['key', 'url']));
  });

  it('the nested package proves re-injection REPLACES a stale bridge tag rather than duplicating it', () => {
    const nested = SYNTHETIC_PACKAGES.find((p) => p.entryRel.includes('/'))!;
    const stored = syntheticObjects().get(`${storagePrefixOf(nested)}/${nested.entryRel}`)!;
    expect(stored).toContain(STALE_BRIDGE_HASH);
    const emitted = fileFor(join(storagePrefixOf(nested), nested.entryRel));
    expect(emitted).not.toContain(STALE_BRIDGE_HASH);
    expect(emitted.match(/SIM_BRIDGE_SCRIPT_START/g)).toHaveLength(1);
    expect(emitted.match(/sim-raf-gate v\d+ -->/g)).toHaveLength(1);
    // Depth-derived relative path: a './bridge.js' here would 404 one directory down.
    expect(emitted).toContain('src="../bridge.js?v=');
  });
});

describe('gen-rebuilt-fixture — the dump is shaped for rebuilt-packages.spec.ts', () => {
  const dir = tempDir();
  let result: Awaited<ReturnType<typeof generateRebuiltFixture>>;
  beforeAll(async () => { result = await generateRebuiltFixture(dir); });

  /**
   * The browser suite's discovery, replicated.
   *
   * Deliberate duplication: a Node test cannot import a Playwright spec, and this is the contract
   * that actually decides whether the browser gate has anything to assert. It is also STRICTER
   * than parseSectionEntries about the id character class ([0-9a-f-] only), which is exactly the
   * mismatch that would otherwise surface as a package discovered with zero sections and every
   * per-section assertion passing vacuously.
   */
  function discoverLikeSpec(root: string): { simId: string; entryRel: string; sections: string[] }[] {
    const out: { simId: string; entryRel: string; sections: string[] }[] = [];
    const simsRoot = join(root, 'simulations');
    for (const projectId of readdirSync(simsRoot)) {
      for (const simId of readdirSync(join(simsRoot, projectId))) {
        const localRoot = join(simsRoot, projectId, simId);
        const bridge = readFileSync(join(localRoot, 'bridge.js'), 'utf-8');
        const sections = [...new Set([...bridge.matchAll(/@@SIM_BRIDGE:([0-9a-f-]+)@@/gi)].map((m) => m[1]))];
        let entryRel = '';
        for (const sub of readdirSync(localRoot)) {
          const p = join(localRoot, sub);
          if (statSync(p).isDirectory() && existsSync(join(p, 'index.html'))) { entryRel = `${sub}/index.html`; break; }
          if (sub.endsWith('.html')) { entryRel = sub; break; }
        }
        out.push({ simId, entryRel, sections });
      }
    }
    return out;
  }

  it('writes a complete dump and reports no problems', () => {
    expect(result.problems).toEqual([]);
    expect(existsSync(join(dir, FIXTURE_MANIFEST))).toBe(true);
  });

  it('the browser suite discovers every package, its entry and all of its sections', () => {
    const found = discoverLikeSpec(dir);
    expect(found).toHaveLength(SYNTHETIC_PACKAGES.length);
    for (const pkg of SYNTHETIC_PACKAGES) {
      const f = found.find((x) => x.simId === pkg.simulationId);
      expect(f, `package ${pkg.name} was not discovered`).toBeDefined();
      expect(f!.entryRel).toBe(pkg.entryRel);
      expect(f!.sections).toEqual(Object.keys(pkg.sections));
    }
  });

  it('carries more than one multi-section package, so the A → B → A test can never be skipped', () => {
    const multi = discoverLikeSpec(dir).filter((p) => p.sections.length > 1);
    expect(multi.length).toBeGreaterThan(1);
  });

  it('references nothing external — the browser gate must run with no backend and no network', () => {
    for (const pkg of SYNTHETIC_PACKAGES) {
      const entry = readFileSync(join(dir, storagePrefixOf(pkg), pkg.entryRel), 'utf-8');
      // Only same-package relative sources are allowed: any absolute or protocol-relative URL
      // would be proxied to a live backend, reintroducing the dependency this fixture removes.
      const srcs = [...entry.matchAll(/\b(?:src|href)\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
      for (const s of srcs) expect(s, `${pkg.name} entry references ${s}`).toMatch(/^\.{1,2}\//);
    }
  });

  it('is idempotent — regenerating over its own marker rewrites the same bytes', async () => {
    const before = readFileSync(join(dir, storagePrefixOf(SYNTHETIC_PACKAGES[0]), 'bridge.js'), 'utf-8');
    const again = await generateRebuiltFixture(dir);
    expect(again.problems).toEqual([]);
    expect(readFileSync(join(dir, storagePrefixOf(SYNTHETIC_PACKAGES[0]), 'bridge.js'), 'utf-8')).toBe(before);
  });
});

describe('gen-rebuilt-fixture — the guards fail for real reasons', () => {
  it('verifyDump rejects an entry whose ?v= no longer names the bridge beside it', async () => {
    const dir = tempDir();
    const result = await generateRebuiltFixture(dir);
    expect(result.problems).toEqual([]);

    const pkg = SYNTHETIC_PACKAGES[0];
    const bridgePath = join(dir, storagePrefixOf(pkg), 'bridge.js');
    // Exactly what a half-finished write or a hand-edit leaves behind: bytes that still parse and
    // still carry every marker, but that the entry tag no longer describes.
    writeFileSync(bridgePath, readFileSync(bridgePath, 'utf-8') + '\n/* tampered */\n', 'utf-8');

    const expectedSections = Object.fromEntries(
      SYNTHETIC_PACKAGES.map((p) => [p.simulationId, Object.keys(p.sections)]),
    );
    const problems = verifyDump(dir, expectedSections);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('does not name the bridge.js written beside it');
  });

  it('verifyDump rejects a bridge whose sections the browser regex can no longer see', async () => {
    const dir = tempDir();
    await generateRebuiltFixture(dir);
    const pkg = SYNTHETIC_PACKAGES[0];
    const bridgePath = join(dir, storagePrefixOf(pkg), 'bridge.js');
    const mangled = readFileSync(bridgePath, 'utf-8').replace(/@@SIM_BRIDGE:/g, '@@SIM_BRIDGEX:');
    writeFileSync(bridgePath, mangled, 'utf-8');
    // The hash must stay honest so the ONLY problem reported is the invisible sections.
    const entryPath = join(dir, storagePrefixOf(pkg), pkg.entryRel);
    writeFileSync(
      entryPath,
      readFileSync(entryPath, 'utf-8').replace(/bridge\.js\?v=[a-z0-9]+/i, `bridge.js?v=${computeBridgeHash(mangled)}`),
      'utf-8',
    );

    const problems = verifyDump(dir, Object.fromEntries(
      SYNTHETIC_PACKAGES.map((p) => [p.simulationId, Object.keys(p.sections)]),
    ));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('browser discovery finds []');
  });

  it('refuses to overwrite a directory it did not create', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'simulations'), { recursive: true });
    writeFileSync(join(dir, 'simulations', 'someone-elses-dump.txt'), 'do not delete me', 'utf-8');
    await expect(generateRebuiltFixture(dir)).rejects.toThrow(/not empty and carries no rebuilt-fixture\.json marker/);
    // The guard is only worth having if it actually leaves the foreign files alone.
    expect(existsSync(join(dir, 'simulations', 'someone-elses-dump.txt'))).toBe(true);
  });
});

describe('gen-rebuilt-fixture — the section ids the browser suite can actually see', () => {
  it('every declared section id is hex-and-dash, and every package uses declared ids only', () => {
    const declared = new Set<string>(Object.values(REBUILT_FIXTURE_SECTIONS));
    for (const id of declared) expect(id).toMatch(/^[0-9a-f-]+$/);
    const used = SYNTHETIC_PACKAGES.flatMap((p) => Object.keys(p.sections));
    expect(new Set(used)).toEqual(declared);
    expect(used).toHaveLength(declared.size);   // no id shared between packages
  });

  it('the stored bridge is the pre-hardening envelope wrapped around REAL section markers', () => {
    const stored = legacyStoredBridge(new Map([[REBUILT_FIXTURE_SECTIONS.SOLO, '\nreturn null;']]));
    // The envelope must be old, and the markers must be production's — that combination is what
    // makes the rebuild in this fixture a real upgrade of a real package shape.
    expect(stored).toContain(`/* @@SIM_BRIDGE:${REBUILT_FIXTURE_SECTIONS.SOLO}@@ */`);
    expect(parseSectionEntries(stored).get(REBUILT_FIXTURE_SECTIONS.SOLO)).toBe('\nreturn null;');
  });
});
