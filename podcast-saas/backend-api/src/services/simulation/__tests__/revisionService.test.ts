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
 * ON THE CONCURRENCY TESTS, PRECISELY
 * They are written as two promises started before either is awaited. That is not the same as a
 * genuine race, and this file previously claimed it was. PGlite holds an exclusive mutex across a
 * transaction, so the first runs to completion before the second's BEGIN — verified directly. What
 * these tests therefore prove is that the SQL is correct when the two orderings are serialised:
 * the CAS predicates, the demote-before-promote ordering, and that the partial unique index rejects
 * a second active row. What they do NOT exercise is row-lock blocking, EvalPlanQual re-evaluation,
 * or unique-index waiter behaviour under true concurrency. Those rest on the design argument in
 * RevisionService, not on anything that runs here.
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
} from 'shared/sim/simRevision';
import { SIM_MANIFEST_VERSION, type SimManifest } from 'shared/sim/simManifest';

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
    // DERIVED from the files, not hard-coded: a fixture naming a runtime file the list does not
    // contain fails validation for a reason that has nothing to do with the test.
    runtime: files.filter((f) => f.role === 'runtime').map((f) => f.path),
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
    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 1, minAgeMs: 0 });
    expect(res.deleted).not.toContain(id);
    expect(adapter.objects.has(revisionFileKey(PREFIX, id, 'package/index.html'))).toBe(true);
  });

  it('collects failed revisions and their bytes', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    await svc.writeFile(up, PREFIX, {
      manifestPath: 'a.js', bytes: JS, contentType: 'application/javascript', role: 'asset' });
    await svc.markFailed(simId, d.id, 'uploading', 'boom');

    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 2, minAgeMs: 0 });
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

    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 2, minAgeMs: 0 });
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
    await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 1, minAgeMs: 0 });
    expect(adapter.objects.has(`${PREFIX}/index.html`)).toBe(true);
    for (const call of adapter.deleteWithPrefix.mock.calls) {
      expect(String(call[0])).toContain('/revisions/');
    }
  });
});

// ══ REVIEW FINDINGS ══════════════════════════════════════════════════════════════════════════

describe('gc — the active revision is never collectable', () => {
  it('survives a nonsensical keepLastN', async () => {
    // Math.max(1, NaN) is NaN and slice(0, NaN) is empty, which emptied `keep` and made the ACTIVE
    // revision's bytes AND row collectable. A keepLastN arriving from a query string is exactly how
    // that happens.
    const { id } = await publish();
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });

    for (const bad of [NaN, undefined as unknown as number, 'x' as unknown as number]) {
      const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: bad, minAgeMs: 0 });
      expect(res.deleted, `keepLastN ${String(bad)} collected the live revision`).not.toContain(id);
    }
    expect(adapter.objects.has(revisionFileKey(PREFIX, id, 'package/index.html'))).toBe(true);
    const [{ n }] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM sim_revisions WHERE status = 'active'`);
    expect(n).toBe(1);
  });

  it('skips a revision whose status changed DURING the sweep, keeping its bytes', async () => {
    // The row delete carries a CAS on the status that was read. Isolating it needs the status to
    // move between the read and the delete, so the change is made from inside the byte-delete of an
    // EARLIER revision in the same sweep — which is exactly the interleaving the CAS defends
    // against, and the only way to reach it without a fake clock.
    const a = await svc.createDraft({ simulationId: simId });
    const upA = await svc.beginUpload(simId, a.id);
    await svc.writeFile(upA, PREFIX, {
      manifestPath: 'a.js', bytes: JS, contentType: 'application/javascript', role: 'asset' });
    await svc.markFailed(simId, a.id, 'uploading', 'boom');

    const b = await svc.createDraft({ simulationId: simId });
    const upB = await svc.beginUpload(simId, b.id);
    await svc.writeFile(upB, PREFIX, {
      manifestPath: 'b.js', bytes: JS, contentType: 'application/javascript', role: 'asset' });
    await svc.markFailed(simId, b.id, 'uploading', 'boom');

    let moved = false;
    adapter.deleteWithPrefix.mockImplementation(async (prefix: string) => {
      if (!moved) {
        moved = true;
        // B is retained now — its status no longer matches what the sweep read.
        await pg.query(
          `UPDATE sim_revisions SET status='retired', activated_at=now() WHERE id=$1`, [b.id]);
      }
      for (const k of [...adapter.objects.keys()]) if (k.startsWith(prefix)) adapter.objects.delete(k);
    });

    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 1, minAgeMs: 0 });
    expect(res.deleted, 'a revision that moved mid-sweep was collected anyway').not.toContain(b.id);
    expect(adapter.objects.has(revisionFileKey(PREFIX, b.id, 'b.js'))).toBe(true);
  });

  it('deletes the ROW before the bytes, so a crash cannot strand a pointer target', async () => {
    // The reverse order leaves a window where a retained row's bytes are gone; rollbackTargetFor
    // would then select it and activate() would flip the pointer to a dead prefix, so the
    // simulation serves nothing. Asserted directly: at the moment the bytes go, the row must
    // already be gone.
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    await svc.writeFile(up, PREFIX, {
      manifestPath: 'a.js', bytes: JS, contentType: 'application/javascript', role: 'asset' });
    await svc.markFailed(simId, d.id, 'uploading', 'boom');

    // Record EVERY observation, and assert on the FIRST. Keeping only the last would pass for an
    // implementation that deletes bytes first and then again after the row.
    const observed: number[] = [];
    adapter.deleteWithPrefix.mockImplementation(async () => {
      const [{ n }] = await rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM sim_revisions WHERE id = $1`, [d.id]);
      observed.push(n);
    });

    await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 1, minAgeMs: 0 });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed[0], 'bytes were deleted while the row still existed').toBe(0);
  });
});

