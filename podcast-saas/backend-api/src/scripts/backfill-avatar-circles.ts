/**
 * Backfill: repair persisted avatar-circles config so speaker waves map correctly.
 *
 * Fixes the same data the read-path now self-heals (buildPlayerConfig → normalizeAvatarCircles),
 * but PERSISTS it so the stored rows are correct too. Two repairs:
 *   • faces        — a degenerate speaker→circle mapping (both circles same speaker/side,
 *                    count/faces mismatch) — the likely cause of the reported broken waves.
 *   • manualSections — clamp/sort/de-overlap.
 * Projects that use the manual/always circle layers but have ZERO scenes (uploaded videos with
 * no script) are REPORTED as 'no-speaker-source' and NOT touched — there is no speaker data to
 * repair; those need the (separate) diarization follow-up.
 *
 *   Report (dry-run, default):  tsx --env-file=../.env src/scripts/backfill-avatar-circles.ts
 *   Apply:                      tsx --env-file=../.env src/scripts/backfill-avatar-circles.ts --apply
 *   Flags: --max-affected N (default 200)  --run-id ID  --json path.json
 *
 * Safe by construction: report-first; --apply snapshots each old avatar_config into
 * _avatar_circles_backfill_backup before writing; idempotent (a normalized row is skipped);
 * refuses to apply beyond --max-affected without --approve-unsafe.
 *
 * Run in a maintenance window (or when avatar settings aren't being edited): --apply has no
 * optimistic-lock guard, so a concurrent PUT /avatar/config between the read (plan) and the
 * write (apply) would be overwritten. The backup table holds the plan-time value for recovery.
 */
