/**
 * Pure, testable helpers for the localhost-URL backfill (see backfill-localhost-urls.ts).
 * Kept separate so they can be unit-tested without running the migration's DB side effects.
 */

// A URL whose host is localhost/loopback or an internal Docker service name. Postgres
// regex string (used with `~*`) — valid cloud/public URLs never match, so they are safe.
export const NON_PUBLIC_SQL =
  '^https?://(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]|backend|worker|nginx|admin-web|client-web)([:/]|$)';

// JS mirror of NON_PUBLIC_SQL for in-code checks/tests.
export const nonPublicUrlRe =
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|backend|worker|nginx|admin-web|client-web)([:/]|$)/i;

export function isNonPublicUrl(url: string | null | undefined): boolean {
  return !!url && nonPublicUrlRe.test(url);
}

// Serve-route segments the backend uses; the storage key is everything after them.
const ROUTE_MARKERS = ['/sim-public/', '/local-storage/', '/hls-public/', '/video-raw/'];

/**
 * Extract the bare storage key from a backend serve URL, stripping the origin, the route
 * segment, and any leading media-token segment (`t/<token>/`). Returns null if the URL
 * doesn't contain a known serve route.
 */
export function keyFromUrl(url: string): string | null {
  for (const m of ROUTE_MARKERS) {
    const i = url.indexOf(m);
    if (i !== -1) {
      let key = url.slice(i + m.length);
      key = key.replace(/^t\/[^/]+\//, ''); // drop media-token segment if present
      try { key = decodeURIComponent(key); } catch { /* keep raw */ }
      return key.replace(/[?#].*$/, ''); // drop query/hash
    }
  }
  return null;
}

// ─── Safe-backfill contract (machine-readable plan + policy) ──────────────────────
//
// Every data repair runs as: PLAN (read-only classification of every affected row)
// → policy gate → APPLY (executes exactly the planned actions, with per-row backup).
// The plan/report shapes below are consumed by ops/release/database-url-audit.ts.

export type PlannedUrlAction = 'rewrite' | 'key' | 'null' | 'skip';

export interface PlannedUrlRow {
  /** table.column */
  target: string;
  rowId: string;
  oldValue: string;
  newValue: string | null;
  action: PlannedUrlAction;
  /** null = not applicable (no storage object involved). */
  assetExists: boolean | null;
}

export interface UrlBackfillPlanSummary {
  wouldRewrite: number;
  wouldKey: number;
  wouldNull: number;
  wouldSkip: number;
  missingAssets: number;
}

export function summarizePlan(rows: PlannedUrlRow[]): UrlBackfillPlanSummary {
  return {
    wouldRewrite: rows.filter((r) => r.action === 'rewrite').length,
    wouldKey: rows.filter((r) => r.action === 'key').length,
    wouldNull: rows.filter((r) => r.action === 'null').length,
    wouldSkip: rows.filter((r) => r.action === 'skip').length,
    missingAssets: rows.filter((r) => r.assetExists === false).length,
  };
}

export interface UrlBackfillPolicyResult {
  unsafe: boolean;
  reasons: string[];
}

/**
 * A backfill must BLOCK and request approval when rows would be nulled, referenced
 * assets are missing, or the affected-row count exceeds the configured ceiling.
 */
export function evaluateBackfillPolicy(
  summary: UrlBackfillPlanSummary,
  totalAffected: number,
  maxAffectedRows: number,
): UrlBackfillPolicyResult {
  const reasons: string[] = [];
  if (summary.wouldNull > 0) reasons.push(`${summary.wouldNull} row(s) would be NULLed (asset lost on dead local disk).`);
  if (summary.missingAssets > 0) reasons.push(`${summary.missingAssets} referenced object(s) missing from cloud storage.`);
  if (totalAffected > maxAffectedRows) reasons.push(`Affected rows (${totalAffected}) exceed the ceiling (${maxAffectedRows}).`);
  return { unsafe: reasons.length > 0, reasons };
}

export interface UrlBackfillReportJson {
  schema: 'flowvid.url-backfill-report/v1';
  runId: string;
  mode: 'report' | 'apply';
  generatedAt: string;
  targets: Array<{ target: string; affected: number }>;
  totalAffected: number;
  plan: UrlBackfillPlanSummary;
  policy: UrlBackfillPolicyResult;
  applied?: { rewritten: number; keyed: number; nulled: number; skipped: number };
  /** Re-count after apply — must be wouldSkip (ideally 0) when the repair converged. */
  postAffected?: number;
  backupTable: string;
  maxAffectedRows: number;
  /** Small per-target samples for the release plan (URLs here are the poisoned ones — not secrets). */
  samples: Array<{ target: string; rowId: string; oldValue: string; action: PlannedUrlAction }>;
}

export function buildBackfillReport(input: {
  runId: string;
  mode: 'report' | 'apply';
  generatedAt: string;
  targets: Array<{ target: string; affected: number }>;
  plannedRows: PlannedUrlRow[];
  maxAffectedRows: number;
  backupTable: string;
  applied?: { rewritten: number; keyed: number; nulled: number; skipped: number };
  postAffected?: number;
  samplesPerTarget?: number;
}): UrlBackfillReportJson {
  const totalAffected = input.targets.reduce((s, t) => s + t.affected, 0);
  const summary = summarizePlan(input.plannedRows);
  const perTarget = new Map<string, number>();
  const samples: UrlBackfillReportJson['samples'] = [];
  const cap = input.samplesPerTarget ?? 3;
  for (const row of input.plannedRows) {
    const n = perTarget.get(row.target) ?? 0;
    if (n < cap) {
      perTarget.set(row.target, n + 1);
      samples.push({ target: row.target, rowId: row.rowId, oldValue: row.oldValue, action: row.action });
    }
  }
  return {
    schema: 'flowvid.url-backfill-report/v1',
    runId: input.runId,
    mode: input.mode,
    generatedAt: input.generatedAt,
    targets: input.targets,
    totalAffected,
    plan: summary,
    policy: evaluateBackfillPolicy(summary, totalAffected, input.maxAffectedRows),
    ...(input.applied ? { applied: input.applied } : {}),
    ...(input.postAffected !== undefined ? { postAffected: input.postAffected } : {}),
    backupTable: input.backupTable,
    maxAffectedRows: input.maxAffectedRows,
    samples,
  };
}
