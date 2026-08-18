/**
 * runVideoTranscode's retirement + pointer-flip ordering (P0.3), on a real Postgres engine.
 *
 * Three claims are pinned here:
 *  1. A successful re-transcode RETIRES the previous versioned tree (an INSERT into
 *     hls_retired_runs) instead of deleting it from storage on the next microtask —
 *     deleteWithPrefixFallback must not be called at all on this path any more.
 *  2. A transcode failure (e.g. the conformance gate throwing) happens BEFORE the DB
 *     pointer flips: hls_master_key keeps pointing at the old, complete tree, the row is
 *     marked failed, and the OLD tree is not retired — it must outlive the failed attempt.
 *  3. A failure that happens AFTER the transcoder began writing under this run's prefix
 *     cleans up after ITSELF: the partial run tree is queued for deletion, and the early
 *     playback pointer this run published (hls_360p_key) is cleared — so a failure neither
 *     leaks a run tree forever nor leaves a URL aimed into an abandoned run (media-006).
 *
 * The transcoder itself is mocked (its conformance behaviour has its own suites); the
 * database is real PGlite with every migration applied, because the retirement insert and
 * the pointer flip are exactly the kind of SQL a hand-faked db would vacuously pass.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../db/schema.js';

const h = vi.hoisted(() => ({
  dbRef: { current: null as unknown as Record<string, unknown> },
  transcode: vi.fn(),
  deletePrefix: vi.fn(async (_prefix: string) => {}),
}));

vi.mock('../../../db/index.js', async (importOriginal) => {
  // Real schema exports (runVideoTranscode imports `video_files` from db/index.js), fake db.
  const actualSchema = await vi.importActual<typeof import('../../../db/schema.js')>('../../../db/schema.js');
  void importOriginal; // the real module would open a postgres connection — never import it
  return {
    ...actualSchema,
    db: new Proxy({} as Record<string, unknown>, {
      get: (_t, prop: string) => {
        const target = h.dbRef.current as Record<string, unknown>;
        const v = target[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }),
  };
});

vi.mock('../HLSTranscoder.js', () => ({
  transcodeToHLS: h.transcode,
  extractWaveformPeaks: vi.fn(async () => []),
}));
vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPresignedDownloadUrl: vi.fn(async () => 'http://dl.test/source'),
  }),
}));
vi.mock('../../../lib/fetchWithRetry.js', () => ({
  // A fresh body stream per call — pipeline consumes it.
  fetchWithRetry: vi.fn(async () => ({ ok: true, body: Readable.from(['source-bytes']) })),
}));
vi.mock('../../storage/deleteWithFallback.js', () => ({
  deleteWithFallback: vi.fn(async () => {}),
  deleteWithPrefixFallback: (prefix: string) => h.deletePrefix(prefix),
}));
vi.mock('../../crop/runCropAnalysis.js', () => ({ enqueueCropForProject: vi.fn(async () => {}) }));
vi.mock('../../captions/CaptionService.js', () => ({ enqueueCaptionsForProject: vi.fn(async () => {}) }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runVideoTranscode } from '../runVideoTranscode.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

let pg: PGlite;
let vfId: string;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;

  const [org] = await rows<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const [proj] = await rows<{ id: string }>(
    `INSERT INTO projects (org_id, title) VALUES ($1, 'P') RETURNING id`, [org!.id]);

  vfId = randomUUID();
  await pg.query(
    `INSERT INTO video_files (id, project_id, filename, storage_key, status, hls_status, hls_master_key)
     VALUES ($1, $2, 'v.mp4', 'videos/p/src.mp4', 'ready', 'ready', $3)`,
    [vfId, proj!.id, `hls/${vfId}/oldrun/master.m3u8`],
  );

  h.transcode.mockReset();
  h.deletePrefix.mockClear();
});

afterEach(async () => {
  await pg.close();
  vi.clearAllMocks();
});

type VideoRow = { hls_status: string; hls_master_key: string | null; hls_error: string | null };
const videoRow = async (): Promise<VideoRow> =>
  (await rows<VideoRow>('SELECT hls_status, hls_master_key, hls_error FROM video_files WHERE id = $1', [vfId]))[0]!;

describe('runVideoTranscode retention + ordering', () => {
  it('on success: flips the pointer, RETIRES the old tree (insert), and never deletes storage inline', async () => {
    h.transcode.mockImplementation(async (opts: { storageKeyPrefix: string }) => ({
      masterKey: `${opts.storageKeyPrefix}/master.m3u8`,
      durationSec: 42,
    }));

    const before = Date.now();
    const { hls_master_key } = await runVideoTranscode(vfId);

    // Pointer flipped to the NEW versioned tree.
    const row = await videoRow();
    expect(row.hls_status).toBe('ready');
    expect(row.hls_master_key).toBe(hls_master_key);
    expect(hls_master_key).toMatch(new RegExp(`^hls/${vfId}/[a-z0-9]+/master\\.m3u8$`));
    expect(hls_master_key).not.toContain('/oldrun/');

    // The old tree is RECORDED for grace-period deletion…
    const retired = await rows<{ video_file_id: string; prefix: string; retire_after: string | Date; deleted_at: unknown }>(
      'SELECT video_file_id, prefix, retire_after, deleted_at FROM hls_retired_runs',
    );
    expect(retired).toHaveLength(1);
    expect(retired[0]!.video_file_id).toBe(vfId);
    expect(retired[0]!.prefix).toBe(`hls/${vfId}/oldrun`);
    expect(retired[0]!.deleted_at).toBeNull();
    // …due no sooner than the default 24h grace (minus test slack).
    const retireAfter = new Date(retired[0]!.retire_after as string).getTime();
    expect(retireAfter).toBeGreaterThanOrEqual(before + 23.9 * 3_600_000);
    expect(retireAfter).toBeLessThanOrEqual(Date.now() + 24.1 * 3_600_000);

    // …and NOT deleted inline. This is the regression this suite exists to catch.
    expect(h.deletePrefix).not.toHaveBeenCalled();
  });

  it('on failure: the pointer NEVER flips, the row is marked failed, and nothing is retired', async () => {
    h.transcode.mockRejectedValue(new Error(
      'HLS conformance (360p): encoded as Main@L31 but the tier matrix requires baseline@L30 — seg_000.ts',
    ));

    await expect(runVideoTranscode(vfId)).rejects.toThrow(/HLS conformance \(360p\)/);

    const row = await videoRow();
    expect(row.hls_status).toBe('failed');
    expect(row.hls_error).toContain('HLS conformance (360p)');
    // The pointer still names the old, complete tree — viewers keep a working video.
    expect(row.hls_master_key).toBe(`hls/${vfId}/oldrun/master.m3u8`);

    // A failed run retires nothing and deletes nothing: the old tree must survive.
    expect(await rows('SELECT 1 FROM hls_retired_runs')).toHaveLength(0);
    expect(h.deletePrefix).not.toHaveBeenCalled();
  });

  it('on failure AFTER a tier was written: retires the PARTIAL run tree and clears its 360p pointer', async () => {
    // The real shape of the leak (media-006): 360p passes, uploads, and publishes its
    // early-playback key; a later tier fails. Before this, the whole partial run tree stayed
    // in object storage forever and hls_360p_key kept pointing into it.
    let prefix = '';
    h.transcode.mockImplementation(async (opts: {
      storageKeyPrefix: string;
      onTierStart?: (t: string) => Promise<void>;
      onTierComplete?: (t: string, k: string) => Promise<void>;
    }) => {
      prefix = opts.storageKeyPrefix;
      await opts.onTierStart?.('360p');
      await opts.onTierComplete?.('360p', `${opts.storageKeyPrefix}/360p/index.m3u8`);
      await opts.onTierStart?.('480p');
      throw new Error('HLS conformance (480p): first frame of seg_000.ts is not a keyframe');
    });

    await expect(runVideoTranscode(vfId)).rejects.toThrow(/HLS conformance \(480p\)/);

    const [row] = await rows<{ hls_status: string; hls_master_key: string | null; hls_360p_key: string | null }>(
      'SELECT hls_status, hls_master_key, hls_360p_key FROM video_files WHERE id = $1', [vfId]);
    expect(row!.hls_status).toBe('failed');
    // The previous, complete tree is still the published one — the claim above, unchanged.
    expect(row!.hls_master_key).toBe(`hls/${vfId}/oldrun/master.m3u8`);
    // ...and nothing points into the abandoned run any more.
    expect(row!.hls_360p_key).toBeNull();

    // The partial tree is queued for grace-period deletion — and it is THIS run's, never the old one.
    const retired = await rows<{ prefix: string; deleted_at: unknown }>(
      'SELECT prefix, deleted_at FROM hls_retired_runs');
    expect(retired.map((r) => r.prefix)).toEqual([prefix]);
    expect(prefix).toMatch(new RegExp(`^hls/${vfId}/[a-z0-9]+$`));
    expect(prefix).not.toContain('oldrun');
    expect(retired[0]!.deleted_at).toBeNull();
    // Deferred, never inline: a viewer may still hold a segment URL from the 360p tier.
    expect(h.deletePrefix).not.toHaveBeenCalled();
  });

  it('on a first transcode (no previous master) nothing is retired', async () => {
    await pg.query('UPDATE video_files SET hls_master_key = NULL WHERE id = $1', [vfId]);
    h.transcode.mockImplementation(async (opts: { storageKeyPrefix: string }) => ({
      masterKey: `${opts.storageKeyPrefix}/master.m3u8`,
      durationSec: 42,
    }));

    await runVideoTranscode(vfId);

    expect((await videoRow()).hls_status).toBe('ready');
    expect(await rows('SELECT 1 FROM hls_retired_runs')).toHaveLength(0);
    expect(h.deletePrefix).not.toHaveBeenCalled();
  });

  it('a legacy unversioned previous master is left alone (previousHlsTreeToGc filter still applies)', async () => {
    await pg.query('UPDATE video_files SET hls_master_key = $2 WHERE id = $1', [vfId, `hls/${vfId}/master.m3u8`]);
    h.transcode.mockImplementation(async (opts: { storageKeyPrefix: string }) => ({
      masterKey: `${opts.storageKeyPrefix}/master.m3u8`,
      durationSec: 42,
    }));

    await runVideoTranscode(vfId);

    // Legacy tree shares the hls/{id}/ parent with the NEW tree — retiring it would
    // eventually delete the new tree too. The safety filter must keep returning null.
    expect(await rows('SELECT 1 FROM hls_retired_runs')).toHaveLength(0);
    expect(h.deletePrefix).not.toHaveBeenCalled();
  });
});
