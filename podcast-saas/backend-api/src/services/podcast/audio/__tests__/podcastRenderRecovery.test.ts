/**
 * `recoverStuckPodcastRenders` against a REAL Postgres engine.
 *
 * THE BUG THIS SUITE EXISTS FOR (database-003)
 * Startup recovery matched `claimed_at IS NULL` — which is exactly what a render that is QUEUED
 * and has not been picked up yet looks like. Every deploy therefore FAILED every render that was
 * merely waiting its turn: work that had not gone wrong, killed by a restart. Worse, the row was
 * moved to a terminal status, so the queued delivery that arrived afterwards was refused by
 * `runPodcastRenderJob`'s CAS (`status NOT IN ('ready','failed')`) and the work was gone for good.
 *
 * The distinction the recovery has to draw:
 *   • claimed_at NOT NULL and older than the stale window → a process claimed it and died → FAIL it;
 *   • claimed_at NOT NULL and inside the window          → someone may still be running it → LEAVE;
 *   • claimed_at IS NULL                                  → queued, untouched → LEAVE IT QUEUED and
 *     re-drive it. `podcast_render` / `podcast_mix_export` are NOT in PGBOSS_JOB_NAMES, so they
 *     always run on the inline driver, whose `setImmediate` dies with the process. Leaving the row
 *     alone without re-enqueueing would replace "killed on every deploy" with "hangs forever".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../../db/schema.js';

const h = vi.hoisted(() => ({
  dbRef: { current: null as unknown as Record<string, unknown> },
  enqueued: [] as Array<{ name: string; payload: unknown }>,
}));

vi.mock('../../../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../queue/index.js', () => ({
  enqueueJob: vi.fn((name: string, payload: unknown) => { h.enqueued.push({ name, payload }); }),
}));
// PodcastRenderer drags ffmpeg + TTS in; the unit under test is the recovery bookkeeping.
vi.mock('../PodcastRenderer.js', () => ({ PodcastRenderer: class { async render(): Promise<void> {} } }));

import { recoverStuckPodcastRenders } from '../runPodcastRender.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'db', 'migrations');

let pg: PGlite;
let episodeId: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}

interface RenderRow { id: string; status: string; error: string | null; claimed_at: string | Date | null }
const renderRow = (id: string): Promise<RenderRow> =>
  one<RenderRow>(`SELECT id, status, error, claimed_at FROM podcast_renders WHERE id=$1`, [id]);
const episodeStatus = async (): Promise<string> =>
  (await one<{ status: string }>(`SELECT status FROM podcast_episodes WHERE id=$1`, [episodeId])).status;

/** A render row. `claimedMinutesAgo: null` is the QUEUED, never-claimed shape. */
async function newRender(opts: {
  status?: string;
  claimedMinutesAgo?: number | null;
  kind?: 'auto' | 'mix';
} = {}): Promise<string> {
  const claimed = opts.claimedMinutesAgo == null
    ? null
    : new Date(Date.now() - opts.claimedMinutesAgo * 60_000).toISOString();
  const r = await one<{ id: string }>(
    `INSERT INTO podcast_renders (episode_id, status, claimed_at, kind) VALUES ($1,$2,$3,$4) RETURNING id`,
    [episodeId, opts.status ?? 'queued', claimed, opts.kind ?? 'auto'],
  );
  return r.id;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
  h.enqueued.length = 0;

  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Org') RETURNING id`);
  const show = await one<{ id: string }>(
    `INSERT INTO podcast_shows (org_id, title) VALUES ($1,'Show') RETURNING id`, [org.id]);
  const ep = await one<{ id: string }>(
    `INSERT INTO podcast_episodes (show_id, title, status) VALUES ($1,'Ep','rendering') RETURNING id`, [show.id]);
  episodeId = ep.id;
});

afterEach(async () => {
  await pg.close();
});

describe('recoverStuckPodcastRenders', () => {
  it('does NOT fail a render that is merely QUEUED and has never been claimed', async () => {
    // The deploy-kills-waiting-work case. The row was inserted seconds ago by the controller and
    // its inline delivery has not landed yet; nothing about it has gone wrong.
    const queued = await newRender({ status: 'queued', claimedMinutesAgo: null });

    await recoverStuckPodcastRenders();

    const row = await renderRow(queued);
    expect(row.status, 'a queued-but-unclaimed render must survive a restart untouched').toBe('queued');
    expect(row.error).toBeNull();
    expect(await episodeStatus(), 'the episode must stay in its rendering state').toBe('rendering');
  });

  it('re-drives the queued render so the lost inline delivery is replaced', async () => {
    const queued = await newRender({ status: 'queued', claimedMinutesAgo: null });

    await recoverStuckPodcastRenders();

    expect(h.enqueued).toEqual([{ name: 'podcast_render', payload: { renderId: queued } }]);
  });

  it('re-drives a queued STUDIO export onto its own job name', async () => {
    const queued = await newRender({ status: 'queued', claimedMinutesAgo: null, kind: 'mix' });

    await recoverStuckPodcastRenders();

    expect(h.enqueued).toEqual([{ name: 'podcast_mix_export', payload: { renderId: queued } }]);
  });

  it('still fails a render a dead process claimed and abandoned', async () => {
    const abandoned = await newRender({ status: 'synthesizing', claimedMinutesAgo: 45 });

    await recoverStuckPodcastRenders();

    const row = await renderRow(abandoned);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/interrupted/i);
    expect(row.claimed_at).toBeNull();
    expect(await episodeStatus(), 'the episode must be released from rendering').toBe('approved');
    expect(h.enqueued, 'an abandoned render is failed, not silently retried').toEqual([]);
  });

  it('leaves a render another live process claimed a moment ago alone', async () => {
    const live = await newRender({ status: 'synthesizing', claimedMinutesAgo: 1 });

    await recoverStuckPodcastRenders();

    expect((await renderRow(live)).status).toBe('synthesizing');
  });

  it('leaves terminal rows alone', async () => {
    const ready = await newRender({ status: 'ready', claimedMinutesAgo: null });
    const failed = await newRender({ status: 'failed', claimedMinutesAgo: null });

    await recoverStuckPodcastRenders();

    expect((await renderRow(ready)).status).toBe('ready');
    expect((await renderRow(failed)).status).toBe('failed');
    expect(h.enqueued, 'terminal rows must never be re-driven').toEqual([]);
  });

  it('sends an abandoned render`s episode back to ready when a prior render is still playable', async () => {
    await newRender({ status: 'ready', claimedMinutesAgo: null });
    await newRender({ status: 'stitching', claimedMinutesAgo: 45 });

    await recoverStuckPodcastRenders();

    expect(await episodeStatus()).toBe('ready');
  });
});
