/**
 * Manifest canonicalisation, validation and path normalisation (Priority 7.3).
 *
 * The collision tests below are the point of this file. Each one constructs two manifests that are
 * genuinely DIFFERENT and asserts their hashes differ — the failure mode being guarded is not a
 * crash but a silent agreement, where the pipeline reports "nothing changed" across a real change.
 */

import { describe, it, expect } from 'vitest';
import {
  SIM_MANIFEST_VERSION,
  normalizeManifestPath,
  caseFoldKey,
  validateManifest,
  manifestIsValid,
  canonicalizeManifest,
  computeManifestHash,
  type SimManifest,
  type SimManifestFile,
} from '../simManifest.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HTML_CT = 'text/html; charset=utf-8';
const JS_CT = 'application/javascript';
const IMMUTABLE = 'public, max-age=31536000, immutable';

function file(over: Partial<SimManifestFile> = {}): SimManifestFile {
  return {
    path: 'index.html', role: 'entry', hash: HASH_A, bytes: 10,
    contentType: HTML_CT, cacheControl: IMMUTABLE, ...over,
  };
}

function manifest(over: Partial<SimManifest> = {}): SimManifest {
  return {
    manifestVersion: SIM_MANIFEST_VERSION,
    simulationId: 'sim-1', projectId: 'proj-1', revisionId: 'rev-1', revisionNumber: 1,
    bridgeProtocolVersion: 3, runtimeProtocolVersion: 3,
    entry: 'index.html',
    runtime: ['runtime/bridge.js'],
    files: [
      file(),
      file({ path: 'runtime/bridge.js', role: 'runtime', hash: HASH_B, contentType: JS_CT }),
    ],
    variants: [{ variantKey: 'main', configHashes: ['c1'] }],
    posters: [],
    qualityProfiles: ['high'],
    externalDependencies: [],
    generatedFrom: {},
    canary: { classification: null, ranAt: null, engine: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: null,
    ...over,
  };
}

// ── Path normalisation ──────────────────────────────────────────────────────────────────────────

describe('normalizeManifestPath', () => {
  it('strips leading slashes but keeps the rest verbatim', () => {
    expect(normalizeManifestPath('/a/b.js')).toBe('a/b.js');
    expect(normalizeManifestPath('a/b.js')).toBe('a/b.js');
  });

  it('rejects rather than repairs traversal', () => {
    // Repairing would store the object somewhere the author did not intend, and report success.
    expect(normalizeManifestPath('../escape.js')).toBeNull();
    expect(normalizeManifestPath('a/../../escape.js')).toBeNull();
    expect(normalizeManifestPath('a/./b.js')).toBeNull();
  });

  it('rejects NUL — which is what makes it usable as the canonical delimiter', () => {
    expect(normalizeManifestPath('a' + '\u0000' + 'b.js')).toBeNull();
  });

  it('rejects backslashes, empty segments and the empty path', () => {
    expect(normalizeManifestPath('a' + '\\' + 'b.js')).toBeNull();
    expect(normalizeManifestPath('a//b.js')).toBeNull();
    expect(normalizeManifestPath('a/b/')).toBeNull();
    expect(normalizeManifestPath('')).toBeNull();
    expect(normalizeManifestPath('/')).toBeNull();
  });

  it('caseFoldKey is locale-independent', () => {
    // toLocaleLowerCase would map I to a dotless i under a Turkish locale; toLowerCase does not.
    expect(caseFoldKey('INDEX.HTML')).toBe('index.html');
    expect(caseFoldKey('I')).toBe('i');
  });
});

// ── Canonical form: collisions ──────────────────────────────────────────────────────────────────

describe('canonicalizeManifest — separator ambiguity', () => {
  it('does not confuse a contentType/cacheControl boundary (space separator)', () => {
    // With a space separator both flatten to "... a b c".
    const x = manifest({ files: [file({ contentType: 'a b', cacheControl: 'c' })] });
    const y = manifest({ files: [file({ contentType: 'a', cacheControl: 'b c' })] });
    expect(computeManifestHash(x)).not.toBe(computeManifestHash(y));
  });

  it('does not confuse a record boundary when a path contains the record separator', () => {
    // The regression that motivated RS: records were joined with "|", and BOTH cacheControl and
    // path may contain one, so the joined token was ambiguous.
    const x = manifest({
      files: [
        file({ path: 'a.html', cacheControl: 'no-store|' }),
        file({ path: 'b.js', role: 'asset', hash: HASH_B, contentType: JS_CT }),
      ],
      entry: 'a.html', runtime: [],
    });
    const y = manifest({
      files: [
        file({ path: 'a.html', cacheControl: 'no-store' }),
        file({ path: '|b.js', role: 'asset', hash: HASH_B, contentType: JS_CT }),
      ],
      entry: 'a.html', runtime: [],
    });
    expect(computeManifestHash(x)).not.toBe(computeManifestHash(y));
  });

  it('does not confuse externalDependencies whose URLs contain commas', () => {
    const x = manifest({ externalDependencies: ['https://h/a?x=1,2', 'https://h/b'] });
    const y = manifest({ externalDependencies: ['https://h/a?x=1', '2,https://h/b'] });
    expect(computeManifestHash(x)).not.toBe(computeManifestHash(y));
  });

  it('distinguishes posters differing only in an identity axis', () => {
    // identity is opaque at this layer, so the axes must be spelled out.
    const base = { identity: 'p1', variantKey: 'main', configHash: 'c1', paths: ['posters/p1/a.webp'] };
    const x = manifest({ posters: [{ ...base, aspectProfile: 'wide', qualityProfile: 'high' } as never] });
    const y = manifest({ posters: [{ ...base, aspectProfile: 'tall', qualityProfile: 'high' } as never] });
    expect(computeManifestHash(x)).not.toBe(computeManifestHash(y));
  });
});

describe('canonicalizeManifest — stability', () => {
  it('is independent of file order', () => {
    const m = manifest();
    const reordered = manifest({ files: [...m.files].reverse() });
    expect(canonicalizeManifest(m)).toBe(canonicalizeManifest(reordered));
  });

  it('is independent of createdAt and createdBy', () => {
    // Otherwise a no-op republish is indistinguishable from a real change.
    const a = manifest({ createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'alice' });
    const b = manifest({ createdAt: '2027-09-09T09:09:09.000Z', createdBy: 'bob' });
    expect(computeManifestHash(a)).toBe(computeManifestHash(b));
  });

  it('changes when a served byte-hash changes', () => {
    const a = manifest();
    const b = manifest({ files: [file({ hash: HASH_B }), a.files[1]!] });
    expect(computeManifestHash(a)).not.toBe(computeManifestHash(b));
  });

  it('changes when only cacheControl changes', () => {
    // The entry HTML cannot be immutable while the boot snippet is injected at serve time, so this
    // field really does move — and the hash has to notice.
    const a = manifest();
    const b = manifest({ files: [file({ cacheControl: 'no-store' }), a.files[1]!] });
    expect(computeManifestHash(a)).not.toBe(computeManifestHash(b));
  });

  it('produces a 64-char lowercase hex digest', () => {
    expect(computeManifestHash(manifest())).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────────────────────────

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateManifest(manifest())).toEqual([]);
    expect(manifestIsValid(manifest())).toBe(true);
  });

  it('refuses an unknown manifest version without reporting anything else', () => {
    // Nothing below can be trusted about a shape we do not know.
    const problems = validateManifest(manifest({ manifestVersion: 99 as never, files: [] }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.code).toBe('unknown-manifest-version');
  });

  it('reports every problem rather than the first', () => {
    const problems = validateManifest(manifest({
      files: [file({ hash: 'short' }), file({ path: 'x.js', role: 'asset', bytes: -1, contentType: JS_CT })],
    }));
    expect(problems.length).toBeGreaterThan(1);
    expect(problems.map((p) => p.code)).toContain('bad-hash');
    expect(problems.map((p) => p.code)).toContain('bad-size');
  });

  it('flags a case collision', () => {
    const problems = validateManifest(manifest({
      files: [file(), file({ path: 'INDEX.html', role: 'asset', hash: HASH_B })],
    }));
    expect(problems.map((p) => p.code)).toContain('case-collision');
  });

  it('flags a duplicate path', () => {
    const problems = validateManifest(manifest({ files: [file(), file()] }));
    expect(problems.map((p) => p.code)).toContain('duplicate-path');
  });

  it('flags an entry that is not in files[]', () => {
    const problems = validateManifest(manifest({ entry: 'missing.html' }));
    expect(problems.map((p) => p.code)).toContain('missing-entry');
  });

  it('flags a runtime file that is not in files[]', () => {
    const problems = validateManifest(manifest({ runtime: ['runtime/ghost.js'] }));
    expect(problems.map((p) => p.code)).toContain('missing-runtime-file');
  });

  it('flags a content type that disagrees with the extension', () => {
    const m = manifest();
    const problems = validateManifest(manifest({
      files: [file({ contentType: 'text/plain' }), m.files[1]!],
    }));
    expect(problems.map((p) => p.code)).toContain('content-type-mismatch');
  });

  it('flags a referenced asset that is absent from files[]', () => {
    const problems = validateManifest(manifest(), new Set(['assets/ghost.png']));
    expect(problems.map((p) => p.code)).toContain('missing-asset-reference');
  });

  it('skips reference checks when the caller supplies no references', () => {
    // A caller that cannot extract references must not be told its package is broken.
    expect(validateManifest(manifest(), new Set())).toEqual([]);
  });

  it('flags a poster path that is absent from files[]', () => {
    const problems = validateManifest(manifest({
      posters: [{
        identity: 'p1', variantKey: 'main', configHash: 'c1',
        aspectProfile: 'wide', qualityProfile: 'high', paths: ['posters/p1/ghost.webp'],
      } as never],
    }));
    expect(problems.map((p) => p.code)).toContain('poster-path-missing');
  });

  it('flags a package with no variants', () => {
    expect(validateManifest(manifest({ variants: [] })).map((p) => p.code)).toContain('no-variants');
  });

  it('flags a duplicate variant key', () => {
    const problems = validateManifest(manifest({
      variants: [{ variantKey: 'main', configHashes: [] }, { variantKey: 'main', configHashes: [] }],
    }));
    expect(problems.map((p) => p.code)).toContain('duplicate-variant');
  });

  it('flags a non-normalized path instead of silently normalizing it', () => {
    const problems = validateManifest(manifest({ files: [file({ path: '/index.html' })] }));
    expect(problems.map((p) => p.code)).toContain('bad-path');
  });
});
