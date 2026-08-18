/**
 * DERIVING A NEW REVISION FROM THE LIVE ONE — replace and publish-guidance (audit D-04).
 *
 * WHAT A BROKEN IMPLEMENTATION WOULD ALSO SATISFY, AND WHAT THIS FILE ASSERTS INSTEAD
 *
 * The shipped defect was that both operations wrote into the mutable prefix, which a revisioned
 * package does not serve: they succeeded and changed nothing. The obvious test — "guidance.js
 * exists somewhere under a revision prefix afterwards" — is satisfied by at least three broken
 * implementations, so every case below is written against one of them by name:
 *
 *   (1) writes to the MUTABLE prefix (the shipped bug). Defeated by asserting the pointer MOVED and
 *       that the mutable prefix received no write at all — not merely that a revision key exists.
 *   (2) writes IN PLACE into the active revision's own prefix. That produces a guidance.js under a
 *       revision, an entry with the tag, and a package that serves the new bytes — every visible
 *       half. Defeated by snapshotting the base revision's bytes and requiring them BYTE-IDENTICAL
 *       afterwards, and by requiring `active_revision_id` to be a value it has never had.
 *   (3) activates under a process-local lock instead of a compare-and-set. Passes every
 *       single-caller assertion. Defeated by moving the pointer mid-staging and requiring THIS
 *       publication to lose, damage nothing, and leave its draft unactivatable.
 *   (4) publishes correctly but writes the terminal row state outside the activation transaction —
 *       the ef651a9 shape: the work lands, the row says it never finished. Defeated by requiring
 *       that, when the activation loses, `status` / `guidance_status` are NOT the terminal value.
 *
 * WHY PGlite AND NOT THE HOUSE db-FAKE
 * Same reasoning as `revisionService.test.ts` and `bridgePublication.test.ts`: the guarantees are
 * guarantees about SQL. "The status moves inside the activation transaction" is meaningless without
 * a real transaction, and a hand-faked `db` would let (4) pass while proving nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';

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

// The only vendor call in the guidance flow. Mocked so the suite never reaches ElevenLabs.
const tts = vi.hoisted(() => ({ synthesize: vi.fn(async () => Buffer.from('ID3-fake-mp3')) }));
vi.mock('../../audio/GuidanceTTSService.js', () => ({
  GuidanceTTSService: class { synthesize = tts.synthesize; },
  resolveGuidanceVoice: async () => ({ voiceId: 'voice-1', model: 'eleven_flash' }),
}));

import { SimulationService, computeBridgeHash } from '../SimulationService.js';
import { GuidanceService, computeGuidanceHash, type GuidanceEntryStored } from '../GuidanceService.js';
import { RevisionService, RevisionConflict } from '../RevisionService.js';
import { RevisionMigration } from '../RevisionMigration.js';
import { deriveRevision, derivedCapabilities, NoActiveRevision } from '../RevisionDerivation.js';
import { readActiveRevisionPackage } from '../activeRevisionPackage.js';
import { resolveSimulationUrl } from '../simulationUrlResolver.js';
import { BRIDGE_CAPABILITIES_KEY } from 'shared/sim/bridgeCapability';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'db', 'migrations');

// ── The storage double ───────────────────────────────────────────────────────────────────────────

function fakeStorage() {
  const objects = new Map<string, { bytes: Buffer; contentType: string; cacheControl?: string }>();
  const uploadLog: string[] = [];
  const deleteLog: string[] = [];
  const hooks: { onUpload: ((key: string) => Promise<void> | void) | null } = { onUpload: null };
  return {
    objects, uploadLog, deleteLog, hooks,
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
    deleteFile: vi.fn(async (k: string) => { deleteLog.push(k); objects.delete(k); }),
    deleteWithPrefix: vi.fn(async (p: string) => {
      for (const k of [...objects.keys()]) if (k.startsWith(p)) { deleteLog.push(k); objects.delete(k); }
    }),
    objectExists: vi.fn(async (k: string) => objects.has(k)),
    getSimPublicUrl: (k: string) => `https://cdn.test/${k}`,
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

/** Carries the SCRIPT_APPLIED post, so `detectBridgeCapabilities` records `scriptApplied: true`. */
const BRIDGE = Buffer.from("_post({ type: 'SCRIPT_APPLIED', id: 1 });\n", 'utf8');
const GUIDANCE = Buffer.from('/* published guidance v1 */\n', 'utf8');
const HTML = Buffer.from('<html><head></head><body>original</body></html>', 'utf8');
const CSS = Buffer.from('body{margin:0}', 'utf8');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