describe('recordCanary is compare-and-set, like every other mutation here', () => {
  it('refuses a verdict for a revision that is already active', async () => {
    // A late canary overwriting the verdict of an activated revision would be projected onto the
    // simulations row by the next rollback — a stale verdict describing bytes it never ran against.
    const { id } = await publish();
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });

    await expect(svc.recordCanary(simId, id, {
      classification: 'managed-presentable', report: { late: true }, ranAt: new Date(),
    })).rejects.toThrow(RevisionConflict);

    const [rev] = await rows<{ package_class: string | null }>(
      `SELECT package_class FROM sim_revisions WHERE id = $1`, [id]);
    expect(rev!.package_class).toBeNull();
  });

  it('refuses a verdict for a failed revision', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    await svc.markFailed(simId, d.id, 'draft', 'boom');
    await expect(svc.recordCanary(simId, d.id, {
      classification: 'failed', report: {}, ranAt: new Date(),
    })).rejects.toThrow(RevisionConflict);
  });

  it('accepts a verdict while the revision is still being published', async () => {
    const { id } = await publish();
    await expect(svc.recordCanary(simId, id, {
      classification: 'managed-presentable', report: { ok: true }, ranAt: new Date(),
    })).resolves.toBeUndefined();
  });
});

// ══ PACKAGE WEIGHT — before/after evidence (P8.11) ═══════════════════════════════════════════

