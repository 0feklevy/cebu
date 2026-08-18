/**
 * HLS stuck-transcode recovery against a REAL Postgres engine (job-queue-003).
 *
 * THE BUG THIS SUITE EXISTS FOR
 * The only thing that ever cleared `hls_status='processing'` ran ONCE, at boot, and only for rows
 * whose `hls_started_at` was already thirty minutes old. Those two rules never intersect where the
 * failure actually happens: a transcode orphaned five minutes before a deploy is far too YOUNG for
 * the boot pass, and the boot pass is the last thing that will ever look at it. The row is stuck at
 * `processing` for the life of the database.
 *
 * The three properties, and why the third is not optional:
 *   • a transcode that has gone quiet is reaped on a LATER pass, not only at boot;
 *   • the reaper runs repeatedly, so "not stale yet at boot" is not a death sentence;
 *   • a transcode that is genuinely still running is NOT reaped — it beats a heartbeat.
 * Without the heartbeat, making a 30-minute wall-clock rule repeat would kill honest long
 * transcodes on the next tick, which is a worse bug than the one being fixed.
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
      const target = h.dbRef.current;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  HLS_HEARTBEAT_MS,
  HLS_STALE_AFTER_MS,
  HLS_SWEEP_INTERVAL_MS,
  beatHlsHeartbeat,
  hlsStaleBefore,
  startHlsRecoverySweep,
  sweepStuckTranscodes,
} from '../hlsRecovery.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

let pg: PGlite;
let projectId: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}

interface VideoRow { hls_status: string; hls_error: string | null; hls_started_at: string | Date | null }
const videoRow = (id: string): Promise<VideoRow> =>
  one<VideoRow>(`SELECT hls_status, hls_error, hls_started_at FROM video_files WHERE id=$1`, [id]);

/** A video whose transcode last showed a sign of life `quietMs` ago. */
async function transcoding(quietMs: number, status = 'processing'): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, storage_key, status, hls_status, hls_started_at)
     VALUES ($1,'v.mp4','videos/v.mp4','ready',$2,$3) RETURNING id`,
    [projectId, status, new Date(Date.now() - quietMs).toISOString()],
  );
  return r.id;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Org') RETURNING id`);
  const p = await one<{ id: string }>(
    `INSERT INTO projects (org_id, title) VALUES ($1,'P') RETURNING id`, [org.id]);
  projectId = p.id;
});

afterEach(async () => {
  vi.useRealTimers();
  await pg.close();
});

describe('sweepStuckTranscodes', () => {
  it('recovers a transcode orphaned minutes — not half an hour — before the restart', async () => {
    // THE REPORTED CASE. A deploy five minutes into a transcode. The boot pass demanded thirty
    // minutes of staleness, so this row was invisible to it, and nothing looked again.
    const orphaned = await transcoding(6 * 60_000);

    const reaped = await sweepStuckTranscodes();

    expect(reaped).toBe(1);
    const row = await videoRow(orphaned);
    expect(row.hls_status, 'a transcode nothing is running must not stay at processing').toBe('failed');
    expect(row.hls_error).toMatch(/interrupted/i);
  });

  it('leaves a transcode that showed a sign of life a moment ago alone', async () => {
    const live = await transcoding(5_000);

    expect(await sweepStuckTranscodes()).toBe(0);
    expect((await videoRow(live)).hls_status).toBe('processing');
  });

  it('never touches a row that is not processing', async () => {
    const ready = await transcoding(60 * 60_000, 'ready');
    const pending = await transcoding(60 * 60_000, 'pending');

    await sweepStuckTranscodes();

    expect((await videoRow(ready)).hls_status).toBe('ready');
    expect((await videoRow(pending)).hls_status).toBe('pending');
  });

  it('is idempotent across two instances sweeping at once — the second reaps nothing', async () => {
    // The pooler forbids advisory locks, so the CAS in the UPDATE is the whole guard.
    await transcoding(60 * 60_000);

    const [a, b] = await Promise.all([sweepStuckTranscodes(), sweepStuckTranscodes()]);

    expect(a + b, 'exactly one sweep may claim the row').toBe(1);
  });

  it('honours its per-pass bound', async () => {
    await transcoding(60 * 60_000);
    await transcoding(60 * 60_000);
    await transcoding(60 * 60_000);

    expect(await sweepStuckTranscodes(2)).toBe(2);
    expect(await sweepStuckTranscodes(2)).toBe(1);
  });
});

