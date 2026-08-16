/**
 * Forward-only migration runner.
 *
 * Every migration file and its `schema_migrations` tracker row are written inside ONE explicit
 * transaction, so the two can never disagree: either the schema change and the "I ran this" record
 * both land, or neither does and the next run retries the file.
 *
 * This replaces a runner that treated "duplicate object" errors (42701 / 42P07 / 23505) as proof
 * the file had already been applied. Postgres runs a multi-statement file in ONE implicit
 * transaction, so such an error rolls back the ENTIRE file — including any genuinely-new DDL in it
 * — and the old runner then marked the file applied anyway. The new statements were silently
 * dropped and could never be retried, because the runner believed it had run them. Those codes are
 * no longer tolerated: a failing migration now fails the run, loudly, with nothing recorded.
 *
 * Three further guarantees:
 *   • a session-level ADVISORY LOCK serializes runners, so two concurrent deploys cannot race
 *     each other (nor race on `CREATE TABLE IF NOT EXISTS schema_migrations` itself);
 *   • a CHECKSUM per applied file turns "somebody edited an already-applied migration" from an
 *     invisible divergence into a hard, named failure. Never edit an applied migration — if the
 *     schema needs repair, the answer is a NEW migration;
 *   • the run aborts on drift BEFORE applying anything, so a tampered history cannot be built on.
 *
 * Files are applied in the order of the hardcoded `migrations` list below. A .sql file that is not
 * in that list is never run — deliberately, so ordering is explicit and reviewable — and both the
 * release engine's migration audit and the db suite assert the list matches the directory.
 */