const NEW_HTML = '<html><head></head><body>REPLACED</body></html>';
const NEW_CSS = Buffer.from('body{margin:8px}', 'utf8');

const CUE: GuidanceEntryStored = {
  id: 'cue-1',
  kind: 'feature',
  title: 'Press start',
  narration: 'Press the start button to begin.',
  enabled: true,
  trigger: { kind: 'feature', targetId: 'start', events: ['pointerdown'] },
  audioUrl: null,
  confidence: 0.9,
  warnings: [],
};

let pg: PGlite;
let adapter: ReturnType<typeof fakeStorage>;
let svc: SimulationService;
let guidance: GuidanceService;
let revisions: RevisionService;
let migration: RevisionMigration;

let projectId: string;
let simId: string;
let sectionA: string;
let prefix: string;
let rev1: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

const revPrefix = (revisionId: string): string => `${prefix}/revisions/${revisionId}`;

const keysUnder = (p: string): string[] =>
  [...adapter.objects.keys()].filter((k) => k.startsWith(`${p}/`)).sort();

const snapshotOf = (keys: string[]): Map<string, string> =>
  new Map(keys.map((k) => [k, adapter.objects.get(k)!.bytes.toString('base64')]));

/** Every stored key under the sim prefix that is NOT inside a revision — the mutable package. */
const legacyKeys = (): string[] => keysUnder(prefix).filter((k) => !k.startsWith(`${prefix}/revisions/`));

const simRow = async () => (await rows<{
  status: string; error: string | null;
  active_revision_id: string | null; active_revision_entry_key: string | null;
  guidance: unknown; guidance_meta: Record<string, unknown> | null;
  guidance_status: string; guidance_error: string | null;
  package_class: string | null; bridge_ack_capable: boolean | null; requires_import_maps: boolean | null;
}>(
  `SELECT status, error, active_revision_id, active_revision_entry_key, guidance, guidance_meta,
          guidance_status, guidance_error, package_class, bridge_ack_capable, requires_import_maps
     FROM simulations WHERE id = $1`, [simId],
))[0]!;

const revisionRows = async () => rows<{
  id: string; revision_number: number; status: string; entry_path: string | null;
  created_by: string | null; metadata: Record<string, unknown> | null;
}>(`SELECT id, revision_number, status, entry_path, created_by, metadata
      FROM sim_revisions WHERE simulation_id = $1 ORDER BY revision_number`, [simId]);

const sectionUrl = async (): Promise<string | null> => (await rows<{ simulation_url: string | null }>(
  `SELECT simulation_url FROM timeline_sections WHERE id = $1`, [sectionA]))[0]!.simulation_url;

/** Publish the legacy prefix as a revision and make it live — the realistic starting state. */
async function publishAndActivate(expected: string | null): Promise<string> {
  const res = await migration.publishLegacyAsRevision({ simulationId: simId, force: true });
  if (!res.revisionId || res.error) throw new Error(`fixture migration failed: ${res.error}`);
  await revisions.activate({
    simulationId: simId, revisionId: res.revisionId, storagePrefix: prefix,
    expectedActiveRevisionId: expected, supersede: 'retired',
  });
  return res.revisionId;
}

