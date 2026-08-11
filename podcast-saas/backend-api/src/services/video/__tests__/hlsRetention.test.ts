/**
 * Grace-period retention for retired HLS trees (P0.3) against a REAL Postgres engine.
 *
 * Same harness as revisionService.test.ts and for the same reason: what this module
 * guarantees lives in SQL — the UNIQUE(prefix) idempotency, the due/not-due predicate, the
 * LIMIT bound, the deleted_at marking — and a hand-faked db would pass while proving none
 * of it. `db/index.js` is mocked to a drizzle instance bound to PGlite; storage deletion is
 * mocked because the unit under test is the bookkeeping, not the bucket.
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

const storage = vi.hoisted(() => ({ deletePrefix: vi.fn(async (_prefix: string) => {}) }));
vi.mock('../../storage/deleteWithFallback.js', () => ({
  deleteWithPrefixFallback: (prefix: string) => storage.deletePrefix(prefix),
}));

import {
  retireHlsRun,
  sweepRetiredHlsRuns,
  deleteHlsRetirementRowsForVideo,
  hlsRetireGraceHours,
  HLS_RETIRE_GRACE_HOURS_DEFAULT,
  HLS_RETIRE_GRACE_HOURS_MIN,
} from '../hlsRetention.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

const VF1 = '00000000-0000-0000-0000-0000000000a1';
const VF2 = '00000000-0000-0000-0000-0000000000b2';

let pg: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

type RetiredRow = {
  video_file_id: string; prefix: string;
  retired_at: string | Date; retire_after: string | Date; deleted_at: string | Date | null;
};

const ts = (v: string | Date): number => new Date(v).getTime();

/** Insert a retirement row directly, with full control of retire_after. */
async function seed(videoFileId: string, prefix: string, retireAfter: Date, deletedAt: Date | null = null): Promise<void> {
  await pg.query(
    `INSERT INTO hls_retired_runs (video_file_id, prefix, retire_after, deleted_at)
     VALUES ($1, $2, $3, $4)`,
    [videoFileId, prefix, retireAfter.toISOString(), deletedAt ? deletedAt.toISOString() : null],
  );
}

const envBackup = process.env.HLS_RETIRE_GRACE_HOURS;

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
  storage.deletePrefix.mockReset();
  storage.deletePrefix.mockImplementation(async () => {});
  delete process.env.HLS_RETIRE_GRACE_HOURS;
});

afterEach(async () => {
  await pg.close();
  if (envBackup === undefined) delete process.env.HLS_RETIRE_GRACE_HOURS;
  else process.env.HLS_RETIRE_GRACE_HOURS = envBackup;
  vi.clearAllMocks();
});

// ── Grace window resolution ──────────────────────────────────────────────────────────────

describe('hlsRetireGraceHours', () => {
  it('defaults to 24 when unset, empty, or unparseable', () => {
    expect(hlsRetireGraceHours(undefined)).toBe(HLS_RETIRE_GRACE_HOURS_DEFAULT);
    expect(hlsRetireGraceHours('')).toBe(HLS_RETIRE_GRACE_HOURS_DEFAULT);
    expect(hlsRetireGraceHours('  ')).toBe(HLS_RETIRE_GRACE_HOURS_DEFAULT);
    expect(hlsRetireGraceHours('abc')).toBe(HLS_RETIRE_GRACE_HOURS_DEFAULT);
  });

  it('clamps to ≥ 1 hour — misconfiguration must never mean "delete now"', () => {
    expect(hlsRetireGraceHours('0')).toBe(HLS_RETIRE_GRACE_HOURS_MIN);
    expect(hlsRetireGraceHours('-5')).toBe(HLS_RETIRE_GRACE_HOURS_MIN);
    expect(hlsRetireGraceHours('0.25')).toBe(HLS_RETIRE_GRACE_HOURS_MIN);
  });

  it('accepts explicit values above the floor', () => {
    expect(hlsRetireGraceHours('48')).toBe(48);
    expect(hlsRetireGraceHours('1')).toBe(1);
    expect(hlsRetireGraceHours('2.5')).toBe(2.5);
  });
});