describe('the stale window', () => {
  it('is a heartbeat multiple, not a wall-clock guess at how long encoding takes', () => {
    expect(HLS_STALE_AFTER_MS).toBeLessThan(30 * 60_000);
    expect(HLS_STALE_AFTER_MS / HLS_HEARTBEAT_MS).toBeGreaterThanOrEqual(4);
    expect(hlsStaleBefore(new Date(1_000_000)).getTime()).toBe(1_000_000 - HLS_STALE_AFTER_MS);
  });
});

describe('beatHlsHeartbeat', () => {
  it('keeps a genuinely long transcode out of the reaper`s reach', async () => {
    // Without this the repeating sweep would be a REGRESSION: an honest transcode longer than the
    // window gets failed out from under itself on the next tick.
    const live = await transcoding(0);
    const stop = beatHlsHeartbeat(live, 1_000);
    try {
      // Age the row past the window, as a long encode would.
      await pg.query(
        `UPDATE video_files SET hls_started_at = now() - interval '1 hour' WHERE id=$1`, [live]);
      // Let one beat land.
      await new Promise((r) => setTimeout(r, 1_200));

      expect(await sweepStuckTranscodes(), 'a beating transcode must never be reaped').toBe(0);
      expect((await videoRow(live)).hls_status).toBe('processing');
    } finally {
      stop();
    }
  });

  it('cannot drag a finished row forward', async () => {
    const done = await transcoding(60 * 60_000, 'ready');
    const before = (await videoRow(done)).hls_started_at;
    const stop = beatHlsHeartbeat(done, 1_000);
    try {
      await new Promise((r) => setTimeout(r, 1_200));
      expect(new Date((await videoRow(done)).hls_started_at!).getTime())
        .toBe(new Date(before!).getTime());
    } finally {
      stop();
    }
  });

  it('stops beating once stopped', async () => {
    const live = await transcoding(0);
    const stop = beatHlsHeartbeat(live, 1_000);
    stop();
    await pg.query(`UPDATE video_files SET hls_started_at = now() - interval '1 hour' WHERE id=$1`, [live]);
    await new Promise((r) => setTimeout(r, 1_200));

    expect(await sweepStuckTranscodes()).toBe(1);
  });
});

describe('startHlsRecoverySweep', () => {
  it('does not reap a live row on its boot kick', async () => {
    const live = await transcoding(5_000);
    const stop = startHlsRecoverySweep(200);
    try {
      await sleep(150);
      expect((await videoRow(live)).hls_status).toBe('processing');
    } finally {
      stop();
    }
  });

  it('LOOKS AGAIN — a row stranded after the boot pass is still recovered', async () => {
    // THE OTHER HALF OF THE BUG. With recovery only at boot, "not stale yet when we looked" is a
    // life sentence: a transcode orphaned five minutes before the restart is younger than the
    // window at boot and nothing ever looks a second time. This row is created AFTER the boot
    // kick has already run, so only a repeating sweep can ever see it.
    const stop = startHlsRecoverySweep(200);
    try {
      await sleep(150); // the boot kick happens here, with nothing to do
      const stranded = await transcoding(60 * 60_000);

      await waitFor(async () => (await videoRow(stranded)).hls_status === 'failed', 3_000);

      expect((await videoRow(stranded)).hls_status).toBe('failed');
    } finally {
      stop();
    }
  });

  it('stops when told to', async () => {
    const stop = startHlsRecoverySweep(200);
    await sleep(150);
    stop();
    const stranded = await transcoding(60 * 60_000);
    await sleep(600);

    expect((await videoRow(stranded)).hls_status).toBe('processing');
  });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** Poll until the predicate holds or the budget runs out. Returns either way; the caller asserts. */
async function waitFor(pred: () => Promise<boolean>, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(50);
  }
}