/** Stage a second activatable revision without activating it — the interloper's ammunition. */
async function stageSpareRevision(): Promise<string> {
  const res = await migration.publishLegacyAsRevision({ simulationId: simId, force: true });
  if (!res.revisionId || res.error) throw new Error(`fixture spare failed: ${res.error}`);
  return res.revisionId;
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
  projectId = p!.id;
  const [v] = await rows<{ id: string }>(
    `INSERT INTO video_files (project_id, filename) VALUES ($1, 'v.mp4') RETURNING id`, [projectId]);

  const [s] = await rows<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, status, guidance, guidance_status)
     VALUES ($1, 'sim', 'pending', 'pending', 'ready', $2::jsonb, 'draft') RETURNING id`,
    [projectId, JSON.stringify([CUE])]);
  simId = s!.id;
  prefix = `simulations/${projectId}/${simId}`;
  await pg.query(`UPDATE simulations SET storage_prefix = $2, entry_file = $3 WHERE id = $1`,
    [simId, prefix, `${prefix}/index.html`]);

  const [a] = await rows<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, simulation_id)
     VALUES ($1, $2, 0, 5, 'simulation', $3) RETURNING id`, [projectId, v!.id, simId]);
  sectionA = a!.id;

  adapter = fakeStorage();
  storageRef.adapter = adapter;
  adapter.objects.set(`${prefix}/index.html`,       { bytes: HTML, contentType: 'text/html; charset=utf-8' });
  adapter.objects.set(`${prefix}/bridge.js`,        { bytes: BRIDGE, contentType: 'application/javascript' });
  adapter.objects.set(`${prefix}/guidance.js`,      { bytes: GUIDANCE, contentType: 'application/javascript' });
  adapter.objects.set(`${prefix}/styles.css`,       { bytes: CSS, contentType: 'text/css' });
  adapter.objects.set(`${prefix}/assets/logo.png`,  { bytes: PNG, contentType: 'image/png' });

  revisions = new RevisionService(adapter as never);
  migration = new RevisionMigration(adapter as never, revisions);
  svc = new SimulationService(adapter as never, null as never);
  guidance = new GuidanceService(adapter as never, null as never);

  rev1 = await publishAndActivate(null);
  // The section's stored URL is what the publication that generated IT wrote — it names revision 1.
  await pg.query(`UPDATE timeline_sections SET simulation_url = $2 WHERE id = $1`,
    [sectionA, `https://cdn.test/${revPrefix(rev1)}/package/index.html?section=main&v=abc`]);

  adapter.uploadLog.length = 0;
  adapter.deleteLog.length = 0;
});

afterEach(async () => { await pg.close(); vi.restoreAllMocks(); });

// ═══ REPLACE ═════════════════════════════════════════════════════════════════════════════════════

