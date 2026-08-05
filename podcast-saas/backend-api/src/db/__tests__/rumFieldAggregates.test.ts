/**
 * `fieldAggregates` — the real query, EXECUTED against a real Postgres engine.
 *
 * WHY THIS FILE EXISTS
 * The original query interpolated a JavaScript array straight into `= ANY(${wanted})`. Drizzle
 * expands a bare array chunk into a parenthesised parameter LIST, so Postgres received
 * `= ANY(($1, $2))` and answered `op ANY/ALL (array) requires array on right side` — and with a
 * single element, `malformed array literal`. It could never return a row.
 *
 * Nothing caught it. `tsc` is happy (the fragment is well-typed), the unit test for the caller
 * mocked `fieldAggregates` wholesale, and the function's own `catch` returned an empty map — which
 * is exactly what "no samples collected yet" looks like. So the closed loop silently fell back to
 * the lab budget for every project, forever, with no error anywhere.
 *
 * The lesson is about the TEST, not the query: a SQL string is only checked by an engine. This
 * suite therefore executes the real statement rather than asserting on its rendered text, which is
 * why it also pins the two shapes that broke — one revision and several.
 *
 * Isolation contract, as in the migration suites: this file never imports `db/index.js`, so it
 * cannot reach the database that preview and production share.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { inArray, sql } from 'drizzle-orm';

import * as schema from '../schema.js';
import { sim_rum_events } from '../schema.js';

let pg: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeEach(async () => {
  pg = new PGlite();
  db = drizzle(pg, { schema });
  await pg.exec(`
    CREATE TABLE sim_rum_events (
      id             BIGSERIAL PRIMARY KEY,
      kind           TEXT        NOT NULL,
      package_revision TEXT      NOT NULL,
      total_ms       INTEGER,
      dropped        INTEGER     NOT NULL DEFAULT 0,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
});
afterEach(async () => { await pg.close(); });

/** The statement exactly as `RumService.fieldAggregates` builds it. */
const aggregate = (wanted: string[], cutoff: Date) => db.execute(sql`
  SELECT package_revision,
         count(*)::int                                         AS samples,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms)  AS p50,
         percentile_disc(0.9) WITHIN GROUP (ORDER BY total_ms)  AS p90,
         COALESCE(sum(dropped), 0)::bigint                      AS dropped
    FROM ${sim_rum_events}
   WHERE kind = 'transition'
     AND total_ms IS NOT NULL
     AND created_at >= ${cutoff}
     AND ${inArray(sim_rum_events.package_revision, wanted)}
   GROUP BY package_revision
`);

const rowsOf = (res: unknown): Record<string, unknown>[] => {
  const r = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
  return (Array.isArray(r) ? r : []) as Record<string, unknown>[];
};

const seed = async (rev: string, totals: number[]) => {
  for (const ms of totals) {
    await pg.query(
      `INSERT INTO sim_rum_events (kind, package_revision, total_ms) VALUES ('transition', $1, $2)`,
      [rev, ms],
    );
  }
};

describe('fieldAggregates — executed, not rendered', () => {
  it('returns a row for a SINGLE revision (the shape that raised "malformed array literal")', async () => {
    await seed('rev-a', [100, 200, 300]);
    const rows = rowsOf(await aggregate(['rev-a'], new Date(Date.now() - 86_400_000)));
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].samples)).toBe(3);
  });

  it('returns one row per revision for SEVERAL (the shape that raised "requires array on right side")', async () => {
    await seed('rev-a', [100, 200]);
    await seed('rev-b', [50]);
    await seed('rev-c', [999]);   // not asked for
    const rows = rowsOf(await aggregate(['rev-a', 'rev-b'], new Date(Date.now() - 86_400_000)));
    expect(rows.map((r) => String(r.package_revision)).sort()).toEqual(['rev-a', 'rev-b']);
  });

  it('computes nearest-rank percentiles, so every value reported actually occurred', async () => {
    // percentile_disc, not percentile_cont: an interpolated p90 is a number no session ever saw,
    // and the budget derived from it would describe a transition that never happened.
    await seed('rev-a', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const rows = rowsOf(await aggregate(['rev-a'], new Date(Date.now() - 86_400_000)));
    expect([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]).toContain(Number(rows[0].p90));
    expect([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]).toContain(Number(rows[0].p50));
  });

  it('excludes samples older than the cutoff', async () => {
    await seed('rev-a', [100]);
    await pg.query(
      `INSERT INTO sim_rum_events (kind, package_revision, total_ms, created_at)
       VALUES ('transition', 'rev-a', 9999, now() - interval '40 days')`,
    );
    const rows = rowsOf(await aggregate(['rev-a'], new Date(Date.now() - 30 * 86_400_000)));
    expect(Number(rows[0].samples)).toBe(1);
    expect(Number(rows[0].p90)).toBe(100);
  });

  it('ignores rows with no measurement rather than counting them as zero', async () => {
    // A null duration means "never observed". Counting it as 0 would drag the percentile toward a
    // transition speed no device achieved — the exact confusion `total_ms IS NOT NULL` prevents.
    await seed('rev-a', [100, 200]);
    await pg.query(
      `INSERT INTO sim_rum_events (kind, package_revision, total_ms) VALUES ('transition', 'rev-a', NULL)`,
    );
    const rows = rowsOf(await aggregate(['rev-a'], new Date(Date.now() - 86_400_000)));
    expect(Number(rows[0].samples)).toBe(2);
  });

  it('sums the client-reported drop count, so a truncated sample is detectable', async () => {
    await pg.query(
      `INSERT INTO sim_rum_events (kind, package_revision, total_ms, dropped)
       VALUES ('transition', 'rev-a', 100, 3), ('transition', 'rev-a', 120, 4)`,
    );
    const rows = rowsOf(await aggregate(['rev-a'], new Date(Date.now() - 86_400_000)));
    expect(Number(rows[0].dropped)).toBe(7);
  });

  it('counts only transition events', async () => {
    await seed('rev-a', [100]);
    await pg.query(
      `INSERT INTO sim_rum_events (kind, package_revision, total_ms) VALUES ('error', 'rev-a', 500)`,
    );
    const rows = rowsOf(await aggregate(['rev-a'], new Date(Date.now() - 86_400_000)));
    expect(Number(rows[0].samples)).toBe(1);
  });
});
