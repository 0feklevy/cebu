/**
 * THE PUBLISH GATE — the check that decides a package cannot render offline BEFORE it goes live.
 *
 * The v0.1.26 incident's real cost was that nothing ever asked. A package naming a CDN published
 * green, served fine in the viewer (which has a network), and only failed months later inside the
 * capture container as a dead black canvas. `RevisionService.validate()` now refuses such a
 * revision; without a test, deleting that block would break nothing and the gate would silently
 * disappear — which is exactly how the original hole was made.
 *
 * These drive the REAL validator against package bytes, so they fail if the gate is removed, if it
 * stops reading the entry, or if it stops classifying a CDN dependency as boot-critical.
 */

import { describe, expect, it } from 'vitest';

import { loadTrustedRegistry } from '../../export/capture/dependencies/trustedRegistry.js';
import { validateCaptureCompatibility } from '../../export/capture/dependencies/captureCompatibility.js';

/** The shape `RevisionService.checkCaptureCompatibility` assembles from the manifest + storage. */
const revisionPackage = (files: Record<string, string>, entryPath = 'package/index.html') => ({
  entryPath,
  files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
});

const IMPORTMAP = (imports: Record<string, string>): string =>
  `<script type="importmap">${JSON.stringify({ imports })}</script>`;

describe('publish gate — capture compatibility decides whether a revision may go live', () => {
  it('REFUSES a revision whose runtime library is an untrusted CDN', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      revisionPackage({
        'package/index.html': IMPORTMAP({ d3: 'https://cdn.jsdelivr.net/npm/d3@7/+esm' }),
      }),
      registry,
    );
    // This verdict is what makes RevisionService.validate() call markFailed instead of advancing
    // the revision to canary_passed.
    expect(report.verdict).toBe('incompatible');
    expect(report.reasons.some((r) => r.includes('d3'))).toBe(true);
    expect(report.reasons.some((r) => r.includes('no network access'))).toBe(true);
  });

  it('REFUSES a revision whose module imports an absolute URL directly', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      revisionPackage({
        'package/index.html': '<script type="module" src="./main.js"></script>',
        'package/main.js': "import p from 'https://esm.sh/plotly@2';",
      }),
      registry,
    );
    expect(report.verdict).toBe('incompatible');
    expect(report.reasons.join(' ')).toMatch(/main\.js imports https:\/\/esm\.sh/);
  });

  it('REFUSES a revision whose entry references a file the package does not contain', async () => {
    const report = validateCaptureCompatibility(
      revisionPackage({ 'package/index.html': '<script type="module" src="./missing.js"></script>' }),
      [],
    );
    expect(report.verdict).toBe('incompatible');
    expect(report.missingLocalRefs).toEqual(['package/missing.js']);
  });

  it('ALLOWS a revision whose only external dependency is a trusted pinned pack', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      revisionPackage({
        'package/index.html':
          IMPORTMAP({
            three: 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js',
            'three/addons/': 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/',
          }) + '<script type="module" src="./main.js"></script>',
        'package/main.js': "import * as THREE from 'three';",
        'package/bridge.js': '/* generated runtime */',
      }),
      registry,
    );
    expect(report.verdict).toBe('compatible');
    expect(report.requiredPacks).toEqual(['three@0.169.0']);
  });

  it('ALLOWS a revision with an external FONT, flagged as a substitution rather than refused', async () => {
    const registry = (await loadTrustedRegistry()).descriptors();
    const report = validateCaptureCompatibility(
      revisionPackage({
        'package/index.html':
          '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter" />',
      }),
      registry,
    );
    // A remote icon font changes pixels; it cannot stop the module graph. Refusing here would
    // reject a large share of perfectly capturable packages.
    expect(report.verdict).toBe('compatible-with-substitutions');
  });

  it('the gate is reachable from RevisionService — validate() consults it before canary_passed', async () => {
    // Guards against the failure mode the audit caught elsewhere: a rule that exists, is exported,
    // is unit-tested, and is called from nowhere.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../RevisionService.ts', import.meta.url), 'utf8');
    expect(src).toContain('checkCaptureCompatibility');
    expect(src).toMatch(/capture\.verdict === 'incompatible'/);
    // …and it runs BEFORE the transition that makes a revision eligible to become active.
    expect(src.indexOf('checkCaptureCompatibility(')).toBeLessThan(src.indexOf("'validating', 'canary_passed'"));
  });
});
