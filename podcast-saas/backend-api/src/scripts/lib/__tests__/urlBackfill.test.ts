import { describe, it, expect } from 'vitest';
import {
  avatarConfigStillPoisoned,
  buildBackfillReport,
  evaluateBackfillPolicy,
  isNonPublicUrl,
  keyFromUrl,
  planCircleFaceRepair,
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

// ── The JSON-embedded target: what the backfill would actually DO to the poisoned row ──
//
// These exercise the exact decision the script makes per `projects` row — target naming,
// rewrite-vs-null classification, and the payload it would write — with the storage lookup
// stubbed. Without this, only the primitives were covered and the wiring was not.
describe('planCircleFaceRepair (projects.avatar_config → avatarCircles.faces[].imageUrl)', () => {
  const PROJECT = '431df510-45e5-4d4b-9750-87ed723776ba';
  const KEY = `avatar-circles/${PROJECT}/4829af92-9757-4d4c-842e-8adc6bdaf763.png`;
  const POISONED = `http://localhost:8080/local-storage/${KEY}`;
  const PUBLIC = `https://abc123ref.supabase.co/storage/v1/object/public/media/${KEY}`;

  const config = () => ({
    avatarCircles: {
      enabled: true, visibility: 'always', count: 1,
      faces: [{ speaker: 'host_a', side: 'left', label: 'hey hey', imageUrl: POISONED }],
    },
  });
  /** Production holds this column double-encoded — a jsonb STRING, not an object. */
  const storedAsProduction = () => JSON.stringify(config());
  const found = async () => ({ newValue: PUBLIC, assetExists: true });
  const missing = async () => ({ newValue: null, assetExists: false });

  it('plans ONE rewrite for the poisoned face, named by its JSON path', async () => {
    const repair = await planCircleFaceRepair(PROJECT, storedAsProduction(), found);
    expect(repair?.rows).toEqual([{
      target: 'projects.avatar_config#avatarCircles.faces[0].imageUrl',
      rowId: PROJECT,
      oldValue: POISONED,
      newValue: PUBLIC,
      action: 'rewrite',
      assetExists: true,
      jsonPath: 'avatarCircles.faces[0].imageUrl',
    }]);
  });

  it('writes back a jsonb STRING for a string-shaped row — the no-op a path update would be', async () => {
    const repair = await planCircleFaceRepair(PROJECT, storedAsProduction(), found);
    const stored = JSON.parse(repair!.payload) as unknown;
    expect(typeof stored).toBe('string'); // still double-encoded, as it was found
    expect(JSON.parse(stored as string)).toEqual({
      avatarCircles: { ...config().avatarCircles, faces: [{ speaker: 'host_a', side: 'left', label: 'hey hey', imageUrl: PUBLIC }] },
    });
  });

  it('writes back an OBJECT for an object-shaped row', async () => {
    const repair = await planCircleFaceRepair(PROJECT, config(), found);
    expect(JSON.parse(repair!.payload)).toBeTypeOf('object');
    expect(JSON.parse(repair!.payload).avatarCircles.faces[0].imageUrl).toBe(PUBLIC);
  });

  it('a missing object becomes a NULL action — which the policy gate then refuses to auto-apply', async () => {
    const repair = await planCircleFaceRepair(PROJECT, storedAsProduction(), missing);
    expect(repair!.rows[0]).toMatchObject({ action: 'null', newValue: null, assetExists: false });
    expect(evaluateBackfillPolicy(summarizePlan(repair!.rows), 1, 50).unsafe).toBe(true);
    // …and it clears only the picture.
    const document = JSON.parse(JSON.parse(repair!.payload) as string);
    expect(document.avatarCircles.faces[0]).toEqual({ speaker: 'host_a', side: 'left', label: 'hey hey' });
  });

  it('plans nothing for a healthy row, a row with no circles, or a non-JSON column', async () => {
    const healthy = { avatarCircles: { count: 1, faces: [{ speaker: 'host_a', side: 'left', imageUrl: PUBLIC }] } };
    expect(await planCircleFaceRepair(PROJECT, healthy, found)).toBeNull();
    expect(await planCircleFaceRepair(PROJECT, { characterId: 'einstein' }, found)).toBeNull();
    expect(await planCircleFaceRepair(PROJECT, null, found)).toBeNull();
    expect(await planCircleFaceRepair(PROJECT, 'not json at all', found)).toBeNull();
  });

  it('converges: the repaired value no longer counts as poisoned', async () => {
    expect(avatarConfigStillPoisoned(storedAsProduction())).toBe(true);
    const repair = await planCircleFaceRepair(PROJECT, storedAsProduction(), found);
    expect(avatarConfigStillPoisoned(JSON.parse(repair!.payload))).toBe(false);
  });
});
