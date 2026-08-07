/**
 * The canary verdict must die with the bytes it describes.
 *
 * `uploadSectionBridge` writes the new `bridge_hash` on every regeneration. Until this was added it
 * left `package_class` alone, so a package canaried at revision H1 kept its `managed-presentable`
 * verdict after its bridge became H2 — granting the modern path to bytes no canary ever ran, with
 * every poster lookup missing because poster identities carry H1. That is the exact state
 * `sim-canary-publish` refuses to publish (EXIT.POSTERS_MISSING), reached through the back door.
 *
 * These tests drive the WHERE clause directly against a real Postgres (PGlite) rather than mocking
 * drizzle, because the whole question is whether the predicate matches the rows it should.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pg: PGlite;

const seed = async (bridgeHash: string | null): Promise<void> => {
  await pg.exec(`
    CREATE TABLE simulations (
      id TEXT PRIMARY KEY,
      bridge_hash TEXT,
      package_class TEXT,
      canary_report JSONB,
      canary_at TIMESTAMPTZ,
      active_revision_id UUID
    );
  `);
  await pg.query(
    `INSERT INTO simulations (id, bridge_hash, package_class, canary_report, canary_at)
     VALUES ('sim-1', $1, 'managed-presentable', '{"classification":"managed-presentable"}'::jsonb, now())`,
    [bridgeHash],
  );
};

/** The exact predicate SimulationService applies alongside the bridge_hash write. */
const applyBridgeWrite = (hash: string) =>
  pg.query(
    `UPDATE simulations
        SET bridge_hash = $1, package_class = NULL, canary_report = NULL, canary_at = NULL
      WHERE id = 'sim-1' AND (bridge_hash IS NULL OR bridge_hash <> $1)
        AND active_revision_id IS NULL`,
    [hash],
  );

const row = async () => {
  const r = await pg.query<{ bridge_hash: string | null; package_class: string | null }>(
    `SELECT bridge_hash, package_class FROM simulations WHERE id = 'sim-1'`,
  );
  return r.rows[0];
};

beforeEach(async () => { pg = new PGlite(); });
afterEach(async () => { await pg.close(); });

describe('the bridge_hash write clears the canary verdict', () => {
  it('clears the verdict when the bridge genuinely changed', async () => {
    await seed('H1');
    await applyBridgeWrite('H2');
    const after = await row();
    expect(after.bridge_hash).toBe('H2');
    expect(after.package_class, 'a verdict survived the bytes it described').toBeNull();
  });

  it('clears the verdict on the FIRST generation, when the previous hash was NULL', async () => {
    // NULL -> H1 is a byte change like any other. The isNull arm of the predicate exists for this.
    await seed(null);
    await applyBridgeWrite('H1');
    const after = await row();
    expect(after.bridge_hash).toBe('H1');
    expect(after.package_class).toBeNull();
  });

  it('KEEPS the verdict when the regeneration produced identical bytes', async () => {
    // An idempotent regeneration is not a new package. Clearing here would force a needless
    // re-canary on every no-op save, which is how a gate becomes something people route around.
    await seed('H1');
    await applyBridgeWrite('H1');
    const after = await row();
    expect(after.bridge_hash).toBe('H1');
    expect(after.package_class, 'an unchanged package lost its verdict').toBe('managed-presentable');
  });
});

// ── The projected verdict (migration 050) ────────────────────────────────────────────────────────

describe('a revisioned simulation keeps its projected verdict', () => {
  it('does NOT clear the verdict when an active revision owns it', async () => {
    // On a revisioned simulation these columns are a PROJECTION of the active revision's verdict,
    // written inside the activation transaction. This statement fires against the LEGACY mutable
    // prefix, which still exists and is still reachable — so without the active_revision_id
    // predicate, regenerating one section's bridge nulls package_class on the row while the
    // revision still holds a valid verdict for the bytes actually being served. The row and the
    // revision disagree, the row is what the player reads, and every viewer silently drops to the
    // legacy runtime path with every poster lookup missing. Nothing errors.
    await seed('H1');
    await pg.query(
      `UPDATE simulations SET active_revision_id = '00000000-0000-0000-0000-0000000000aa'`,
    );

    await applyBridgeWrite('H2');

    const { rows } = await pg.query<{ package_class: string | null; bridge_hash: string }>(
      `SELECT package_class, bridge_hash FROM simulations WHERE id = 'sim-1'`,
    );
    expect(rows[0]!.package_class).toBe('managed-presentable');
    // The bridge_hash is not advanced either — the whole statement is skipped. That is correct:
    // on a revisioned package the legacy prefix is not what is served, so its hash is not the
    // package's identity. `packageRevisionFor` reads active_revision_id, not bridge_hash.
    expect(rows[0]!.bridge_hash).toBe('H1');
  });

  it('still clears the verdict for a simulation with no revision', async () => {
    await seed('H1');
    await applyBridgeWrite('H2');
    const { rows } = await pg.query<{ package_class: string | null; bridge_hash: string }>(
      `SELECT package_class, bridge_hash FROM simulations WHERE id = 'sim-1'`,
    );
    expect(rows[0]!.package_class).toBeNull();
    expect(rows[0]!.bridge_hash).toBe('H2');
  });
});


/**
 * THE COPY ABOVE IS NOT THE PRODUCTION STATEMENT.
 *
 * Everything above drives `applyBridgeWrite`, a hand-written SQL transcription of the update in
 * `SimulationService`. That proves the SEMANTICS are right; it cannot prove production still issues
 * them. Dropping `isNull(simulations.active_revision_id)` from the real `.where(...)` left every
 * assertion above green while production stomped the projected verdict of every revisioned
 * simulation — the one outcome this file exists to prevent.
 *
 * `SimulationService` cannot be instantiated here (storage adapter, LLM client, live db), so its
 * source is read instead, with comments stripped so prose cannot satisfy an assertion. Same
 * technique as `trustProxyWiring.test.ts`.
 */
describe('the production statement still carries every predicate the copy models', () => {
  const SRC = readFileSync(join(__dirname, '..', 'SimulationService.ts'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  /** The `.set(...).where(...)` chain that writes bridge_hash. */
  const stmt = (): string => {
    const m = SRC.match(/\.set\(\{\s*bridge_hash:[\s\S]*?\)\);/);
    expect(m, 'could not find the bridge_hash update in SimulationService').not.toBeNull();
    return m![0];
  };

  it('clears all three verdict columns with the hash', () => {
    for (const col of ['package_class: null', 'canary_report: null', 'canary_at: null']) {
      expect(stmt(), `the bridge write no longer clears ${col}`).toContain(col);
    }
  });

  it('keeps the verdict when the hash is UNCHANGED (idempotent regeneration)', () => {
    expect(stmt()).toMatch(/isNull\(simulations\.bridge_hash\)/);
    expect(stmt()).toMatch(/ne\(simulations\.bridge_hash,\s*hash\)/);
  });

  // THE REGRESSION. Migration 050 projects the verdict onto the revision; a revisioned simulation
  // must never have it stomped by a bridge regeneration.
  it('NEVER stomps a projected verdict — the revisioned guard is still in the predicate', () => {
    expect(stmt(),
      'active_revision_id guard missing: a bridge regeneration now nulls package_class on '
      + 'revisioned simulations, demoting proven packages to the legacy path')
      .toMatch(/isNull\(simulations\.active_revision_id\)/);
  });
});