describe('weight is recorded at publication, so an optimisation claim is checkable', () => {
  it('records the measured weight on the revision', async () => {
    const { id } = await publish();
    const [row] = await rows<{ metadata: { weight?: { totalBytes: number; fileCount: number } } }>(
      `SELECT metadata FROM sim_revisions WHERE id = $1`, [id]);
    expect(row!.metadata.weight).toBeDefined();
    // The bytes actually published, not an estimate.
    expect(row!.metadata.weight!.totalBytes).toBe(HTML.length + JS.length);
    expect(row!.metadata.weight!.fileCount).toBe(2);
  });

  it('compares two revisions as a delta of MEASUREMENTS', async () => {
    const before = await publish();

    // Publish a lighter revision: same entry, a smaller runtime.
    const small = Buffer.from('x', 'utf8');
    const draft = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, draft.id);
    const files = [
      { path: 'package/index.html', bytes: HTML, contentType: 'text/html; charset=utf-8', role: 'entry' },
      { path: 'runtime/bridge.js', bytes: small, contentType: 'application/javascript', role: 'runtime' },
    ];
    for (const f of files) {
      await svc.writeFile(up, PREFIX, {
        manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never });
    }
    const validating = await svc.finishUpload(simId, draft.id);
    await svc.validate(simId, validating, PREFIX, { manifest: manifestFor(files) });

    const cmp = await svc.compareRevisionWeight(simId, before.id, draft.id);
    expect(cmp).not.toBeNull();
    // Negative = a saving, the way an engineer reads it.
    expect(cmp!.deltaBytes).toBe(small.length - JS.length);
    expect(cmp!.improved).toBe(true);
    expect(cmp!.percentChange).toBeLessThan(0);
  });

  it('returns null rather than 0 when a revision predates weight recording', async () => {
    // A zero would read as "no change" for a comparison that cannot be made at all.
    const a = await publish();
    const b = await publish();
    await pg.query(`UPDATE sim_revisions SET metadata = '{}'::jsonb WHERE id = $1`, [a.id]);
    expect(await svc.compareRevisionWeight(simId, a.id, b.id)).toBeNull();
  });

  it('is ADVISORY — a package with findings still publishes', async () => {
    // These are the customer's own files; refusing to publish would fail real content over a
    // threshold this code chose.
    const huge = Buffer.alloc(600 * 1024, 0x41);
    const draft = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, draft.id);
    const files = [
      { path: 'package/index.html', bytes: HTML, contentType: 'text/html; charset=utf-8', role: 'entry' },
      { path: 'package/big.png', bytes: huge, contentType: 'image/png', role: 'asset' },
    ];
    for (const f of files) {
      await svc.writeFile(up, PREFIX, {
        manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never });
    }
    const validating = await svc.finishUpload(simId, draft.id);
    const res = await svc.validate(simId, validating, PREFIX, { manifest: manifestFor(files) });
    expect(res.ok, 'a heavy package was refused publication').toBe(true);

    const [row] = await rows<{ metadata: { weight?: { findings: { code: string }[] } } }>(
      `SELECT metadata FROM sim_revisions WHERE id = $1`, [draft.id]);
    expect(row!.metadata.weight!.findings.map((f) => f.code)).toContain('oversized-image');
  });
});

describe('gc — the age guard', () => {
  it('refuses to collect a revision younger than the grace period', async () => {
    // A publication in flight has a row and a partly-written prefix and is not retained by status,
    // so an age-blind sweep deletes both while the publisher is still writing into it. The
    // publisher checks its own in-memory record and never re-reads the row, so it keeps writing —
    // and those files are permanent orphans, because nothing lists storage.
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    await svc.writeFile(up, PREFIX, {
      manifestPath: 'a.js', bytes: JS, contentType: 'application/javascript', role: 'asset' });

    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 2 });
    expect(res.deleted, 'an in-flight publication was collected').not.toContain(d.id);
    expect(adapter.objects.has(revisionFileKey(PREFIX, d.id, 'a.js'))).toBe(true);
  });

  it('collects the same revision once it is past the grace period', async () => {
    // The guard must delay collection, not prevent it — otherwise abandoned drafts accumulate.
    const d = await svc.createDraft({ simulationId: simId });
    const up = await svc.beginUpload(simId, d.id);
    await svc.writeFile(up, PREFIX, {
      manifestPath: 'a.js', bytes: JS, contentType: 'application/javascript', role: 'asset' });
    await svc.markFailed(simId, d.id, 'uploading', 'boom');

    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 2, minAgeMs: 0 });
    expect(res.deleted).toContain(d.id);
  });
});

