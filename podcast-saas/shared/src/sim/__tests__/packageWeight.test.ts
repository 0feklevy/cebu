/**
 * Package weight analysis (Priority 8.11).
 *
 * This is the only Priority 8 lever that REMOVES work rather than rescheduling it, and every number
 * comes from the manifest — which records the size and type of the exact stored bytes and is
 * verified by read-back at publication. So a before/after comparison compares two measurements, not
 * two guesses, which is what makes an optimisation claim checkable.
 */

import { describe, it, expect } from 'vitest';
import { categorize, analyzeWeight, compareWeight, LIMITS } from '../packageWeight.js';
import { SIM_MANIFEST_VERSION, type SimManifest, type SimManifestFile } from '../simManifest.js';

const file = (over: Partial<SimManifestFile>): SimManifestFile => ({
  path: 'package/a.js', role: 'asset', hash: 'a'.repeat(64), bytes: 100,
  contentType: 'application/javascript', cacheControl: 'x', ...over,
});

const manifest = (files: SimManifestFile[], ext: string[] = []): SimManifest => ({
  manifestVersion: SIM_MANIFEST_VERSION, simulationId: 's', projectId: 'p',
  revisionId: 'r', revisionNumber: 1, bridgeProtocolVersion: 3, runtimeProtocolVersion: 3,
  entry: 'package/index.html', runtime: [], files,
  variants: [{ variantKey: 'main', configHashes: [] }], posters: [], qualityProfiles: ['high'],
  externalDependencies: ext, generatedFrom: {},
  canary: { classification: null, ranAt: null, engine: null },
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: null,
});

describe('categorize', () => {
  it('prefers the stored content type — it is what a browser acts on', () => {
    expect(categorize(file({ path: 'x.bin', contentType: 'image/png' }))).toBe('image');
    expect(categorize(file({ path: 'x.bin', contentType: 'font/woff2' }))).toBe('font');
    expect(categorize(file({ path: 'x.bin', contentType: 'video/mp4' }))).toBe('media');
  });

  it('falls back to the extension when the type is unhelpful', () => {
    expect(categorize(file({ path: 'a/b.png', contentType: 'application/octet-stream' }))).toBe('image');
    expect(categorize(file({ path: 'a/b.woff2', contentType: 'application/octet-stream' }))).toBe('font');
    expect(categorize(file({ path: 'a/b.css', contentType: 'application/octet-stream' }))).toBe('style');
  });

  it('lets role outrank both — entry and runtime are ours, not the customer bytes', () => {
    expect(categorize(file({ role: 'entry', contentType: 'text/html; charset=utf-8' }))).toBe('entry');
    expect(categorize(file({ role: 'runtime', contentType: 'application/javascript' }))).toBe('runtime');
  });

  it('falls back to other rather than guessing', () => {
    expect(categorize(file({ path: 'a/b.xyz', contentType: 'application/octet-stream' }))).toBe('other');
  });
});

