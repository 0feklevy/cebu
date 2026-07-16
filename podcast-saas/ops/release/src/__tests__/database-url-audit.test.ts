import { describe, expect, it } from 'vitest';
import { auditDatabaseUrls, parseBackfillReport, type UrlBackfillReport } from '../database-url-audit.js';

/** The real July 2026 incident shape: 8 poisoned rows, 6 rewritable, 2 null-only. */
const INCIDENT: UrlBackfillReport = {
  schema: 'flowvid.url-backfill-report/v1',
  runId: 'backfill-20260715-1',
  mode: 'report',
  targets: [
    { target: 'projects.thumbnail_url', affected: 1 },
    { target: 'playlists.banner_url', affected: 1 },
    { target: 'avatar_visuals.sim_entry_url', affected: 3 },
    { target: 'timeline_sections.simulation_url', affected: 3 },
  ],
  totalAffected: 8,
  plan: { wouldRewrite: 6, wouldKey: 0, wouldNull: 2, missingAssets: 2 },
  backupTable: '_url_backfill_backup',
  maxAffectedRows: 50,
};

const CLEAN: UrlBackfillReport = {
  ...INCIDENT,
  targets: INCIDENT.targets.map((t) => ({ ...t, affected: 0 })),
  totalAffected: 0,
  plan: { wouldRewrite: 0, wouldKey: 0, wouldNull: 0, missingAssets: 0 },
};

describe('auditDatabaseUrls', () => {
  it('zero affected rows → no findings, nothing to do (post-repair steady state)', () => {
    const res = auditDatabaseUrls(CLEAN, 'allow-safe', 50);
    expect(res.findings).toEqual([]);
    expect(res.decision).toBe('no-action-needed');
  });

  it('detects the incident recurrence and requires approval when rows would be nulled', () => {
    const res = auditDatabaseUrls(INCIDENT, 'allow-safe', 50);
    expect(res.findings.some((f) => f.id === 'db-urls.non-public-rows' && f.severity === 'HIGH')).toBe(true);
    expect(res.findings.some((f) => f.id === 'db-urls.would-null')).toBe(true);
    expect(res.findings.some((f) => f.id === 'db-urls.missing-assets')).toBe(true);
    expect(res.decision).toBe('requires-approval');
  });

  it('allow-safe permits apply only for fully-safe rewrites', () => {
    const safe: UrlBackfillReport = {
      ...INCIDENT,
      totalAffected: 3,
      plan: { wouldRewrite: 3, wouldKey: 0, wouldNull: 0, missingAssets: 0 },
    };
    expect(auditDatabaseUrls(safe, 'allow-safe', 50).decision).toBe('apply-allowed');
    expect(auditDatabaseUrls(safe, 'require-approval', 50).decision).toBe('requires-approval');
    expect(auditDatabaseUrls(safe, 'report-only', 50).decision).toBe('report-only');
  });

  it('blocks when the affected-row count exceeds the configured threshold', () => {
    const big: UrlBackfillReport = {
      ...INCIDENT,
      totalAffected: 51,
      plan: { wouldRewrite: 51, wouldKey: 0, wouldNull: 0, missingAssets: 0 },
    };
    const res = auditDatabaseUrls(big, 'allow-safe', 50);
    expect(res.findings.some((f) => f.id === 'db-urls.threshold-exceeded')).toBe(true);
    expect(res.decision).toBe('requires-approval');
  });

  it('blocks when rollback provenance (backup table) is missing', () => {
    const noBackup = { ...INCIDENT, plan: { wouldRewrite: 8, wouldKey: 0, wouldNull: 0, missingAssets: 0 }, backupTable: undefined };
    const res = auditDatabaseUrls(noBackup, 'allow-safe', 50);
    expect(res.findings.some((f) => f.id === 'db-urls.no-backup-provenance')).toBe(true);
    expect(res.decision).toBe('requires-approval');
  });

  it('parses only its own schema', () => {
    expect(() => parseBackfillReport('{"schema":"x"}')).toThrow(/schema/);
    expect(parseBackfillReport(JSON.stringify(INCIDENT)).totalAffected).toBe(8);
  });
});