describe('gc — keepLastN cannot annihilate the rollback path', () => {
  it('keeps a rollback target even when asked to keep only one', async () => {
    // `retained` is newest-first and its head is always the ACTIVE revision, so keepLastN:1 keeps
    // only what is being served and collects every revision rollback could return to — reporting
    // success while removing the recovery path. 1 was also what a non-finite value coerced to.
    const first = await publish();
    await svc.activate({ simulationId: simId, revisionId: first.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const second = await publish();
    await svc.activate({ simulationId: simId, revisionId: second.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: first.id, supersede: 'retired' });

    const res = await svc.gc({ simulationId: simId, storagePrefix: PREFIX, keepLastN: 1, minAgeMs: 0 });
    expect(res.deleted, 'the only rollback target was collected').not.toContain(first.id);
    expect(adapter.objects.has(revisionFileKey(PREFIX, first.id, 'package/index.html'))).toBe(true);
  });
});

describe('markFailed cannot wedge a live simulation', () => {
  it('refuses to fail the ACTIVE revision in place', async () => {
    // The pointer would keep naming it — the player reads the pointer, never the status — while
    // every later activation and rollback CAS expects an incumbent that no longer exists in that
    // state. There is no repair path, so the only safe answer is to refuse.
    const { id } = await publish();
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });

    await expect(svc.markFailed(simId, id, 'active', 'boom')).rejects.toThrow(RevisionConflict);

    const [row] = await rows<{ status: string }>(
      `SELECT status FROM sim_revisions WHERE id = $1`, [id]);
    expect(row!.status).toBe('active');
    const [sim] = await rows<{ active_revision_id: string | null }>(
      `SELECT active_revision_id FROM simulations WHERE id = $1`, [simId]);
    expect(sim!.active_revision_id).toBe(id);
  });

  it('still fails a revision that is not live', async () => {
    const d = await svc.createDraft({ simulationId: simId });
    const r = await svc.markFailed(simId, d.id, 'draft', 'boom');
    expect(r.status).toBe('failed');
  });
});

describe('activation cannot point at a prefix that is not the simulation\'s own', () => {
  it('refuses a storagePrefix that does not match the simulation row', async () => {
    // `active_revision_entry_key` is composed from the caller's prefix and `sim_revisions` has no
    // prefix column, so nothing else in the transaction can notice. The pointer would name bytes
    // that were never written, and the read path has no fallback for that — the simulation serves
    // nothing, with no error recorded anywhere.
    const { id } = await publish();
    await expect(svc.activate({
      simulationId: simId, revisionId: id, storagePrefix: 'simulations/other/sim',
      expectedActiveRevisionId: null, supersede: 'retired',
    })).rejects.toThrow(RevisionConflict);

    const [sim] = await rows<{ active_revision_id: string | null }>(
      `SELECT active_revision_id FROM simulations WHERE id = $1`, [simId]);
    expect(sim!.active_revision_id, 'the pointer moved despite the refusal').toBeNull();
  });

  it('still activates with the simulation\'s real prefix', async () => {
    const { id } = await publish();
    const res = await svc.activate({
      simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired',
    });
    expect(res.activated.id).toBe(id);
  });
});

// ── Bridge acknowledgement capability (migration 055, audit P0.5) ────────────────────────────────
//
// The viewer's apply gate needs to know, BEFORE a package's first activation, whether its bridge
// posts SCRIPT_APPLIED — in-session evidence by definition does not exist at that moment, and the
// gate used to resolve the absence by revealing, over whatever the pooled document had drawn. The
// fact is recorded on the revision (in `metadata`, beside the weight report) and PROJECTED onto the
// simulations row in the pointer flip, for exactly the reason the canary verdict is: it describes
// BYTES, so after a rollback it has to describe the revision the pointer now names.

