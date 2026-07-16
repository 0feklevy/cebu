import { describe, it, expect } from 'vitest';
import {
  buildBackfillReport,
  evaluateBackfillPolicy,
  isNonPublicUrl,
  keyFromUrl,
  summarizePlan,
  type PlannedUrlRow,
} from '../urlBackfill.js';

describe('isNonPublicUrl (migration match predicate)', () => {
  it('flags poisoned localhost/internal-host URLs that must be rewritten', () => {
    for (const u of [
      'http://localhost:8080/local-storage/playlist-banners/p/v/a.png',
      'http://localhost:8080/sim-public/simulations/p/v/index.html',
      'https://127.0.0.1/local-storage/thumbnails/x.png',
      'http://backend:8080/local-storage/images/y.png',
    ]) {
      expect(isNonPublicUrl(u)).toBe(true);
    }
  });

  it('LEAVES valid cloud + public-API URLs untouched (no blind rewrite)', () => {
    for (const u of [
      'https://abc123.supabase.co/storage/v1/object/public/media/thumbnails/x.png',
      'https://api.flowvidco.com/sim-public/simulations/p/v/index.html', // valid prod sim URL
      'https://cdn.example.com/a.png',
      'https://youtube.com/watch?v=abc', // user-entered external
    ]) {
      expect(isNonPublicUrl(u)).toBe(false);
    }
  });
});

describe('keyFromUrl (URL → storage key extraction)', () => {
  it('strips origin + serve route back to the bare key', () => {
    expect(keyFromUrl('http://localhost:8080/local-storage/thumbnails/p/v/a.png')).toBe('thumbnails/p/v/a.png');
    expect(keyFromUrl('http://localhost:8080/sim-public/simulations/p/v/index.html')).toBe('simulations/p/v/index.html');
  });

  it('strips a leading media-token segment', () => {
    expect(keyFromUrl('http://localhost:8080/hls-public/t/abc.def.ghi/hls/p/v/master.m3u8')).toBe('hls/p/v/master.m3u8');
    expect(keyFromUrl('http://localhost:8080/video-raw/t/tok/videos/v1.mp4')).toBe('videos/v1.mp4');
  });

  it('drops query/hash and decodes percent-encoding', () => {
    expect(keyFromUrl('http://localhost:8080/local-storage/images/a%20b.png?x=1#y')).toBe('images/a b.png');
  });

  it('returns null when no known serve route is present', () => {
    expect(keyFromUrl('https://youtube.com/watch?v=abc')).toBeNull();
  });
});

// ─── Safe-backfill contract ────────────────────────────────────────────────────────

const row = (target: string, action: PlannedUrlRow['action'], assetExists: boolean | null = true): PlannedUrlRow => ({
  target,
  rowId: 'id-1',
  oldValue: 'http://localhost:8080/local-storage/x.png',
  newValue: action === 'rewrite' ? 'https://cloud.example/x.png' : action === 'key' ? 'sims/x' : null,
  action,
  assetExists,
});

describe('summarizePlan / evaluateBackfillPolicy', () => {
  it('classifies rewritten, keyed, nulled, skipped, and missing assets', () => {
    const plan = [
      row('projects.thumbnail_url', 'rewrite'),
      row('playlists.banner_url', 'null', false),
      row('simulations.entry_file', 'key', false),
      row('timeline_sections.simulation_url', 'skip', null),
    ];
    expect(summarizePlan(plan)).toEqual({ wouldRewrite: 1, wouldKey: 1, wouldNull: 1, wouldSkip: 1, missingAssets: 2 });
  });

  it('safe plan (pure rewrites under threshold) does not require approval', () => {
    const summary = summarizePlan([row('projects.thumbnail_url', 'rewrite'), row('corpora.storage_url', 'rewrite')]);
    expect(evaluateBackfillPolicy(summary, 2, 50)).toEqual({ unsafe: false, reasons: [] });
  });

  it('blocks on nulled rows, missing assets, and threshold breaches', () => {
    const summary = summarizePlan([row('playlists.banner_url', 'null', false)]);
    const policy = evaluateBackfillPolicy(summary, 1, 50);
    expect(policy.unsafe).toBe(true);
    expect(policy.reasons.some((r) => r.includes('NULLed'))).toBe(true);
    expect(policy.reasons.some((r) => r.includes('missing'))).toBe(true);

    const big = evaluateBackfillPolicy(summarizePlan([row('projects.thumbnail_url', 'rewrite')]), 51, 50);
    expect(big.unsafe).toBe(true);
  });
});

describe('buildBackfillReport (machine-readable contract)', () => {
  it('produces the schema ops/release consumes, with per-target samples and run provenance', () => {
    const report = buildBackfillReport({
      runId: 'urlbf-test-1',
      mode: 'report',
      generatedAt: '2026-07-16T00:00:00.000Z',
      targets: [
        { target: 'projects.thumbnail_url', affected: 1 },
        { target: 'playlists.banner_url', affected: 1 },
      ],
      plannedRows: [row('projects.thumbnail_url', 'rewrite'), row('playlists.banner_url', 'null', false)],
      maxAffectedRows: 50,
      backupTable: '_url_backfill_backup',
    });
    expect(report.schema).toBe('flowvid.url-backfill-report/v1');
    expect(report.runId).toBe('urlbf-test-1');
    expect(report.totalAffected).toBe(2);
    expect(report.plan.wouldNull).toBe(1);
    expect(report.policy.unsafe).toBe(true);
    expect(report.backupTable).toBe('_url_backfill_backup');
    expect(report.samples).toHaveLength(2);
  });

  it('caps samples per target and records applied counts + convergence', () => {
    const rows = Array.from({ length: 10 }, () => row('projects.thumbnail_url', 'rewrite'));
    const report = buildBackfillReport({
      runId: 'urlbf-test-2',
      mode: 'apply',
      generatedAt: '2026-07-16T00:00:00.000Z',
      targets: [{ target: 'projects.thumbnail_url', affected: 10 }],
      plannedRows: rows,
      maxAffectedRows: 50,
      backupTable: '_url_backfill_backup',
      applied: { rewritten: 10, keyed: 0, nulled: 0, skipped: 0 },
      postAffected: 0,
    });
    expect(report.samples).toHaveLength(3);
    expect(report.applied).toEqual({ rewritten: 10, keyed: 0, nulled: 0, skipped: 0 });
    expect(report.postAffected).toBe(0);
  });
});
