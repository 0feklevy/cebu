/**
 * PUBLISH-TIME VALIDATION — the check that would have stopped the v0.1.26 incident at its source.
 *
 * A package referencing a CDN published green and served fine in the viewer (which has a network);
 * only an export, months later, discovered it could not render offline — as a dead black canvas.
 * These tests pin the verdict for every shape that matters, against the REAL vendored registry.
 */

import { describe, expect, it } from 'vitest';

import { loadTrustedRegistry } from '../trustedRegistry.js';
import { resolvePackageRef, validateCaptureCompatibility, type ValidatablePackage } from '../captureCompatibility.js';

const pkg = (entryPath: string, files: Record<string, string>): ValidatablePackage => ({
  entryPath,
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
});

const IMPORTMAP = (imports: Record<string, string>): string =>
  `<script type="importmap">${JSON.stringify({ imports })}</script>`;

const THREE_CDN = {
  three: 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js',
  'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/',
};

describe('validateCaptureCompatibility', () => {
  it('COMPATIBLE: a package whose only external dependency is a trusted pinned pack', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      pkg('scene/index.html', {
        'scene/index.html': `${IMPORTMAP(THREE_CDN)}<script type="module" src="./main.js"></script>`,
        'scene/main.js': "import * as THREE from 'three';",
      }),
      registry,
    );
    expect(report.verdict).toBe('compatible');
    expect(report.requiredPacks).toEqual(['three@0.169.0']);
    expect(report.reasons).toEqual([]);
  });

  it('COMPATIBLE-WITH-SUBSTITUTIONS: an external font stylesheet is a fidelity note, not a blocker', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      pkg('index.html', {
        'index.html':
          '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded" />' +
          IMPORTMAP(THREE_CDN),
      }),
      registry,
    );
    expect(report.verdict).toBe('compatible-with-substitutions');
    expect(report.reasons.join(' ')).toMatch(/fonts\.googleapis\.com/);
    expect(report.reasons.join(' ')).toMatch(/local fallback/);
  });

  it('INCOMPATIBLE: an unpinned library version — 0.170.0 is a different identity', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      pkg('index.html', {
        'index.html': IMPORTMAP({ three: 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js' }),
      }),
      registry,
    );
    expect(report.verdict).toBe('incompatible');
    expect(report.reasons.join(' ')).toMatch(/no trusted dependency pack provides it/);
    expect(report.reasons.join(' ')).toMatch(/no network access/);
  });

  it('INCOMPATIBLE: an arbitrary library nothing trusts', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      pkg('index.html', { 'index.html': IMPORTMAP({ d3: 'https://cdn.jsdelivr.net/npm/d3@7/+esm' }) }),
      registry,
    );
    expect(report.verdict).toBe('incompatible');
  });

  it('INCOMPATIBLE: a referenced package file that does not exist (a torn package)', async () => {
    const report = validateCaptureCompatibility(
      pkg('scene/index.html', {
        'scene/index.html': '<script type="module" src="./missing.js"></script>',
      }),
      [],
    );
    expect(report.verdict).toBe('incompatible');
    expect(report.missingLocalRefs).toEqual(['scene/missing.js']);
    expect(report.reasons.join(' ')).toMatch(/referenced package file is missing/);
  });

  it('INCOMPATIBLE: a reference that escapes the package root', async () => {
    const report = validateCaptureCompatibility(
      pkg('index.html', { 'index.html': '<script src="../../../etc/passwd"></script>' }),
      [],
    );
    expect(report.verdict).toBe('incompatible');
    expect(report.reasons.join(' ')).toMatch(/escapes the package root/);
  });

  it('INCOMPATIBLE: a malformed import map is reported as such, not silently ignored', async () => {
    const report = validateCaptureCompatibility(
      pkg('index.html', { 'index.html': '<script type="importmap">{oops}</script>' }),
      [],
    );
    expect(report.verdict).toBe('incompatible');
    expect(report.reasons.join(' ')).toMatch(/malformed/);
  });

  it('INCOMPATIBLE: the entry document is not in the package at all', () => {
    const report = validateCaptureCompatibility(pkg('nope.html', { 'index.html': '<p/>' }), []);
    expect(report.verdict).toBe('incompatible');
    expect(report.reasons.join(' ')).toMatch(/not in the package/);
  });

  it('COMPATIBLE: a nested entry resolving its own relative assets', () => {
    const report = validateCaptureCompatibility(
      pkg('boids-3d/index.html', {
        'boids-3d/index.html':
          '<link rel="stylesheet" href="./css/style.css"><script type="module" src="./src/main.js"></script>',
        'boids-3d/css/style.css': 'body{}',
        'boids-3d/src/main.js': 'export const x=1;',
        'bridge.js': '/* root runtime */',
      }),
      [],
    );
    expect(report.verdict).toBe('compatible');
    expect(report.missingLocalRefs).toEqual([]);
  });
});

describe('resolvePackageRef', () => {
  it('resolves relative, root-absolute and parent references against the entry document', () => {
    expect(resolvePackageRef('boids-3d/index.html', './src/main.js')).toBe('boids-3d/src/main.js');
    expect(resolvePackageRef('boids-3d/index.html', '../bridge.js')).toBe('bridge.js');
    expect(resolvePackageRef('boids-3d/index.html', '/bridge.js')).toBe('bridge.js');
    expect(resolvePackageRef('index.html', 'main.js')).toBe('main.js');
    // Query and hash are not part of the file identity.
    expect(resolvePackageRef('index.html', './a.js?v=1#x')).toBe('a.js');
  });

  it('returns null for anything that is not a package file, and for traversal past the root', () => {
    expect(resolvePackageRef('index.html', 'https://cdn.example/x.js')).toBeNull();
    expect(resolvePackageRef('index.html', 'data:text/css,body{}')).toBeNull();
    expect(resolvePackageRef('index.html', '#anchor')).toBeNull();
    expect(resolvePackageRef('index.html', '../../etc/passwd')).toBeNull();
    expect(resolvePackageRef('a/b/index.html', '../../../x')).toBeNull();
  });
});

describe('validateCaptureCompatibility — JS imports the import map cannot govern', () => {
  it('INCOMPATIBLE: a module importing an absolute URL directly', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      pkg('index.html', {
        'index.html': '<script type="module" src="./main.js"></script>',
        'main.js': "import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';",
      }),
      registry,
    );
    expect(report.verdict).toBe('incompatible');
    expect(report.reasons.join(' ')).toMatch(/main\.js imports https:\/\/cdn\.jsdelivr\.net/);
    expect(report.reasons.join(' ')).toMatch(/an import map cannot redirect an absolute URL/);
  });

  it('COMPATIBLE: a direct URL import that a TRUSTED pack satisfies is fine', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      pkg('index.html', {
        'index.html': '<script type="module" src="./main.js"></script>',
        'main.js': "import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';",
      }),
      registry,
    );
    expect(report.verdict).toBe('compatible');
  });

  it('a commented-out CDN import does not make a package incompatible', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      pkg('index.html', {
        'index.html': '<script type="module" src="./main.js"></script>',
        'main.js': "// import d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm'\nexport const x = 1;",
      }),
      registry,
    );
    expect(report.verdict).toBe('compatible');
  });
});