// ── Retirement (the INSERT that replaced the immediate delete) ───────────────────────────

describe('retireHlsRun', () => {
  it('records the tree with retire_after = now + default grace, pending (deleted_at NULL)', async () => {
    const now = new Date('2026-08-11T00:00:00Z');
    await retireHlsRun(VF1, `hls/${VF1}/oldrun`, now);

    const all = await rows<RetiredRow>('SELECT * FROM hls_retired_runs');
    expect(all).toHaveLength(1);
    expect(all[0]!.video_file_id).toBe(VF1);
    expect(all[0]!.prefix).toBe(`hls/${VF1}/oldrun`);
    expect(all[0]!.deleted_at).toBeNull();
    expect(ts(all[0]!.retire_after)).toBe(now.getTime() + 24 * 3_600_000);
    // Retiring NEVER touches storage — that is the whole point.
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('honours HLS_RETIRE_GRACE_HOURS, clamped to the 1h floor', async () => {
    const now = new Date('2026-08-11T00:00:00Z');
    process.env.HLS_RETIRE_GRACE_HOURS = '48';
    await retireHlsRun(VF1, `hls/${VF1}/r48`, now);
    process.env.HLS_RETIRE_GRACE_HOURS = '0'; // would be "delete now" — clamps to 1h
    await retireHlsRun(VF1, `hls/${VF1}/r0`, now);

    const all = await rows<RetiredRow>('SELECT prefix, retire_after FROM hls_retired_runs ORDER BY prefix');
    expect(ts(all.find((r) => r.prefix.endsWith('/r48'))!.retire_after)).toBe(now.getTime() + 48 * 3_600_000);
    expect(ts(all.find((r) => r.prefix.endsWith('/r0'))!.retire_after)).toBe(now.getTime() + 1 * 3_600_000);
  });

  it('is idempotent on prefix (crash-and-retry of the same run queues the tree once)', async () => {
    const now = new Date('2026-08-11T00:00:00Z');
    await retireHlsRun(VF1, `hls/${VF1}/samerun`, now);
    await expect(retireHlsRun(VF1, `hls/${VF1}/samerun`, new Date(now.getTime() + 5_000))).resolves.toBeUndefined();
    expect(await rows('SELECT 1 FROM hls_retired_runs')).toHaveLength(1);
  });
});

// ── The sweep ────────────────────────────────────────────────────────────────────────────

describe('sweepRetiredHlsRuns', () => {
  const NOW = new Date('2026-08-11T12:00:00Z');
  const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
  const hoursAhead = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

  it('deletes due trees, marks them, and leaves not-yet-due and already-swept rows alone', async () => {
    await seed(VF1, `hls/${VF1}/due-old`, hoursAgo(2));
    await seed(VF1, `hls/${VF1}/due-new`, hoursAgo(1));
    await seed(VF1, `hls/${VF1}/not-due`, hoursAhead(1));
    await seed(VF2, `hls/${VF2}/already-swept`, hoursAgo(5), hoursAgo(4));

    const swept = await sweepRetiredHlsRuns(20, NOW);
    expect(swept).toBe(2);
    expect(storage.deletePrefix.mock.calls.map((c) => c[0]).sort()).toEqual([
      `hls/${VF1}/due-new`, `hls/${VF1}/due-old`,
    ]);

    const pending = await rows<RetiredRow>('SELECT prefix FROM hls_retired_runs WHERE deleted_at IS NULL');
    expect(pending.map((r) => r.prefix)).toEqual([`hls/${VF1}/not-due`]);

    // A second sweep finds nothing: swept rows stay swept, the future row is still not due.
    storage.deletePrefix.mockClear();
    expect(await sweepRetiredHlsRuns(20, NOW)).toBe(0);
    expect(storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('is bounded: processes at most `limit` rows per pass, oldest due first', async () => {
    for (let i = 1; i <= 5; i++) await seed(VF1, `hls/${VF1}/run${i}`, hoursAgo(i));

    expect(await sweepRetiredHlsRuns(2, NOW)).toBe(2);
    // Oldest retire_after first: run5 (5h ago) then run4.
    expect(storage.deletePrefix.mock.calls.map((c) => c[0])).toEqual([
      `hls/${VF1}/run5`, `hls/${VF1}/run4`,
    ]);
    expect(await rows('SELECT 1 FROM hls_retired_runs WHERE deleted_at IS NULL')).toHaveLength(3);
  });

  it('a row whose storage delete throws is retried later; the rest of the pass proceeds', async () => {
    await seed(VF1, `hls/${VF1}/poison`, hoursAgo(3));
    await seed(VF1, `hls/${VF1}/fine`, hoursAgo(2));
    storage.deletePrefix.mockImplementation(async (prefix: string) => {
      if (prefix.endsWith('/poison')) throw new Error('bucket exploded');
    });

    expect(await sweepRetiredHlsRuns(20, NOW)).toBe(1);
    const pending = await rows<RetiredRow>('SELECT prefix FROM hls_retired_runs WHERE deleted_at IS NULL');
    expect(pending.map((r) => r.prefix)).toEqual([`hls/${VF1}/poison`]); // still pending → retried

    storage.deletePrefix.mockImplementation(async () => {}); // bucket recovered
    expect(await sweepRetiredHlsRuns(20, NOW)).toBe(1);
    expect(await rows('SELECT 1 FROM hls_retired_runs WHERE deleted_at IS NULL')).toHaveLength(0);
  });

  it('tolerates an already-missing prefix (the storage helper resolves; the row is marked)', async () => {
    // deleteWithPrefixFallback's contract is log-and-continue — the mock's default resolve
    // models exactly the "prefix already gone" case.
    await seed(VF1, `hls/${VF1}/vanished`, hoursAgo(1));
    expect(await sweepRetiredHlsRuns(20, NOW)).toBe(1);
    expect(await rows('SELECT 1 FROM hls_retired_runs WHERE deleted_at IS NULL')).toHaveLength(0);
  });
});

// ── Entity-deletion interplay (the two purge call sites) ────────────────────────────────

describe('deleteHlsRetirementRowsForVideo', () => {
  it('drops only the purged video\'s rows — the sweep can never resurrect or double-delete them', async () => {
    await seed(VF1, `hls/${VF1}/r1`, new Date('2026-08-10T00:00:00Z'));
    await seed(VF1, `hls/${VF1}/r2`, new Date('2026-08-12T00:00:00Z'));
    await seed(VF2, `hls/${VF2}/r1`, new Date('2026-08-10T00:00:00Z'));

    await deleteHlsRetirementRowsForVideo(VF1);

    const left = await rows<RetiredRow>('SELECT video_file_id FROM hls_retired_runs');
    expect(left).toHaveLength(1);
    expect(left[0]!.video_file_id).toBe(VF2);

    // The purged video's overdue row is GONE, so a sweep touches only the other video's data.
    await sweepRetiredHlsRuns(20, new Date('2026-08-11T00:00:00Z'));
    expect(storage.deletePrefix.mock.calls.map((c) => c[0])).toEqual([`hls/${VF2}/r1`]);
  });

  it('never fails the entity delete: a missing table is swallowed (42P01 → debug)', async () => {
    await pg.exec('DROP TABLE hls_retired_runs');
    await expect(deleteHlsRetirementRowsForVideo(VF1)).resolves.toBeUndefined();
  });

  it('is a no-op for a video with no retirement rows', async () => {
    await expect(deleteHlsRetirementRowsForVideo(VF1)).resolves.toBeUndefined();
  });
});