describe('replace on a revisioned package derives a NEW revision', () => {
  const upload = () => new Map<string, Buffer>([
    ['index.html', Buffer.from(NEW_HTML, 'utf8')],
    ['styles.css', NEW_CSS],
  ]);

  it('moves the pointer to a revision that has never existed, and writes nothing else anywhere', async () => {
    const base = snapshotOf(keysUnder(revPrefix(rev1)));
    const legacyBefore = snapshotOf(legacyKeys());

    const res = await svc.replaceIntoRevision({
      projectId, simId, files: upload(), entryRelPath: 'index.html',
    });

    // (1) THE POINTER MOVED. A mutable-prefix write leaves it at rev1; an in-place rewrite does too.
    const sim = await simRow();
    expect(sim.active_revision_id).toBe(res.revisionId);
    expect(res.revisionId).not.toBe(rev1);
    expect(sim.active_revision_entry_key).toBe(`${revPrefix(res.revisionId)}/package/index.html`);

    // (2) THE BASE REVISION IS BYTE-IDENTICAL. This is what an in-place rewrite fails.
    expect(snapshotOf(keysUnder(revPrefix(rev1)))).toEqual(base);

    // (3) THE MUTABLE PREFIX WAS NOT TOUCHED — not written, not deleted. This is the shipped bug.
    expect(adapter.uploadLog.filter((k) => !k.startsWith(`${prefix}/revisions/`))).toEqual([]);
    expect(adapter.deleteLog).toEqual([]);
    expect(snapshotOf(legacyKeys())).toEqual(legacyBefore);

    // (4) …and every write this publication made went to the NEW revision's prefix only.
    expect(adapter.uploadLog.every((k) => k.startsWith(`${revPrefix(res.revisionId)}/`))).toBe(true);
  });

  it('combines the uploaded files with the LIVE bridge and guidance', async () => {
    const res = await svc.replaceIntoRevision({
      projectId, simId, files: upload(), entryRelPath: 'index.html',
    });
    const rp = revPrefix(res.revisionId);

    // The customer's new bytes.
    expect(adapter.objects.get(`${rp}/package/styles.css`)!.bytes).toEqual(NEW_CSS);
    // The system-owned runtime, carried across byte-for-byte from the revision that was live.
    expect(adapter.objects.get(`${rp}/package/bridge.js`)!.bytes).toEqual(BRIDGE);
    expect(adapter.objects.get(`${rp}/package/guidance.js`)!.bytes).toEqual(GUIDANCE);
    expect(res.carriedForward.sort()).toEqual(['bridge.js', 'guidance.js']);

    // The new entry is the CUSTOMER's document, re-wired to both, with their CURRENT hashes.
    const entry = adapter.objects.get(`${rp}/package/index.html`)!.bytes.toString('utf8');
    expect(entry).toContain('REPLACED');
    expect(entry).toContain(`src="./bridge.js?v=${computeBridgeHash(BRIDGE.toString('utf8'))}"`);
    expect(entry).toContain(`src="./guidance.js?v=${computeGuidanceHash(GUIDANCE.toString('utf8'))}"`);
    expect(entry).toContain('sim-raf-gate');

    // A base asset the upload does not contain is GONE from the live package — the revision
    // equivalent of the legacy stale-key delete, with no delete that can half-fail.
    expect(adapter.objects.has(`${rp}/package/assets/logo.png`)).toBe(false);
    expect(res.droppedFromBase).toContain('assets/logo.png');
    // …and it is still there in the base, so a rollback restores a complete package.
    expect(adapter.objects.has(`${revPrefix(rev1)}/package/assets/logo.png`)).toBe(true);
  });

  it('ends the row ready when the publication succeeds', async () => {
    await pg.query(`UPDATE simulations SET status = 'processing' WHERE id = $1`, [simId]);
    await svc.replaceIntoRevision({ projectId, simId, files: upload(), entryRelPath: 'index.html' });

    const sim = await simRow();
    expect(sim.status).toBe('ready');
    expect(sim.error).toBeNull();
  });

  it('LOSES to a concurrent activation, and leaves the row un-finished rather than ready', async () => {
    const spare = await stageSpareRevision();
    await pg.query(`UPDATE simulations SET status = 'processing' WHERE id = $1`, [simId]);

    // The precondition a race PRODUCES: the pointer moves between our opening read and our
    // activation. Created explicitly, from a hook that fires once, mid-staging.
    let fired = false;
    adapter.hooks.onUpload = async (key) => {
      if (fired || !key.includes('/revisions/')) return;
      if (key.includes(spare) || key.includes(rev1)) return;
      fired = true;
      await revisions.activate({
        simulationId: simId, revisionId: spare, storagePrefix: prefix,
        expectedActiveRevisionId: rev1, supersede: 'retired',
      });
    };

    await expect(
      svc.replaceIntoRevision({ projectId, simId, files: upload(), entryRelPath: 'index.html' }),
    ).rejects.toBeInstanceOf(RevisionConflict);

    const sim = await simRow();
    // The interloper is live; we damaged nothing.
    expect(sim.active_revision_id).toBe(spare);
    // AND the row did not finish. A terminal status written outside the activation transaction
    // would read 'ready' here — a package that is live with a row claiming the replace succeeded.
    expect(sim.status).toBe('processing');

    // Our draft can never be activated later by something else.
    const drafts = (await revisionRows()).filter((r) => r.created_by === 'simulation-replace');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe('failed');
  });

  it('nests the customer bundle so a file named manifest.json cannot shadow the revision manifest', async () => {
    // THE COLLISION THIS PREVENTS. A revision's own manifest is written at `<rev>/manifest.json`,
    // AFTER every file has been written and byte-verified. If a customer file could take the same
    // key, verification would pass and the manifest write would then silently replace the
    // customer's bytes — a corrupted package that reports itself healthy.
    const res = await svc.replaceIntoRevision({
      projectId, simId, entryRelPath: 'index.html',
      files: new Map([
        ['index.html', Buffer.from(NEW_HTML, 'utf8')],
        ['manifest.json', Buffer.from('{"mine":true}', 'utf8')],
      ]),
    });
    const rp = revPrefix(res.revisionId);

    // The customer's file, intact, under the package subdirectory…
    expect(adapter.objects.get(`${rp}/package/manifest.json`)!.bytes.toString('utf8'))
      .toBe('{"mine":true}');
    // …and the revision's own manifest, which is a manifest and not the customer's JSON.
    const ours = JSON.parse(adapter.objects.get(`${rp}/manifest.json`)!.bytes.toString('utf8'));
    expect(ours.revisionId).toBe(res.revisionId);
    expect(ours.entry).toBe('package/index.html');
    expect(ours.files.map((f: { path: string }) => f.path)).toContain('package/manifest.json');
  });

  it('refuses a legacy simulation rather than silently deriving one', async () => {
    await pg.query(
      `UPDATE simulations SET active_revision_id = NULL, active_revision_entry_key = NULL WHERE id = $1`,
      [simId]);
    await expect(
      svc.replaceIntoRevision({ projectId, simId, files: upload(), entryRelPath: 'index.html' }),
    ).rejects.toBeInstanceOf(NoActiveRevision);
  });
});

