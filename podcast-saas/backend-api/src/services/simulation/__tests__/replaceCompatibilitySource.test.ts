/**
 * Which bytes the replace-compatibility gate reads (audit simulation-003).
 *
 * The controller suite proves the endpoint behaviour; these pin the resolution rules themselves,
 * including the two that have no endpoint-level expression: the `package/` translation, and the
 * refusal to answer at all when the active revision cannot be read.
 */
import { describe, it, expect } from 'vitest';
import {
  ActiveRevisionUnreadable,
  bridgeManifestPath,
  bundleRelPathForManifestPath,
  readReplaceCompatibilitySource,
} from '../replaceCompatibilitySource.js';
import type { SimManifest } from 'shared/sim/simManifest';

const PREFIX = 'simulations/proj-1/sim-1';
const REV    = 'rev-9f3caaaa1111';
const REV_ROOT = `${PREFIX}/revisions/${REV}`;

const manifest = (over: Partial<SimManifest> = {}): SimManifest => ({
  manifestVersion: 1,
  simulationId: 'sim-1',
  projectId: 'proj-1',
  revisionId: REV,
  revisionNumber: 2,
  bridgeProtocolVersion: 2,
  runtimeProtocolVersion: 1,
  entry: 'package/index.html',
  runtime: ['package/bridge.js'],
  files: [
    { path: 'package/index.html', role: 'entry',   hash: 'a'.repeat(64), bytes: 1, contentType: 'text/html', cacheControl: 'no-cache' },
    { path: 'package/bridge.js',  role: 'runtime', hash: 'b'.repeat(64), bytes: 1, contentType: 'application/javascript', cacheControl: 'immutable' },
  ],
  variants: [],
  posters: [],
  qualityProfiles: [],
  externalDependencies: [],
  generatedFrom: {},
  canary: { classification: null, ranAt: null, engine: null },
  createdAt: new Date(0).toISOString(),
  createdBy: null,
  ...over,
}) as SimManifest;

/** Minimal read-only storage over a key→bytes map. */
const storageOf = (objects: Record<string, string>) => ({
  readObject: async (key: string): Promise<Buffer> => {
    const v = objects[key];
    if (v === undefined) throw new Error(`NoSuchKey: ${key}`);
    return Buffer.from(v);
  },
});

const LEGACY_SIM = { storage_prefix: PREFIX, entry_file: `${PREFIX}/index.html`, active_revision_id: null };
const REV_SIM    = { storage_prefix: PREFIX, entry_file: `${PREFIX}/index.html`, active_revision_id: REV };

describe('bundleRelPathForManifestPath', () => {
  it('strips the package/ nesting the revision layout adds', () => {
    expect(bundleRelPathForManifestPath('package/index.html')).toBe('index.html');
    expect(bundleRelPathForManifestPath('package/sub/dir/main.html')).toBe('sub/dir/main.html');
  });

  it('leaves a pre-nesting path alone', () => {
    expect(bundleRelPathForManifestPath('index.html')).toBe('index.html');
  });

  it('has no answer for an empty path', () => {
    expect(bundleRelPathForManifestPath('')).toBeNull();
    expect(bundleRelPathForManifestPath('package/')).toBeNull();
  });
});

describe('bridgeManifestPath', () => {
  it('prefers package/bridge.js — where publication puts it', () => {
    expect(bridgeManifestPath(manifest())).toBe('package/bridge.js');
  });

  it('falls back to whatever the manifest declares as runtime', () => {
    expect(bridgeManifestPath(manifest({ runtime: ['package/nested/bridge.js'] })))
      .toBe('package/nested/bridge.js');
  });

  it('finds a runtime-role file when `runtime` is empty', () => {
    expect(bridgeManifestPath(manifest({ runtime: [] }))).toBe('package/bridge.js');
  });

  it('reports null for a package that never generated one', () => {
    expect(bridgeManifestPath(manifest({ runtime: [], files: [] }))).toBeNull();
  });
});

describe('readReplaceCompatibilitySource — legacy package', () => {
  it('reads the mutable prefix, exactly as before revisions existed', async () => {
    const src = await readReplaceCompatibilitySource(
      storageOf({ [`${PREFIX}/bridge.js`]: 'LEGACY' }), LEGACY_SIM,
    );
    expect(src).toMatchObject({
      origin: 'legacy', bridgeJs: 'LEGACY', bridgeKey: `${PREFIX}/bridge.js`,
      entryRelPath: 'index.html', revisionId: null,
    });
  });

  it('treats a missing bridge as nothing to preserve', async () => {
    const src = await readReplaceCompatibilitySource(storageOf({}), LEGACY_SIM);
    expect(src.bridgeJs).toBe('');
    expect(src.bridgeKey).toBeNull();
  });
});

describe('readReplaceCompatibilitySource — revisioned package', () => {
  it('reads the ACTIVE manifest and its package/bridge.js, never the legacy copy', async () => {
    const src = await readReplaceCompatibilitySource(
      storageOf({
        [`${PREFIX}/bridge.js`]:            'STALE LEGACY',
        [`${REV_ROOT}/manifest.json`]:      JSON.stringify(manifest()),
        [`${REV_ROOT}/package/bridge.js`]:  'ACTIVE',
      }),
      REV_SIM,
    );
    expect(src).toMatchObject({
      origin: 'revision', bridgeJs: 'ACTIVE',
      bridgeKey: `${REV_ROOT}/package/bridge.js`, entryRelPath: 'index.html', revisionId: REV,
    });
  });

  it('takes the entry path from the manifest, not from the legacy entry_file column', async () => {
    const src = await readReplaceCompatibilitySource(
      storageOf({
        [`${REV_ROOT}/manifest.json`]: JSON.stringify(manifest({ entry: 'package/app/main.html' })),
        [`${REV_ROOT}/package/bridge.js`]: 'ACTIVE',
      }),
      REV_SIM,   // entry_file still says index.html — the row is the stale one here
    );
    expect(src.entryRelPath).toBe('app/main.html');
  });

  it('a revision that genuinely has no bridge reports nothing to preserve', async () => {
    const src = await readReplaceCompatibilitySource(
      storageOf({ [`${REV_ROOT}/manifest.json`]: JSON.stringify(manifest({ runtime: [], files: [] })) }),
      REV_SIM,
    );
    expect(src.bridgeJs).toBe('');
    expect(src.bridgeKey).toBeNull();
  });

  it('REFUSES rather than defaulting to compatible when the manifest is unreadable', async () => {
    await expect(readReplaceCompatibilitySource(storageOf({ [`${PREFIX}/bridge.js`]: 'STALE' }), REV_SIM))
      .rejects.toBeInstanceOf(ActiveRevisionUnreadable);
  });

  it('REFUSES when the manifest resolves but its bridge is missing', async () => {
    await expect(readReplaceCompatibilitySource(
      storageOf({ [`${REV_ROOT}/manifest.json`]: JSON.stringify(manifest()) }), REV_SIM,
    )).rejects.toBeInstanceOf(ActiveRevisionUnreadable);
  });

  it('REFUSES when the manifest names no entry document', async () => {
    await expect(readReplaceCompatibilitySource(
      storageOf({ [`${REV_ROOT}/manifest.json`]: JSON.stringify(manifest({ entry: '' })) }), REV_SIM,
    )).rejects.toBeInstanceOf(ActiveRevisionUnreadable);
  });
});
