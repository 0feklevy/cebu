/**
 * Live section-bridge generation publishes a STAGED IMMUTABLE REVISION (audit P0.4).
 *
 * WHAT THIS FILE EXISTS TO PROVE
 * `SimulationService.uploadSectionBridge` used to overwrite `<prefix>/bridge.js` and the entry HTML
 * in place: two writes a viewer could land between, a client abort could orphan halfway, and a
 * concurrent generation could silently clobber. It now stages every byte under a never-reused
 * revision prefix and makes it live with ONE compare-and-set activation whose transaction also
 * carries the caller's section-row write. Nothing tested that the publication actually happens —
 * `revisionService.test.ts` proves the CAS machinery in isolation and `revisionMigration.test.ts`
 * proves the operator migration, but the live generation path that now depends on both had no
 * coverage at all. This file is that coverage.
 *
 * WHY PGlite AND NOT THE HOUSE db-FAKE
 * Same reasoning as `revisionService.test.ts`: every guarantee here is a guarantee about SQL. The
 * activation is one transaction containing three compare-and-sets, a pointer flip, a verdict
 * projection and the caller's hook — a hand-faked `db` would let all of them "pass" while proving
 * none, and the single most important case in this file (a hook that throws rolls back the WHOLE
 * activation) is meaningless without a real transaction. So `db/index.js` is bound to PGlite with
 * the real migrations replayed, and storage is an in-memory adapter that records every write.
 *
 * THE ENTRY POINT DRIVEN IS `applyMinimalUiOnly`
 * It is one of the three public entry points and the only one that reaches `uploadSectionBridge`
 * with no LLM in the way, so these cases exercise the real publication rather than a mock of it.
 * `generateBridgeScript` hands the same private method the same contract (its `persistSection` is
 * wrapped, nothing else differs); the source assertions at the bottom pin that it still does.
 *
 * ON THE CONCURRENCY CASES, PRECISELY
 * There is no genuine race here and this file does not claim one. The precondition a race PRODUCES
 * — the pointer moving between the publication's opening read and its activation — is created
 * explicitly, from a storage-write hook that fires mid-staging. What that proves is that the
 * activation CAS is evaluated against what the publication READ rather than against a re-read, and
 * that the loser damages nothing. Row-lock blocking and unique-index waiter behaviour under true
 * concurrency rest on the design argument in RevisionService, not on anything that runs here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';

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

const storageRef = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('../../storage/getStorageAdapter.js', () => ({ getStorageAdapter: () => storageRef.adapter }));

import {
  SimulationService, computeBridgeHash, type SectionPersistHook,
} from '../SimulationService.js';
import { RevisionService } from '../RevisionService.js';
import { RevisionMigration } from '../RevisionMigration.js';
import { timeline_sections, simulations } from '../../../db/schema.js';
import { IMMUTABLE_CACHE_CONTROL, POINTER_CACHE_CONTROL } from 'shared/sim/simRevision';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'db', 'migrations');

// ── The storage double ───────────────────────────────────────────────────────────────────────────

/**
 * An in-memory adapter that records EVERY write, in order.
 *
 * The write log is not decoration: "nothing writes into a published revision prefix" and "the
 * legacy prefix is never written again" are both statements about the SET OF KEYS this path
 * touches, and only a log can falsify them.
 *
 * `onUpload` is the injection point the concurrency and abort cases need. It fires after a write
 * lands and is NOT self-clearing — a callback that must run once guards itself, so that a hook
 * looking for a specific key is not consumed by the first unrelated write.
 */
