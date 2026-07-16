/**
 * backfill-localhost-urls — detect & repair browser-visible asset URLs that were
 * persisted with a non-public host (http://localhost:8080, 127.0.0.1, or an internal
 * Docker hostname) during the local-dev era / a misconfigured deploy.
 *
 * SAFE BY DEFAULT: runs in REPORT mode (no writes) and prints affected row counts per
 * table.column. Pass --apply to perform the backfill. Idempotent: the WHERE predicate only
 * matches non-public hosts, so once a value is rewritten to a cloud URL / NULL it is never
 * touched again. Before any write it snapshots the old value into a backup table.
 *
 *   Report:  tsx --env-file=../.env src/scripts/backfill-localhost-urls.ts
 *   Apply:   tsx --env-file=../.env src/scripts/backfill-localhost-urls.ts --apply
 *
 * Repair strategy per column:
 *   - key-backed (*_url has a sibling *_key): if the object exists in cloud → rewrite the
 *     URL via the storage adapter (getPublicUrl/getSimPublicUrl); else NULL it (the asset
 *     only ever lived on dead local disk — regenerate or re-upload; a broken localhost URL
 *     is worse than a null that the UI renders as a placeholder / regenerates).
 *   - simulations.entry_file: strip the '{base}/sim-public/' prefix back to the bare KEY so
 *     the read-time resolver rebuilds the correct URL from the (now-fixed) API origin.
 *   - timeline_sections.simulation_url: recompute from the parent simulation (only rows with
 *     a simulation_id; user-entered external URLs are left alone).
 *   - no-key columns (branch_edges.thumbnail_url): NULL the poisoned value.
 *
 * Never blindly rewrites unrelated text: it only touches the columns listed below and only
 * rows whose value's HOST is non-public, so legitimate https cloud URLs and user-entered
 * external URLs are preserved.
 */
import postgres from 'postgres';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { logger } from '../lib/logger.js';
import { NON_PUBLIC_SQL as NON_PUBLIC, keyFromUrl } from './lib/urlBackfill.js';

const APPLY = process.argv.includes('--apply');
const BACKUP_TABLE = '_url_backfill_backup';

type KeyBacked = { table: string; urlCol: string; keyCol: string; sim?: boolean };
const KEY_BACKED: KeyBacked[] = [
  { table: 'projects', urlCol: 'thumbnail_url', keyCol: 'thumbnail_key' },
  { table: 'image_files', urlCol: 'original_url', keyCol: 'storage_key' },
  { table: 'audio_files', urlCol: 'url', keyCol: 'storage_key' },
  { table: 'playlists', urlCol: 'banner_url', keyCol: 'banner_storage_key' },
  { table: 'avatar_visuals', urlCol: 'image_url', keyCol: 'image_key' },
];

// Columns reported (and, where noted, handled specially) beyond the key-backed set.
const OTHER_COLUMNS: Array<{ table: string; col: string }> = [
  { table: 'simulations', col: 'entry_file' },
  { table: 'avatar_visuals', col: 'sim_entry_url' },
  { table: 'timeline_sections', col: 'simulation_url' },
  { table: 'corpora', col: 'storage_url' },
  { table: 'branch_edges', col: 'thumbnail_url' },
];

