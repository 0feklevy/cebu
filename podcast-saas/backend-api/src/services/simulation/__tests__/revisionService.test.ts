/**
 * RevisionService against a REAL Postgres engine (Priority 7.4 / 7.5 / 7.6 / 7.8).
 *
 * WHY NOT THE HOUSE db-FAKE PATTERN
 * The sibling suites hand-fake `db` with an in-memory row array. That is right for logic that only
 * needs rows back, and useless here: every guarantee this service makes lives in SQL the fake does
 * not have. `IS NOT DISTINCT FROM` vs `=` against a NULL incumbent, the partial unique index that
 * makes two concurrent activations impossible, the demote-before-promote ordering the index forces,
 * the CHECK that stops the live revision being deleted — a fake would pass all of them while
 * proving none. So `db/index.js` is mocked to a drizzle instance bound to PGlite: real SQL, real
 * constraints, and no connection to DATABASE_URL, which points at the database preview and
 * production SHARE.
 *
 * The concurrency tests are written as genuine races — two promises started before either is
 * awaited — rather than as sequential calls that merely look concurrent.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { createHash } from 'node:crypto';

import * as schema from '../../../db/schema.js';

const h = vi.hoisted(() => ({ dbRef: { current: null as unknown as Record<string, unknown> } }));

// Forwards to whichever PGlite-backed drizzle instance the current test built. Methods are bound so
// `db.transaction(...)` keeps its receiver.
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

const storage = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => storage.adapter,
}));

import { RevisionService, RevisionConflict, cacheControlForRole } from '../RevisionService.js';
import {
  IMMUTABLE_CACHE_CONTROL, POINTER_CACHE_CONTROL, revisionFileKey,
} from 'shared/src/sim/simRevision';
import { SIM_MANIFEST_VERSION, type SimManifest } from 'shared/src/sim/simManifest';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const PREFIX = 'simulations/proj/sim';

/** An in-memory storage adapter that records what it was asked to store. */
function fakeStorage() {
  const objects = new Map<string, { bytes: Buffer; contentType: string; cacheControl?: string }>();
  return {
    objects,
    /** When set, headObject reports nulls — the local-disk case, which cannot verify metadata. */
    metadataBlind: false,
    uploadFile: vi.fn(async (key: string, bytes: Buffer, contentType: string, cacheControl?: string) => {
      objects.set(key, { bytes, contentType, cacheControl });
      return `https://cdn.test/${key}`;
    }),
    readObject: vi.fn(async (key: string) => {
      const o = objects.get(key);
      if (!o) throw new Error(`no such object: ${key}`);
      return o.bytes;
    }),
    headObject: vi.fn(async function (this: { metadataBlind: boolean }, key: string) {
      const o = objects.get(key);
      if (!o) return null;
      if (adapter.metadataBlind) {
        return { contentType: null, cacheControl: null, size: o.bytes.length, etag: null };
      }
      return {
        contentType: o.contentType,
        cacheControl: o.cacheControl ?? null,
        size: o.bytes.length,
        etag: `"${createHash('sha256').update(o.bytes).digest('hex').slice(0, 16)}"`,
      };
    }),
    deleteWithPrefix: vi.fn(async (prefix: string) => {
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
    }),
    listObjects: vi.fn(async (prefix: string) => [...objects.keys()].filter((k) => k.startsWith(prefix))),
    objectExists: vi.fn(async (key: string) => objects.has(key)),
  };
}
let adapter: ReturnType<typeof fakeStorage>;

let pg: PGlite;
let svc: RevisionService;
let simId: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A manifest describing exactly the files this suite publishes. */
function manifestFor(files: Array<{ path: string; bytes: Buffer; contentType: string; role: string }>): SimManifest {
  return {
    manifestVersion: SIM_MANIFEST_VERSION,
    simulationId: simId, projectId: 'proj', revisionId: 'r', revisionNumber: 1,
    bridgeProtocolVersion: 3, runtimeProtocolVersion: 3,
    entry: 'package/index.html',
    runtime: ['runtime/bridge.js'],
    files: files.map((f) => ({
      path: f.path, role: f.role as never, hash: sha(f.bytes), bytes: f.bytes.length,
      contentType: f.contentType, cacheControl: cacheControlForRole(f.role as never, f.path),
    })),
    variants: [{ variantKey: 'main', configHashes: ['c1'] }],
    posters: [], qualityProfiles: ['high'], externalDependencies: [],
    generatedFrom: {}, canary: { classification: null, ranAt: null, engine: null },
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: null,
  };
}