import { randomUUID } from 'node:crypto';
import { positiveIntArg } from './argGuards.js';
import { writeFileSync } from 'node:fs';
import postgres from 'postgres';
import { logger } from '../lib/logger.js';
import {
  classifyAvatarCircles,
  normalizeAvatarCircles,
  type AvatarCirclesLike,
} from '../services/avatarCircles/normalizeAvatarCircles.js';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const APPROVE_UNSAFE = argv.includes('--approve-unsafe');
const argValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const RUN_ID = argValue('--run-id') ?? `circbf-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
// NOT `Number(argValue(...))` — that reads `--max-affected --apply` as NaN and the ceiling
// test `total > NaN` is false, so a typo DISARMS the guard instead of failing the run
// (scripts-ship-010). `positiveIntArg` refuses anything it cannot read.
const MAX_AFFECTED = positiveIntArg(argv, '--max-affected', 200);
const JSON_OUT = argValue('--json');
const BACKUP_TABLE = '_avatar_circles_backfill_backup';

type Action = 'ok' | 'repair-faces' | 'repair-sections' | 'repair-both' | 'no-speaker-source';
interface PlannedRow {
  projectId: string;
  title: string | null;
  action: Action;
  /** Uses a manual/always circle layer but has ZERO scenes → no speaker data to attribute.
   *  Tracked independently of `action` so a project that ALSO needs a faces/section repair
   *  is still surfaced (a repair doesn't invent a speaker source). */
  noSpeakerSource: boolean;
  oldConfig: string;   // JSON string of the full avatar_config (for backup)
  newConfig: string | null;   // JSON string to write, or null when nothing to write
}

/** avatar_config may be a jsonb object or (legacy) a double-encoded JSON string. */
function parseAvatarConfig(raw: unknown): { obj: Record<string, unknown>; circles: AvatarCirclesLike } | null {
  let v: unknown = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const obj = v as Record<string, unknown>;
  const circles = obj.avatarCircles;
  if (!circles || typeof circles !== 'object' || Array.isArray(circles)) return null;
  return { obj, circles: circles as AvatarCirclesLike };
}

function emitJson(report: unknown): void {
  const line = JSON.stringify(report);
  if (JSON_OUT) writeFileSync(JSON_OUT, line + '\n');
  process.stdout.write(`---AVATAR-CIRCLES-BACKFILL-JSON---\n${line}\n---END-AVATAR-CIRCLES-BACKFILL-JSON---\n`);
}

async function main() {
  const connectionString = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas';
  const sql = postgres(connectionString, { max: 4 });
  const q = <T>(text: string, params: Array<string | number | null> = []): Promise<T[]> =>
    sql.unsafe(text, params as string[]) as unknown as Promise<T[]>;

  try {
    logger.info(`[circles-backfill] run=${RUN_ID} mode=${APPLY ? 'APPLY' : 'REPORT (dry-run)'} max-affected=${MAX_AFFECTED}`);

    // ── 1. PLAN — classify every project with an avatarCircles config (read-only) ──
    const rows = await q<{ id: string; title: string | null; avatar_config: unknown; scene_count: number }>(
      `SELECT p.id, p.title, p.avatar_config,
              (SELECT count(*)::int FROM scenes s WHERE s.project_id = p.id) AS scene_count
         FROM projects p
        WHERE p.avatar_config IS NOT NULL`,
    );

    const plan: PlannedRow[] = [];
    for (const r of rows) {
      const parsed = parseAvatarConfig(r.avatar_config);
      if (!parsed) continue; // no avatarCircles on this project
      const { obj, circles } = parsed;
      const cls = classifyAvatarCircles(circles);
      // A manual/always project with no scenes has no speaker to attribute — flag it EVEN when
      // it also needs a faces/section repair (the repair can't create speaker data).
      const noSpeakerSource = cls.usesManualLayer && r.scene_count === 0;

      if (!cls.facesRepaired && !cls.sectionsRepaired) {
        if (noSpeakerSource) {
          plan.push({ projectId: r.id, title: r.title, action: 'no-speaker-source', noSpeakerSource, oldConfig: JSON.stringify(r.avatar_config), newConfig: null });
        }
        continue;
      }

      const nextCircles = normalizeAvatarCircles(circles);
      const nextConfig = { ...obj, avatarCircles: nextCircles };
      const action: Action = cls.facesRepaired && cls.sectionsRepaired ? 'repair-both' : cls.facesRepaired ? 'repair-faces' : 'repair-sections';
      plan.push({ projectId: r.id, title: r.title, action, noSpeakerSource, oldConfig: JSON.stringify(r.avatar_config), newConfig: JSON.stringify(nextConfig) });
    }

    const repairs = plan.filter((p) => p.newConfig !== null);
    const noSpeakerSourceCount = plan.filter((p) => p.noSpeakerSource).length;
    const byAction = plan.reduce<Record<string, number>>((acc, p) => { acc[p.action] = (acc[p.action] ?? 0) + 1; return acc; }, {});
    console.table(plan.map((p) => ({ project: p.projectId.slice(0, 8), title: (p.title ?? '').slice(0, 40), action: p.action, noSpeaker: p.noSpeakerSource })));
    logger.info(`[circles-backfill] projects scanned=${rows.length} repairs=${repairs.length} no-speaker-source=${noSpeakerSourceCount} ${JSON.stringify(byAction)}`);

    // ── 2. REPORT mode stops here ─────────────────────────────────────────────────
    if (!APPLY) {
      emitJson({ runId: RUN_ID, mode: 'report', scanned: rows.length, repairs: repairs.length, noSpeakerSourceCount, byAction, backupTable: BACKUP_TABLE, plan: plan.map((p) => ({ projectId: p.projectId, title: p.title, action: p.action, noSpeakerSource: p.noSpeakerSource })) });
      logger.info('[circles-backfill] REPORT only — re-run with --apply to persist repairs. No data changed.');
      return;
    }

    // ── 3. Policy gate ────────────────────────────────────────────────────────────
    if (repairs.length > MAX_AFFECTED && !APPROVE_UNSAFE) {
      emitJson({ runId: RUN_ID, mode: 'blocked', scanned: rows.length, repairs: repairs.length, byAction, reason: `repairs (${repairs.length}) exceed --max-affected (${MAX_AFFECTED})` });
      logger.error(`[circles-backfill] BLOCKED: ${repairs.length} repairs exceed --max-affected=${MAX_AFFECTED}. Re-run with --approve-unsafe to override.`);
      process.exitCode = 2;
      return;
    }

    // ── 4. APPLY — snapshot then write ────────────────────────────────────────────
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
        id bigserial PRIMARY KEY,
        project_id text NOT NULL,
        old_config jsonb,
        new_config jsonb,
        run_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    let applied = 0;
    for (const p of repairs) {
      await q(`INSERT INTO ${BACKUP_TABLE} (project_id, old_config, new_config, run_id) VALUES ($1,$2,$3,$4)`,
        [p.projectId, p.oldConfig, p.newConfig, RUN_ID]);
      await q(`UPDATE projects SET avatar_config = $1::jsonb, updated_at = now() WHERE id = $2`,
        [p.newConfig, p.projectId]);
      applied++;
    }

    // ── 5. Re-count to prove convergence (idempotent) ─────────────────────────────
    const after = await q<{ id: string; avatar_config: unknown }>(
      `SELECT id, avatar_config FROM projects WHERE id = ANY($1)`,
      [`{${repairs.map((p) => p.projectId).join(',')}}`],
    );
    const stillDirty = after.filter((r) => {
      const parsed = parseAvatarConfig(r.avatar_config);
      if (!parsed) return false;
      const cls = classifyAvatarCircles(parsed.circles);
      return cls.facesRepaired || cls.sectionsRepaired;
    }).length;

    emitJson({ runId: RUN_ID, mode: 'apply', scanned: rows.length, applied, stillDirty, byAction, backupTable: BACKUP_TABLE });
    logger.info(`[circles-backfill] APPLIED ${applied} repair(s); post-apply still-dirty=${stillDirty}. Old configs snapshotted in ${BACKUP_TABLE} (run ${RUN_ID}).`);
    if (stillDirty > 0) { logger.error('[circles-backfill] some rows did not converge — inspect the backup table.'); process.exitCode = 3; }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => { logger.error({ err }, '[circles-backfill] failed'); process.exit(1); });
