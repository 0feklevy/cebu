/**
 * Pure, testable helpers for the localhost-URL backfill (see backfill-localhost-urls.ts).
 * Kept separate so they can be unit-tested without running the migration's DB side effects.
 */
import {
  circlesOf,
  nonPublicCircleFaceUrls,
  parseAvatarConfigColumn,
  serializeAvatarConfigColumn,
  withCircleFaceUrls,
} from '../../services/avatarCircles/circleFaceUrls.js';

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
  /** table.column, plus `#<json path>` when the URL is embedded in a JSON document. */
  target: string;
  rowId: string;
  oldValue: string;
  newValue: string | null;
  action: PlannedUrlAction;
  /** null = not applicable (no storage object involved). */
  assetExists: boolean | null;
  /**
   * Set when this URL lives INSIDE a JSON column at the named path (e.g.
   * `avatarCircles.faces[0].imageUrl`). Such a row is written by re-serializing the whole
   * document in the shape it was read in — never by assigning to the column — so the apply
   * step routes it separately. Absent for ordinary `SET col = value` targets.
   */
  jsonPath?: string;
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

// ─── JSON-embedded target: projects.avatar_config → avatarCircles.faces[].imageUrl ───────
//
// The one browser-visible URL this product stores inside a JSON document rather than a column,
// and therefore the one the fixed column list could never reach. The whole per-row decision lives
// here — target naming, rewrite-vs-null classification, and the shape-preserving payload — so the
// repair the script would actually perform is unit-testable without a database.

/** What the caller's storage lookup concluded about one poisoned URL. */
export interface CircleFaceResolution {
  /** The URL to write, or null to clear this one field (the object is gone or unaddressable). */
  newValue: string | null;
  /** null = no key could be derived from the URL, so no existence question was asked. */
  assetExists: boolean | null;
}

export interface CircleFaceRepair {
  /** One planned row per poisoned face URL, classified exactly like every column target. */
  rows: PlannedUrlRow[];
  /** The literal jsonb text to write back, in the SHAPE the column was read in. */
  payload: string;
}

/**
 * The complete repair for ONE `projects` row, or null when the row holds nothing to repair.
 *
 * `resolve` performs the IO (derive key → objectExists → public URL); everything else is decided
 * here. Preserving the column's shape is the point: production stores this column double-encoded,
 * as a jsonb *string*, and a repair that writes an object back would change how project
 * duplication treats the row while looking like a clean fix.
 */
export async function planCircleFaceRepair(
  rowId: string,
  avatarConfig: unknown,
  resolve: (url: string) => Promise<CircleFaceResolution>,
): Promise<CircleFaceRepair | null> {
  const parsed = parseAvatarConfigColumn(avatarConfig);
  if (!parsed) return null;
  const sites = nonPublicCircleFaceUrls(circlesOf(parsed.config));
  if (sites.length === 0) return null;

  const rows: PlannedUrlRow[] = [];
  const resolutions = new Map<number, string | null>();
  for (const site of sites) {
    const { newValue, assetExists } = await resolve(site.url);
    resolutions.set(site.faceIndex, newValue);
    rows.push({
      target: `projects.avatar_config#${site.path}`,
      rowId,
      oldValue: site.url,
      newValue,
      action: newValue ? 'rewrite' : 'null',
      assetExists,
      jsonPath: site.path,
    });
  }
  return {
    rows,
    payload: serializeAvatarConfigColumn(withCircleFaceUrls(parsed.config, resolutions), parsed.shape),
  };
}

/** True when this stored avatar_config still holds a non-public face URL (post-apply convergence). */
export function avatarConfigStillPoisoned(avatarConfig: unknown): boolean {
  const parsed = parseAvatarConfigColumn(avatarConfig);
  return !!parsed && nonPublicCircleFaceUrls(circlesOf(parsed.config)).length > 0;
}