describe('analyzeWeight', () => {
  it('totals bytes and files by category', () => {
    const r = analyzeWeight(manifest([
      file({ path: 'package/index.html', role: 'entry', bytes: 1000, contentType: 'text/html; charset=utf-8' }),
      file({ path: 'runtime/bridge.js', role: 'runtime', bytes: 2000 }),
      file({ path: 'package/a.png', bytes: 3000, contentType: 'image/png', hash: 'b'.repeat(64) }),
    ]));
    expect(r.totalBytes).toBe(6000);
    expect(r.fileCount).toBe(3);
    expect(r.byCategory.image.bytes).toBe(3000);
    expect(r.byCategory.entry.count).toBe(1);
  });

  it('ranks the largest files first — a long tail of small files is rarely the problem', () => {
    const r = analyzeWeight(manifest([
      file({ path: 'a', bytes: 10, hash: 'a'.repeat(64) }),
      file({ path: 'b', bytes: 900, hash: 'b'.repeat(64) }),
      file({ path: 'c', bytes: 50, hash: 'c'.repeat(64) }),
    ]));
    expect(r.largest.map((e) => e.path)).toEqual(['b', 'c', 'a']);
  });

  it('breaks size ties deterministically, so two runs agree', () => {
    const r = analyzeWeight(manifest([
      file({ path: 'z', bytes: 10, hash: 'a'.repeat(64) }),
      file({ path: 'a', bytes: 10, hash: 'b'.repeat(64) }),
    ]));
    expect(r.largest.map((e) => e.path)).toEqual(['a', 'z']);
  });

  it('flags an oversized package with the recoverable amount', () => {
    const r = analyzeWeight(manifest([file({ bytes: LIMITS.packageBytes + 1000 })]));
    const f = r.findings.find((x) => x.code === 'oversized-package');
    expect(f).toBeDefined();
    expect(f!.recoverableBytes).toBe(1000);
  });

  it('flags an oversized image but not an oversized script', () => {
    // A big bundle is a different problem with a different fix; conflating them makes the report
    // less actionable, not more.
    const r = analyzeWeight(manifest([
      file({ path: 'p/big.png', bytes: LIMITS.imageBytes + 1, contentType: 'image/png', hash: 'b'.repeat(64) }),
      file({ path: 'p/big.js', bytes: LIMITS.imageBytes + 1, hash: 'c'.repeat(64) }),
    ]));
    expect(r.findings.filter((x) => x.code === 'oversized-image')).toHaveLength(1);
  });

  it('detects duplicate bytes by HASH, not by filename', () => {
    // The manifest already hashes the final stored bytes, so this is an observation rather than a
    // heuristic about names.
    const r = analyzeWeight(manifest([
      file({ path: 'p/logo.png', bytes: 5000, hash: 'd'.repeat(64), contentType: 'image/png' }),
      file({ path: 'p/assets/brand.png', bytes: 5000, hash: 'd'.repeat(64), contentType: 'image/png' }),
    ]));
    const dup = r.findings.find((x) => x.code === 'duplicate-bytes');
    expect(dup).toBeDefined();
    // Only the extra copy is recoverable — one has to remain.
    expect(dup!.recoverableBytes).toBe(5000);
  });

  it('does not flag a single copy as duplicated', () => {
    const r = analyzeWeight(manifest([file({ path: 'a', hash: 'a'.repeat(64) })]));
    expect(r.findings.some((x) => x.code === 'duplicate-bytes')).toBe(false);
  });

  it('flags a high file count — each file is a request', () => {
    const files = [...Array(LIMITS.fileCount + 1)].map((_, i) =>
      file({ path: `p/f${i}.js`, bytes: 1, hash: String(i).padStart(64, '0') }));
    expect(analyzeWeight(manifest(files)).findings.some((x) => x.code === 'many-files')).toBe(true);
  });

  it('records external dependencies without fetching them', () => {
    const r = analyzeWeight(manifest([file({})], ['https://cdn.example.com/three.js']));
    const f = r.findings.find((x) => x.code === 'external-dependency');
    expect(f?.detail).toContain('three.js');
  });

  it('is advisory — a heavy package still produces a report, never a refusal', () => {
    // These are the customer's own files; refusing to publish would fail real content over a
    // number this module chose.
    const r = analyzeWeight(manifest([file({ bytes: 100 * 1024 * 1024 })]));
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.totalBytes).toBe(100 * 1024 * 1024);
  });

  it('handles an empty package without inventing numbers', () => {
    const r = analyzeWeight(manifest([]));
    expect(r.totalBytes).toBe(0);
    expect(r.largest).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it('ignores a nonsensical size rather than propagating it', () => {
    const r = analyzeWeight(manifest([
      file({ path: 'a', bytes: -5, hash: 'a'.repeat(64) }),
      file({ path: 'b', bytes: NaN, hash: 'b'.repeat(64) }),
      file({ path: 'c', bytes: 100, hash: 'c'.repeat(64) }),
    ]));
    expect(r.totalBytes).toBe(100);
  });
});

describe('compareWeight — the checkable claim', () => {
  const rep = (bytes: number, files: number) =>
    analyzeWeight(manifest([...Array(files)].map((_, i) =>
      file({ path: `p/f${i}`, bytes: Math.floor(bytes / files), hash: String(i).padStart(64, '0') }))));

  it('reports a saving as a NEGATIVE delta, the way an engineer reads it', () => {
    const c = compareWeight(rep(1000, 1), rep(600, 1));
    expect(c.deltaBytes).toBe(-400);
    expect(c.improved).toBe(true);
    expect(c.percentChange).toBe(-40);
  });

  it('reports a regression honestly', () => {
    const c = compareWeight(rep(1000, 1), rep(1500, 1));
    expect(c.deltaBytes).toBe(500);
    expect(c.improved).toBe(false);
  });

  it('reports no change as no change', () => {
    const c = compareWeight(rep(1000, 1), rep(1000, 1));
    expect(c.deltaBytes).toBe(0);
    expect(c.improved).toBe(false);
  });

  it('does not report a spectacular improvement for a package that was empty', () => {
    // Infinity or NaN here would render as a triumph in any report that formats percentages.
    const c = compareWeight(analyzeWeight(manifest([])), rep(1000, 1));
    expect(Number.isFinite(c.percentChange)).toBe(true);
    expect(c.percentChange).toBe(0);
  });

  it('counts files as well as bytes', () => {
    expect(compareWeight(rep(1000, 4), rep(1000, 2)).deltaFiles).toBe(-2);
  });
});