describe('bridge_ack_capable — projected with the pointer, like the verdict', () => {
  /** Publish a revision whose metadata carries a capability record. */
  async function publishWithCapability(scriptApplied: boolean | undefined): Promise<string> {
    const draft = await svc.createDraft({
      simulationId: simId,
      metadata: scriptApplied === undefined ? {} : { bridgeCapabilities: { scriptApplied } },
    });
    const up = await svc.beginUpload(simId, draft.id);
    for (const f of STD_FILES) {
      await svc.writeFile(up, PREFIX, {
        manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never,
      });
    }
    const validating = await svc.finishUpload(simId, draft.id);
    const res = await svc.validate(simId, validating, PREFIX, { manifest: manifestFor(STD_FILES) });
    expect(res.ok).toBe(true);
    return draft.id;
  }

  const projected = async (): Promise<boolean | null> => {
    const [sim] = await rows<{ bridge_ack_capable: boolean | null }>(
      `SELECT bridge_ack_capable FROM simulations WHERE id = $1`, [simId]);
    return sim!.bridge_ack_capable;
  };

  it('projects TRUE for a bridge that acknowledges', async () => {
    const id = await publishWithCapability(true);
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    expect(await projected()).toBe(true);
  });

  it('projects FALSE for a bridge that does not', async () => {
    const id = await publishWithCapability(false);
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    expect(await projected()).toBe(false);
  });

  it('projects NULL when the revision predates the record — never a confident false', async () => {
    // Every package published before 055. NULL is UNKNOWN, which the gate handles as its own case;
    // a `false` here would tell the viewer "this bridge cannot acknowledge, so reveal on sight",
    // which is the hole restored by a default.
    const id = await publishWithCapability(undefined);
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    expect(await projected()).toBeNull();
  });

  it('survives validate(), which rewrites the metadata column to add the weight report', async () => {
    // `validate` sets `metadata` wholesale. Spreading the existing record is what keeps the
    // capability alive to reach activation at all; without it this column is NULL for every package
    // and the whole mechanism is inert while every other test still passes.
    const id = await publishWithCapability(true);
    const [rev] = await rows<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM sim_revisions WHERE id = $1`, [id]);
    expect(rev!.metadata).toHaveProperty('weight');
    expect(rev!.metadata).toHaveProperty('bridgeCapabilities');
  });

  it('A ROLLBACK RE-PROJECTS THE TARGET: an acking package does not vouch for the one before it', async () => {
    const silent = await publishWithCapability(false);
    await svc.activate({ simulationId: simId, revisionId: silent, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const acking = await publishWithCapability(true);
    await svc.activate({ simulationId: simId, revisionId: acking, storagePrefix: PREFIX,
      expectedActiveRevisionId: silent, supersede: 'retired' });
    expect(await projected()).toBe(true);

    await svc.rollback({ simulationId: simId, storagePrefix: PREFIX,
      expectedActiveRevisionId: acking, reason: 'bad release' });
    // Left at `true`, the gate would hold every first activation of the rolled-back package waiting
    // for an acknowledgement its bridge cannot send — the section would sit behind a cover for its
    // whole duration, on the strength of a capability belonging to bytes no longer served.
    expect(await projected(), 'the capability described the withdrawn revision').toBe(false);
  });

  it('ignores a malformed record rather than trusting it', async () => {
    const draft = await svc.createDraft({
      simulationId: simId, metadata: { bridgeCapabilities: { scriptApplied: 'yes' } },
    });
    const up = await svc.beginUpload(simId, draft.id);
    for (const f of STD_FILES) {
      await svc.writeFile(up, PREFIX, {
        manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never,
      });
    }
    const validating = await svc.finishUpload(simId, draft.id);
    await svc.validate(simId, validating, PREFIX, { manifest: manifestFor(STD_FILES) });
    await svc.activate({ simulationId: simId, revisionId: draft.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    expect(await projected()).toBeNull();
  });
});

// ── Import-map requirement (migration 057, audit P0.8) ───────────────────────────────────────────
//
// The second fact in the same capability record, projected by the same statement. It has to move
// with the pointer for a reason the ack does not even have: a republish can ADD or REMOVE the
// `<script type="importmap">` tag, so the answer genuinely differs between two revisions of one
// package — and a stale `true` costs a working simulation (replaced by a still image) while a stale
// `false` costs a permanently blank frame.

describe('requires_import_maps — projected with the pointer, like the ack', () => {
  async function publishRequiring(requiresImportMaps: boolean | undefined): Promise<string> {
    const draft = await svc.createDraft({
      simulationId: simId,
      metadata: requiresImportMaps === undefined ? {} : { bridgeCapabilities: { requiresImportMaps } },
    });
    const up = await svc.beginUpload(simId, draft.id);
    for (const f of STD_FILES) {
      await svc.writeFile(up, PREFIX, {
        manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never,
      });
    }
    const validating = await svc.finishUpload(simId, draft.id);
    const res = await svc.validate(simId, validating, PREFIX, { manifest: manifestFor(STD_FILES) });
    expect(res.ok).toBe(true);
    return draft.id;
  }

  const projected = async (): Promise<boolean | null> => {
    const [sim] = await rows<{ requires_import_maps: boolean | null }>(
      `SELECT requires_import_maps FROM simulations WHERE id = $1`, [simId]);
    return sim!.requires_import_maps;
  };

  it('projects TRUE for a package whose entry needs import maps', async () => {
    const id = await publishRequiring(true);
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    expect(await projected()).toBe(true);
  });

  it('projects FALSE for a package that does not', async () => {
    const id = await publishRequiring(false);
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    expect(await projected()).toBe(false);
  });

  it('projects NULL when the revision predates the record — never a guessed requirement', async () => {
    // Every package published before 057. NULL is UNKNOWN, and the viewer's floor leaves an unknown
    // package running exactly as it does today; a `true` here would poster it on every browser
    // without import maps for a need nobody ever detected.
    const id = await publishRequiring(undefined);
    await svc.activate({ simulationId: simId, revisionId: id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    expect(await projected()).toBeNull();
  });

  it('A ROLLBACK RE-PROJECTS THE TARGET: the newer revision does not vouch for the older one', async () => {
    // The realistic sequence: an old revision loads three.js from a CDN, the republish switches it
    // to an import map, the release is rolled back. Left at `true`, every viewer on an older WebKit
    // would see a poster instead of a simulation that runs perfectly well on their browser.
    const noMap = await publishRequiring(false);
    await svc.activate({ simulationId: simId, revisionId: noMap, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const withMap = await publishRequiring(true);
    await svc.activate({ simulationId: simId, revisionId: withMap, storagePrefix: PREFIX,
      expectedActiveRevisionId: noMap, supersede: 'retired' });
    expect(await projected()).toBe(true);

    await svc.rollback({ simulationId: simId, storagePrefix: PREFIX,
      expectedActiveRevisionId: withMap, reason: 'bad release' });
    expect(await projected(), 'the requirement described the withdrawn revision').toBe(false);
  });

  it('the two capabilities in one record are projected independently', async () => {
    // One JSONB key, two columns. A record that carries only the ack must not make the import-map
    // column say anything, and the reverse — otherwise "unknown" would be curable by luck.
    const draft = await svc.createDraft({
      simulationId: simId, metadata: { bridgeCapabilities: { scriptApplied: true } },
    });
    const up = await svc.beginUpload(simId, draft.id);
    for (const f of STD_FILES) {
      await svc.writeFile(up, PREFIX, {
        manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never,
      });
    }
    const validating = await svc.finishUpload(simId, draft.id);
    await svc.validate(simId, validating, PREFIX, { manifest: manifestFor(STD_FILES) });
    await svc.activate({ simulationId: simId, revisionId: draft.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    const [sim] = await rows<{ bridge_ack_capable: boolean | null; requires_import_maps: boolean | null }>(
      `SELECT bridge_ack_capable, requires_import_maps FROM simulations WHERE id = $1`, [simId]);
    expect(sim!.bridge_ack_capable).toBe(true);
    expect(sim!.requires_import_maps).toBeNull();
  });

  it('ignores a malformed record rather than trusting it', async () => {
    const draft = await svc.createDraft({
      simulationId: simId, metadata: { bridgeCapabilities: { requiresImportMaps: 'yes' } },
    });
    const up = await svc.beginUpload(simId, draft.id);
    for (const f of STD_FILES) {
      await svc.writeFile(up, PREFIX, {
        manifestPath: f.path, bytes: f.bytes, contentType: f.contentType, role: f.role as never,
      });
    }
    const validating = await svc.finishUpload(simId, draft.id);
    await svc.validate(simId, validating, PREFIX, { manifest: manifestFor(STD_FILES) });
    await svc.activate({ simulationId: simId, revisionId: draft.id, storagePrefix: PREFIX,
      expectedActiveRevisionId: null, supersede: 'retired' });
    expect(await projected()).toBeNull();
  });
});