async function main() {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas';
  const sql = postgres(connectionString, { max: 4 });
  const storage = getStorageAdapter();

  // Typed wrapper around raw SQL (parameterised — never string-interpolated user input).
  const q = <T>(text: string, params: Array<string | null> = []): Promise<T[]> =>
    sql.unsafe(text, params as string[]) as unknown as Promise<T[]>;

  const exists = async (key: string): Promise<boolean> => {
    try { return await storage.objectExists(key); } catch { return false; }
  };

  try {
    // ── 1. REPORT (always) ────────────────────────────────────────────────────
    logger.info(`[backfill] mode=${APPLY ? 'APPLY' : 'REPORT (dry-run)'}`);
    const reportRows: Array<{ target: string; affected: number }> = [];
    const allTargets = [
      ...KEY_BACKED.map((k) => ({ table: k.table, col: k.urlCol })),
      ...OTHER_COLUMNS,
    ];
    for (const t of allTargets) {
      const [{ count }] = await q<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${t.table} WHERE ${t.col} ~* $1`,
        [NON_PUBLIC],
      );
      reportRows.push({ target: `${t.table}.${t.col}`, affected: count });
    }
    const total = reportRows.reduce((s, r) => s + r.affected, 0);
    console.table(reportRows);
    logger.info(`[backfill] total affected rows: ${total}`);
    if (!APPLY) {
      logger.info('[backfill] REPORT only — re-run with --apply to repair. No data changed.');
      return;
    }
    if (total === 0) {
      logger.info('[backfill] nothing to repair.');
      return;
    }

    // ── 2. Backup table (idempotent create) ───────────────────────────────────
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
        target text NOT NULL,
        row_id text NOT NULL,
        old_value text,
        new_value text,
        backed_up_at timestamptz NOT NULL DEFAULT now()
      )`);

    const backup = async (target: string, id: string, oldV: string | null, newV: string | null) => {
      await sql.unsafe(
        `INSERT INTO ${BACKUP_TABLE} (target, row_id, old_value, new_value) VALUES ($1,$2,$3,$4)`,
        [target, id, oldV, newV],
      );
    };

    let rewritten = 0, nulled = 0, keyed = 0;

    // ── 3. Key-backed columns ─────────────────────────────────────────────────
    for (const spec of KEY_BACKED) {
      const rows = await q<{ id: string; url: string; key: string | null }>(
        `SELECT id, ${spec.urlCol} AS url, ${spec.keyCol} AS key FROM ${spec.table} WHERE ${spec.urlCol} ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        let next: string | null = null;
        if (r.key && (await exists(r.key))) next = storage.getPublicUrl(r.key);
        await backup(`${spec.table}.${spec.urlCol}`, String(r.id), r.url, next);
        await sql.unsafe(`UPDATE ${spec.table} SET ${spec.urlCol} = $1 WHERE id = $2`, [next, r.id]);
        if (next) rewritten++; else nulled++;
      }
      logger.info(`[backfill] ${spec.table}.${spec.urlCol}: processed ${rows.length}`);
    }

    // ── 4. simulations.entry_file → bare key ──────────────────────────────────
    {
      const rows = await q<{ id: string; entry_file: string }>(
        `SELECT id, entry_file FROM simulations WHERE entry_file ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        const key = keyFromUrl(r.entry_file);
        if (!key) continue;
        if (!(await exists(key))) logger.warn({ id: r.id, key }, '[backfill] sim bundle missing in cloud — key stored, re-upload needed');
        await backup('simulations.entry_file', String(r.id), r.entry_file, key);
        await sql.unsafe(`UPDATE simulations SET entry_file = $1 WHERE id = $2`, [key, r.id]);
        keyed++;
      }
      logger.info(`[backfill] simulations.entry_file: processed ${rows.length}`);
    }

    // ── 5. avatar_visuals.sim_entry_url → recompute from key ──────────────────
    {
      const rows = await q<{ id: string; sim_entry_url: string; visual_spec: { entryKey?: string } | null }>(
        `SELECT id, sim_entry_url, visual_spec FROM avatar_visuals WHERE sim_entry_url ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        const key = r.visual_spec?.entryKey ?? keyFromUrl(r.sim_entry_url);
        const next = key && (await exists(key)) ? storage.getSimPublicUrl(key) : null;
        await backup('avatar_visuals.sim_entry_url', String(r.id), r.sim_entry_url, next);
        await sql.unsafe(`UPDATE avatar_visuals SET sim_entry_url = $1 WHERE id = $2`, [next, r.id]);
        if (next) rewritten++; else nulled++;
      }
      logger.info(`[backfill] avatar_visuals.sim_entry_url: processed ${rows.length}`);
    }

    // ── 6. timeline_sections.simulation_url → recompute from parent sim ───────
    // Runs AFTER simulations.entry_file is fixed. Only rows with a simulation_id (FK);
    // user-entered external sim URLs (simulation_id IS NULL) are left untouched.
    {
      const rows = await q<{ id: string; simulation_url: string; entry_file: string | null }>(
        `SELECT ts.id, ts.simulation_url, s.entry_file
           FROM timeline_sections ts JOIN simulations s ON s.id = ts.simulation_id
          WHERE ts.simulation_url ~* $1 AND ts.simulation_id IS NOT NULL`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        const ef = r.entry_file;
        const next = !ef ? null : ef.startsWith('http') ? ef : storage.getSimPublicUrl(ef);
        await backup('timeline_sections.simulation_url', String(r.id), r.simulation_url, next);
        await sql.unsafe(`UPDATE timeline_sections SET simulation_url = $1 WHERE id = $2`, [next, r.id]);
        if (next) rewritten++; else nulled++;
      }
      logger.info(`[backfill] timeline_sections.simulation_url: processed ${rows.length}`);
    }

    // ── 7. corpora.storage_url (no key column — parse key from URL) ────────────
    {
      const rows = await q<{ id: string; storage_url: string }>(
        `SELECT id, storage_url FROM corpora WHERE storage_url ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        const key = keyFromUrl(r.storage_url);
        const next = key && (await exists(key)) ? storage.getPublicUrl(key) : null;
        await backup('corpora.storage_url', String(r.id), r.storage_url, next);
        await sql.unsafe(`UPDATE corpora SET storage_url = $1 WHERE id = $2`, [next, r.id]);
        if (next) rewritten++; else nulled++;
      }
      logger.info(`[backfill] corpora.storage_url: processed ${rows.length}`);
    }

    // ── 8. branch_edges.thumbnail_url (no key — null poisoned) ────────────────
    {
      const rows = await q<{ id: string; thumbnail_url: string }>(
        `SELECT id, thumbnail_url FROM branch_edges WHERE thumbnail_url ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        await backup('branch_edges.thumbnail_url', String(r.id), r.thumbnail_url, null);
        await sql.unsafe(`UPDATE branch_edges SET thumbnail_url = NULL WHERE id = $1`, [r.id]);
        nulled++;
      }
      logger.info(`[backfill] branch_edges.thumbnail_url: processed ${rows.length}`);
    }

    logger.info(
      `[backfill] DONE — rewritten-to-cloud=${rewritten}, keyed(sim)=${keyed}, nulled(regenerate/re-upload)=${nulled}. ` +
        `Old values snapshotted in ${BACKUP_TABLE}.`,
    );
    logger.info(
      '[backfill] NULLed rows had no cloud object (asset only existed on dead local disk) — ' +
        'regenerate thumbnails/AI banners, re-upload user files/sim bundles. See the backup table for provenance.',
    );
  } catch (err) {
    logger.error({ err }, '[backfill] failed');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