// ═══ THE PRIMITIVE'S ATOMICITY ═══════════════════════════════════════════════════════════

describe('the caller\'s row write and the pointer flip commit together, or neither does', () => {
  /**
   * THE CASE THE CAS-LOSS TESTS ABOVE CANNOT SEE.
   *
   * When the activation LOSES, the hook is never reached — so those tests pass just as happily
   * against an implementation that runs the hook AFTER `activate()` resolves. What separates the
   * two is the opposite direction: the activation SUCCEEDS and the caller's write fails. Inside
   * the transaction that is a full rollback, pointer included. Outside it, the package goes live
   * and the row keeps saying the job never finished — the ef651a9 defect, exactly.
   *
   * Asserted on the primitive because both writers reach the transaction through it, and neither
   * of their own hooks can be made to fail without inventing a failure they do not have.
   */
  const carryEverything = (base: { manifest: { files: Array<{ path: string; role: string; contentType: string }> }; read: (p: string) => Promise<Buffer>; entryManifestPath: string }) => ({
    files: base.manifest.files
      .filter((f) => f.role !== 'poster' && f.role !== 'canary')
      .map((f) => ({
        manifestPath: f.path, role: f.role as never, contentType: f.contentType,
        read: () => base.read(f.path),
      })),
    entryManifestPath: base.entryManifestPath,
  });

  it('rolls the POINTER back when the activation hook throws', async () => {
    await expect(deriveRevision({
      storage: adapter as never,
      simulationId: simId, projectId, createdBy: 'atomicity-probe', trigger: 'test',
      transform: (base) => carryEverything(base as never),
      onActivated: async () => { throw new Error('the section row vanished'); },
    })).rejects.toThrow('the section row vanished');

    const sim = await simRow();
    // The package that was live is still live. An implementation that ran the hook after the
    // transaction committed would have moved the pointer to bytes whose caller then failed.
    expect(sim.active_revision_id).toBe(rev1);
    const revs = await revisionRows();
    expect(revs.find((r) => r.id === rev1)!.status).toBe('active');
    // …and the incumbent was not left demoted by a half-applied activation.
    expect(revs.filter((r) => r.status === 'active')).toHaveLength(1);
    // The abandoned draft cannot be activated later by anything else.
    expect(revs.find((r) => r.created_by === 'atomicity-probe')!.status).toBe('failed');
  });

  it('commits the hook\'s write with the flip when both succeed', async () => {
    let seen: string | null = null;
    const res = await deriveRevision({
      storage: adapter as never,
      simulationId: simId, projectId, createdBy: 'atomicity-probe', trigger: 'test',
      transform: (base) => carryEverything(base as never),
      onActivated: async (tx, r) => {
        seen = r.revisionId;
        // Read THROUGH the transaction handle: the pointer flip is already visible to it, which is
        // what makes an in-transaction hook able to depend on the activation having happened.
        await tx.execute(sql`UPDATE simulations SET error = ${r.revisionId} WHERE id = ${simId}`);
      },
    });

    const sim = await simRow();
    expect(seen).toBe(res.revisionId);
    expect(sim.error).toBe(res.revisionId);
    expect(sim.active_revision_id).toBe(res.revisionId);
  });
});

