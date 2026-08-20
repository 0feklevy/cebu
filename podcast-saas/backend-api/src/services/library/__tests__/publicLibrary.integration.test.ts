/**
 * The public library mini-site, end to end against a REAL Postgres engine (PGlite) with every
 * migration through 065 replayed, and the actual Fastify routes registered.
 *
 * This file exists because of a specific, verified coverage blind spot: `backend-api/vitest.config.ts`
 * measures coverage over `src/services/**` ONLY, so a new controller can be entirely untested
 * without moving the number by a single point. There are no controller tests for
 * `share.controller.ts` or `permalink.controller.ts` today. These seven are what stop
 * `library-share.controller.ts` inheriting that.
 *
 * The highest-value one is `no private field survives serialization` — it asserts over the WHOLE
 * response string rather than field by field, so a future field added by spreading a database row
 * fails here instead of shipping a storage key to an anonymous visitor.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import Fastify, { type FastifyInstance } from 'fastify';
import * as schema from '../../../db/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'db', 'migrations');
const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();

// The app's `db` is a module singleton bound to a real Postgres URL at import time. Proxying it to
// the per-test PGlite instance is the same seam `publicQuery.integration.test.ts` uses.
const holder = vi.hoisted(() => ({ current: null as unknown as ReturnType<typeof drizzle> }));
vi.mock('../../../db/index.js', () => ({
  db: new Proxy({}, { get: (_t, prop) => (holder.current as Record<string | symbol, unknown>)[prop] }),
}));

import { registerLibraryShareRoutes } from '../../../controllers/v1/library-share.controller.js';
import { mintShare, resolveShare, revokeShare, liveShareForProject } from '../LibraryShareService.js';

let pg: PGlite;
let app: FastifyInstance;
let orgId: string;
let userId: string;
let projectId: string;

const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await pg.query<T>(sql, params)).rows;

beforeAll(() => {
  process.env.PUBLIC_SITE_URL = 'https://flowvidco.test';
  process.env.BACKEND_API_URL = 'http://localhost:8080';
  // Keeps `getStorageAdapter` on the local adapter, whose sim URLs are on the API origin — which is
  // exactly what the origin guard in buildLibraryView expects. An R2 adapter here would (correctly)
  // drop every simulation.
  process.env.STORAGE_BACKEND = 'local';
});

beforeEach(async () => {
  pg = new PGlite();
  for (const f of ALL_MIGRATIONS) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  holder.current = drizzle(pg, { schema });

  orgId = (await q<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Org') RETURNING id`))[0].id;
  userId = (await q<{ id: string }>(`INSERT INTO users (firebase_uid, email) VALUES ('uid-owner','owner@example.com') RETURNING id`))[0].id;
  projectId = (await q<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,$3) RETURNING id`,
    [orgId, userId, 'The Edge of Chaos: When One Bird Changes the Sky'],
  ))[0].id;

  app = Fastify();
  await registerLibraryShareRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await pg.close();
});

// ── seeding helpers ─────────────────────────────────────────────────────────────────────────────

async function addSimulation(name: string, status = 'ready'): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, status, bridge_functions, guidance)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [projectId, name, `simulations/${projectId}/pkg`, `simulations/${projectId}/pkg/index.html`, status,
      JSON.stringify([{ name: 'setGravity' }]), JSON.stringify([{ at: 0, say: 'hello' }])],
  );
  return r[0].id;
}

async function addImage(filename: string): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO image_files (project_id, filename, storage_key, original_url, width, height, crop_x, crop_y, crop_w, crop_h)
     VALUES ($1,$2,$3,$4,900,600,0.1,0.2,0.7,0.6) RETURNING id`,
    [projectId, filename, `images/${projectId}/${filename}`, `https://cdn.test/storage/v1/object/public/media/images/${filename}`],
  );
  return r[0].id;
}

async function addVideo(filename: string, hlsStatus = 'ready'): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, storage_key, status, hls_status, duration_sec)
     VALUES ($1,$2,$3,'ready',$4,12.5) RETURNING id`,
    [projectId, filename, `video-raw/${filename}`, hlsStatus],
  );
  // `hls/{video_file_id}/…` is the real layout (runVideoTranscode / hlsRetention), so it is written
  // after the insert rather than guessed — the leak assertions below depend on it being truthful.
  await q(`UPDATE video_files SET hls_master_key = $2 WHERE id = $1`, [r[0].id, `hls/${r[0].id}/master.m3u8`]);
  return r[0].id;
}

async function addAudio(filename: string): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO audio_files (project_id, filename, storage_key, url, duration_sec)
     VALUES ($1,$2,$3,$4,3.25) RETURNING id`,
    [projectId, filename, `audio/${projectId}/${filename}`, `https://cdn.test/storage/v1/object/public/media/audio/${filename}`],
  );
  return r[0].id;
}

async function seedOneOfEach(): Promise<void> {
  await addSimulation('Boids');
  await addImage('diagram.png');
  await addVideo('intro.mp4');
  await addAudio('theme.mp3');
}

const getPublic = (slug: string, query = '') =>
  app.inject({ method: 'GET', url: `/api/v1/public/library/${slug}${query}` });

// ────────────────────────────────────────────────────────────────────────────────────────────────

describe('minting', () => {
  it('1. is idempotent — a second mint returns the same slug, not a second link', async () => {
    const first = await mintShare({ id: projectId, title: 'The Edge of Chaos' }, userId);
    const second = await mintShare({ id: projectId, title: 'The Edge of Chaos' }, userId);

    expect(second.id).toBe(first.id);
    expect(second.slug).toBe(first.slug);
    expect(first.slug).toMatch(/^the-edge-of-chaos-[a-z2-7]{13}$/);
    expect(await q(`SELECT id FROM library_shares WHERE project_id = $1`, [projectId])).toHaveLength(1);
  });

  it('2. re-mints the code on a forced 23505 and succeeds within three attempts', async () => {
    // Park the first code on ANOTHER project, so attempt 1 hits the unique index on `slug` rather
    // than the per-project live index (which would be answered by idempotency instead of a retry).
    const other = (await q<{ id: string }>(
      `INSERT INTO projects (org_id, title) VALUES ($1,'Other') RETURNING id`, [orgId],
    ))[0].id;
    await q(
      `INSERT INTO library_shares (project_id, slug, code) VALUES ($1,'chaos-aaaaaaaaaaaaa','aaaaaaaaaaaaa')`,
      [other],
    );

    const codes = ['aaaaaaaaaaaaa', 'bbbbbbbbbbbbb'];
    let calls = 0;
    const share = await mintShare(
      { id: projectId, title: 'Chaos' }, userId, undefined,
      () => codes[calls++] ?? 'zzzzzzzzzzzzz',
    );

    expect(calls).toBe(2);
    expect(share.slug).toBe('chaos-bbbbbbbbbbbbb');
    expect((await getPublic(share.slug)).statusCode).toBe(200);
  });

  it('falls back to an id-derived base when the title yields nothing sluggable', async () => {
    const share = await mintShare({ id: projectId, title: '???' }, userId);
    expect(share.slug.startsWith(`lib-${projectId.replace(/-/g, '').slice(0, 8)}-`)).toBe(true);
  });
});

describe('resolution', () => {
  it('3. revoked, expired and unknown are byte-identical 404s', async () => {
    const revokedShare = await mintShare({ id: projectId, title: 'Revoked' }, userId);
    await revokeShare(projectId);

    const expiredProject = (await q<{ id: string }>(
      `INSERT INTO projects (org_id, title) VALUES ($1,'Expired') RETURNING id`, [orgId],
    ))[0].id;
    await q(
      `INSERT INTO library_shares (project_id, slug, code, expires_at)
       VALUES ($1,'expired-cccccccccccc','cccccccccccc', now() - interval '1 hour')`,
      [expiredProject],
    );

    const revoked = await getPublic(revokedShare.slug);
    const expired = await getPublic('expired-cccccccccccc');
    const unknown = await getPublic('never-minted-dddddddddddd');

    for (const r of [revoked, expired, unknown]) expect(r.statusCode).toBe(404);
    // Byte-identical: a visitor must not be able to tell "revoked" from "never existed".
    expect(expired.body).toBe(revoked.body);
    expect(unknown.body).toBe(revoked.body);

    expect(await resolveShare(revokedShare.slug)).toBeNull();
    expect(await liveShareForProject(projectId)).toBeNull();
  });

  it('resolves the clean permalink alias only while the project is public', async () => {
    await mintShare({ id: projectId, title: 'Aliased' }, userId);
    await q(`UPDATE projects SET slug = 'my-video', visibility = 'unlisted' WHERE id = $1`, [projectId]);
    expect((await getPublic('my-video')).statusCode).toBe(404);

    await q(`UPDATE projects SET visibility = 'public' WHERE id = $1`, [projectId]);
    expect((await getPublic('my-video')).statusCode).toBe(200);
  });
});

describe('the view model', () => {
  it('4. a type outside include_types is absent from materials AND its sub-route 404s', async () => {
    await seedOneOfEach();
    const share = await mintShare({ id: projectId, title: 'Scoped' }, userId, ['image', 'video']);

    const res = await getPublic(share.slug);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.materials.map((m: { type: string }) => m.type).sort()).toEqual(['image', 'video']);
    // Absent from the payload, not hidden by CSS — and genuinely zero in the counts.
    expect(body.counts.simulation).toBe(0);
    expect(body.counts.audio).toBe(0);

    expect((await getPublic(share.slug, '?type=simulation')).statusCode).toBe(404);
    expect((await getPublic(share.slug, '?type=sounds')).statusCode).toBe(404);
    expect((await getPublic(share.slug, '?type=images')).statusCode).toBe(200);
  });

  it('5. omits a processing simulation and a video whose HLS is not ready', async () => {
    await addSimulation('Ready sim', 'ready');
    await addSimulation('Half-built sim', 'processing');
    await addVideo('ready.mp4', 'ready');
    await addVideo('transcoding.mp4', 'processing');
    await addVideo('broken.mp4', 'failed');
    const share = await mintShare({ id: projectId, title: 'Partial' }, userId);

    const body = (await getPublic(share.slug)).json();
    const names = body.materials.map((m: { name: string }) => m.name);
    expect(names).toContain('Ready sim');
    expect(names).toContain('ready.mp4');
    expect(names).not.toContain('Half-built sim');
    expect(names).not.toContain('transcoding.mp4');
    expect(names).not.toContain('broken.mp4');
    expect(body.counts).toEqual({ simulation: 1, image: 0, video: 1, audio: 0 });
  });

  it('6. no private field survives serialization — asserted over the WHOLE response', async () => {
    await seedOneOfEach();
    await q(`UPDATE projects SET share_token = 'super-secret-token' WHERE id = $1`, [projectId]);
    const share = await mintShare({ id: projectId, title: 'Leak check' }, userId);

    const res = await getPublic(share.slug);
    expect(res.statusCode).toBe(200);
    const json = res.body;

    // Field NAMES that must never appear anywhere in the payload. This is the assertion that
    // survives a refactor: it fails the moment someone spreads a database row into a material.
    for (const field of [
      'storage_key', 'storageKey', 'share_token', 'shareToken', 'project_id', 'projectId',
      'org_id', 'orgId', 'created_by', 'createdBy', 'bridge_functions', 'bridgeFunctions',
      'guidance', 'canary_report', 'canaryReport', 'entry_file', 'entryFile', 'storage_prefix',
      'render_count', 'renderCount', 'revoked_at', 'expires_at', 'hls_master_key', 'captions_vtt',
    ]) {
      expect(json, `"${field}" leaked into the public library payload`).not.toContain(field);
    }

    // And the VALUES, which is the half a rename would otherwise slip past.
    expect(json).not.toContain('super-secret-token');
    expect(json).not.toContain(orgId);
    expect(json).not.toContain(userId);
    // The raw upload key — the one storage key with no public route in front of it.
    expect(json).not.toContain('video-raw/');

    // The share CODE appears exactly once, inside `canonicalUrl`, and nowhere else. That is not a
    // leak: the visitor typed it to get here. Everywhere else it would be one.
    expect(json.split(share.code)).toHaveLength(2);
    expect(res.json().canonicalUrl).toContain(share.code);

    // THE PROJECT ID IS THE ONE THING THE PLAN GOT WRONG, and it is a platform property rather
    // than a shaping mistake: real simulation packages are stored under
    // `simulations/{project_id}/{sim_id}/…` (SimulationService), and `/sim-public/{key}` is that
    // key verbatim. Every existing public surface — `/v/{token}`, the permalink player config —
    // already emits it for the same reason. So the assertion that CAN be kept is the narrow,
    // truthful one: the id appears only inside a simulation URL, never as data.
    const nonSimText = JSON.stringify({
      ...res.json(),
      materials: res.json().materials.filter((m: { type: string }) => m.type !== 'simulation'),
    });
    expect(nonSimText).not.toContain(projectId);
    for (const m of res.json().materials as Array<{ type: string; url: string }>) {
      if (m.type === 'simulation') expect(m.url).toContain(`/sim-public/simulations/${projectId}/`);
    }

    // Positive control: every assertion above would pass on an empty body, so prove there is one.
    expect(res.json().materials).toHaveLength(4);
  });

  it('7. counts cover all four buckets even when one type is requested', async () => {
    await addSimulation('Boids');
    await addImage('a.png');
    await addImage('b.png');
    await addVideo('clip.mp4');
    await addAudio('hum.mp3');
    const share = await mintShare({ id: projectId, title: 'Counted' }, userId);

    const body = (await getPublic(share.slug, '?type=images')).json();
    expect(body.materials.map((m: { type: string }) => m.type)).toEqual(['image', 'image']);
    expect(body.counts).toEqual({ simulation: 1, image: 2, video: 1, audio: 1 });
  });

  it('emits the public URLs the materials already have, and the stored crop fractions', async () => {
    await seedOneOfEach();
    const share = await mintShare({ id: projectId, title: 'Urls' }, userId);
    const body = (await getPublic(share.slug)).json();

    const byType = (t: string) => body.materials.find((m: { type: string }) => m.type === t);
    expect(byType('simulation').url).toBe(`http://localhost:8080/sim-public/simulations/${projectId}/pkg/index.html`);
    expect(byType('image').url).toBe('https://cdn.test/storage/v1/object/public/media/images/diagram.png');
    expect(byType('image').crop).toEqual({ x: 0.1, y: 0.2, w: 0.7, h: 0.6 });
    expect(byType('audio').url).toBe('https://cdn.test/storage/v1/object/public/media/audio/theme.mp3');
    expect(body.canonicalUrl).toBe(`https://flowvidco.test/${share.slug}/library`);
    expect(body.indexable).toBe(false);
  });

  it('sets the ISR-shaped Cache-Control the page depends on', async () => {
    const share = await mintShare({ id: projectId, title: 'Cached' }, userId);
    const res = await getPublic(share.slug);
    expect(res.headers['cache-control']).toBe('public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  });

  it('rate-limits the public endpoint per IP and answers 429 over quota', async () => {
    const share = await mintShare({ id: projectId, title: 'Limited' }, userId);
    let last = 200;
    // The limiter is per-process and keyed on the IP; 61 requests inside one window must trip it.
    for (let i = 0; i < 61; i++) last = (await getPublic(share.slug)).statusCode;
    expect(last).toBe(429);
  });
});
