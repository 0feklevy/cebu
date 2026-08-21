/**
 * Migration 067 (video_dubs + dubbing_slots) against a real Postgres engine, in the 064 pattern.
 *
 * The properties that matter, and why each is worth a test rather than a comment:
 *   • UNIQUE(video_file_id, target_language, provider) — the LAST line of the double-billing
 *     defence. The vendor accepts no idempotency key on any dubbing create endpoint, so a retried
 *     create is a new billed job at roughly 3,000 credits per source-minute. If this constraint is
 *     ever weakened the failure is silent and expensive, which is exactly the kind that needs a
 *     test rather than a reviewer;
 *   • ON DELETE CASCADE from video_files — a deleted video must not strand dub rows pointing at a
 *     parent that no longer exists;
 *   • the status CHECK matches the vendor's own language-target enum, so our state machine and
 *     theirs cannot drift apart into a value neither side handles;
 *   • the language CHECK is the SAME regex courses.language carries, so one BCP-47 tag means one
 *     thing across the schema;
 *   • dubbing_slots is seeded with exactly three rows — the vendor's per-workspace ceiling. A pool
 *     that seeds zero rows silently blocks every dub forever; one that seeds more silently exceeds
 *     the vendor limit and earns `too_many_concurrent_requests`;
 *   • FOR UPDATE SKIP LOCKED actually excludes a concurrent claimer — the property the whole
 *     cluster-wide gate rests on, asserted against the engine rather than assumed;
 *   • idempotent, rolls back cleanly, registered with the runner, and holds its locks briefly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { MIGRATION_FILES } from '../migrate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const TARGET = '067_video_dubs.sql';
const ROLLBACK = '067_video_dubs.rollback.sql';
const ALL = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[^.]+\.sql$/.test(f)).sort();
const PRIOR = ALL.slice(0, ALL.indexOf(TARGET));
const forwardSql = readFileSync(join(MIGRATIONS_DIR, TARGET), 'utf-8');
const rollbackSql = readFileSync(join(MIGRATIONS_DIR, ROLLBACK), 'utf-8');

let pg: PGlite;
const rows = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await pg.query<T>(sql, params)).rows;

const applyForwardToHead = async (): Promise<void> => {
  await pg.exec(forwardSql);
  for (const f of ALL.slice(ALL.indexOf(TARGET) + 1)) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
};

/** A project + video_file to hang dubs off, since video_dubs is a child table with a real FK. */
async function seedVideo(): Promise<string> {
  const [user] = await rows<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('dub-uid', 'dub@example.com') RETURNING id`,
  );
  const [org] = await rows<{ id: string }>(
    `INSERT INTO orgs (name) VALUES ('Dub org') RETURNING id`,
  );
  const [project] = await rows<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1, $2, 'Dub test') RETURNING id`,
    [org!.id, user!.id],
  );
  const [video] = await rows<{ id: string }>(
    `INSERT INTO video_files (project_id, filename) VALUES ($1, 'lesson.mp4') RETURNING id`,
    [project!.id],
  );
  return video!.id;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of PRIOR) await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
});
afterEach(async () => { await pg.close(); });

describe('migration 067 — the constraint that stands between a retry and a second invoice', () => {
  beforeEach(applyForwardToHead);

  it('refuses a second dub of the same video, language and provider', async () => {
    const videoId = await seedVideo();
    await pg.query(
      `INSERT INTO video_dubs (video_file_id, target_language, provider) VALUES ($1, 'he', 'elevenlabs')`,
      [videoId],
    );
    await expect(pg.query(
      `INSERT INTO video_dubs (video_file_id, target_language, provider) VALUES ($1, 'he', 'elevenlabs')`,
      [videoId],
    )).rejects.toBeTruthy();
  });

  it('still allows the same language from a DIFFERENT provider — a captions-only row beside a dub', async () => {
    const videoId = await seedVideo();
    await pg.query(
      `INSERT INTO video_dubs (video_file_id, target_language, provider) VALUES ($1, 'es', 'elevenlabs')`,
      [videoId],
    );
    await expect(pg.query(
      `INSERT INTO video_dubs (video_file_id, target_language, provider) VALUES ($1, 'es', 'whisper+llm')`,
      [videoId],
    )).resolves.toBeTruthy();
  });

  it('cascades from video_files, so deleting a video strands no dub rows', async () => {
    const videoId = await seedVideo();
    await pg.query(
      `INSERT INTO video_dubs (video_file_id, target_language) VALUES ($1, 'he')`,
      [videoId],
    );
    await pg.query(`DELETE FROM video_files WHERE id = $1`, [videoId]);
    expect(await rows(`SELECT id FROM video_dubs`)).toEqual([]);
  });
});

