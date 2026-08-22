/**
 * Forward-only migration runner.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * DEPLOY PREREQUISITE — `MIGRATION_DATABASE_URL` MUST BE A SESSION-MODE ENDPOINT
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Set `MIGRATION_DATABASE_URL` to Supabase's DIRECT connection or its SESSION-mode pooler
 * (port 5432). NOT the transaction pooler (port 6543). A deploy that has not done this now FAILS
 * FAST, before any DDL, with an error naming the variable — see `resolveMigrationUrl` below.
 *
 * WHY THIS IS A PREREQUISITE AND NOT A PREFERENCE. This runner serializes concurrent deploys with
 * a SESSION-level advisory lock (`pg_advisory_lock`). A session-level lock is owned by ONE Postgres
 * BACKEND and lives until that backend's session ends. Through a TRANSACTION pooler, a client
 * connection is not a backend session: the pooler hands each transaction whichever backend happens
 * to be free and returns it to the pool at COMMIT. So `postgres(url, { max: 1 })` pins one
 * connection to the POOLER — it does not pin a Postgres backend. `pg_advisory_lock` can then be
 * taken in one backend while the migrations run in another, and the unlock can miss a third.
 *
 * That failure is SILENT. `SELECT pg_advisory_lock(...)` returns successfully; the lock is real;
 * it simply does not guard the thing it was meant to guard. Two concurrent deploys would each
 * believe they held it, and could apply the same file at the same time — which is exactly the
 * `CREATE TABLE IF NOT EXISTS schema_migrations` race, and every duplicate-DDL race after it, that
 * the lock exists to prevent. There is no error to notice and nothing in the logs to read. The
 * runner therefore refuses to start rather than proceed with a lock that does not lock.
 *
 * The documented `DATABASE_URL` for this deployment goes through the transaction pooler on 6543
 * (deploy/.env.example and deploy/README.md both describe that layout), which is why defaulting to
 * it was the defect and why the resolver below no longer treats it as good enough on its own.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
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
 *     each other (nor race on `CREATE TABLE IF NOT EXISTS schema_migrations` itself) — but ONLY on
 *     a session-mode endpoint, which is what the DEPLOY PREREQUISITE above is about;
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

const migrations = ['001_initial.sql', '002_audio_scenes.sql', '003_document_type.sql', '004_video_editor.sql', '005_hls_transcoding.sql', '006_hls_tier_progress.sql', '007_waveform_peaks.sql', '008_simulations.sql', '009_section_sim_ref.sql', '010_broll_generation.sql', '011_sim_prompt.sql', '012_broll_source_flag.sql', '013_sim_meta.sql', '014_clip_source.sql', '015_bridge_plan_prompt.sql', '016_share_token.sql', '017_broll_audio.sql', '018_image_clips.sql', '019_guidance.sql', '020_audio_files.sql', '021_playlists.sql', '022_smart_crop.sql', '023_playlist_banners.sql', '024_billing.sql', '025_video_metadata.sql', '026_crop_updated_at.sql', '027_view_counts.sql', '028_avatar.sql', '029_avatar_persona.sql', '030_course_publishing.sql', '031_captions.sql', '032_course_publishing_hardening.sql', '033_captions_vtt.sql', '034_project_seo.sql', '035_project_delete_cascade.sql', '036_project_visibility.sql', '037_branching.sql', '038_branch_analytics.sql', '039_perf_indexes.sql', '040_generation_limit.sql', '041_timeline_markers.sql', '042_collaborators.sql', '043_permalink_slugs.sql', '044_podcast_studio.sql', '045_podcast_audio_studio.sql', '046_token_usage_cost_precision.sql', '047_complex_model_opus.sql', '048_sim_pool_mode.sql', '049_sim_posters.sql', '050_sim_revisions.sql', '051_sim_rum.sql', '052_sim_scheduler.sql', '053_hls_retired_runs.sql', '054_sim_transition_coordinator.sql', '055_sim_bridge_ack_capable.sql', '056_project_duplication.sql', '057_sim_requires_import_maps.sql', '058_project_exports.sql', '059_export_degradation_policy.sql', '060_export_plan_snapshot.sql', '061_export_progress.sql', '062_broll_idempotency.sql', '063_segment_relative_placement.sql', '064_avatar_cost_meter.sql', '065_library_shares.sql', '066_crop_algo_version.sql', '067_video_dubs.sql', '068_project_source_language.sql', '069_placement_impact_review.sql', '070_dub_stage_and_language_origin.sql', '071_project_audio_editions.sql', '072_listener_questions.sql', '073_usage_units.sql'];

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

// ── Which database the runner connects to (the DEPLOY PREREQUISITE, enforced) ─────────────────

/** Supabase's transaction pooler. The one port this runner will not migrate through. */
export const TRANSACTION_POOLER_PORT = '6543';