const HTML = Buffer.from('<html><head></head><body>sim</body></html>', 'utf8');
const JS = Buffer.from('export const bridge = 1;\n', 'utf8');
const STD_FILES = [
  { path: 'package/index.html', bytes: HTML, contentType: 'text/html; charset=utf-8', role: 'entry' },
  { path: 'runtime/bridge.js', bytes: JS, contentType: 'application/javascript', role: 'runtime' },
];

/** draft → uploading → write files → validating → validate() → canary_passed. */
async function publish(): Promise<{ id: string; manifest: SimManifest }> {
  const draft = await svc.createDraft({ simulationId: simId });
  const up = await svc.beginUpload(simId, draft.id);
  for (const f of STD_FILES) {
    await svc.writeFile(up, PREFIX, {
      manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never,
    });
  }
  const validating = await svc.finishUpload(simId, draft.id);
  const manifest = manifestFor(STD_FILES);
  const res = await svc.validate(simId, validating, PREFIX, { manifest });
  expect(res.ok).toBe(true);
  return { id: draft.id, manifest };
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
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file)
     VALUES ($1, 'sim', $2, 'index.html') RETURNING id`, [p!.id, PREFIX]);
  simId = s!.id;

  adapter = fakeStorage();
  storage.adapter = adapter;
  svc = new RevisionService(adapter as never);
});

afterEach(async () => { await pg.close(); vi.clearAllMocks(); });

// ── Draft allocation ─────────────────────────────────────────────────────────────────────────────

describe('createDraft', () => {
  it('allocates revision numbers monotonically', async () => {
    const a = await svc.createDraft({ simulationId: simId });
    const b = await svc.createDraft({ simulationId: simId });
    expect([a.revisionNumber, b.revisionNumber]).toEqual([1, 2]);
  });

  it('allocates distinct numbers under a genuine race', async () => {
    // Started before either is awaited. The counter is incremented under the simulations row lock,
    // so these serialise; max()+1 would hand both the same number.
    const [a, b, c] = await Promise.all([
      svc.createDraft({ simulationId: simId }),
      svc.createDraft({ simulationId: simId }),
      svc.createDraft({ simulationId: simId }),
    ]);
    expect(new Set([a.revisionNumber, b.revisionNumber, c.revisionNumber]).size).toBe(3);
  });

  it('refuses an unknown simulation', async () => {
    await expect(svc.createDraft({ simulationId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toThrow(RevisionConflict);
  });

  it('records the rollback provenance', async () => {
    const first = await svc.createDraft({ simulationId: simId });
    const second = await svc.createDraft({ simulationId: simId, rollbackOfRevisionId: first.id });
    expect(second.rollbackOfRevisionId).toBe(first.id);
  });
});

// ── Status CAS ───────────────────────────────────────────────────────────────────────────────────

describe('status transitions are compare-and-set', () => {
  it('moves draft → uploading → validating', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    expect((await svc.beginUpload(simId, d.id)).status).toBe('uploading');
    expect((await svc.finishUpload(simId, d.id)).status).toBe('validating');
  });

  it('a second beginUpload loses the CAS instead of silently succeeding', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    await svc.beginUpload(simId, d.id);
    await expect(svc.beginUpload(simId, d.id)).rejects.toThrow(RevisionConflict);
  });

  it('exactly one of two racing beginUpload calls wins', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    const results = await Promise.allSettled([
      svc.beginUpload(simId, d.id), svc.beginUpload(simId, d.id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('refuses an illegal transition as a programming error, not a conflict', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    // failed is terminal, so failed → failed is not a race, it is a bug in the caller.
    await expect(svc.markFailed(simId, d.id, 'failed', 'x')).rejects.toThrow(/illegal revision transition/);
  });

  it('scopes the CAS to the simulation, not just the revision id', async () => {
    const [p2] = await rows<{ id: string }>(
      `INSERT INTO projects (org_id, title) SELECT org_id, 'P2' FROM projects LIMIT 1 RETURNING id`);
    const [other] = await rows<{ id: string }>(
      `INSERT INTO simulations (project_id, name, storage_prefix, entry_file)
       VALUES ($1, 's2', 'simulations/p2/s2', 'i.html') RETURNING id`, [p2!.id]);
    const d = await svc.createDraft({ simulationId: simId });
    await expect(svc.beginUpload(other!.id, d.id)).rejects.toThrow(RevisionConflict);
  });
});

// ── The single write path ────────────────────────────────────────────────────────────────────────

describe('writeFile — the only way into a revision prefix', () => {
  it('writes under the revision prefix and returns the manifest entry', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    const f = await svc.writeFile(up, PREFIX, {
      manifestPath: 'package/index.html', bytes: HTML,
      contentType: 'text/html; charset=utf-8', role: 'entry',
    });
    expect(f.hash).toBe(sha(HTML));
    expect(f.bytes).toBe(HTML.length);
    expect(adapter.objects.has(revisionFileKey(PREFIX, d.id, 'package/index.html'))).toBe(true);
  });

  it('refuses to add files to a revision that is no longer uploading', async () => {
    // Nothing may be appended to a package that has already been validated, canaried or activated.
    const d = await svc.createDraft({ simulationId: simId });
    await expect(svc.writeFile(d, PREFIX, {
      manifestPath: 'a.js', bytes: JS, contentType: 'application/javascript', role: 'asset',
    })).rejects.toThrow(RevisionConflict);
  });

  it('refuses a traversing path rather than flattening it', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    for (const bad of ['../escape.js', 'a/../../escape.js', 'a//b.js', 'a/./b.js']) {
      await expect(svc.writeFile(up, PREFIX, {
        manifestPath: bad, bytes: JS, contentType: 'application/javascript', role: 'asset',
      })).rejects.toThrow(/unrepresentable manifest path/);
    }
    expect(adapter.uploadFile).not.toHaveBeenCalled();
  });

  it('normalizes a leading slash rather than rejecting it', async () => {
    // A leading slash is not an escape attempt — the normalized result is still inside the prefix.
    // Rejection is reserved for paths whose author expected to LEAVE the prefix.
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    const f = await svc.writeFile(up, PREFIX, {
      manifestPath: '/abs.js', bytes: JS, contentType: 'application/javascript', role: 'asset',
    });
    expect(f.path).toBe('abs.js');
    expect(adapter.objects.has(revisionFileKey(PREFIX, d.id, 'abs.js'))).toBe(true);
  });

  it('stores non-entry files immutable and the entry document revalidating', async () => {
    // The entry document is the exception: the boot snippet is injected at SERVE time, so served
    // bytes are not stored bytes — and its CSP frame-ancestors list is deploy-dependent.
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    await svc.writeFile(up, PREFIX, {
      manifestPath: 'package/index.html', bytes: HTML,
      contentType: 'text/html; charset=utf-8', role: 'entry',
    });
    await svc.writeFile(up, PREFIX, {
      manifestPath: 'runtime/bridge.js', bytes: JS, contentType: 'application/javascript', role: 'runtime',
    });
    expect(adapter.objects.get(revisionFileKey(PREFIX, d.id, 'package/index.html'))!.cacheControl)
      .toBe(POINTER_CACHE_CONTROL);
    expect(adapter.objects.get(revisionFileKey(PREFIX, d.id, 'runtime/bridge.js'))!.cacheControl)
      .toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('treats any .html as an entry document regardless of declared role', async () => {
    expect(cacheControlForRole('asset', 'package/embedded.html')).toBe(POINTER_CACHE_CONTROL);
    expect(cacheControlForRole('asset', 'package/data.json')).toBe(IMMUTABLE_CACHE_CONTROL);
  });
});

// ── Verification ─────────────────────────────────────────────────────────────────────────────────

describe('verifyStoredBytes', () => {
  it('verifies bytes and metadata when the store reports them', async () => {
    const { id } = await publish();
    const rev = (await svc.listRevisions(simId)).find((r) => r.id === id)!;
    const report = await svc.verifyStoredBytes(rev, PREFIX, manifestFor(STD_FILES));
    expect(report.problems).toEqual([]);
    expect(report.bytesVerified).toBe(2);
    expect(report.metadataVerified).toBe(2);
    expect(report.metadataUnverified).toBe(0);
  });

  it('counts metadata UNVERIFIED, never verified, when the store cannot report it', async () => {
    // Local disk stores no per-object metadata. Reporting those as verified would be a lie that
    // looks exactly like a pass.
    const { id } = await publish();
    adapter.metadataBlind = true;
    const rev = (await svc.listRevisions(simId)).find((r) => r.id === id)!;
    const report = await svc.verifyStoredBytes(rev, PREFIX, manifestFor(STD_FILES));
    expect(report.problems).toEqual([]);
    expect(report.bytesVerified).toBe(2);
    expect(report.metadataVerified).toBe(0);
    expect(report.metadataUnverified).toBe(2);
  });

  it('catches bytes that do not match the manifest hash', async () => {
    // An upload call that resolves is not proof the object landed intact.
    const { id } = await publish();
    const key = revisionFileKey(PREFIX, id, 'runtime/bridge.js');
    adapter.objects.set(key, { ...adapter.objects.get(key)!, bytes: Buffer.from('short') });
    const rev = (await svc.listRevisions(simId)).find((r) => r.id === id)!;
    const report = await svc.verifyStoredBytes(rev, PREFIX, manifestFor(STD_FILES));
    expect(report.problems.map((p) => p.code)).toContain('size-mismatch');
  });

  it('catches same-length bytes that differ', async () => {
    const { id } = await publish();
    const key = revisionFileKey(PREFIX, id, 'runtime/bridge.js');
    const tampered = Buffer.from(JS); tampered[0] = 0x58;
    adapter.objects.set(key, { ...adapter.objects.get(key)!, bytes: tampered });
    const rev = (await svc.listRevisions(simId)).find((r) => r.id === id)!;
    const report = await svc.verifyStoredBytes(rev, PREFIX, manifestFor(STD_FILES));
    expect(report.problems.map((p) => p.code)).toContain('hash-mismatch');
  });

  it('catches a file that never landed', async () => {
    const { id } = await publish();
    adapter.objects.delete(revisionFileKey(PREFIX, id, 'runtime/bridge.js'));
    const rev = (await svc.listRevisions(simId)).find((r) => r.id === id)!;
    const report = await svc.verifyStoredBytes(rev, PREFIX, manifestFor(STD_FILES));
    expect(report.problems.map((p) => p.code)).toContain('missing');
  });

  it('catches a stored Cache-Control that disagrees with the manifest', async () => {
    const { id } = await publish();
    const key = revisionFileKey(PREFIX, id, 'runtime/bridge.js');
    adapter.objects.set(key, { ...adapter.objects.get(key)!, cacheControl: 'no-store' });
    const rev = (await svc.listRevisions(simId)).find((r) => r.id === id)!;
    const report = await svc.verifyStoredBytes(rev, PREFIX, manifestFor(STD_FILES));
    expect(report.problems.map((p) => p.code)).toContain('cache-control-mismatch');
  });

  it('fails the revision and writes NO manifest when verification fails', async () => {
    // A revision whose manifest exists is a revision whose bytes were checked.
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    for (const f of STD_FILES) {
      await svc.writeFile(up, PREFIX, {
        manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never });
    }
    adapter.objects.delete(revisionFileKey(PREFIX, d.id, 'runtime/bridge.js'));
    const validating = await svc.finishUpload(simId, d.id);
    const res = await svc.validate(simId, validating, PREFIX, { manifest: manifestFor(STD_FILES) });

    expect(res.ok).toBe(false);
    const [row] = await rows<{ status: string; manifest_hash: string | null }>(
      `SELECT status, manifest_hash FROM sim_revisions WHERE id = $1`, [d.id]);
    expect(row!.status).toBe('failed');
    expect(row!.manifest_hash).toBeNull();
    expect(adapter.objects.has(`${PREFIX}/revisions/${d.id}/manifest.json`)).toBe(false);
  });

  it('fails the revision when the manifest itself is invalid', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    for (const f of STD_FILES) {
      await svc.writeFile(up, PREFIX, {
        manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never });
    }
    const validating = await svc.finishUpload(simId, d.id);
    const bad = manifestFor(STD_FILES);
    const res = await svc.validate(simId, validating, PREFIX, {
      manifest: { ...bad, entry: 'package/missing.html' },
    });
    expect(res.ok).toBe(false);
    expect(res.problems.map((p) => p.code)).toContain('missing-entry');
  });
});

// ── Activation ───────────────────────────────────────────────────────────────────────────────────

describe('activate', () => {
  it('activates the first revision when the incumbent pointer is NULL', async () => {
    // The IS NOT DISTINCT FROM test. With eq(), `active_revision_id = NULL` is never true, so first
    // activation would be impossible while the code looked entirely correct.
    const { id } = await publish();
    const res = await svc.activate({
      simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired',
    });
    expect(res.activated.status).toBe('active');
    expect(res.superseded).toBeNull();
    const p = await svc.readPointer(simId);
    expect(p.activeRevisionId).toBe(id);
    expect(p.entryKey).toBe(revisionFileKey(PREFIX, id, 'package/index.html'));
  });

  it('demotes the incumbent and promotes the successor', async () => {
    const first = await publish();
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const second = await publish();
    const res = await svc.activate({ simulationId: simId, revisionId: second.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: first.id, supersede: 'retired' });

    expect(res.superseded).toBe(first.id);
    const all = await svc.listRevisions(simId);
    expect(all.find((r) => r.id === first.id)!.status).toBe('retired');
    expect(all.find((r) => r.id === second.id)!.status).toBe('active');
  });

  it('refuses a stale expected pointer', async () => {
    const first = await publish();
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const second = await publish();
    // A caller that read the pointer before `first` was activated still believes it is null.
    await expect(svc.activate({
      simulationId: simId, revisionId: second.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired',
    })).rejects.toThrow(RevisionConflict);
  });

  it('exactly one of two racing activations wins', async () => {
    // The adversarial case. Both callers read the same (null) pointer and both try to promote.
    const a = await publish();
    const b = await publish();
    const results = await Promise.allSettled([
      svc.activate({ simulationId: simId, revisionId: a.id, storagePrefix: PREFIX,
        expectedActiveRevisionId: null, supersede: 'retired' }),
      svc.activate({ simulationId: simId, revisionId: b.id, storagePrefix: PREFIX,
        expectedActiveRevisionId: null, supersede: 'retired' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const [{ n }] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM sim_revisions WHERE status = 'active'`);
    expect(n).toBe(1);
    const p = await svc.readPointer(simId);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ activated: { id: string } }>;
    expect(p.activeRevisionId).toBe(winner.value.activated.id);
  });

  it('refuses to activate a revision that was never validated', async () => {
    // manifest_hash / entry_path NOT NULL in the promote CAS. A caller that skipped validate()
    // cannot promote unverified bytes even by calling activate directly.
    const d = await svc.createDraft({ simulationId: simId });
    await pg.query(`UPDATE sim_revisions SET status = 'canary_passed' WHERE id = $1`, [d.id]);
    await expect(svc.activate({
      simulationId: simId, revisionId: d.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired',
    })).rejects.toThrow(/target is not activatable/);
  });

  it('refuses to activate straight from draft', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    await expect(svc.activate({
      simulationId: simId, revisionId: d.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired',
    })).rejects.toThrow(RevisionConflict);
  });

  it('refuses a revision with no manifest_hash even when everything else is in order', async () => {
    // ISOLATES the manifest_hash predicate. The "never validated" test above leaves entry_path
    // null too, so it kills the PAIR without proving either half — dropping just this guard
    // survived it. Unverified bytes must be unactivatable on their own account.
    const d = await svc.createDraft({ simulationId: simId });
    await pg.query(
      `UPDATE sim_revisions SET status='canary_passed', entry_path='package/index.html' WHERE id=$1`,
      [d.id]);
    await expect(svc.activate({
      simulationId: simId, revisionId: d.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired',
    })).rejects.toThrow(/target is not activatable/);
  });

  it('refuses a revision with no entry_path even when everything else is in order', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    await pg.query(
      `UPDATE sim_revisions SET status='canary_passed', manifest_hash=$2 WHERE id=$1`,
      [d.id, 'a'.repeat(64)]);
    await expect(svc.activate({
      simulationId: simId, revisionId: d.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired',
    })).rejects.toThrow(/target is not activatable/);
  });

  it('refuses to promote from a status the machine forbids, even when fully validated', async () => {
    // ISOLATES the source-status predicate. A fully-validated revision sitting in `draft` or
    // `uploading` still has not passed a canary, and must not be promotable.
    for (const status of ['draft', 'uploading', 'validating', 'failed']) {
      const d = await svc.createDraft({ simulationId: simId });
      await pg.query(
        `UPDATE sim_revisions SET status=$2, manifest_hash=$3, entry_path='package/index.html'
          WHERE id=$1`, [d.id, status, 'a'.repeat(64)]);
      await expect(svc.activate({
        simulationId: simId, revisionId: d.id, storagePrefix: PREFIX,
        expectedActiveRevisionId: null, supersede: 'retired',
      })).rejects.toThrow(/target is not activatable/);
    }
  });

  it('refuses when the pointer moved even though the statuses still agree', async () => {
    // ISOLATES the pointer CAS. The status predicates cannot see this: the caller's expected
    // incumbent really is active, so the demote succeeds and the promote succeeds — only the
    // POINTER has moved out from under it. Without this predicate the flip is last-writer-wins,
    // and the simulation ends up serving a revision nobody asked to activate.
    const first = await publish();
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const second = await publish();

    // Model a pointer that moved between the caller's read and its write.
    await pg.query(
      `UPDATE simulations SET active_revision_id=NULL, active_revision_entry_key=NULL WHERE id=$1`,
      [simId]);

    await expect(svc.activate({
      simulationId: simId, revisionId: second.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: first.id, supersede: 'retired',
    })).rejects.toThrow(/active_revision_id moved/);

    // And the transaction rolled back cleanly: first is still the active revision.
    const all = await svc.listRevisions(simId);
    expect(all.find((r) => r.id === first.id)!.status).toBe('active');
  });

  it('refuses to demote an incumbent that is no longer active', async () => {
    // ISOLATES the demote CAS. The caller names a real revision and the pointer agrees, but that
    // revision has already been superseded — so demoting it would overwrite a retired_at and
    // silently re-stamp history.
    const first = await publish();
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const second = await publish();
    await svc.activate({ simulationId: simId, revisionId: second.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: first.id, supersede: 'retired' });
    const third = await publish();

    // Pointer says `first`, but `first` is retired — the divergence a CAS exists to catch.
    await pg.query(
      `UPDATE simulations SET active_revision_id=$1, active_revision_entry_key='k' WHERE id=$2`,
      [first.id, simId]);

    await expect(svc.activate({
      simulationId: simId, revisionId: third.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: first.id, supersede: 'retired',
    })).rejects.toThrow(/incumbent is no longer active/);
  });

  it('leaves nothing half-applied when the promote fails', async () => {
    // The demote and the promote are in one transaction. If the promote is refused, the incumbent
    // must still be active — otherwise a failed activation takes the live package down with it.
    const first = await publish();
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const unvalidated = await svc.createDraft({ simulationId: simId });
    await pg.query(`UPDATE sim_revisions SET status = 'canary_passed' WHERE id = $1`, [unvalidated.id]);

    await expect(svc.activate({
      simulationId: simId, revisionId: unvalidated.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: first.id, supersede: 'retired',
    })).rejects.toThrow(RevisionConflict);

    const all = await svc.listRevisions(simId);
    expect(all.find((r) => r.id === first.id)!.status).toBe('active');
    expect((await svc.readPointer(simId)).activeRevisionId).toBe(first.id);
  });
});

