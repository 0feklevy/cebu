/**
 * Every migration the live-DB suites walk over must have a rollback file.
 *
 * ── THE COUPLING THIS PROTECTS, WHICH IS NOT OBVIOUS FROM EITHER SIDE ─────────────────────────
 * `migration0NN.test.ts` measures one migration's rollback on ITS OWN schema. To get there it
 * applies every LATER migration and then undoes them, newest first — reading
 * `<name>.rollback.sql` for each. So adding a forward migration with no rollback does not merely
 * skip a nicety: it breaks the rollback test of every earlier migration, all at once, with an
 * ENOENT that names a file the author never thought about.
 *
 * ── WHY THIS TEST EXISTS SEPARATELY, AND WITHOUT A DATABASE ───────────────────────────────────
 * Those suites need a live Postgres and are skipped where there is none — which is exactly the
 * environment a pull request runs in. The omission therefore passes CI green and fails in the
 * RELEASE GATE, after the merge, in the middle of a shipment. That happened on 2026-08-25: three
 * red tests, one missing file, discovered only because a combined-merge run was done by hand.
 *
 * This check needs no database. It is filesystem arithmetic, it runs everywhere, and it fails on
 * the pull request that introduced the gap.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

const forwardMigrations = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f) && !f.endsWith('.rollback.sql'))
    .sort();

/**
 * The first migration whose rollback the live suites depend on.
 *
 * Deliberately a NUMBER and not "all of them": migrations below this line predate the convention
 * and no test reads their rollbacks. Backfilling forty of them would be busywork that proves
 * nothing, while pretending the floor is zero would make this test permanently red and therefore
 * ignored — which is the failure mode a gate must never have.
 */
const ROLLBACK_REQUIRED_FROM = 69;

const numberOf = (file: string): number => Number(file.slice(0, file.indexOf('_')));

describe('rollback coverage', () => {
  it('every migration from 069 onward has a .rollback.sql', () => {
    // The assertion that would have caught the 079 gap on its own pull request instead of in the
    // release gate. The message names the file to create, because the ENOENT the live suites
    // raise names a file in a DIFFERENT migration's test and reads like that test's bug.
    const missing = forwardMigrations()
      .filter((f) => numberOf(f) >= ROLLBACK_REQUIRED_FROM)
      .filter((f) => !existsSync(join(MIGRATIONS_DIR, f.replace(/\.sql$/, '.rollback.sql'))));

    expect(
      missing,
      `these need a .rollback.sql — without one, the rollback test of EVERY earlier migration fails with ENOENT: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the floor is real — there ARE migrations above it, so the check cannot pass vacuously', () => {
    // A guard that checks an empty set is decoration. If a refactor ever moved migrations
    // elsewhere, this fails rather than reporting a cheerful green over nothing.
    const covered = forwardMigrations().filter((f) => numberOf(f) >= ROLLBACK_REQUIRED_FROM);
    expect(covered.length).toBeGreaterThan(5);
  });

  it('no rollback file is orphaned — every one belongs to a forward migration', () => {
    // The mirror image, and a cheap way to catch a rename that took the forward file with it and
    // left the undo behind, pointing at a schema change nothing performs any more.
    const forwards = new Set(forwardMigrations());
    const orphans = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.rollback.sql'))
      .filter((f) => !forwards.has(f.replace(/\.rollback\.sql$/, '.sql')));
    expect(orphans, `rollback files with no forward migration: ${orphans.join(', ')}`).toEqual([]);
  });
});