/** Used only when nothing is configured at all — i.e. a developer's local Postgres. */
export const DEFAULT_LOCAL_MIGRATION_URL = 'postgresql://postgres:postgres@localhost:5432/podcast_saas';

/** Where a migration connection string may come from, in order of preference. */
export type MigrationUrlSource =
  | 'MIGRATION_DATABASE_URL'
  | 'QUEUE_DATABASE_URL'
  | 'DATABASE_URL'
  | 'default';

export interface ResolvedMigrationUrl {
  url: string;
  source: MigrationUrlSource;
  /**
   * Set whenever the URL did NOT come from `MIGRATION_DATABASE_URL`. The runner logs it at WARN,
   * so a fallback is always something an operator can see in the deploy output — never a silent
   * default that happens to work until it doesn't.
   */
  fallbackNote?: string;
}

/**
 * Name the reason this connection string is transaction-pooled, or return null.
 *
 * DELIBERATELY NOT A HOSTNAME TEST. `*.pooler.supabase.com` serves BOTH modes — transaction on
 * 6543 and SESSION on 5432 — and the session pooler is precisely what deploy/README.md instructs
 * operators to point `QUEUE_DATABASE_URL` at, because pg-boss needs advisory locks for the same
 * reason this runner does. Rejecting the host would reject the documented-correct configuration.
 * The PORT (and the pooling parameters some tools append) is the signal that actually discriminates.
 *
 * An unparseable string is not judged: the driver will produce a better error about it than a
 * guess from here would, and refusing to migrate over a URL we could not even read would turn a
 * typo into a mystery.
 */
export function describeTransactionPooler(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.port === TRANSACTION_POOLER_PORT) {
    return `it connects on port ${TRANSACTION_POOLER_PORT}, which is Supabase's TRANSACTION pooler`;
  }
  const params = parsed.searchParams;
  if ((params.get('pgbouncer') ?? '').toLowerCase() === 'true') {
    return 'it carries `pgbouncer=true`, which names a transaction-pooled endpoint';
  }
  const poolMode = (params.get('pool_mode') ?? '').toLowerCase();
  if (poolMode === 'transaction' || poolMode === 'statement') {
    return `it carries \`pool_mode=${poolMode}\`, which is not a session-mode endpoint`;
  }
  return null;
}

function assertSessionMode(resolved: ResolvedMigrationUrl): ResolvedMigrationUrl {
  const reason = describeTransactionPooler(resolved.url);
  if (reason === null) return resolved;
  throw new Error(
    `Refusing to run migrations through a transaction pooler.\n` +
      `  Connection string resolved from: ${resolved.source}\n` +
      `  Why it was rejected: ${reason}.\n\n` +
      `This runner serializes concurrent deploys with a SESSION-level advisory lock. A transaction ` +
      `pooler hands each transaction whichever backend is free, so \`max: 1\` pins a POOLER ` +
      `connection rather than a Postgres backend — the lock can be taken in one backend while the ` +
      `migrations run in another. Nothing would error; the lock would simply serialize nothing, and ` +
      `two concurrent deploys could apply the same file at the same time.\n\n` +
      `Fix: set MIGRATION_DATABASE_URL to the DIRECT connection or the SESSION-mode pooler ` +
      `(port 5432). Leave DATABASE_URL on :${TRANSACTION_POOLER_PORT} if the web tier wants it — ` +
      `only the migration runner needs the session-mode endpoint. Nothing has been applied.`,
  );
}

