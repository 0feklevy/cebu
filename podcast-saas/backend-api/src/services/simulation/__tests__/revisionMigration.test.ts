/**
 * Migrating an existing legacy package onto an immutable revision (Priority 7.7).
 *
 * The property that matters most here is what the migration does NOT do: it never activates, and it
 * never moves or deletes the legacy bytes. Both are load-bearing —
 *
 *   • activating changes the identity axis, and every sim_posters row for that package is keyed on
 *     the OLD value with no fallback, so activating before a poster re-capture blanks every poster
 *     the package has; and
 *   • migration 050's rollback reverts every simulation to the legacy path, which must still hold a
 *     servable package.
 *
 * Both are asserted directly rather than assumed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../db/schema.js';

const h = vi.hoisted(() => ({ dbRef: { current: null as unknown as Record<string, unknown> } }));
vi.mock('../../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current as Record<string, unknown>;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const storageRef = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('../../storage/getStorageAdapter.js', () => ({ getStorageAdapter: () => storageRef.adapter }));

import {
  RevisionMigration, roleForLegacyPath, revisionPathForLegacy, projectIdFromPrefix,
  buildLegacyManifest,
} from '../RevisionMigration.js';
import { RevisionService } from '../RevisionService.js';
import { IMMUTABLE_CACHE_CONTROL, POINTER_CACHE_CONTROL } from 'shared/sim/simRevision';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const PREFIX = 'simulations/proj-1/sim-1';

function fakeStorage() {
  const objects = new Map<string, { bytes: Buffer; contentType: string; cacheControl?: string }>();
  return {
    objects,
    uploadFile: vi.fn(async (k: string, b: Buffer, ct: string, cc?: string) => {
      objects.set(k, { bytes: b, contentType: ct, cacheControl: cc }); return `https://cdn/${k}`;
    }),
    readObject: vi.fn(async (k: string) => {
      const o = objects.get(k); if (!o) throw new Error(`missing ${k}`); return o.bytes;
    }),
    headObject: vi.fn(async (k: string) => {
      const o = objects.get(k); if (!o) return null;
      return { contentType: o.contentType, cacheControl: o.cacheControl ?? null, size: o.bytes.length, etag: null };
    }),
    listObjects: vi.fn(async (p: string) => [...objects.keys()].filter((k) => k.startsWith(p))),
    deleteWithPrefix: vi.fn(async (p: string) => {
      for (const k of [...objects.keys()]) if (k.startsWith(p)) objects.delete(k);
    }),
    objectExists: vi.fn(async (k: string) => objects.has(k)),
  };
}

let pg: PGlite;
let adapter: ReturnType<typeof fakeStorage>;
let mig: RevisionMigration;
let svc: RevisionService;
let simId: string;

const HTML = Buffer.from('<html><head></head><body>legacy</body></html>', 'utf8');
const BRIDGE = Buffer.from('window.__bridge = 1;\n', 'utf8');
const CSS = Buffer.from('body{margin:0}', 'utf8');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

/** A legacy package laid out the way the pipeline writes one today. */
function seedLegacyObjects(): void {
  adapter.objects.set(`${PREFIX}/index.html`, { bytes: HTML, contentType: 'text/html; charset=utf-8' });
  adapter.objects.set(`${PREFIX}/bridge.js`, { bytes: BRIDGE, contentType: 'application/javascript' });
  adapter.objects.set(`${PREFIX}/styles.css`, { bytes: CSS, contentType: 'text/css' });
  adapter.objects.set(`${PREFIX}/assets/logo.png`, { bytes: PNG, contentType: 'image/png' });
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;

  const [org] = await rows<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const [p] = await rows<{ id: string }>(
    `INSERT INTO projects (org_id, title) VALUES ($1, 'P') RETURNING id`, [org!.id]);
  const [s] = await rows<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, bridge_hash)
     VALUES ($1, 'sim', $2, $3, 'H1') RETURNING id`,
    [p!.id, PREFIX, `${PREFIX}/index.html`]);
  simId = s!.id;

  adapter = fakeStorage();
  storageRef.adapter = adapter;
  svc = new RevisionService(adapter as never);
  mig = new RevisionMigration(adapter as never, svc);
  seedLegacyObjects();
});

afterEach(async () => { await pg.close(); vi.clearAllMocks(); });

// ── Classification ───────────────────────────────────────────────────────────────────────────────

describe('classification', () => {
  it('recognises the entry, the runtime, and everything else as customer content', () => {
    expect(roleForLegacyPath('index.html', 'index.html')).toBe('entry');
    expect(roleForLegacyPath('bridge.js', 'index.html')).toBe('runtime');
    expect(roleForLegacyPath('guidance.js', 'index.html')).toBe('runtime');
    expect(roleForLegacyPath('runtime/bridge.js', 'index.html')).toBe('runtime');
    expect(roleForLegacyPath('styles.css', 'index.html')).toBe('asset');
    expect(roleForLegacyPath('assets/logo.png', 'index.html')).toBe('asset');
  });

  it('does not mistake a customer file for the runtime by prefix alone', () => {
    // `bridge.js` is the runtime; `my-bridge.js` and `bridges.js` are the customer's.
    expect(roleForLegacyPath('my-bridge.js', 'index.html')).toBe('asset');
    expect(roleForLegacyPath('bridges.js', 'index.html')).toBe('asset');
    expect(roleForLegacyPath('lib/bridge.js', 'index.html')).toBe('asset');
  });

  it('nests customer bytes under package/ so they cannot shadow ours', () => {
    // A customer file literally called manifest.json must not land beside the real one.
    expect(revisionPathForLegacy('manifest.json', 'asset')).toBe('package/manifest.json');
    expect(revisionPathForLegacy('index.html', 'entry')).toBe('package/index.html');
    expect(revisionPathForLegacy('bridge.js', 'runtime')).toBe('runtime/bridge.js');
    expect(revisionPathForLegacy('runtime/bridge.js', 'runtime')).toBe('runtime/bridge.js');
  });

  it('recovers the project id from a canonical prefix and shrugs at anything else', () => {
    expect(projectIdFromPrefix('simulations/proj-9/sim-2')).toBe('proj-9');
    // Cosmetic only — nothing resolves a path from it, so an odd prefix must not fail a migration.
    expect(projectIdFromPrefix('weird/layout')).toBe('');
  });
});

// ── Dry run ──────────────────────────────────────────────────────────────────────────────────────

describe('dry run', () => {
  it('reports the plan without creating a draft or writing a byte', async () => {
    const res = await mig.publishLegacyAsRevision({ simulationId: simId, dryRun: true });
    expect(res.filesCopied).toBe(4);
    expect(res.entryPath).toBe('package/index.html');
    expect(res.revisionId).toBeNull();
    expect(adapter.uploadFile).not.toHaveBeenCalled();
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_revisions`);
    expect(n).toBe(0);
  });
});