function fakeStorage() {
  const objects = new Map<string, { bytes: Buffer; contentType: string; cacheControl?: string }>();
  const uploadLog: string[] = [];
  const hooks: { onUpload: ((key: string) => Promise<void> | void) | null } = { onUpload: null };
  return {
    objects,
    uploadLog,
    hooks,
    uploadFile: vi.fn(async (key: string, bytes: Buffer, contentType: string, cacheControl?: string) => {
      objects.set(key, { bytes, contentType, cacheControl });
      uploadLog.push(key);
      if (hooks.onUpload) await hooks.onUpload(key);
      return `https://cdn.test/${key}`;
    }),
    readObject: vi.fn(async (key: string) => {
      const o = objects.get(key);
      if (!o) throw new Error(`no such object: ${key}`);
      return o.bytes;
    }),
    headObject: vi.fn(async (key: string) => {
      const o = objects.get(key);
      if (!o) return null;
      return { contentType: o.contentType, cacheControl: o.cacheControl ?? null, size: o.bytes.length, etag: null };
    }),
    listObjects: vi.fn(async (p: string) => [...objects.keys()].filter((k) => k.startsWith(p))),
    deleteWithPrefix: vi.fn(async (p: string) => {
      for (const k of [...objects.keys()]) if (k.startsWith(p)) objects.delete(k);
    }),
    objectExists: vi.fn(async (k: string) => objects.has(k)),
    getSimPublicUrl: (k: string) => `https://cdn.test/${k}`,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────
//
// Deliberately the SAME four-object legacy package `revisionMigration.test.ts` uses, so the
// migration-on-write case can be compared against that suite's expectations file-for-file rather
// than against a fixture invented to make it pass.

const HTML = Buffer.from('<html><head></head><body>legacy</body></html>', 'utf8');
const BRIDGE = Buffer.from('window.__bridge = 1;\n', 'utf8');
const CSS = Buffer.from('body{margin:0}', 'utf8');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let pg: PGlite;
let adapter: ReturnType<typeof fakeStorage>;
let svc: SimulationService;
let revisions: RevisionService;
let migration: RevisionMigration;

let projectId: string;
let simId: string;
let sectionA: string;
let sectionB: string;
let prefix: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

const revPrefix = (revisionId: string): string => `${prefix}/revisions/${revisionId}`;

/** Every stored key beneath a prefix, sorted — the shape a layout assertion needs. */
const keysUnder = (p: string): string[] =>
  [...adapter.objects.keys()].filter((k) => k.startsWith(`${p}/`)).sort();

/** A key→bytes snapshot, so "these bytes were not touched" is checkable after the fact. */
const snapshotOf = (keys: string[]): Map<string, string> =>
  new Map(keys.map((k) => [k, adapter.objects.get(k)!.bytes.toString('base64')]));

/** The LEGACY package only — everything under the sim prefix that is not inside a revision. */
const legacyKeys = (): string[] => keysUnder(prefix).filter((k) => !k.startsWith(`${prefix}/revisions/`));

const simRow = async () => (await rows<{
  active_revision_id: string | null;
  active_revision_entry_key: string | null;
  bridge_hash: string | null;
  package_class: string | null;
  canary_report: unknown;
  canary_at: Date | null;
  prepare_budget_ms: number | null;
}>(
  `SELECT active_revision_id, active_revision_entry_key, bridge_hash, package_class,
          canary_report, canary_at, prepare_budget_ms
     FROM simulations WHERE id = $1`, [simId],
))[0]!;

const revisionRows = async () => rows<{
  id: string; revision_number: number; status: string; entry_path: string | null;
  package_class: string | null; created_by: string | null;
  metadata: Record<string, unknown> | null; retired_at: Date | null;
}>(`SELECT id, revision_number, status, entry_path, package_class, created_by, metadata, retired_at
      FROM sim_revisions WHERE simulation_id = $1 ORDER BY revision_number`, [simId]);

const sectionRow = async (id: string) => (await rows<{
  simulation_url: string | null; sim_meta: Record<string, unknown> | null; sim_script: string | null;
}>(`SELECT simulation_url, sim_meta, sim_script FROM timeline_sections WHERE id = $1`, [id]))[0]!;

/**
 * The controller's `persistSection`, in miniature.
 *
 * Same three properties as the real one: it writes the WHOLE patch (not only the url), it writes
 * through the transaction handle it is given, and it throws when the row is gone.
 */
function persistHook(sectionId: string) {
  const calls: Array<{ sectionUrl: string; bridgeHash: string }> = [];
  const hook: SectionPersistHook = async (tx, pub) => {
    calls.push(pub);
    const [row] = await tx
      .update(timeline_sections)
      .set({ simulation_url: pub.sectionUrl, sim_script: 'main', sim_meta: { bridgeHash: pub.bridgeHash } })
      .where(eq(timeline_sections.id, sectionId))
      .returning();
    if (!row) throw new Error('This section was removed during generation.');
  };
  return Object.assign(hook, { calls });
}

/** Generate section `id`'s bridge through the real publication path. */
const generate = (id: string, opts: { signal?: AbortSignal; persistSection?: SectionPersistHook } = {}) =>
  svc.applyMinimalUiOnly({
    simId, sectionId: id, projectId,
    entryKey: `${prefix}/index.html`,
    signal: opts.signal,
    persistSection: opts.persistSection ?? persistHook(id),
  });

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;

  const [org] = await rows<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const [p] = await rows<{ id: string }>(
    `INSERT INTO projects (org_id, title) VALUES ($1, 'P') RETURNING id`, [org!.id]);
  projectId = p!.id;
  const [v] = await rows<{ id: string }>(
    `INSERT INTO video_files (project_id, filename) VALUES ($1, 'v.mp4') RETURNING id`, [projectId]);

  // The service DERIVES `simulations/<projectId>/<simId>` as the prefix, and `activate()` refuses
  // any prefix that is not the simulation's own — so the row must carry the same one a real upload
  // would have written. It is filled in after the insert because the id is generated by the row.
  const [s] = await rows<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, bridge_hash)
     VALUES ($1, 'sim', 'pending', 'pending', 'H1') RETURNING id`, [projectId]);
  simId = s!.id;
  prefix = `simulations/${projectId}/${simId}`;
  await pg.query(`UPDATE simulations SET storage_prefix = $2, entry_file = $3 WHERE id = $1`,
    [simId, prefix, `${prefix}/index.html`]);

  const [a] = await rows<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, simulation_id)
     VALUES ($1, $2, 0, 5, 'simulation', $3) RETURNING id`, [projectId, v!.id, simId]);
  const [b] = await rows<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, simulation_id)
     VALUES ($1, $2, 5, 10, 'simulation', $3) RETURNING id`, [projectId, v!.id, simId]);
  sectionA = a!.id;
  sectionB = b!.id;

  adapter = fakeStorage();
  storageRef.adapter = adapter;
  adapter.objects.set(`${prefix}/index.html`, { bytes: HTML, contentType: 'text/html; charset=utf-8' });
  adapter.objects.set(`${prefix}/bridge.js`, { bytes: BRIDGE, contentType: 'application/javascript' });
  adapter.objects.set(`${prefix}/styles.css`, { bytes: CSS, contentType: 'text/css' });
  adapter.objects.set(`${prefix}/assets/logo.png`, { bytes: PNG, contentType: 'image/png' });
  adapter.uploadLog.length = 0;

  revisions = new RevisionService(adapter as never);
  migration = new RevisionMigration(adapter as never, revisions);
  svc = new SimulationService(adapter as never, null as never);
});

afterEach(async () => { await pg.close(); vi.restoreAllMocks(); });

// ── (1) Migration-on-write: the first generation on an un-revisioned simulation ──────────────────

describe('first generation on a LEGACY simulation publishes the whole package as revision 1', () => {
  it('copies the FULL legacy layout into revision 1 and activates it', async () => {
    const hook = persistHook(sectionA);
    const res = await generate(sectionA, { persistSection: hook });

    const [rev] = await revisionRows();
    expect(rev!.revision_number).toBe(1);
    expect(rev!.status).toBe('active');
    expect(rev!.created_by).toBe('live-generation');
    expect(rev!.metadata).toMatchObject({
      trigger: 'section-generation', sectionId: sectionA, baseRevisionId: null,
    });

    // THE WHOLE PACKAGE, not bridge + entry. The exact file set `revisionMigration.test.ts` expects
    // from the same fixture, plus the manifest — a partial copy would publish a revision whose
    // entry document 404s its own stylesheet and image, and validate green while doing it.
    const rp = revPrefix(rev!.id);
    expect(keysUnder(rp)).toEqual([
      `${rp}/manifest.json`,
      `${rp}/package/assets/logo.png`,
      `${rp}/package/bridge.js`,
      `${rp}/package/index.html`,
      `${rp}/package/styles.css`,
    ]);

    // The pointer names this revision's entry, and the returned URL is exactly what the player
    // composes from it (`buildPlayerConfig.simulationUrlOf`).
    const sim = await simRow();
    expect(sim.active_revision_id).toBe(rev!.id);
    expect(sim.active_revision_entry_key).toBe(`${rp}/package/index.html`);
    expect(res.sectionUrl)
      .toBe(`https://cdn.test/${rp}/package/index.html?section=${sectionA}&v=${res.bridgeHash}`);
    expect(res.bridgeHash)
      .toBe(computeBridgeHash(adapter.objects.get(`${rp}/package/bridge.js`)!.bytes.toString('utf8')));

    // The hook ran exactly once, and the section row carries the result.
    expect(hook.calls).toHaveLength(1);
    expect((await sectionRow(sectionA)).simulation_url).toBe(res.sectionUrl);
    expect((await sectionRow(sectionA)).sim_script).toBe('main');
  });

  it('carries the customer bytes across unchanged and keeps the layout resolvable from the entry', async () => {
    await generate(sectionA);
    const rp = revPrefix((await simRow()).active_revision_id!);

    expect(adapter.objects.get(`${rp}/package/styles.css`)!.bytes).toEqual(CSS);
    expect(adapter.objects.get(`${rp}/package/assets/logo.png`)!.bytes).toEqual(PNG);

    // The property that actually matters about layout preservation: every relative reference the
    // entry document makes still resolves against its own directory INSIDE the revision.
    const entryKey = `${rp}/package/index.html`;
    const entryDir = entryKey.slice(0, entryKey.lastIndexOf('/') + 1);
    for (const ref of ['bridge.js', 'styles.css', 'assets/logo.png']) {
      expect(adapter.objects.has(entryDir + ref), `<src="${ref}"> resolves to ${entryDir + ref}, never written`)
        .toBe(true);
    }
    // …and the entry really does ask for the bridge at that relative path.
    expect(adapter.objects.get(entryKey)!.bytes.toString('utf8')).toContain('src="./bridge.js?v=');
  });

  it('stores the entry revalidating and everything else immutable', async () => {
    await generate(sectionA);
    const rp = revPrefix((await simRow()).active_revision_id!);
    expect(adapter.objects.get(`${rp}/package/index.html`)!.cacheControl).toBe(POINTER_CACHE_CONTROL);
    expect(adapter.objects.get(`${rp}/package/bridge.js`)!.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(adapter.objects.get(`${rp}/package/styles.css`)!.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(adapter.objects.get(`${rp}/package/assets/logo.png`)!.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('leaves the LEGACY prefix exactly as it was — nothing is written outside the new revision', async () => {
    // Migration 050's rollback reverts every simulation to the legacy path, so it must still hold a
    // complete, servable package. The old in-place path REWROTE index.html and bridge.js here.
    const before = snapshotOf(legacyKeys());
    await generate(sectionA);
    const rp = revPrefix((await simRow()).active_revision_id!);

    expect(snapshotOf(legacyKeys())).toEqual(before);
    expect(adapter.uploadLog.filter((k) => !k.startsWith(`${rp}/`)),
      'the publication wrote outside its own revision prefix').toEqual([]);
    expect(adapter.deleteWithPrefix).not.toHaveBeenCalled();
  });

  it('does NOT advance simulations.bridge_hash, and leaves no verdict on the row', async () => {
    // `bridge_hash` describes the LEGACY prefix, which this path no longer writes; a revisioned
    // package's identity axis is the revision id (`packageRevisionFor`). Advancing it here would
    // claim the legacy bytes changed when they did not.
    await generate(sectionA);
    const sim = await simRow();
    expect(sim.bridge_hash).toBe('H1');
    expect(sim.package_class).toBeNull();
  });
});

// ── (2) A generation whose BASE is the active revision ───────────────────────────────────────────

describe('a generation on an already-revisioned simulation builds on the ACTIVE revision', () => {
  it('publishes a new revision with the full layout and leaves the previous one byte-identical', async () => {
    await generate(sectionA);
    const rev1 = (await simRow()).active_revision_id!;
    const rev1Bytes = snapshotOf(keysUnder(revPrefix(rev1)));

    const hookB = persistHook(sectionB);
    const res = await generate(sectionB, { persistSection: hookB });

    const all = await revisionRows();
    expect(all.map((r) => r.revision_number)).toEqual([1, 2]);
    const rev2 = all[1]!;
    expect(rev2.status).toBe('active');
    expect(rev2.metadata).toMatchObject({ baseRevisionId: rev1, sectionId: sectionB });

    // The pointer advanced, and the SUPERSEDED revision was demoted in the same transaction.
    expect((await simRow()).active_revision_id).toBe(rev2.id);
    expect(all[0]!.status).toBe('retired');
    expect(all[0]!.retired_at).not.toBeNull();

    // The whole package came across again — a "copy only what changed" regression would leave the
    // new revision serving an entry document whose stylesheet and image are 404s.
    const rp2 = revPrefix(rev2.id);
    expect(keysUnder(rp2)).toEqual([
      `${rp2}/manifest.json`,
      `${rp2}/package/assets/logo.png`,
      `${rp2}/package/bridge.js`,
      `${rp2}/package/index.html`,
      `${rp2}/package/styles.css`,
    ]);

    // The previous revision's bytes are untouched: a viewer still holding the old pointer keeps
    // receiving a complete, self-consistent package.
    expect(snapshotOf(keysUnder(revPrefix(rev1)))).toEqual(rev1Bytes);
    expect(hookB.calls).toHaveLength(1);
    expect((await sectionRow(sectionB)).simulation_url).toBe(res.sectionUrl);
  });

  it('accumulates section bodies: the previous section survives the next section’s generation', async () => {
    // This is the defect the mutable path had. Two sections of one simulation each read `bridge.js`
    // and wrote it back, and the later write dropped the earlier section entirely. The ACTIVE
    // revision's bridge.js is now the authoritative base, so the merge starts from what is live.
    await generate(sectionA);
    const rev1 = (await simRow()).active_revision_id!;
    await generate(sectionB);
    const rev2 = (await simRow()).active_revision_id!;

    const bridge1 = adapter.objects.get(`${revPrefix(rev1)}/package/bridge.js`)!.bytes.toString('utf8');
    const bridge2 = adapter.objects.get(`${revPrefix(rev2)}/package/bridge.js`)!.bytes.toString('utf8');
    expect(bridge1).toContain(`@@SIM_BRIDGE:${sectionA}@@`);
    expect(bridge1).not.toContain(`@@SIM_BRIDGE:${sectionB}@@`);
    expect(bridge2).toContain(`@@SIM_BRIDGE:${sectionA}@@`);
    expect(bridge2).toContain(`@@SIM_BRIDGE:${sectionB}@@`);
  });

  it('takes its file list from the base revision’s MANIFEST, not from a storage listing', async () => {
    // A file dropped into the legacy prefix after revision 1 was published is not part of the live
    // package, and re-listing storage would silently adopt it. The manifest is the authority.
    await generate(sectionA);
    adapter.objects.set(`${prefix}/stray.css`, { bytes: Buffer.from('.x{}'), contentType: 'text/css' });

    await generate(sectionB);
    const rp2 = revPrefix((await simRow()).active_revision_id!);
    expect(adapter.objects.has(`${rp2}/package/stray.css`)).toBe(false);
    expect(keysUnder(rp2)).toHaveLength(5);
  });

  it('never writes into a revision prefix that has already been published', async () => {
    await generate(sectionA);
    const rev1 = (await simRow()).active_revision_id!;
    adapter.uploadLog.length = 0;

    await generate(sectionB);
    const rp2 = revPrefix((await simRow()).active_revision_id!);
    expect(adapter.uploadLog.filter((k) => k.startsWith(`${revPrefix(rev1)}/`)),
      'immutable bytes of an already-published revision were overwritten').toEqual([]);
    expect(adapter.uploadLog.every((k) => k.startsWith(`${rp2}/`))).toBe(true);
  });
});

// ── (3) Abort ────────────────────────────────────────────────────────────────────────────────────

describe('abort', () => {
  it('after the build but BEFORE activation: nothing is activated and nothing is touched', async () => {
    await generate(sectionA);
    const rev1 = (await simRow()).active_revision_id!;
    const simBefore = await simRow();
    const rev1Bytes = snapshotOf(keysUnder(revPrefix(rev1)));
    const legacyBytes = snapshotOf(legacyKeys());

    // The last write of a publication is the revision's own manifest.json, from inside validate() —
    // so aborting on it lands the signal in exactly the window step (5) guards: after the package
    // is built and verified, before the activation transaction opens.
    const controller = new AbortController();
    adapter.hooks.onUpload = (key) => { if (key.endsWith('/manifest.json')) controller.abort(); };

    const hookB = persistHook(sectionB);
    await expect(generate(sectionB, { signal: controller.signal, persistSection: hookB }))
      .rejects.toMatchObject({ name: 'AbortError' });

    // The draft is FAILED, so nothing can activate it later.
    const all = await revisionRows();
    expect(all).toHaveLength(2);
    expect(all[1]!.status).toBe('failed');
    expect(String((all[1]!.metadata as { error?: string }).error)).toContain('aborted before activation');

    // The pointer, the section row and both sets of previous bytes are exactly as they were.
    expect(await simRow()).toEqual(simBefore);
    expect((await simRow()).active_revision_id).toBe(rev1);
    expect(hookB.calls).toHaveLength(0);
    expect((await sectionRow(sectionB)).simulation_url).toBeNull();
    expect(snapshotOf(keysUnder(revPrefix(rev1)))).toEqual(rev1Bytes);
    expect(snapshotOf(legacyKeys())).toEqual(legacyBytes);

    // The abandoned bytes sit in a prefix nothing references — reaping them is gc/staleDrafts' job,
    // and no sweep is wired here. What matters is that they are unreachable, not that they are gone.
    expect(keysUnder(revPrefix(all[1]!.id)).length).toBeGreaterThan(0);
    expect(simBefore.active_revision_entry_key!.startsWith(revPrefix(rev1))).toBe(true);
  });

  it('mid-staging: the draft is failed from `uploading` and nothing is ever activated', async () => {
    const controller = new AbortController();
    // Abort as soon as the first staged file lands — the per-file check is what stops a long copy
    // from running to completion after the client has gone.
    adapter.hooks.onUpload = () => { controller.abort(); };

    await expect(generate(sectionA, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });

    const all = await revisionRows();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('failed');
    expect((await simRow()).active_revision_id).toBeNull();
    expect((await sectionRow(sectionA)).simulation_url).toBeNull();
  });

  it('an already-aborted signal never creates a draft row at all', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generate(sectionA, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(await revisionRows()).toHaveLength(0);
    expect(adapter.uploadLog).toEqual([]);
  });
});

// ── (4) A lost compare-and-set ───────────────────────────────────────────────────────────────────

describe('a concurrent publication that activates first', () => {
  /**
   * Stage a complete, activatable revision without activating it — the "other" publication, built
   * with the operator migration so it is a genuine revision and not a hand-written row.
   */
  async function stageRival(): Promise<string> {
    const res = await migration.publishLegacyAsRevision({ simulationId: simId, force: true });
    expect(res.error, res.error).toBeUndefined();
    return res.revisionId!;
  }

  /**
   * SIMULATED PRECONDITION, not a real race. The pointer moves between the in-flight publication's
   * opening read and its activation — exactly the state a concurrent generation produces, and the
   * state the compare-and-set exists to detect. Fires once, on the in-flight draft's manifest.
   */
  function activateRivalMidBuild(rival: string, expected: string | null): void {
    let fired = false;
    adapter.hooks.onUpload = async (key) => {
      if (fired || !key.endsWith('/manifest.json')) return;
      fired = true;
      await revisions.activate({
        simulationId: simId, revisionId: rival, storagePrefix: prefix,
        expectedActiveRevisionId: expected, supersede: 'retired',
      });
    };
  }

  it('loses with a RevisionConflict, leaving the winner intact and overwriting nothing', async () => {
    await generate(sectionA);
    const rev1 = (await simRow()).active_revision_id!;
    const rival = await stageRival();
    const rivalBytes = snapshotOf(keysUnder(revPrefix(rival)));
    const rev1Bytes = snapshotOf(keysUnder(revPrefix(rev1)));
    adapter.uploadLog.length = 0;
    activateRivalMidBuild(rival, rev1);

    const hookB = persistHook(sectionB);
    await expect(generate(sectionB, { persistSection: hookB }))
      .rejects.toMatchObject({ name: 'RevisionConflict' });

    // THE WINNER IS FULLY INTACT.
    const sim = await simRow();
    expect(sim.active_revision_id).toBe(rival);
    expect(sim.active_revision_entry_key).toBe(`${revPrefix(rival)}/package/index.html`);
    expect(snapshotOf(keysUnder(revPrefix(rival)))).toEqual(rivalBytes);
    expect(snapshotOf(keysUnder(revPrefix(rev1)))).toEqual(rev1Bytes);

    // THE LOSER OVERWROTE NOTHING: every byte it wrote went into its own never-referenced prefix,
    // and its draft is failed so it can never be activated after the fact.
    //
    // Identified positionally rather than by `metadata.sectionId`, because `markFailed` REPLACES a
    // revision's metadata with `{ error }` — the generation provenance does not survive a failure.
    const all = await revisionRows();
    expect(all).toHaveLength(3);
    const loser = all.find((r) => r.id !== rev1 && r.id !== rival)!;
    expect(loser.status).toBe('failed');
    expect(String((loser.metadata as { error?: string }).error)).toContain('activation failed');
    expect(adapter.uploadLog.length).toBeGreaterThan(0);
    expect(adapter.uploadLog.every((k) => k.startsWith(`${revPrefix(loser.id)}/`))).toBe(true);

    // AND THE HOOK NEVER RAN — a lost CAS throws before the post-promote hook is reached, so the
    // section row cannot be made consistent with an activation that did not happen.
    expect(hookB.calls).toHaveLength(0);
    expect((await sectionRow(sectionB)).simulation_url).toBeNull();
  });

  it('loses to the partial unique index when the stale pointer read was NULL', async () => {
    // The other stale direction: the publication read "no active revision" and someone activated
    // one meanwhile. The demote is skipped (nothing was believed active), so the promote collides
    // with the real incumbent on `uniq_sim_revisions_active` — which IS losing a compare-and-set,
    // and is reported as one rather than as a raw 23505 a caller cannot act on.
    const rival = await stageRival();
    activateRivalMidBuild(rival, null);

    await expect(generate(sectionA)).rejects.toMatchObject({ name: 'RevisionConflict' });
    expect((await simRow()).active_revision_id).toBe(rival);
    expect((await sectionRow(sectionA)).simulation_url).toBeNull();
    // Exactly one active revision survives — the index is what guarantees that, cluster-wide.
    expect((await revisionRows()).filter((r) => r.status === 'active').map((r) => r.id)).toEqual([rival]);
  });
});

// ── (5) The post-promote hook is part of the activation transaction ──────────────────────────────

describe('the onActivated hook is transactional', () => {
  it('a hook that throws rolls back the ENTIRE activation — promote, pointer and its own writes', async () => {
    // This is the atomicity guarantee the whole finding rests on. The hook WRITES the section row
    // and then throws: were the transaction not shared, that write would survive and the section
    // would reference a revision that is not live.
    await generate(sectionA);
    const rev1 = (await simRow()).active_revision_id!;
    const simBefore = await simRow();
    const urlBefore = (await sectionRow(sectionB)).simulation_url;

    const exploding: SectionPersistHook = async (tx, pub) => {
      await tx.update(timeline_sections)
        .set({ simulation_url: pub.sectionUrl })
        .where(eq(timeline_sections.id, sectionB));
      throw new Error('This section was removed during generation.');
    };

    await expect(generate(sectionB, { persistSection: exploding }))
      .rejects.toThrow('This section was removed during generation.');

    // Nothing about the activation survived.
    expect(await simRow()).toEqual(simBefore);
    expect((await simRow()).active_revision_id).toBe(rev1);
    const all = await revisionRows();
    expect(all.filter((r) => r.status === 'active').map((r) => r.id)).toEqual([rev1]);
    expect(all.find((r) => r.id !== rev1)!.status).toBe('failed');
    // …including the hook's OWN write, which is the half a non-shared transaction would keep.
    expect((await sectionRow(sectionB)).simulation_url).toBe(urlBefore);
  });

  it('runs INSIDE the transaction and AFTER the pointer flip', async () => {
    // Read the pointer through the hook's own `tx`: it must already see the new revision, which is
    // only possible if the hook runs after the flip and before the commit.
    let seenByHook: string | null | undefined;
    const observing: SectionPersistHook = async (tx, pub) => {
      const [row] = await tx.select({ id: simulations.active_revision_id })
        .from(simulations).where(eq(simulations.id, simId));
      seenByHook = row?.id;
      await tx.update(timeline_sections)
        .set({ simulation_url: pub.sectionUrl })
        .where(eq(timeline_sections.id, sectionA));
    };

    await generate(sectionA, { persistSection: observing });
    const after = await simRow();
    expect(seenByHook).toBe(after.active_revision_id);
    expect((await sectionRow(sectionA)).simulation_url).toContain(after.active_revision_id!);
  });

  it('publishes without a hook when the caller supplies none', async () => {
    // `onActivated` is additive: rollback and every pre-existing caller keep not passing it.
    const res = await svc.applyMinimalUiOnly({
      simId, sectionId: sectionA, projectId, entryKey: `${prefix}/index.html`,
    });
    expect((await simRow()).active_revision_id).not.toBeNull();
    expect(res.sectionUrl).toContain('/revisions/');
    expect((await sectionRow(sectionA)).simulation_url).toBeNull();
  });
});

// ── (6) The verdict projection ───────────────────────────────────────────────────────────────────

describe('the canary verdict follows the bytes it describes', () => {
  /** A proven revision, active, with its verdict projected onto the simulations row. */
  async function activeProvenRevision(): Promise<string> {
    const res = await migration.publishLegacyAsRevision({ simulationId: simId });
    const id = res.revisionId!;
    await revisions.recordCanary(simId, id, {
      classification: 'managed-presentable',
      report: { cases: [{ steps: [{ step: 'prepare', ms: 400, status: 'pass' }] }] },
      ranAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await revisions.activate({
      simulationId: simId, revisionId: id, storagePrefix: prefix,
      expectedActiveRevisionId: null, supersede: 'retired',
    });
    return id;
  }

  it('a fresh-bytes revision leaves the row UNPROVEN — the same outcome the old explicit nulling had', async () => {
    const proven = await activeProvenRevision();
    const before = await simRow();
    expect(before.package_class).toBe('managed-presentable');
    expect(before.prepare_budget_ms).toBe(400);

    await generate(sectionA);

    // The new bytes were never canaried, so the row must say so — the player reads a null class as
    // "unproven ⇒ legacy path", which is the safe default and exactly what the removed explicit
    // `package_class: null` write produced. The budget is derived from the same report and must not
    // be left describing the withdrawn package.
    const after = await simRow();
    expect(after.active_revision_id).not.toBe(proven);
    expect(after.package_class).toBeNull();
    expect(after.canary_report).toBeNull();
    expect(after.canary_at).toBeNull();
    expect(after.prepare_budget_ms).toBeNull();
  });

  it('does not carry the previous verdict onto the new revision, and does not destroy the old one', async () => {
    const proven = await activeProvenRevision();
    await generate(sectionA);

    const all = await revisionRows();
    // The retired revision keeps the verdict for ITS bytes — a rollback re-projects it, which is
    // why activation re-projects rather than clears.
    expect(all.find((r) => r.id === proven)!.package_class).toBe('managed-presentable');
    expect(all.find((r) => r.status === 'active')!.package_class).toBeNull();
  });

  it('a rollback to the proven revision restores its verdict onto the row', async () => {
    // The other half of "re-project, never clear": the verdict is valid for those exact bytes, so
    // returning to them must return the verdict too.
    const proven = await activeProvenRevision();
    await generate(sectionA);
    const fresh = (await simRow()).active_revision_id!;

    await revisions.rollback({
      simulationId: simId, storagePrefix: prefix,
      expectedActiveRevisionId: fresh, reason: 'test',
    });
    const after = await simRow();
    expect(after.active_revision_id).toBe(proven);
    expect(after.package_class).toBe('managed-presentable');
    expect(after.prepare_budget_ms).toBe(400);
  });
});

// ── (7) One write path ───────────────────────────────────────────────────────────────────────────

describe('RevisionService.writeFile is the only way bytes enter a revision prefix', () => {
  it('every write of a publication came through writeFile, save the manifest validate() writes', async () => {
    // The object store has no versioning, no object lock and no conditional writes, so immutability
    // is a CODE-LEVEL invariant with exactly one chokepoint. A stray `uploadFile` anywhere in the
    // generation path would silently succeed — this is what notices.
    //
    // `vi.spyOn` with no replacement observes and calls through: the publication under test is the
    // real one, not a substitute.
    const watcher = vi.spyOn(RevisionService.prototype, 'writeFile');
    await generate(sectionA);

    const throughChokepoint = watcher.mock.calls
      .map(([rev, storagePrefix, opts]) => `${storagePrefix}/revisions/${rev.id}/${opts.manifestPath}`);
    const rp = revPrefix((await simRow()).active_revision_id!);

    expect(new Set(adapter.uploadLog)).toEqual(new Set([...throughChokepoint, `${rp}/manifest.json`]));
    expect(adapter.uploadLog).toHaveLength(throughChokepoint.length + 1);
  });

  it('refuses to add a file to a revision that is no longer uploading', async () => {
    // The chokepoint's own guard, reached against a revision the live path published: once a
    // package is validated and live, nothing may be appended to it.
    await generate(sectionA);
    const rev1 = (await simRow()).active_revision_id!;
    await expect(revisions.writeFile(
      { id: rev1, status: 'active' } as never,
      prefix,
      { manifestPath: 'package/sneak.js', bytes: Buffer.from('x'), contentType: 'application/javascript', role: 'asset' },
    )).rejects.toMatchObject({ name: 'RevisionConflict' });
    expect(adapter.objects.has(`${revPrefix(rev1)}/package/sneak.js`)).toBe(false);
  });
});

// ── (8) The other entry point takes the same contract ────────────────────────────────────────────

describe('generateBridgeScript publishes through the same private path', () => {
  /**
   * Driving the LLM path end-to-end here would mean standing up a provider double, the prompt table
   * and the whole context builder in order to re-prove a publication this file already proves — the
   * two entry points call ONE private method. What must not drift is that they still do, and that
   * each still hands it a `persistSection`, so the LLM path's section row is written inside the
   * activation too. Read from source with comments stripped, so prose cannot satisfy an assertion
   * (same technique as `bridgeVerdictClear.test.ts`).
   */
  const SERVICE = readFileSync(join(HERE, '..', 'SimulationService.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('all three public entry points reach uploadSectionBridge with a persistSection hook', () => {
    // Three, acknowledged one by one: generateBridgeScript (LLM), applyMinimalUiOnly (mechanical),
    // and applySavedBridgeBody (the saved-bridge artifact load, 079). A FOURTH caller appearing
    // here must be a conscious decision — every entry point inherits the CAS activation and the
    // in-transaction section write, and a caller that bypasses uploadSectionBridge bypasses both.
    const sites = [...SERVICE.matchAll(/this\.uploadSectionBridge\(\{/g)].map((m) => m.index!);
    expect(sites.length, 'uploadSectionBridge is no longer the single publication path').toBe(3);
    for (const at of sites) {
      expect(SERVICE.slice(at, at + 700),
        'an entry point publishes without an in-transaction section write').toMatch(/persistSection/);
    }
  });

  it('activates with the pointer it READ, not with a re-read', () => {
    // A re-read inside activate() would observe whoever won the race and then overwrite them; the
    // compare-and-set only means anything while the expected value is the caller's own.
    expect(SERVICE).toMatch(/const baseRevisionId = simRow\.active_revision_id/);
    expect(SERVICE).toMatch(/expectedActiveRevisionId:\s*baseRevisionId/);
  });
});
