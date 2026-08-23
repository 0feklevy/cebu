/**
 * Migration 077 — vendor config becomes admin-manageable — applied to a REAL Postgres.
 *
 * Written while v0.1.44 was in flight: 077 runs against production within minutes, and "the
 * registries list it" is not the same claim as "it applies". Two things are proven here that a
 * registry check cannot see: the enum gains 'groq' WITHOUT disturbing the values already in it
 * (an enum rebuild would invalidate every api_keys row), and the three admin_settings columns
 * arrive nullable so the pre-077 app image keeps inserting while the new one reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const TARGET = '077_admin_vendor_config.sql';
const ROLLBACK = '077_admin_vendor_config.rollback.sql';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const forwardSql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf-8');
const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK), 'utf-8');

let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
});
afterEach(async () => { await pg.close(); });

const enumValues = async (): Promise<string[]> => {
  const r = await pg.query<{ enumlabel: string }>(
    `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'provider' ORDER BY e.enumsortorder`);
  return r.rows.map((x) => x.enumlabel);
};

describe('077 applies to a real Postgres', () => {
  it('adds groq to the provider enum WITHOUT disturbing the existing values', async () => {
    const before = await enumValues();
    expect(before).not.toContain('groq');
    await pg.exec(forwardSql);
    const after = await enumValues();
    // Every prior value survives IN ORDER — an enum rebuild (the alternative implementation)
    // would invalidate every api_keys row that references it.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toContain('groq');
  });

  it('an api_keys row can actually BE a groq key after the migration', async () => {
    await pg.exec(forwardSql);
    await pg.exec(`INSERT INTO api_keys (provider, encrypted_key) VALUES ('groq', 'enc')`);
    const r = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM api_keys WHERE provider = 'groq'`);
    expect(r.rows[0].n).toBe(1);
  });

  it('the three admin_settings columns arrive NULLABLE — the previous image keeps inserting', async () => {
    await pg.exec(forwardSql);
    const r = await pg.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'admin_settings' AND column_name LIKE 'avatar_default_%'
        ORDER BY column_name`);
    expect(r.rows.map((x) => x.column_name)).toEqual(
      ['avatar_default_avatar_id', 'avatar_default_llm_id', 'avatar_default_voice_id']);
    expect(r.rows.every((x) => x.is_nullable === 'YES'), 'a NOT NULL column here would break the old image').toBe(true);
  });

  it('is idempotent — a re-run is a no-op, not an error', async () => {
    await pg.exec(forwardSql);
    await pg.exec(forwardSql);   // IF NOT EXISTS on both halves
    expect(await enumValues()).toContain('groq');
  });

  it('the rollback drops the columns and leaves the enum alone (documented, deliberate)', async () => {
    await pg.exec(forwardSql);
    await pg.exec(rollbackSql);
    const r = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'admin_settings' AND column_name LIKE 'avatar_default_%'`);
    expect(r.rows[0].n).toBe(0);
    expect(await enumValues(), 'Postgres cannot remove an enum value in place').toContain('groq');
  });
});