import { readFileSync, realpathSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { logger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const migrations = ['001_initial.sql', '002_audio_scenes.sql', '003_document_type.sql', '004_video_editor.sql', '005_hls_transcoding.sql', '006_hls_tier_progress.sql', '007_waveform_peaks.sql', '008_simulations.sql', '009_section_sim_ref.sql', '010_broll_generation.sql', '011_sim_prompt.sql', '012_broll_source_flag.sql', '013_sim_meta.sql', '014_clip_source.sql', '015_bridge_plan_prompt.sql', '016_share_token.sql', '017_broll_audio.sql', '018_image_clips.sql', '019_guidance.sql', '020_audio_files.sql', '021_playlists.sql', '022_smart_crop.sql', '023_playlist_banners.sql', '024_billing.sql', '025_video_metadata.sql', '026_crop_updated_at.sql', '027_view_counts.sql', '028_avatar.sql', '029_avatar_persona.sql', '030_course_publishing.sql', '031_captions.sql', '032_course_publishing_hardening.sql', '033_captions_vtt.sql', '034_project_seo.sql', '035_project_delete_cascade.sql', '036_project_visibility.sql', '037_branching.sql', '038_branch_analytics.sql', '039_perf_indexes.sql', '040_generation_limit.sql', '041_timeline_markers.sql', '042_collaborators.sql', '043_permalink_slugs.sql', '044_podcast_studio.sql', '045_podcast_audio_studio.sql', '046_token_usage_cost_precision.sql', '047_complex_model_opus.sql', '048_sim_pool_mode.sql', '049_sim_posters.sql', '050_sim_revisions.sql', '051_sim_rum.sql', '052_sim_scheduler.sql', '053_hls_retired_runs.sql', '054_sim_transition_coordinator.sql', '055_sim_bridge_ack_capable.sql', '056_project_duplication.sql', '057_sim_requires_import_maps.sql', '058_project_exports.sql', '059_export_degradation_policy.sql', '060_export_plan_snapshot.sql', '061_export_progress.sql'];

/** The ordered list of migration files the runner applies. */
export const MIGRATION_FILES: readonly string[] = migrations;

/**
 * Session-level advisory lock key. Arbitrary but STABLE — every runner must pick the same number
 * or the lock serializes nothing. Inlined as a literal (never a bind parameter) so no driver can
 * infer it as int4 and silently select the two-argument `pg_advisory_lock(int, int)` overload.
 */
export const MIGRATION_LOCK_KEY = 4867221936;

/**
 * KNOWN LIMITATION — `CREATE INDEX CONCURRENTLY` (and the handful of other statements Postgres
 * refuses to run inside a transaction block) cannot be used in a migration under this runner. It
 * fails with 25001, the file rolls back, and nothing is recorded — loudly, and with no way to
 * force it through.
 *
 * This is deliberate, and it costs nothing today: NO .sql file in this repo uses CONCURRENTLY
 * (the only two occurrences of the word are English prose in comments in 056 and 058). Wrapping
 * every file unconditionally is therefore the smaller, safer runner.
 *
 * An opt-out marker alone would NOT lift the limitation, which is why there isn't one. Postgres
 * runs a multi-statement simple query in a single implicit transaction, so simply omitting BEGIN
 * still yields 25001 for any file with more than one statement (verified on PGlite). Supporting
 * CONCURRENTLY needs the runner to split the file into individual statements and send them one at
 * a time — a real SQL splitter, with all the dollar-quoting and semicolon-in-literal hazards that
 * implies. If a migration ever genuinely needs it, that is the work to do, and the escape hatch
 * should apply to a file holding that statement and nothing else.
 */

/** A minimal driver seam: satisfied by postgres.js in production and by PGlite in the tests. */
export interface MigrationClient {
  /** Run one parameterized statement and return its rows. */
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /** Run a SQL script, which may contain multiple statements. No parameters. */
  exec(text: string): Promise<void>;
}

/** The subset of the pino logger this module uses. */
export interface MigrationLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface RunMigrationsOptions {
  client: MigrationClient;
  /** Defaults to the `migrations/` directory next to this file. */
  migrationsDir?: string;
  /** Defaults to the hardcoded ordered list. */
  files?: readonly string[];
  logger?: MigrationLogger;
}

export interface MigrationRunSummary {
  /** Files applied by this run, in order. */
  applied: string[];
  /** Files already recorded as applied, left alone. */
  skipped: string[];
  /** Pre-checksum rows whose checksum this run adopted from disk (see `verifyChecksums`). */
  checksumAdopted: string[];
}

/**
 * Content hash of a migration file. CRLF is normalized to LF first so a checkout with different
 * line-ending settings does not read as tampering — the guarantee is about CONTENT, not bytes.
 */
export function migrationChecksum(source: string): string {
  return `sha256:${createHash('sha256').update(source.replace(/\r\n/g, '\n'), 'utf8').digest('hex')}`;
}

interface LoadedMigration {
  file: string;
  text: string;
  checksum: string;
}

/**
 * Compare every already-applied file against its checksum on disk.
 *
 * Rows written before checksums existed have a NULL checksum: there is no record of what they
 * looked like when they ran, so drift is unknowable for them and this ADOPTS the current file as
 * the baseline. That is the only honest option, and it keeps the first run after this upgrade from
 * failing every existing deployment. Everything applied from here on is checked for real.
 */
function verifyChecksums(
  loaded: LoadedMigration[],
  appliedChecksums: Map<string, string | null>,
): { drifted: LoadedMigration[]; toAdopt: LoadedMigration[] } {
  const drifted: LoadedMigration[] = [];
  const toAdopt: LoadedMigration[] = [];
  for (const m of loaded) {
    if (!appliedChecksums.has(m.file)) continue;
    const stored = appliedChecksums.get(m.file) ?? null;
    if (stored === null) toAdopt.push(m);
    else if (stored !== m.checksum) drifted.push(m);
  }
  return { drifted, toAdopt };
}

/**
 * Apply one file and record it, atomically. Any error rolls back BOTH the schema change and the
 * tracker row, then propagates — the file stays unapplied and untracked, and the next run retries
 * it from a clean state.
 */
async function applyInTransaction(
  client: MigrationClient,
  m: LoadedMigration,
  log: MigrationLogger,
): Promise<void> {
  await client.exec('BEGIN');
  try {
    await client.exec(m.text);
    await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [
      m.file,
      m.checksum,
    ]);
    await client.exec('COMMIT');
  } catch (err) {
    // Roll back on a best-effort basis; a rollback failure must never replace the real error.
    try {
      await client.exec('ROLLBACK');
    } catch (rollbackErr) {
      log.error({ file: m.file, err: rollbackErr }, 'Rollback failed after a failed migration');
    }
    log.error(
      { file: m.file, err },
      'Migration failed — the file and its tracker row were both rolled back. Nothing was recorded; the next run will retry this file.',
    );
    throw err;
  }
}

async function runLocked(
  client: MigrationClient,
  dir: string,
  files: readonly string[],
  log: MigrationLogger,
): Promise<MigrationRunSummary> {
  await client.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Additive, idempotent, and safe against an older app image reading this table.
  await client.exec('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');

  const rows = await client.query<{ filename: string; checksum: string | null }>(
    'SELECT filename, checksum FROM schema_migrations',
  );
  const appliedChecksums = new Map(rows.map((r) => [r.filename, r.checksum]));

  // Read everything up front: a missing file fails the run before any DDL is executed, rather
  // than halfway through with some files applied.
  const loaded: LoadedMigration[] = files.map((file) => {
    const text = readFileSync(join(dir, file), 'utf-8');
    return { file, text, checksum: migrationChecksum(text) };
  });

  const { drifted, toAdopt } = verifyChecksums(loaded, appliedChecksums);
  if (drifted.length > 0) {
    log.error(
      { files: drifted.map((d) => ({ file: d.file, applied: appliedChecksums.get(d.file), onDisk: d.checksum })) },
      'Migration drift: already-applied migration files have changed on disk',
    );
    throw new Error(
      `Migration drift detected — ${drifted.length} already-applied migration file(s) changed on disk since they were applied: ${drifted
        .map((d) => d.file)
        .join(', ')}. An applied migration must never be edited; the databases that already ran it will not pick the change up. Restore the original content and express the change as a NEW migration. No migrations were applied by this run.`,
    );
  }

  for (const m of toAdopt) {
    await client.query('UPDATE schema_migrations SET checksum = $1 WHERE filename = $2', [
      m.checksum,
      m.file,
    ]);
  }
  if (toAdopt.length > 0) {
    log.info(
      { count: toAdopt.length },
      'Adopted the on-disk content of pre-checksum migrations as their baseline — drift before this point is unknowable, drift after it is not.',
    );
  }

  const summary: MigrationRunSummary = {
    applied: [],
    skipped: [],
    checksumAdopted: toAdopt.map((m) => m.file),
  };

  for (const m of loaded) {
    if (appliedChecksums.has(m.file)) {
      summary.skipped.push(m.file);
      continue;
    }
    log.info({ file: m.file }, 'Applying migration');
    await applyInTransaction(client, m, log);
    summary.applied.push(m.file);
    log.info({ file: m.file }, 'Migration applied');
  }

  return summary;
}

/**
 * Apply every pending migration. Serialized against other runners by a session-level advisory
 * lock, so concurrent deploys queue instead of racing.
 *
 * The lock MUST be held on a single session for its whole lifetime; the production client is
 * therefore configured with `max: 1`.
 */
export async function runMigrations(opts: RunMigrationsOptions): Promise<MigrationRunSummary> {
  const { client } = opts;
  const dir = opts.migrationsDir ?? join(__dirname, 'migrations');
  const files = opts.files ?? migrations;
  const log = opts.logger ?? logger;

  await client.exec(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
  try {
    return await runLocked(client, dir, files, log);
  } finally {
    try {
      await client.exec(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    } catch (unlockErr) {
      // Never let a failed unlock mask the real outcome — ending the session releases it anyway.
      log.error({ err: unlockErr }, 'Failed to release the migration advisory lock');
    }
  }
}

/** Adapt postgres.js to the driver seam. */
export function postgresMigrationClient(sql: ReturnType<typeof postgres>): MigrationClient {
  return {
    async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
      const rows = await sql.unsafe(text, params as never[]);
      return rows as unknown as T[];
    },
    async exec(text: string): Promise<void> {
      await sql.unsafe(text);
    },
  };
}

async function migrateCli(): Promise<void> {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas';
  // max: 1 is load-bearing — the advisory lock and every BEGIN/COMMIT must be on ONE session.
  const sql = postgres(connectionString, { max: 1 });

  let failed = false;
  try {
    logger.info('Running migrations...');
    const summary = await runMigrations({ client: postgresMigrationClient(sql) });
    logger.info(
      { applied: summary.applied.length, skipped: summary.skipped.length },
      'Migrations complete',
    );
  } catch (err) {
    failed = true;
    logger.error({ err }, 'Migration failed');
  } finally {
    await sql.end();
  }
  if (failed) process.exit(1);
}

/** Only run when executed as a script — importing this module (as the tests do) must not connect. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  const self = fileURLToPath(import.meta.url);
  if (resolve(entry) === self) return true;
  try {
    return realpathSync(resolve(entry)) === realpathSync(self);
  } catch {
    return false;
  }
}

if (invokedDirectly()) void migrateCli();