// ═══ LEGACY IS UNTOUCHED ═════════════════════════════════════════════════════════════════════════

describe('a LEGACY simulation keeps its mutable-prefix paths, exactly as before', () => {
  beforeEach(async () => {
    // Un-revision the simulation: no pointer, and the mutable package is what is served.
    await pg.query(
      `UPDATE simulations SET active_revision_id = NULL, active_revision_entry_key = NULL WHERE id = $1`,
      [simId]);
    adapter.uploadLog.length = 0;
  });

  it('replace still swaps files IN PLACE and creates no revision', async () => {
    const revisionsBefore = (await revisionRows()).length;

    const res = await svc.processReplace({
      projectId, simId, entryRelPath: 'index.html',
      files: new Map([['index.html', Buffer.from(NEW_HTML, 'utf8')], ['styles.css', NEW_CSS]]),
    });

    expect(res.entryKey).toBe(`${prefix}/index.html`);
    expect(adapter.objects.get(`${prefix}/styles.css`)!.bytes).toEqual(NEW_CSS);
    // The generated artifacts survive the swap and are re-wired, as they always did.
    const entry = adapter.objects.get(`${prefix}/index.html`)!.bytes.toString('utf8');
    expect(entry).toContain('REPLACED');
    expect(entry).toContain(`src="./bridge.js?v=${computeBridgeHash(BRIDGE.toString('utf8'))}"`);
    expect(entry).toContain('./guidance.js?v=');
    expect(adapter.objects.get(`${prefix}/bridge.js`)!.bytes).toEqual(BRIDGE);

    // No revision was created and none was activated.
    expect((await revisionRows()).length).toBe(revisionsBefore);
    expect((await simRow()).active_revision_id).toBeNull();
    expect(adapter.uploadLog.some((k) => k.includes('/revisions/'))).toBe(false);
  });

  it('publish-guidance still writes guidance.js and the entry HTML to the mutable prefix', async () => {
    const revisionsBefore = (await revisionRows()).length;

    const res = await guidance.publishGuidance({
      simId, projectId, entries: [CUE], language: 'en', existing: [CUE],
      entryKey: `${prefix}/index.html`,
    });

    expect(res.revisionId).toBeNull();
    expect(res.simulation).toBeNull();
    expect(adapter.objects.get(`${prefix}/guidance.js`)!.bytes.toString('utf8'))
      .toContain('Press the start button');
    expect(adapter.objects.get(`${prefix}/index.html`)!.bytes.toString('utf8'))
      .toContain(`./guidance.js?v=${res.guidanceHash}`);

    expect((await revisionRows()).length).toBe(revisionsBefore);
    expect((await simRow()).active_revision_id).toBeNull();
    expect(adapter.uploadLog.some((k) => k.includes('/revisions/'))).toBe(false);
  });
});

// ═══ PUBLISH GUIDANCE ════════════════════════════════════════════════════════════════════════════