function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Choose the connection string the migration runner will use, and refuse a transaction pooler.
 *
 * Preference order, each step explicit rather than implied:
 *
 *   1. `MIGRATION_DATABASE_URL` — the intended answer. One variable whose only job is this, so a
 *      deployment can move the web tier onto the transaction pooler without moving migrations.
 *   2. `QUEUE_DATABASE_URL` — an accepted fallback, because the deploy contract ALREADY requires
 *      this one to be session-mode: pg-boss uses LISTEN/NOTIFY and advisory locks, and
 *      deploy/.env.example, deploy/README.md and queue/pgBoss.ts all say to point it at the
 *      `:5432` session pooler or the direct connection. That is a verified property of the
 *      variable's contract, not an assumption about a given deployment's value — and the check
 *      below re-verifies the actual value anyway.
 *   3. `DATABASE_URL` — last resort, and the one most likely to be the transaction pooler. Kept so
 *      that single-endpoint deployments and local development keep working; it is checked exactly
 *      as strictly as the others, so a 6543 value fails here instead of migrating unserialized.
 *   4. A local default, for a developer who has configured nothing.
 *
 * Every branch runs through `assertSessionMode`. There is no path that skips the check.
 */
export function resolveMigrationUrl(env: NodeJS.ProcessEnv = process.env): ResolvedMigrationUrl {
  const explicit = present(env.MIGRATION_DATABASE_URL);
  if (explicit) {
    return assertSessionMode({ url: explicit, source: 'MIGRATION_DATABASE_URL' });
  }

  const queue = present(env.QUEUE_DATABASE_URL);
  if (queue) {
    return assertSessionMode({
      url: queue,
      source: 'QUEUE_DATABASE_URL',
      fallbackNote:
        'MIGRATION_DATABASE_URL is unset — falling back to QUEUE_DATABASE_URL, which the deploy ' +
        'contract already requires to be a session-mode or direct endpoint (pg-boss needs advisory ' +
        'locks too). Set MIGRATION_DATABASE_URL to make the migration endpoint explicit.',
    });
  }

  const app = present(env.DATABASE_URL);
  if (app) {
    return assertSessionMode({
      url: app,
      source: 'DATABASE_URL',
      fallbackNote:
        'Neither MIGRATION_DATABASE_URL nor QUEUE_DATABASE_URL is set — falling back to ' +
        'DATABASE_URL. That is only safe while DATABASE_URL is a session-mode or direct endpoint; ' +
        'the moment the web tier moves to the transaction pooler this deploy will (correctly) fail. ' +
        'Set MIGRATION_DATABASE_URL now.',
    });
  }

  return assertSessionMode({
    url: DEFAULT_LOCAL_MIGRATION_URL,
    source: 'default',
    fallbackNote:
      'No database URL is configured — using the local development default. This is never the ' +
      'right answer in a deployed environment.',
  });
}

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
 * The lock MUST be held on a single Postgres BACKEND SESSION for its whole lifetime. Two things
 * are required for that, and `max: 1` alone is only the first:
 *   • the client keeps one connection (`max: 1`), and
 *   • that connection IS a backend session — i.e. a direct or session-mode endpoint, which
 *     `resolveMigrationUrl` enforces. See the DEPLOY PREREQUISITE at the top of this file.
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
  // Resolve BEFORE connecting. A transaction-pooled URL throws here, so the deploy fails with a
  // named variable and an explanation instead of running unserialized migrations that look fine.
  let resolved: ResolvedMigrationUrl;
  try {
    resolved = resolveMigrationUrl(process.env);
  } catch (err) {
    logger.error({ err }, 'Migration aborted before connecting — no migrations were applied');
    process.exit(1);
    return;
  }
  if (resolved.fallbackNote) {
    logger.warn({ source: resolved.source }, resolved.fallbackNote);
  }
  logger.info({ source: resolved.source }, 'Migration connection resolved');

  // max: 1 is load-bearing — the advisory lock and every BEGIN/COMMIT must be on ONE session.
  // It is only sufficient BECAUSE `resolveMigrationUrl` has guaranteed a session-mode endpoint:
  // through a transaction pooler, one client connection is not one Postgres backend.
  const sql = postgres(resolved.url, { max: 1 });

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