// ── Publication ──────────────────────────────────────────────────────────────────────────────────

describe('publishLegacyAsRevision', () => {
  it('copies every file into the revision prefix and verifies it', async () => {
    const res = await mig.publishLegacyAsRevision({ simulationId: simId });
    expect(res.error).toBeUndefined();
    expect(res.filesCopied).toBe(4);
    expect(res.bytesCopied).toBe(HTML.length + BRIDGE.length + CSS.length + PNG.length);

    const rev = res.revisionId!;
    expect(adapter.objects.has(`${PREFIX}/revisions/${rev}/package/index.html`)).toBe(true);
    expect(adapter.objects.has(`${PREFIX}/revisions/${rev}/runtime/bridge.js`)).toBe(true);
    expect(adapter.objects.has(`${PREFIX}/revisions/${rev}/package/assets/logo.png`)).toBe(true);
    expect(adapter.objects.has(`${PREFIX}/revisions/${rev}/manifest.json`)).toBe(true);
  });

  it('leaves the revision canary_passed and NEVER activates it', async () => {
    // Activating flips the identity axis, and every existing poster is keyed on the old value with
    // no fallback — so activation has to wait for a canary and a poster re-capture.
    const res = await mig.publishLegacyAsRevision({ simulationId: simId });
    const [rev] = await rows<{ status: string }>(
      `SELECT status FROM sim_revisions WHERE id = $1`, [res.revisionId]);
    expect(rev!.status).toBe('canary_passed');
    const [sim] = await rows<{ active_revision_id: string | null }>(
      `SELECT active_revision_id FROM simulations WHERE id = $1`, [simId]);
    expect(sim!.active_revision_id).toBeNull();
  });

  it('never moves or deletes the legacy bytes', async () => {
    // Migration 050's rollback reverts every simulation to this path; it must stay servable.
    await mig.publishLegacyAsRevision({ simulationId: simId });
    expect(adapter.objects.has(`${PREFIX}/index.html`)).toBe(true);
    expect(adapter.objects.has(`${PREFIX}/bridge.js`)).toBe(true);
    expect(adapter.objects.get(`${PREFIX}/index.html`)!.bytes).toEqual(HTML);
    expect(adapter.deleteWithPrefix).not.toHaveBeenCalled();
  });

  it('stores the entry document revalidating and everything else immutable', async () => {
    const res = await mig.publishLegacyAsRevision({ simulationId: simId });
    const rev = res.revisionId!;
    expect(adapter.objects.get(`${PREFIX}/revisions/${rev}/package/index.html`)!.cacheControl)
      .toBe(POINTER_CACHE_CONTROL);
    expect(adapter.objects.get(`${PREFIX}/revisions/${rev}/package/styles.css`)!.cacheControl)
      .toBe(IMMUTABLE_CACHE_CONTROL);
    expect(adapter.objects.get(`${PREFIX}/revisions/${rev}/runtime/bridge.js`)!.cacheControl)
      .toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('records the legacy provenance on the revision', async () => {
    const res = await mig.publishLegacyAsRevision({ simulationId: simId });
    const [rev] = await rows<{ metadata: { migratedFromLegacyPrefix: string; legacyBridgeHash: string } }>(
      `SELECT metadata FROM sim_revisions WHERE id = $1`, [res.revisionId]);
    expect(rev!.metadata.migratedFromLegacyPrefix).toBe(PREFIX);
    expect(rev!.metadata.legacyBridgeHash).toBe('H1');
  });

  it('refuses a second migration once one is active, unless forced', async () => {
    const first = await mig.publishLegacyAsRevision({ simulationId: simId });
    await svc.activate({
      simulationId: simId, revisionId: first.revisionId!, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired',
    });

    expect((await mig.publishLegacyAsRevision({ simulationId: simId })).skipped).toBe('already-migrated');
    const forced = await mig.publishLegacyAsRevision({ simulationId: simId, force: true });
    expect(forced.error).toBeUndefined();
    expect(forced.revisionNumber).toBe(2);
  });

  it('never re-copies a revision into a revision', async () => {
    // listObjects on the simulation prefix returns everything beneath it, which after the first
    // migration includes the first revision's own files.
    await mig.publishLegacyAsRevision({ simulationId: simId });
    const second = await mig.publishLegacyAsRevision({ simulationId: simId, force: true });
    expect(second.filesCopied).toBe(4);
  });

  it('refuses before touching storage when the entry path cannot be derived', async () => {
    // A revision with a NULL entry_path is unactivatable. The later "entry not present" check would
    // also catch this, so what this guard adds is (a) short-circuiting before a storage listing and
    // (b) distinguishing TWO different operator problems that need different fixes: an unusable
    // entry_file COLUMN versus an entry file missing from STORAGE. Reporting one as the other sends
    // whoever is on call to the wrong system.
    await pg.query(`UPDATE simulations SET entry_file = '' WHERE id = $1`, [simId]);
    const res = await mig.publishLegacyAsRevision({ simulationId: simId });
    expect(res.skipped).toBe('no-entry-path');
    expect(res.error).toContain('cannot derive entry path');
    expect(adapter.listObjects).not.toHaveBeenCalled();
    expect(adapter.uploadFile).not.toHaveBeenCalled();
    const [{ n }] = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM sim_revisions`);
    expect(n).toBe(0);
  });

  it('refuses when the declared entry is not present in storage, and says so distinctly', async () => {
    adapter.objects.delete(`${PREFIX}/index.html`);
    const res = await mig.publishLegacyAsRevision({ simulationId: simId });
    expect(res.skipped).toBe('no-entry-path');
    // The other half of the distinction: the column was fine, the object is gone.
    expect(res.error).toContain('not present under');
    expect(adapter.listObjects).toHaveBeenCalled();
    expect(adapter.uploadFile).not.toHaveBeenCalled();
  });

  it('handles a legacy entry_file stored as a full URL', async () => {
    // The two historical shapes are exactly why deriveEntryRelPath exists.
    await pg.query(`UPDATE simulations SET entry_file = $2 WHERE id = $1`,
      [simId, `https://cdn.example.com/sim-public/${PREFIX}/index.html`]);
    const res = await mig.publishLegacyAsRevision({ simulationId: simId });
    expect(res.entryPath).toBe('package/index.html');
  });

  it('reports no-files for an empty prefix', async () => {
    adapter.objects.clear();
    expect((await mig.publishLegacyAsRevision({ simulationId: simId })).skipped).toBe('no-files');
  });

  it('reports a missing simulation rather than throwing', async () => {
    const res = await mig.publishLegacyAsRevision({
      simulationId: '00000000-0000-0000-0000-000000000000' });
    expect(res.error).toContain('not found');
  });

  it('marks the revision failed when a copy throws mid-way', async () => {
    let n = 0;
    adapter.readObject.mockImplementation(async (k: string) => {
      if (++n === 3) throw new Error('storage exploded');
      const o = adapter.objects.get(k); if (!o) throw new Error(`missing ${k}`); return o.bytes;
    });
    const res = await mig.publishLegacyAsRevision({ simulationId: simId });
    expect(res.error).toContain('storage exploded');
    const [rev] = await rows<{ status: string }>(
      `SELECT status FROM sim_revisions WHERE id = $1`, [res.revisionId]);
    // Left failed, so gc reclaims the partial bytes and it can never be activated.
    expect(rev!.status).toBe('failed');
    const [sim] = await rows<{ active_revision_id: string | null }>(
      `SELECT active_revision_id FROM simulations WHERE id = $1`, [simId]);
    expect(sim!.active_revision_id).toBeNull();
  });

  it('the published revision is activatable and serves from the revision prefix', async () => {
    const res = await mig.publishLegacyAsRevision({ simulationId: simId });
    const act = await svc.activate({
      simulationId: simId, revisionId: res.revisionId!, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired',
    });
    expect(act.activated.status).toBe('active');
    const p = await svc.readPointer(simId);
    expect(p.entryKey).toBe(`${PREFIX}/revisions/${res.revisionId}/package/index.html`);
  });
});

// ── The legacy manifest ──────────────────────────────────────────────────────────────────────────

describe('buildLegacyManifest', () => {
  it('does not claim a protocol version it never observed', () => {
    // The bytes predate the versioned runtime. Recording a version we did not see would put a false
    // statement in the one document meant to be authoritative about the package.
    const m = buildLegacyManifest({
      sim: { id: 's', projectId: 'p' }, revisionId: 'r', revisionNumber: 1,
      entryPath: 'package/index.html', files: [],
    });
    expect(m.bridgeProtocolVersion).toBe(0);
    expect(m.runtimeProtocolVersion).toBe(0);
  });

  it('records one honest placeholder variant rather than inventing per-section entries', () => {
    // An empty variants list fails validation ("a package with no variants serves nothing"), and a
    // legacy package has no per-section structure to recover.
    const m = buildLegacyManifest({
      sim: { id: 's', projectId: 'p' }, revisionId: 'r', revisionNumber: 1,
      entryPath: 'package/index.html', files: [],
    });
    expect(m.variants).toEqual([{ variantKey: 'main', configHashes: [] }]);
  });

  it('lists exactly the runtime files', () => {
    const m = buildLegacyManifest({
      sim: { id: 's', projectId: 'p' }, revisionId: 'r', revisionNumber: 1,
      entryPath: 'package/index.html',
      files: [
        { path: 'package/index.html', role: 'entry', hash: 'a'.repeat(64), bytes: 1, contentType: 'text/html; charset=utf-8', cacheControl: 'x' },
        { path: 'runtime/bridge.js', role: 'runtime', hash: 'b'.repeat(64), bytes: 1, contentType: 'application/javascript', cacheControl: 'x' },
        { path: 'package/a.css', role: 'asset', hash: 'c'.repeat(64), bytes: 1, contentType: 'text/css', cacheControl: 'x' },
      ],
    });
    expect(m.runtime).toEqual(['runtime/bridge.js']);
  });
});