// ── The canary verdict projection ────────────────────────────────────────────────────────────────

describe('canary verdict', () => {
  it('recordCanary writes to the revision and never to the simulations row', async () => {
    const { id } = await publish();
    await svc.recordCanary(simId, id, {
      classification: 'managed-presentable', report: { ok: true }, ranAt: new Date(),
    });
    const [rev] = await rows<{ package_class: string }>(
      `SELECT package_class FROM sim_revisions WHERE id = $1`, [id]);
    expect(rev!.package_class).toBe('managed-presentable');
    const [sim] = await rows<{ package_class: string | null }>(
      `SELECT package_class FROM simulations WHERE id = $1`, [simId]);
    // A canary against a not-yet-active revision must not change how the player treats the LIVE one.
    expect(sim!.package_class).toBeNull();
  });

  it('activation projects the revision verdict onto the simulations row', async () => {
    const { id } = await publish();
    await svc.recordCanary(simId, id, {
      classification: 'managed-presentable', report: { ok: true }, ranAt: new Date(),
    });
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const [sim] = await rows<{ package_class: string; canary_report: unknown }>(
      `SELECT package_class, canary_report FROM simulations WHERE id = $1`, [simId]);
    expect(sim!.package_class).toBe('managed-presentable');
    expect(sim!.canary_report).toEqual({ ok: true });
  });

  it('activating an un-canaried revision projects NULL — unproven means the legacy path', async () => {
    const proven = await publish();
    await svc.recordCanary(simId, proven.id, {
      classification: 'managed-presentable', report: { ok: true }, ranAt: new Date() });
    await svc.activate({ simulationId: simId, revisionId: proven.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });

    const unproven = await publish();
    await svc.activate({ simulationId: simId, revisionId: unproven.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: proven.id, supersede: 'retired' });

    const [sim] = await rows<{ package_class: string | null }>(
      `SELECT package_class FROM simulations WHERE id = $1`, [simId]);
    // The previous revision's verdict must NOT survive onto bytes no canary ran against.
    expect(sim!.package_class).toBeNull();
  });
});

