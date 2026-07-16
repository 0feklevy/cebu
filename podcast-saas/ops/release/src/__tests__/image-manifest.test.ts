import { describe, expect, it } from 'vitest';
import { RELEASE_CONFIG } from '../config.js';
import { buildManifest, compareDigests, parseManifest, pinnedRef, validateManifest } from '../image-manifest.js';

const D1 = `sha256:${'a'.repeat(64)}`;
const D2 = `sha256:${'b'.repeat(64)}`;
const D3 = `sha256:${'c'.repeat(64)}`;

const manifest = buildManifest({
  version: 'v0.1.2',
  gitSha: '255d06fd9b195dde0a0c2f97f8adcf0d66c2733e',
  images: [
    { service: 'backend', repository: 'ghcr.io/0feklevy/cebu/backend', tag: 'v0.1.2', digest: D1 },
    { service: 'client-web', repository: 'ghcr.io/0feklevy/cebu/client-web', tag: 'v0.1.2', digest: D2 },
    { service: 'admin-web', repository: 'ghcr.io/0feklevy/cebu/admin-web', tag: 'v0.1.2', digest: D3 },
  ],
});

describe('image manifest validation', () => {
  it('accepts a complete, digest-pinned manifest', () => {
    expect(validateManifest(manifest, RELEASE_CONFIG)).toEqual([]);
  });

  it('rejects malformed digests', () => {
    const bad = { ...manifest, images: [{ ...manifest.images[0], digest: 'sha256:short' }, ...manifest.images.slice(1)] };
    expect(validateManifest(bad, RELEASE_CONFIG).some((f) => f.id === 'images.bad-digest')).toBe(true);
  });

  it('rejects floating latest tags', () => {
    const bad = { ...manifest, images: [{ ...manifest.images[0], tag: 'latest' }, ...manifest.images.slice(1)] };
    expect(validateManifest(bad, RELEASE_CONFIG).some((f) => f.id === 'images.floating-tag')).toBe(true);
  });

  it('rejects repositories outside the trusted namespace', () => {
    const bad = { ...manifest, images: [{ ...manifest.images[0], repository: 'docker.io/evil/backend' }, ...manifest.images.slice(1)] };
    expect(validateManifest(bad, RELEASE_CONFIG).some((f) => f.id === 'images.foreign-repository')).toBe(true);
  });

  it('requires every service', () => {
    const bad = { ...manifest, images: manifest.images.slice(0, 2) };
    expect(validateManifest(bad, RELEASE_CONFIG).some((f) => f.id === 'images.missing-service')).toBe(true);
  });
});

describe('digest comparison (VM verification)', () => {
  it('passes when the host pulled exactly the manifest digests', () => {
    expect(compareDigests(manifest, { backend: D1, 'client-web': D2, 'admin-web': D3 })).toEqual([]);
  });

  it('flags digest mismatches as CRITICAL', () => {
    const findings = compareDigests(manifest, { backend: D2, 'client-web': D2, 'admin-web': D3 });
    expect(findings.some((f) => f.id === 'images.digest-mismatch' && f.severity === 'CRITICAL')).toBe(true);
  });

  it('flags missing images', () => {
    const findings = compareDigests(manifest, { backend: D1, 'client-web': D2 });
    expect(findings.some((f) => f.id === 'images.not-pulled')).toBe(true);
  });
});

describe('serialization', () => {
  it('round-trips and pins refs by digest', () => {
    const parsed = parseManifest(JSON.stringify(manifest));
    expect(parsed.images).toHaveLength(3);
    expect(pinnedRef(parsed.images[0])).toBe(`ghcr.io/0feklevy/cebu/backend@${D1}`);
    expect(() => parseManifest('{"schema":"bogus"}')).toThrow(/schema/);
  });
});
