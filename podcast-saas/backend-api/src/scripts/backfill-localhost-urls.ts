/**
 * backfill-localhost-urls — detect & repair browser-visible asset URLs that were
 * persisted with a non-public host (http://localhost:8080, 127.0.0.1, or an internal
 * Docker hostname) during the local-dev era / a misconfigured deploy.
 *
 * SAFE-BACKFILL CONTRACT (see also ops/release/database-url-audit.ts):
 *   1. PLAN — read-only: every affected row is classified (rewrite / key / null / skip)
 *      with a cloud-object existence check. Runs in BOTH modes.
 *   2. POLICY GATE — the apply step is refused (exit 2) when rows would be NULLed,
 *      referenced assets are missing, or the affected count exceeds --max-affected,
 *      unless --approve-unsafe records explicit human approval.
 *   3. APPLY — executes exactly the planned actions; before any write the old value is
 *      snapshotted into the backup table; afterwards the predicate is re-counted
 *      (postAffected) to prove convergence.
 *
 * Idempotent: the WHERE predicate only matches non-public hosts, so once a value is
 * rewritten to a cloud URL / NULL it is never touched again. Only the fixed column list
 * below is examined — never blind replacement inside arbitrary text or JSON.
 *
 *   Report:  tsx --env-file=../.env src/scripts/backfill-localhost-urls.ts
 *   Apply:   tsx --env-file=../.env src/scripts/backfill-localhost-urls.ts --apply
 *   Options: --json <path|->   machine-readable report (path, or sentinel block on stdout)
 *            --run-id <id>     stable run identifier (defaults to a timestamped id)
 *            --max-affected N  policy ceiling for auto-apply (default 50)
 *            --approve-unsafe  explicit approval for null/missing-asset/over-threshold plans
 *
 * Repair strategy per column (unchanged from the original incident repair):
 *   - key-backed (*_url has a sibling *_key): object exists in cloud → rewrite via the
 *     storage adapter; else NULL (a broken localhost URL is worse than a placeholder).
 *   - simulations.entry_file: strip back to the bare storage KEY (read-time resolver
 *     rebuilds the URL from the fixed API origin).
 *   - timeline_sections.simulation_url: recompute from the parent simulation (only rows
 *     with a simulation_id; user-entered external URLs untouched).
 *   - no-key columns (branch_edges.thumbnail_url): NULL the poisoned value.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';
import { logger } from '../lib/logger.js';
import {
  NON_PUBLIC_SQL as NON_PUBLIC,
  buildBackfillReport,
  evaluateBackfillPolicy,
  isNonPublicUrl,
  keyFromUrl,
  summarizePlan,
  type PlannedUrlRow,
  type UrlBackfillReportJson,
} from './lib/urlBackfill.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const APPROVE_UNSAFE = argv.includes('--approve-unsafe');
const argValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const RUN_ID = argValue('--run-id') ?? `urlbf-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const MAX_AFFECTED = Number(argValue('--max-affected') ?? '50');
const JSON_OUT = argValue('--json');

const BACKUP_TABLE = '_url_backfill_backup';
const JSON_SENTINEL_START = '---URL-BACKFILL-REPORT-JSON---';
const JSON_SENTINEL_END = '---END-URL-BACKFILL-REPORT-JSON---';

type KeyBacked = { table: string; urlCol: string; keyCol: string };
const KEY_BACKED: KeyBacked[] = [
  { table: 'projects', urlCol: 'thumbnail_url', keyCol: 'thumbnail_key' },
  { table: 'image_files', urlCol: 'original_url', keyCol: 'storage_key' },
  { table: 'audio_files', urlCol: 'url', keyCol: 'storage_key' },
  { table: 'playlists', urlCol: 'banner_url', keyCol: 'banner_storage_key' },
  { table: 'avatar_visuals', urlCol: 'image_url', keyCol: 'image_key' },
];

// Columns handled specially beyond the key-backed set.
const OTHER_COLUMNS: Array<{ table: string; col: string }> = [
  { table: 'simulations', col: 'entry_file' },
  { table: 'avatar_visuals', col: 'sim_entry_url' },
  { table: 'timeline_sections', col: 'simulation_url' },
  { table: 'corpora', col: 'storage_url' },
  { table: 'branch_edges', col: 'thumbnail_url' },
];

const ALL_TARGETS = [
  ...KEY_BACKED.map((k) => ({ table: k.table, col: k.urlCol })),
  ...OTHER_COLUMNS,
];

function emitJson(report: UrlBackfillReportJson): void {
  if (!JSON_OUT) return;
  const doc = JSON.stringify(report, null, 2);
  if (JSON_OUT === '-') {
    process.stdout.write(`\n${JSON_SENTINEL_START}\n${doc}\n${JSON_SENTINEL_END}\n`);
  } else {
    writeFileSync(JSON_OUT, doc + '\n');
    logger.info(`[backfill] JSON report written to ${JSON_OUT}`);
  }
}

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
    logger.info(`[backfill] run=${RUN_ID} mode=${APPLY ? 'APPLY' : 'REPORT (dry-run)'} max-affected=${MAX_AFFECTED}`);

    // ── 1. Count every target (always) ────────────────────────────────────────
    const targets: Array<{ target: string; affected: number }> = [];
    for (const t of ALL_TARGETS) {
      const [{ count }] = await q<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${t.table} WHERE ${t.col} ~* $1`,
        [NON_PUBLIC],
      );
      targets.push({ target: `${t.table}.${t.col}`, affected: count });
    }
    const total = targets.reduce((s, r) => s + r.affected, 0);
    console.table(targets);
    logger.info(`[backfill] total affected rows: ${total}`);

    // ── 2. PLAN — classify every affected row read-only ───────────────────────
    const plan: PlannedUrlRow[] = [];

    // 2a. Key-backed columns.
    for (const spec of KEY_BACKED) {
      const rows = await q<{ id: string; url: string; key: string | null }>(
        `SELECT id, ${spec.urlCol} AS url, ${spec.keyCol} AS key FROM ${spec.table} WHERE ${spec.urlCol} ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        const assetExists = r.key ? await exists(r.key) : false;
        const next = r.key && assetExists ? storage.getPublicUrl(r.key) : null;
        plan.push({
          target: `${spec.table}.${spec.urlCol}`,
          rowId: String(r.id),
          oldValue: r.url,
          newValue: next,
          action: next ? 'rewrite' : 'null',
          assetExists,
        });
      }
    }

    // 2b. simulations.entry_file → bare key.
    const plannedSimEntry = new Map<string, string>();
    {
      const rows = await q<{ id: string; entry_file: string }>(
        `SELECT id, entry_file FROM simulations WHERE entry_file ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        const key = keyFromUrl(r.entry_file);
        if (!key) {
          plan.push({
            target: 'simulations.entry_file', rowId: String(r.id), oldValue: r.entry_file,
            newValue: null, action: 'skip', assetExists: null,
          });
          continue;
        }
        const assetExists = await exists(key);
        if (!assetExists) logger.warn({ id: r.id, key }, '[backfill] sim bundle missing in cloud — key stored, re-upload needed');
        plannedSimEntry.set(String(r.id), key);
        plan.push({
          target: 'simulations.entry_file', rowId: String(r.id), oldValue: r.entry_file,
          newValue: key, action: 'key', assetExists,
        });
      }
    }

    // 2c. avatar_visuals.sim_entry_url → recompute from key.
    {
      const rows = await q<{ id: string; sim_entry_url: string; visual_spec: { entryKey?: string } | null }>(
        `SELECT id, sim_entry_url, visual_spec FROM avatar_visuals WHERE sim_entry_url ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        const key = r.visual_spec?.entryKey ?? keyFromUrl(r.sim_entry_url);
        const assetExists = key ? await exists(key) : false;
        const next = key && assetExists ? storage.getSimPublicUrl(key) : null;
        plan.push({
          target: 'avatar_visuals.sim_entry_url', rowId: String(r.id), oldValue: r.sim_entry_url,
          newValue: next, action: next ? 'rewrite' : 'null', assetExists,
        });
      }
    }

    // 2d. timeline_sections.simulation_url → recompute from the parent sim, honouring the
    // parent's OWN planned fix. Only FK-backed rows; never rewrite to a still-poisoned URL.
    {
      const rows = await q<{ id: string; simulation_url: string; simulation_id: string; entry_file: string | null }>(
        `SELECT ts.id, ts.simulation_url, ts.simulation_id, s.entry_file
           FROM timeline_sections ts JOIN simulations s ON s.id = ts.simulation_id
          WHERE ts.simulation_url ~* $1 AND ts.simulation_id IS NOT NULL`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        const ef = plannedSimEntry.get(String(r.simulation_id)) ?? r.entry_file;
        let next: string | null;
        let action: PlannedUrlRow['action'];
        let assetExists: boolean | null = null;
        if (!ef) {
          next = null; action = 'null';
        } else if (ef.startsWith('http')) {
          if (isNonPublicUrl(ef)) {
            // Parent sim is itself still poisoned and unrepairable — do NOT copy the poison.
            next = null; action = 'skip';
          } else {
            next = ef; action = 'rewrite';
          }
        } else {
          assetExists = await exists(ef);
          next = storage.getSimPublicUrl(ef); action = 'rewrite';
        }
        plan.push({
          target: 'timeline_sections.simulation_url', rowId: String(r.id), oldValue: r.simulation_url,
          newValue: next, action, assetExists,
        });
      }
    }

    // 2e. corpora.storage_url (no key column — parse key from URL).
    {
      const rows = await q<{ id: string; storage_url: string }>(
        `SELECT id, storage_url FROM corpora WHERE storage_url ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        const key = keyFromUrl(r.storage_url);
        const assetExists = key ? await exists(key) : false;
        const next = key && assetExists ? storage.getPublicUrl(key) : null;
        plan.push({
          target: 'corpora.storage_url', rowId: String(r.id), oldValue: r.storage_url,
          newValue: next, action: next ? 'rewrite' : 'null', assetExists,
        });
      }
    }

    // 2f. branch_edges.thumbnail_url (no key — null poisoned).
    {
      const rows = await q<{ id: string; thumbnail_url: string }>(
        `SELECT id, thumbnail_url FROM branch_edges WHERE thumbnail_url ~* $1`,
        [NON_PUBLIC],
      );
      for (const r of rows) {
        plan.push({
          target: 'branch_edges.thumbnail_url', rowId: String(r.id), oldValue: r.thumbnail_url,
          newValue: null, action: 'null', assetExists: null,
        });
      }
    }

    const summary = summarizePlan(plan);
    const policy = evaluateBackfillPolicy(summary, total, MAX_AFFECTED);
    logger.info(
      `[backfill] plan: rewrite=${summary.wouldRewrite} key=${summary.wouldKey} null=${summary.wouldNull} ` +
        `skip=${summary.wouldSkip} missing-assets=${summary.missingAssets} unsafe=${policy.unsafe}`,
    );
    for (const reason of policy.reasons) logger.warn(`[backfill] policy: ${reason}`);

    const now = new Date().toISOString();

    // ── 3. REPORT mode stops here ─────────────────────────────────────────────
    if (!APPLY) {
      emitJson(buildBackfillReport({
        runId: RUN_ID, mode: 'report', generatedAt: now, targets, plannedRows: plan,
        maxAffectedRows: MAX_AFFECTED, backupTable: BACKUP_TABLE,
      }));
      logger.info('[backfill] REPORT only — re-run with --apply to repair. No data changed.');
      return;
    }
    if (total === 0) {
      emitJson(buildBackfillReport({
        runId: RUN_ID, mode: 'apply', generatedAt: now, targets, plannedRows: plan,
        maxAffectedRows: MAX_AFFECTED, backupTable: BACKUP_TABLE,
        applied: { rewritten: 0, keyed: 0, nulled: 0, skipped: 0 }, postAffected: 0,
      }));
      logger.info('[backfill] nothing to repair.');
      return;
    }

    // ── 4. POLICY GATE — unsafe plans need explicit approval ─────────────────
    if (policy.unsafe && !APPROVE_UNSAFE) {
      emitJson(buildBackfillReport({
        runId: RUN_ID, mode: 'report', generatedAt: now, targets, plannedRows: plan,
        maxAffectedRows: MAX_AFFECTED, backupTable: BACKUP_TABLE,
      }));
      logger.error('[backfill] BLOCKED — the plan is unsafe and --approve-unsafe was not given. No data changed.');
      process.exitCode = 2;
      return;
    }

    // ── 5. Backup table (idempotent create) ───────────────────────────────────
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
        target text NOT NULL,
        row_id text NOT NULL,
        old_value text,
        new_value text,
        run_id text,
        backed_up_at timestamptz NOT NULL DEFAULT now()
      )`);
    // run_id column for provenance (added by this contract; tolerate pre-existing table).
    await sql.unsafe(`ALTER TABLE ${BACKUP_TABLE} ADD COLUMN IF NOT EXISTS run_id text`);

    const backup = async (target: string, id: string, oldV: string | null, newV: string | null) => {
      await sql.unsafe(
        `INSERT INTO ${BACKUP_TABLE} (target, row_id, old_value, new_value, run_id) VALUES ($1,$2,$3,$4,$5)`,
        [target, id, oldV, newV, RUN_ID],
      );
    };

    // ── 6. APPLY — execute exactly the planned actions ────────────────────────
    let rewritten = 0, nulled = 0, keyed = 0, skipped = 0;
    for (const row of plan) {
      if (row.action === 'skip') { skipped++; continue; }
      const [table, col] = row.target.split('.');
      await backup(row.target, row.rowId, row.oldValue, row.newValue);
      await sql.unsafe(`UPDATE ${table} SET ${col} = $1 WHERE id = $2`, [row.newValue, row.rowId]);
      if (row.action === 'key') keyed++;
      else if (row.newValue !== null) rewritten++;
      else nulled++;
    }

    // ── 7. Post-apply convergence check ───────────────────────────────────────
    let postAffected = 0;
    for (const t of ALL_TARGETS) {
      const [{ count }] = await q<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${t.table} WHERE ${t.col} ~* $1`,
        [NON_PUBLIC],
      );
      postAffected += count;
    }

    emitJson(buildBackfillReport({
      runId: RUN_ID, mode: 'apply', generatedAt: new Date().toISOString(), targets, plannedRows: plan,
      maxAffectedRows: MAX_AFFECTED, backupTable: BACKUP_TABLE,
      applied: { rewritten, keyed, nulled, skipped }, postAffected,
    }));

    logger.info(
      `[backfill] DONE — rewritten-to-cloud=${rewritten}, keyed(sim)=${keyed}, nulled(regenerate/re-upload)=${nulled}, ` +
        `skipped=${skipped}, post-apply affected=${postAffected}. Old values snapshotted in ${BACKUP_TABLE} (run ${RUN_ID}).`,
    );
    if (nulled > 0) {
      logger.info(
        '[backfill] NULLed rows had no cloud object (asset only existed on dead local disk) — ' +
          'regenerate thumbnails/AI banners, re-upload user files/sim bundles. See the backup table for provenance.',
      );
    }
    if (postAffected > skipped) {
      logger.error(`[backfill] post-apply audit still finds ${postAffected} affected row(s) — investigate before rerunning.`);
      process.exitCode = 1;
    }
  } catch (err) {
    logger.error({ err }, '[backfill] failed');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main();