// ── Rollback ─────────────────────────────────────────────────────────────────────────────────────

describe('rollback', () => {
  it('restores the previous revision and marks the withdrawn one rolled_back', async () => {
    const first = await publish();
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const second = await publish();
    await svc.activate({ simulationId: simId, revisionId: second.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: first.id, supersede: 'retired' });

    const res = await svc.rollback({ simulationId: simId, storagePrefix: PREFIX,
      expectedActiveRevisionId: second.id, reason: 'bad release' });

    expect(res.activated.id).toBe(first.id);
    const all = await svc.listRevisions(simId);
    // 'rolled_back' not 'retired': the audit history must be able to answer WHY a revision stopped
    // serving, and "a human judged it wrong" is not "something newer took over".
    expect(all.find((r) => r.id === second.id)!.status).toBe('rolled_back');
    expect((await svc.readPointer(simId)).activeRevisionId).toBe(first.id);
  });

  it('restores the target verdict rather than clearing it', async () => {
    const first = await publish();
    await svc.recordCanary(simId, first.id, {
      classification: 'managed-presentable', report: { v: 1 }, ranAt: new Date() });
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const second = await publish();
    await svc.activate({ simulationId: simId, revisionId: second.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: first.id, supersede: 'retired' });

    await svc.rollback({ simulationId: simId, storagePrefix: PREFIX,
      expectedActiveRevisionId: second.id, reason: 'regression' });

    const [sim] = await rows<{ package_class: string | null }>(
      `SELECT package_class FROM simulations WHERE id = $1`, [simId]);
    // Clearing would demote a package that was proven for these exact bytes to the legacy path.
    expect(sim!.package_class).toBe('managed-presentable');
  });

  it('rolls back twice by activation time, not by revision number', async () => {
    const r1 = await publish();
    await svc.activate({ simulationId: simId, revisionId: r1.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const r2 = await publish();
    await svc.activate({ simulationId: simId, revisionId: r2.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: r1.id, supersede: 'retired' });
    const r3 = await publish();
    await svc.activate({ simulationId: simId, revisionId: r3.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: r2.id, supersede: 'retired' });

    // Back to r2.
    await svc.rollback({ simulationId: simId, storagePrefix: PREFIX,
      expectedActiveRevisionId: r3.id, reason: 'one' });
    expect((await svc.readPointer(simId)).activeRevisionId).toBe(r2.id);

    // Back again: r3 is now the most recently activated non-current revision, NOT r1. Ordering by
    // revision_number would send us to r1 and skip the one we just came from.
    await svc.rollback({ simulationId: simId, storagePrefix: PREFIX,
      expectedActiveRevisionId: r2.id, reason: 'two' });
    expect((await svc.readPointer(simId)).activeRevisionId).toBe(r3.id);
  });

  it('refuses when there is nothing to roll back to', async () => {
    const only = await publish();
    await svc.activate({ simulationId: simId, revisionId: only.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    await expect(svc.rollback({ simulationId: simId, storagePrefix: PREFIX,
      expectedActiveRevisionId: only.id, reason: 'x' })).rejects.toThrow(/no retained revision/);
  });

  it('never rolls back onto the revision that is currently live', async () => {
    const first = await publish();
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    // A caller whose pointer read was stale (null) must not be handed back the live revision.
    await expect(svc.rollback({ simulationId: simId, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, reason: 'x' })).rejects.toThrow(/no retained revision/);
  });
});

// ── Garbage collection ───────────────────────────────────────────────────────────────────────────

describe('gc', () => {
  it('never deletes the active revision', async () => {
    const { id } = await publish();
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 1 });
    expect(res.deleted).not.toContain(id);
    expect(adapter.objects.has(revisionFileKey(PREFIX, id, 'package/index.html'))).toBe(true);
  });

  it('collects failed revisions and their bytes', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    await svc.writeFile(up, PREFIX, {
      manifestPath: 'a.js', bytes: JS, contentType: 'application/javascript', role: 'asset' });
    await svc.markFailed(simId, d.id, 'uploading', 'boom');

    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 2 });
    expect(res.deleted).toContain(d.id);
    expect(adapter.objects.has(revisionFileKey(PREFIX, d.id, 'a.js'))).toBe(false);
  });

  it('retains rollback targets up to keepLastN', async () => {
    const first = await publish();
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const second = await publish();
    await svc.activate({ simulationId: simId, revisionId: second.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: first.id, supersede: 'retired' });

    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 2 });
    expect(res.deleted).toEqual([]);
    // Both are reachable by rollback, so both must keep their bytes.
    expect(adapter.objects.has(revisionFileKey(PREFIX, first.id, 'package/index.html'))).toBe(true);
  });

  it('never touches anything outside a revision prefix', async () => {
    // Migration 050's rollback reverts every simulation to its legacy mutable path, which must
    // still hold a servable package.
    adapter.objects.set(`${PREFIX}/index.html`, { bytes: HTML, contentType: 'text/html' });
    const d = await svc.createDraft({ simulationId: simId });
    await svc.markFailed(simId, d.id, 'draft', 'x');
    await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 1 });
    expect(adapter.objects.has(`${PREFIX}/index.html`)).toBe(true);
    for (const call of adapter.deleteWithPrefix.mock.calls) {
      expect(String(call[0])).toContain('/revisions/');
    }
  });
});