describe('publish-guidance on a revisioned package derives a NEW revision', () => {
  const publish = () => guidance.publishGuidance({
    simId, projectId, entries: [CUE], language: 'en', existing: [CUE],
    entryKey: `${prefix}/index.html`, meta: { language: 'en' },
  });

  it('injects guidance.js and the entry tag into a NEW revision, leaving the base untouched', async () => {
    const base = snapshotOf(keysUnder(revPrefix(rev1)));

    const res = await publish();
    expect(res.revisionId).not.toBeNull();
    const rp = revPrefix(res.revisionId!);

    // The pointer moved to bytes that did not exist before this call.
    const sim = await simRow();
    expect(sim.active_revision_id).toBe(res.revisionId);
    expect(sim.active_revision_entry_key).toBe(`${rp}/package/index.html`);

    // The new revision carries the guidance, and the entry actually loads it.
    expect(adapter.objects.get(`${rp}/package/guidance.js`)!.bytes.toString('utf8'))
      .toContain('Press the start button');
    expect(adapter.objects.get(`${rp}/package/index.html`)!.bytes.toString('utf8'))
      .toContain(`./guidance.js?v=${res.guidanceHash}`);
    // …while the bridge and the customer assets are the SAME BYTES: a guidance publish must not
    // disturb the section scripts.
    expect(adapter.objects.get(`${rp}/package/bridge.js`)!.bytes).toEqual(BRIDGE);
    expect(adapter.objects.get(`${rp}/package/assets/logo.png`)!.bytes).toEqual(PNG);

    // The base revision is byte-identical — an in-place rewrite fails here.
    expect(snapshotOf(keysUnder(revPrefix(rev1)))).toEqual(base);

    // Nothing was written to the mutable prefix EXCEPT the content-addressed cue audio, which is
    // deliberately revision-independent (see publishIntoRevision's header).
    const mutableWrites = adapter.uploadLog.filter((k) => !k.startsWith(`${prefix}/revisions/`));
    expect(mutableWrites.every((k) => k.startsWith(`${prefix}/guidance/en/`))).toBe(true);
    expect(adapter.objects.get(`${prefix}/guidance.js`)!.bytes).toEqual(GUIDANCE);   // the OLD one
    expect(adapter.objects.get(`${prefix}/index.html`)!.bytes).toEqual(HTML);        // untouched
  });

  it('writes guidance, meta and status INSIDE the activation transaction', async () => {
    const res = await publish();

    const sim = await simRow();
    expect(sim.guidance_status).toBe('ready');
    expect(sim.guidance_error).toBeNull();
    expect((sim.guidance_meta as { guidanceHash?: string }).guidanceHash).toBe(res.guidanceHash);
    expect((sim.guidance as GuidanceEntryStored[])[0]!.audioUrl).toContain(`${prefix}/guidance/en/`);
    // The row the caller reports to the client is the one that was written in that transaction.
    expect(res.simulation!.guidance_status).toBe('ready');
  });

  it('LOSES to a concurrent activation, and does NOT mark the guidance ready', async () => {
    const spare = await stageSpareRevision();

    let fired = false;
    adapter.hooks.onUpload = async (key) => {
      if (fired || !key.includes('/revisions/')) return;
      if (key.includes(spare) || key.includes(rev1)) return;
      fired = true;
      await revisions.activate({
        simulationId: simId, revisionId: spare, storagePrefix: prefix,
        expectedActiveRevisionId: rev1, supersede: 'retired',
      });
    };

    await expect(publish()).rejects.toBeInstanceOf(RevisionConflict);

    const sim = await simRow();
    expect(sim.active_revision_id).toBe(spare);
    // The whole activation transaction rolled back, and the row write was in it. A publication
    // that reported success outside the transaction would read 'ready' here while serving bytes
    // that carry no guidance at all.
    expect(sim.guidance_status).toBe('draft');
    expect((sim.guidance as GuidanceEntryStored[])[0]!.audioUrl).toBeNull();
    // The interloper's package really has no guidance in it.
    expect(adapter.objects.has(`${revPrefix(spare)}/package/guidance.js`)).toBe(true);
    expect(adapter.objects.get(`${revPrefix(spare)}/package/index.html`)!.bytes.toString('utf8'))
      .not.toContain('guidance.js?v=');
  });

  it('busts every section by MOVING THE POINTER, not by rewriting N section URLs', async () => {
    const before = await sectionUrl();
    const res = await publish();
    const after = await sectionUrl();

    // The stored value is what THIS section published, and it is left exactly alone.
    expect(after).toBe(before);
    expect(after).not.toContain('?g=');
    expect(after).not.toContain('&g=');

    // …and yet the URL the player is served changed, because the pointer did. A publication that
    // did nothing at all would also leave the stored URL alone — this is what separates the two.
    const sim = await simRow();
    const served = resolveSimulationUrl(after, sim, { getSimPublicUrl: (k) => `https://cdn.test/${k}` });
    expect(served).toBe(`https://cdn.test/${revPrefix(res.revisionId!)}/package/index.html?section=main&v=abc`);
    expect(served).not.toContain(rev1);
  });

  it('does not downgrade a recorded capability to UNKNOWN', async () => {
    // The fixture bridge posts SCRIPT_APPLIED, so revision 1 recorded the capability and the row
    // projects it.
    expect((await simRow()).bridge_ack_capable).toBe(true);

    await publish();

    // The bridge was carried across byte-for-byte, so the answer is unchanged. A derivation that
    // recorded no capabilities would project NULL here and silently re-arm the apply gate's
    // bounded cover for every section of this package.
    expect((await simRow()).bridge_ack_capable).toBe(true);
    const active = (await revisionRows()).find((r) => r.created_by === 'guidance-publish')!;
    expect((active.metadata as Record<string, Record<string, unknown>>)[BRIDGE_CAPABILITIES_KEY])
      .toMatchObject({ scriptApplied: true });
  });
});

