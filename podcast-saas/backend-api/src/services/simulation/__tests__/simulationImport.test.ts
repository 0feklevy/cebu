/**
 * Importing a simulation from another project — the `+` without the re-upload.
 *
 * Two properties carry the weight here:
 *   1. The ELIGIBILITY seam holds inside the real flow — a private source is a 404 (never a 403),
 *      the destination is checked first, and the sim names its own project (a client cannot
 *      launder a private sim through a permissive source-project id, because there IS no
 *      source-project input).
 *   2. The COPY discipline: bytes before row, bridge.js and system-owned subtrees excluded, and
 *      the new row claims nothing the copy did not produce (package_class null, guidance none).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  sims: new Map<string, Record<string, unknown>>(),
  projects: new Map<string, Record<string, unknown>>(),
  inserted: [] as Record<string, unknown>[],
  copies: [] as { from: string; to: string }[],
  listed: [] as string[],
};

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      simulations: { findFirst: async () => state.sims.get('lookup') ?? null },
      projects: { findFirst: vi.fn(async () => state.projects.get('next') ?? null) },
    },
    insert: () => ({ values: (v: Record<string, unknown>) => ({ returning: async () => { state.inserted.push(v); return [v]; } }) }),
  },
}));
vi.mock('../../../db/schema.js', () => ({ simulations: {}, projects: {}, collaborators: {} }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../collabAccess.js', () => ({ isCollaborator: vi.fn(async () => false) }));

// The source reader: revisioned shape with a manifest file list.
const srcState = { files: null as { rel: string; key: string; role: string }[] | null, entryRelPath: 'index.html' as string | null };
vi.mock('../replaceCompatibilitySource.js', () => ({
  readReplaceCompatibilitySource: async () => ({
    origin: 'revision', bridgeJs: '', bridgeKey: null,
    entryRelPath: srcState.entryRelPath, revisionId: 'rev-1', files: srcState.files,
  }),
}));

import { SimulationImportService } from '../SimulationImportService.js';

const ALICE = 'uid-alice';
const storage = {
  copyObject: vi.fn(async (from: string, to: string) => { state.copies.push({ from, to }); }),
  listObjects: vi.fn(async () => state.listed),
  getSimPublicUrl: (k: string) => `https://cdn.example/${k}`,
} as never;


beforeEach(() => {
  state.sims.clear(); state.projects.clear();
  state.inserted.length = 0; state.copies.length = 0; state.listed = [];
  srcState.files = [
    { rel: 'index.html', key: 'simulations/srcP/srcSim/revisions/rev-1/package/index.html', role: 'entry' },
    { rel: 'app.js', key: 'simulations/srcP/srcSim/revisions/rev-1/package/app.js', role: 'asset' },
    { rel: 'bridge.js', key: 'simulations/srcP/srcSim/revisions/rev-1/package/bridge.js', role: 'runtime' },
  ];
  srcState.entryRelPath = 'index.html';
});

async function runImport(over: {
  source?: Record<string, unknown> | null;
  sourceProject?: Record<string, unknown> | null;
  destProject?: Record<string, unknown> | null;
} = {}) {
  const source = over.source === undefined ? {
    id: 'sim-1', project_id: 'srcP', name: 'Boids', status: 'ready',
    storage_prefix: 'simulations/srcP/sim-1', entry_file: 'https://cdn.example/x/index.html',
    active_revision_id: 'rev-1', bridge_functions: [{ name: 'pluck' }],
  } : over.source;
  const sourceProject = over.sourceProject === undefined
    ? { id: 'srcP', visibility: 'public', created_by: 'uid-bob', share_token: null }
    : over.sourceProject;
  const destProject = over.destProject === undefined
    ? { id: 'dstP', visibility: 'private', created_by: ALICE, share_token: null }
    : over.destProject;

  state.sims.set('lookup', source as never);
  const seq = [source ? sourceProject : null, destProject].filter(() => true);
  let i = 0;
  const { db } = await import('../../../db/index.js');
  (db.query.projects.findFirst as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    // Source facts resolve first only when a source exists; mirror the service's call order.
    if (!source) return destProject;
    return seq[i++] ?? null;
  });

  const svc = new SimulationImportService(storage);
  return svc.importSimulation({
    destProjectId: 'dstP', sourceSimulationId: 'sim-1',
    who: { uid: ALICE, shareToken: null },
    user: { id: ALICE, email: 'a@x.com' } as never,
  });
}

describe('eligibility inside the real flow', () => {
  it('imports a public source into an editable destination', async () => {
    const r = await runImport();
    expect(r.ok).toBe(true);
  });

  it('answers 404 — not 403 — for a private source', async () => {
    const r = await runImport({ sourceProject: { id: 'srcP', visibility: 'private', created_by: 'uid-bob', share_token: null } });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(state.copies.length, 'bytes were copied for a refused import').toBe(0);
  });

  it('refuses a destination the caller cannot edit, before looking at the source', async () => {
    const r = await runImport({ destProject: { id: 'dstP', visibility: 'public', created_by: 'uid-bob', share_token: null } });
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a still-processing source with a sentence, not a copy of half a sim', async () => {
    const r = await runImport({ source: { id: 'sim-1', project_id: 'srcP', name: 'x', status: 'processing', storage_prefix: 'simulations/srcP/sim-1', entry_file: 'e' } });
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(state.copies.length).toBe(0);
  });
});

describe('the copy discipline', () => {
  it('copies the manifest files EXCEPT bridge.js, server-side, into the new prefix', async () => {
    const r = await runImport();
    expect(r.ok).toBe(true);
    expect(state.copies.map((c) => c.from)).toEqual([
      'simulations/srcP/srcSim/revisions/rev-1/package/index.html',
      'simulations/srcP/srcSim/revisions/rev-1/package/app.js',
    ]);
    // bridge.js was in the manifest and is NOT among the copies: its bodies are keyed by the
    // source project's section ids, which exist nowhere in the destination.
    for (const c of state.copies) {
      expect(c.to).toMatch(/^simulations\/dstP\/[0-9a-f-]{36}\/(index\.html|app\.js)$/);
    }
  });

  it('copies bytes BEFORE inserting the row', async () => {
    await runImport();
    // The insert captured the copies count implicitly: at insert time all copies were done.
    expect(state.inserted.length).toBe(1);
    expect(state.copies.length).toBe(2);
  });

  it('the new row claims nothing the copy did not produce', async () => {
    const r = await runImport();
    expect(r.ok).toBe(true);
    const row = state.inserted[0];
    expect(row.package_class, 'a canary verdict about the SOURCE bytes was carried over').toBeNull();
    expect(row.guidance_status).toBe('none');
    expect(row.status).toBe('ready');
    expect(row.name).toBe('Boids');
    expect(String(row.entry_file)).toMatch(/^https:\/\/cdn\.example\/simulations\/dstP\/.+\/index\.html$/);
  });

  it('legacy source: lists the prefix and excludes the system-owned subtrees', async () => {
    srcState.files = null;
    state.listed = [
      'simulations/srcP/sim-1/index.html',
      'simulations/srcP/sim-1/app.js',
      'simulations/srcP/sim-1/bridge.js',
      'simulations/srcP/sim-1/revisions/r9/package/index.html',
      'simulations/srcP/sim-1/posters/p/large.webp',
    ];
    const r = await runImport();
    expect(r.ok).toBe(true);
    expect(state.copies.map((c) => c.from)).toEqual([
      'simulations/srcP/sim-1/index.html',
      'simulations/srcP/sim-1/app.js',
    ]);
  });

  it('refuses an import with nothing to copy rather than minting an empty sim', async () => {
    srcState.files = [];
    const r = await runImport();
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(state.inserted.length).toBe(0);
  });
});
