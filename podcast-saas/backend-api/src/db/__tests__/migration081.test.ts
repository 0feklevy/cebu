/**
 * 081 — two NON-PUBLIC statuses between byte-verification and activation.
 *
 * WHAT THIS FILE IS DEFENDING. `/sim-public/*` is unauthenticated and a revision prefix lives
 * inside `simulations/`, so "which statuses may be served" is an access-control decision expressed
 * as a CHECK constraint plus one allow-list function. 081 widens the constraint; the allow-list
 * (shipped separately, and EARLIER, in v0.2.7) is what keeps the new values withheld.
 *
 * THE ORDERING IS THE SAFETY PROPERTY, and it is worth restating because a migration file cannot
 * enforce it: the previous form of `isRevisionStatusPublic` was a DENY-list returning true for any
 * status it did not recognise. Introducing `proof_pending` against such an image would have made
 * an unproven candidate world-readable for the length of the deploy window — serving exactly the
 * bytes the status exists to withhold. Hence: allow-list release first, this migration later.
 *
 * Isolation follows migration050.test.ts: never import `../index.js`, which builds a postgres.js
 * pool against `DATABASE_URL` at import time — a URL that preview and production SHARE. Only
 * `schema.ts` (pure table definitions) is imported, bound to a private in-process engine.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const TARGET = '081_sim_revision_proof_states.sql';
const ROLLBACK = '081_sim_revision_proof_states.rollback.sql';

function forwardMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_[^.]+\.sql$/.test(f))
    .sort();
}

const ALL = forwardMigrations();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const forwardSql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf-8');
const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK), 'utf-8');

/** Postgres' code for a CHECK violation. Asserted by CODE, not by message text. */
const CHECK_VIOLATION = '23514';

let pg: PGlite;
let projectId: string;
let simId: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

async function applyPrior(): Promise<void> {
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
}
const applyForward = (): Promise<unknown> => pg.exec(forwardSql);
const applyRollback = (): Promise<unknown> => pg.exec(rollbackSql);

/** Insert a revision in `status`, returning the error code if the CHECK refused it. */
async function insertRevision(status: string, id?: string): Promise<string | null> {
  try {
    await pg.query(
      `INSERT INTO sim_revisions (id, simulation_id, revision_number, status)
       VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, nextval('t_revno'), $3)`,
      [id ?? null, simId, status],
    );
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

beforeEach(async () => {
  pg = new PGlite();
  await applyPrior();
  await pg.exec('CREATE SEQUENCE IF NOT EXISTS t_revno');
  // Minimal owning rows, shaped exactly as migration050.test.ts seeds them — the FK chain is real,
  // because a status test that inserted an orphan revision would be exercising a table that cannot
  // exist in production.
  const [org] = await rows<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Org081') RETURNING id`);
  const [p] = await rows<{ id: string }>(
    `INSERT INTO projects (org_id, title) VALUES ($1, 'Project081') RETURNING id`,
    [org.id],
  );
  projectId = p.id;
  const [s] = await rows<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file)
     VALUES ($1, 'sim081', $2, 'index.html') RETURNING id`,
    [projectId, `simulations/${projectId}/x`],
  );
  simId = s.id;
});

afterEach(async () => { await pg.close(); });

describe('081 forward — the CHECK admits the proof states and nothing else', () => {
  it('refuses both new statuses BEFORE the migration', async () => {
    // Establishes that the migration is what changes the answer. Without this the acceptance
    // assertions below would pass just as well against a constraint that never existed.
    expect(await insertRevision('proof_pending')).toBe(CHECK_VIOLATION);
    expect(await insertRevision('proof_passed')).toBe(CHECK_VIOLATION);
  });

  it('accepts both new statuses after it', async () => {
    await applyForward();
    expect(await insertRevision('proof_pending')).toBeNull();
    expect(await insertRevision('proof_passed')).toBeNull();
  });

  it('still refuses a status nobody defined', async () => {
    // The widening must be exactly two values. A CHECK accidentally dropped rather than replaced
    // would accept everything, and every acceptance test above would still pass.
    await applyForward();
    expect(await insertRevision('published')).toBe(CHECK_VIOLATION);
    expect(await insertRevision('')).toBe(CHECK_VIOLATION);
  });

  it('keeps accepting every pre-existing status', async () => {
    await applyForward();
    for (const s of ['draft', 'uploading', 'validating', 'canary_passed', 'failed']) {
      expect(await insertRevision(s), `${s} was refused`).toBeNull();
    }
  });

  it('is idempotent — a second application changes nothing and refuses nothing', async () => {
    await applyForward();
    await applyForward();
    expect(await insertRevision('proof_pending')).toBeNull();
    expect(await insertRevision('published')).toBe(CHECK_VIOLATION);
  });

  it('leaves activated_at NULL-able for a proof state, and still required for active', async () => {
    // 050's sim_revisions_activated_at_chk constrains only (active, retired, rolled_back). Neither
    // new status is in that set, so a proof-state row correctly has a NULL activated_at — and the
    // constraint must still bite where it always did.
    await applyForward();
    expect(await insertRevision('proof_pending')).toBeNull();
    expect(await insertRevision('active')).toBe(CHECK_VIOLATION);   // NULL activated_at
  });

  it('the constraint carries its documented name', async () => {
    await applyForward();
    const found = await rows<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'sim_revisions'::regclass AND conname = 'sim_revisions_status_check'`,
    );
    expect(found).toHaveLength(1);
  });
});

describe('081 rollback — narrows, and FAILS LOUDLY rather than destroying evidence', () => {
  it('succeeds when no row holds a proof status', async () => {
    await applyForward();
    await insertRevision('draft');
    await applyRollback();
    expect(await insertRevision('proof_pending')).toBe(CHECK_VIOLATION);
    expect(await insertRevision('draft')).toBeNull();
  });

  it('REFUSES to run while a proof-state row exists', async () => {
    // The important assertion in this file. Silently rewriting those rows to 'failed' would
    // destroy the record of why bytes were staged and leave a candidate's bytes in storage with
    // nothing explaining them. The rollback is meant to stop and make a person drain them.
    await applyForward();
    expect(await insertRevision('proof_passed')).toBeNull();
    await expect(applyRollback()).rejects.toThrow();
  });

  it('and the offending row is still there afterwards, undamaged', async () => {
    await applyForward();
    await insertRevision('proof_pending');
    await applyRollback().catch(() => undefined);
    const left = await rows<{ status: string }>(
      `SELECT status FROM sim_revisions WHERE status = 'proof_pending'`,
    );
    expect(left).toHaveLength(1);
  });
});

describe('081 is registered with BOTH runners', () => {
  // `check-db.ts` holds a SECOND hardcoded copy of the ordered migration list, shadowing the name
  // `MIGRATION_FILES` with a local literal instead of importing `db/migrate.ts`. The two agree
  // today, and nothing structural keeps them agreeing — the existing guard is per-migration, so a
  // migration whose author does not write one drifts silently. See the list-parity test in
  // migrationRunner for the general guard; this pair is the specific one for 081.
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  it('appears in db/migrate.ts', () => {
    expect(readFileSync(join(SRC, 'db', 'migrate.ts'), 'utf-8')).toContain(TARGET);
  });

  it('appears in scripts/check-db.ts', () => {
    expect(readFileSync(join(SRC, 'scripts', 'check-db.ts'), 'utf-8')).toContain(TARGET);
  });

  it('ships a rollback file', () => {
    expect(readdirSync(MIGRATIONS_DIR)).toContain(ROLLBACK);
  });
});