// ═══ THE CAPABILITY RULE, ON ITS OWN ═════════════════════════════════════════════════════════════

describe('derivedCapabilities never manufactures a confident answer', () => {
  it('inherits the bridge half when the derived package has NO bridge', () => {
    const caps = derivedCapabilities({
      baseMetadata: { [BRIDGE_CAPABILITIES_KEY]: { scriptApplied: true, requiresImportMaps: false } },
      bridgeJs: null,
      entryHtml: '<html><body>no import map</body></html>',
    });
    // `detectBridgeCapabilities('')` would answer `false` — a claim about a bridge that is not
    // there, and one the apply gate acts on.
    expect(caps).toMatchObject({ scriptApplied: true, requiresImportMaps: false });
  });

  it('leaves an unknown fact unknown rather than answering false', () => {
    const caps = derivedCapabilities({
      baseMetadata: null, bridgeJs: null, entryHtml: '<html><body></body></html>',
    });
    expect('scriptApplied' in caps).toBe(false);
  });

  it('re-detects the ENTRY half, because this publication rewrote the entry', () => {
    const caps = derivedCapabilities({
      baseMetadata: { [BRIDGE_CAPABILITIES_KEY]: { scriptApplied: true, requiresImportMaps: true } },
      bridgeJs: "_post({ type: 'SCRIPT_APPLIED' })",
      entryHtml: '<html><head></head><body>the import map was removed</body></html>',
    });
    expect(caps).toMatchObject({ scriptApplied: true, requiresImportMaps: false });
  });
});

// ═══ REVISION-AWARE READS ════════════════════════════════════════════════════════════════════════

describe('the read paths describe the package that is SERVED', () => {
  it('lists the active revision only — not every revision the package has ever had', async () => {
    const res = await svc.replaceIntoRevision({
      projectId, simId,
      files: new Map([['index.html', Buffer.from(NEW_HTML, 'utf8')], ['styles.css', NEW_CSS]]),
      entryRelPath: 'index.html',
    });

    const sim = await rows<{ id: string; storage_prefix: string; active_revision_id: string | null }>(
      `SELECT id, storage_prefix, active_revision_id FROM simulations WHERE id = $1`, [simId]);
    const view = (await readActiveRevisionPackage(adapter as never, sim[0]!))!;

    expect(view.revisionId).toBe(res.revisionId);
    // Customer-facing paths, and ONLY the live revision's files. Listing the prefix would return
    // both revisions' copies of index.html under machine-generated directory names.
    expect(view.files.map((f) => f.relPath).sort())
      .toEqual(['bridge.js', 'guidance.js', 'index.html', 'styles.css']);
    expect(view.files.every((f) => f.key.startsWith(`${revPrefix(res.revisionId)}/`))).toBe(true);
    expect(view.entryKey).toBe(`${revPrefix(res.revisionId)}/package/index.html`);
    expect(view.entryRelPath).toBe('index.html');
  });

  it('returns null for a legacy simulation so every caller keeps its own listing path', async () => {
    await pg.query(
      `UPDATE simulations SET active_revision_id = NULL, active_revision_entry_key = NULL WHERE id = $1`,
      [simId]);
    const sim = await rows<{ id: string; storage_prefix: string; active_revision_id: string | null }>(
      `SELECT id, storage_prefix, active_revision_id FROM simulations WHERE id = $1`, [simId]);
    expect(await readActiveRevisionPackage(adapter as never, sim[0]!)).toBeNull();
  });
});