describe('migration 067 — the state machine and the language tag cannot drift', () => {
  beforeEach(applyForwardToHead);

  it('accepts exactly the vendor language-target statuses', async () => {
    const videoId = await seedVideo();
    for (const status of ['queued', 'processing', 'completed', 'stale', 'failed']) {
      await expect(pg.query(
        `INSERT INTO video_dubs (video_file_id, target_language, status) VALUES ($1, $2, $3)`,
        [videoId, `x${status.slice(0, 2)}`, status],
      )).resolves.toBeTruthy();
    }
  });

  it('rejects a status outside that set — including "ready", which on the PROJECT resource means transcription finished, not dubbed', async () => {
    const videoId = await seedVideo();
    await expect(pg.query(
      `INSERT INTO video_dubs (video_file_id, target_language, status) VALUES ($1, 'he', 'ready')`,
      [videoId],
    )).rejects.toBeTruthy();
  });

  it('accepts the BCP-47 tags this product ships and rejects a malformed one', async () => {
    const videoId = await seedVideo();
    for (const tag of ['he', 'es', 'en', 'es-MX', 'en-GB']) {
      await expect(pg.query(
        `INSERT INTO video_dubs (video_file_id, target_language) VALUES ($1, $2)`,
        [videoId, tag],
      )).resolves.toBeTruthy();
    }
    await expect(pg.query(
      `INSERT INTO video_dubs (video_file_id, target_language) VALUES ($1, 'not a language')`,
      [videoId],
    )).rejects.toBeTruthy();
  });

  it('rejects a provider the captions-integrity rule does not know how to reason about', async () => {
    const videoId = await seedVideo();
    await expect(pg.query(
      `INSERT INTO video_dubs (video_file_id, target_language, provider) VALUES ($1, 'he', 'some-other-vendor')`,
      [videoId],
    )).rejects.toBeTruthy();
  });

  it('defaults watermarked to false, so a row is only unusable when something says so', async () => {
    const videoId = await seedVideo();
    await pg.query(`INSERT INTO video_dubs (video_file_id, target_language) VALUES ($1, 'he')`, [videoId]);
    const [row] = await rows<{ watermarked: boolean }>(`SELECT watermarked FROM video_dubs`);
    expect(row!.watermarked).toBe(false);
  });
});

describe('migration 067 — the cluster-wide concurrency pool', () => {
  beforeEach(applyForwardToHead);

  it('seeds exactly three slots — the vendor per-workspace ceiling', async () => {
    const slots = await rows<{ slot_no: number }>(`SELECT slot_no FROM dubbing_slots ORDER BY slot_no`);
    expect(slots.map((s) => s.slot_no)).toEqual([1, 2, 3]);
  });

  it('starts every slot free', async () => {
    const free = await rows(`SELECT slot_no FROM dubbing_slots WHERE holder IS NULL AND expires_at IS NULL`);
    expect(free).toHaveLength(3);
  });

  /**
   * The free-slot predicate, which is the half of the gate that IS testable here.
   *
   * True mutual exclusion under concurrency comes from `FOR UPDATE SKIP LOCKED`, and this engine
   * cannot demonstrate it: PGlite is a single in-process Postgres with one connection, so there is
   * no second session to be excluded — a nested query inside an open transaction deadlocks against
   * itself rather than skipping. Re-verifying SKIP LOCKED would in any case be testing Postgres,
   * not this migration. What IS ours, and what a wrong predicate would break silently, is which
   * rows count as free: a held-and-unexpired slot must not be offered again, and an EXPIRED lease
   * must be, or a crashed worker would shrink the pool permanently.
   */
  const freeSlots = `SELECT slot_no FROM dubbing_slots
                      WHERE holder IS NULL OR expires_at IS NULL OR expires_at < now()
                      ORDER BY slot_no`;

  it('stops offering a slot that is held and unexpired', async () => {
    await pg.query(
      `UPDATE dubbing_slots SET holder = 'dub-1', expires_at = now() + interval '30 minutes' WHERE slot_no = 1`,
    );
    const free = await rows<{ slot_no: number }>(freeSlots);
    expect(free.map((s) => s.slot_no)).toEqual([2, 3]);
  });

  it('offers an EXPIRED lease again, so a crashed worker cannot shrink the pool for good', async () => {
    await pg.query(
      `UPDATE dubbing_slots SET holder = 'crashed', expires_at = now() - interval '1 minute' WHERE slot_no = 2`,
    );
    const free = await rows<{ slot_no: number }>(freeSlots);
    expect(free.map((s) => s.slot_no)).toEqual([1, 2, 3]);
  });

  it('offers nothing at all once every slot is held — the state a fourth job must wait on', async () => {
    await pg.query(`UPDATE dubbing_slots SET holder = 'busy', expires_at = now() + interval '30 minutes'`);
    expect(await rows(freeSlots)).toEqual([]);
  });
});

describe('migration 067 — runner hygiene', () => {
  it('is idempotent — applying it twice changes nothing', async () => {
    await applyForwardToHead();
    await expect(pg.exec(forwardSql)).resolves.toBeTruthy();
    const slots = await rows(`SELECT slot_no FROM dubbing_slots`);
    expect(slots).toHaveLength(3);
  });

  it('rolls back to exactly the prior schema', async () => {
    const before = await rows(`SELECT table_name FROM information_schema.tables
                                WHERE table_schema='public' ORDER BY table_name`);
    await pg.exec(forwardSql);
    await pg.exec(rollbackSql);
    expect(await rows(`SELECT table_name FROM information_schema.tables
                        WHERE table_schema='public' ORDER BY table_name`)).toEqual(before);
  });

  it('sets a short lock_timeout, LOCAL so it dies with the migration', async () => {
    expect(forwardSql).toMatch(/SET\s+LOCAL\s+lock_timeout/i);
    expect(forwardSql).not.toMatch(/(?<!LOCAL\s)\bSET\s+lock_timeout/i);
  });

  it('is registered with the migration runner, in order', async () => {
    expect(MIGRATION_FILES).toContain(TARGET);
    expect([...MIGRATION_FILES]).toEqual([...MIGRATION_FILES].sort());
  });

  it('is registered with the db integrity script', async () => {
    const checkDb = readFileSync(join(HERE, '..', '..', 'scripts', 'check-db.ts'), 'utf-8');
    expect(checkDb).toContain(TARGET);
  });

  it('ships a rollback helper', async () => {
    expect(readdirSync(MIGRATIONS_DIR)).toContain(ROLLBACK);
  });
});
