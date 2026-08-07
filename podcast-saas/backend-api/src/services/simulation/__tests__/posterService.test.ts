/**
 * PosterService — storage, checksums, invalidation and cleanup (Priority 5.5).
 *
 * The database is faked with a tiny in-memory table that actually EVALUATES the drizzle predicates
 * (eq / ne / and / inArray are replaced with structured descriptors). That matters: the whole point
 * of `invalidate` is the `package_revision != current` predicate, and a fake that ignored `where`
 * would let a broken filter pass. Storage is faked at the adapter boundary so the sweep's
 * list-then-delete decisions are observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import {
  posterIdentityString,
  posterStoragePath,
  selectPosterVariant,
  type PosterFormat,
  type PosterKey,
  type PosterRecord,
  type PosterSizeName,
} from 'shared/sim/posterIdentity';

// ── Fakes ─────────────────────────────────────────────────────────────────────

type Pred =
  | { op: 'eq' | 'ne'; col: string; val: unknown }
  | { op: 'and'; parts: Pred[] }
  | { op: 'inArray'; col: string; vals: unknown[] };

interface FakeRow {
  id: string;
  simulation_id: string;
  package_revision: string;
  variant_key: string;
  config_hash: string;
  aspect_profile: string;
  quality_profile: string;
  identity: string;
  variants: unknown;
  transparent: boolean;
  captured_at: Date;
  created_at: Date;
  [k: string]: unknown;
}

const h = vi.hoisted(() => {
  const state = { rows: [] as Record<string, unknown>[], nextId: 1, conflictTargets: [] as unknown[] };

  function matches(row: Record<string, unknown>, pred: unknown): boolean {
    if (!pred) return true;
    const p = pred as Pred;
    switch (p.op) {
      case 'and':
        return p.parts.every((part) => matches(row, part));
      case 'eq':
        return row[p.col] === p.val;
      case 'ne':
        return row[p.col] !== p.val;
      case 'inArray':
        return p.vals.includes(row[p.col]);
      default:
        throw new Error(`fake db: unsupported predicate ${JSON.stringify(pred)}`);
    }
  }

  return {
    state,
    matches,
    uploadFile: vi.fn(),
    listObjects: vi.fn(),
    deleteWithFallback: vi.fn(),
  };
});

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (col: { name: string }, val: unknown) => ({ op: 'eq', col: col.name, val }),
    ne: (col: { name: string }, val: unknown) => ({ op: 'ne', col: col.name, val }),
    and: (...parts: unknown[]) => ({ op: 'and', parts: parts.filter(Boolean) }),
    inArray: (col: { name: string }, vals: unknown[]) => ({ op: 'inArray', col: col.name, vals }),
  };
});

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      sim_posters: {
        findFirst: async ({ where }: { where?: unknown }) => {
          const hit = h.state.rows.find((r) => h.matches(r, where));
          return hit ? { ...hit } : undefined;
        },
        findMany: async ({ where }: { where?: unknown } = {}) =>
          h.state.rows.filter((r) => h.matches(r, where)).map((r) => ({ ...r })),
      },
    },
    insert: () => ({
      values: (vals: Record<string, unknown>) => ({
        onConflictDoUpdate: ({ target, set }: { target: unknown; set: Record<string, unknown> }) => {
          h.state.conflictTargets.push(target);
          return {
            returning: async () => {
              const existing = h.state.rows.find(
                (r) => r.simulation_id === vals.simulation_id && r.identity === vals.identity,
              );
              if (existing) {
                Object.assign(existing, set);
                return [{ ...existing }];
              }
              const row = { id: `row-${h.state.nextId++}`, created_at: new Date(), ...vals };
              h.state.rows.push(row);
              return [{ ...row }];
            },
          };
        },
      }),
    }),
    delete: () => ({
      where: async (pred: unknown) => {
        const removed = h.state.rows.filter((r) => h.matches(r, pred));
        h.state.rows = h.state.rows.filter((r) => !h.matches(r, pred));
        return removed;
      },
    }),
  },
}));

vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ uploadFile: h.uploadFile, listObjects: h.listObjects }),
}));

vi.mock('../../storage/deleteWithFallback.js', () => ({
  deleteWithFallback: h.deleteWithFallback,
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PosterService, assertSweepablePrefix, sha256OfBytes, type PosterRendition } from '../PosterService.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SIM = 'sim-1';
const PREFIX = 'simulations/proj-1/sim-1';

const KEY: PosterKey = {
  packageRevision: 'rev00000000000a',
  variantKey: 'section-a',
  configHash: 'cfg000000000000a',
  aspectProfile: 'wide',
  qualityProfile: 'high',
};

function keyWith(over: Partial<PosterKey>): PosterKey {
  return { ...KEY, ...over };
}

function rendition(
  size: PosterSizeName,
  format: PosterFormat,
  body = `${size}-${format}`,
  transparent = false,
): PosterRendition {
  return { size, format, bytes: Buffer.from(body), width: 1280, height: 720, transparent };
}

const svc = new PosterService();

function rows(): FakeRow[] {
  return h.state.rows as unknown as FakeRow[];
}

beforeEach(() => {
  h.state.rows = [];
  h.state.nextId = 1;
  h.state.conflictTargets = [];
  h.uploadFile.mockReset().mockResolvedValue('https://cdn.example/x');
  h.listObjects.mockReset().mockResolvedValue([]);
  h.deleteWithFallback.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── storePoster: checksums, paths, upload metadata ────────────────────────────

describe('storePoster', () => {
  it('records the real sha256 of every rendition and stores the exact bytes it hashed', async () => {
    const webp = rendition('standard', 'webp', 'STANDARD-WEBP-BYTES');
    const png = rendition('compact', 'png', 'COMPACT-PNG-BYTES');

    const record = await svc.storePoster(SIM, PREFIX, KEY, [webp, png]);

    const expectWebp = createHash('sha256').update(webp.bytes).digest('hex');
    const expectPng = createHash('sha256').update(png.bytes).digest('hex');

    expect(record.variants.find((v) => v.format === 'webp')!.checksum).toBe(expectWebp);
    expect(record.variants.find((v) => v.format === 'png')!.checksum).toBe(expectPng);
    // 64 hex chars — the full digest, not the truncated identity-style hash.
    expect(expectWebp).toMatch(/^[0-9a-f]{64}$/);
    expect(expectWebp).not.toBe(expectPng);

    const uploadedWebp = h.uploadFile.mock.calls.find((c) => String(c[0]).endsWith('.webp'))!;
    expect(sha256OfBytes(uploadedWebp[1] as Buffer)).toBe(expectWebp);
  });

  it('writes every rendition to the deterministic identity path with its content type and an immutable cache-control', async () => {
    await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp'), rendition('standard', 'png')]);

    expect(h.uploadFile).toHaveBeenCalledTimes(2);
    expect(h.uploadFile).toHaveBeenCalledWith(
      posterStoragePath(PREFIX, KEY, 'standard', 'webp'),
      expect.any(Buffer),
      'image/webp',
      'public, max-age=31536000, immutable',
    );
    expect(h.uploadFile).toHaveBeenCalledWith(
      posterStoragePath(PREFIX, KEY, 'standard', 'png'),
      expect.any(Buffer),
      'image/png',
      'public, max-age=31536000, immutable',
    );
  });

  it('is path-deterministic: same identity → same paths, any key change → different paths', async () => {
    const a = await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);
    const again = await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp', 'other')]);
    expect(again.variants[0].path).toBe(a.variants[0].path);

    const otherConfig = await svc.storePoster(SIM, PREFIX, keyWith({ configHash: 'cfg000000000000b' }), [
      rendition('standard', 'webp'),
    ]);
    const otherAspect = await svc.storePoster(SIM, PREFIX, keyWith({ aspectProfile: 'portrait' }), [
      rendition('standard', 'webp'),
    ]);
    const otherQuality = await svc.storePoster(SIM, PREFIX, keyWith({ qualityProfile: 'low' }), [
      rendition('standard', 'webp'),
    ]);
    const paths = new Set([
      a.variants[0].path,
      otherConfig.variants[0].path,
      otherAspect.variants[0].path,
      otherQuality.variants[0].path,
    ]);
    expect(paths.size).toBe(4);
  });

  it('trailing slashes in the prefix do not mint a second, differently-pathed poster', async () => {
    const a = await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);
    const b = await svc.storePoster(SIM, `${PREFIX}///`, KEY, [rendition('standard', 'webp')]);
    expect(b.variants[0].path).toBe(a.variants[0].path);
    expect(rows()).toHaveLength(1);
  });

  it('upserts on (simulation_id, identity) instead of accumulating rows', async () => {
    const first = await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp', 'v1')], {
      capturedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const second = await svc.storePoster(
      SIM,
      PREFIX,
      KEY,
      [rendition('standard', 'webp', 'v2'), rendition('compact', 'webp', 'v2c')],
      { capturedAt: new Date('2026-02-02T00:00:00.000Z') },
    );

    expect(rows()).toHaveLength(1);
    expect(second.variants).toHaveLength(2);
    expect(second.variants[0].checksum).not.toBe(first.variants[0].checksum);
    expect(second.capturedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(h.state.conflictTargets.length).toBeGreaterThan(0);
    expect((h.state.conflictTargets[0] as { name: string }[]).map((c) => c.name)).toEqual([
      'simulation_id',
      'identity',
    ]);
  });

  it('a different simulation with the same identity gets its own row', async () => {
    await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);
    await svc.storePoster('sim-2', 'simulations/proj-1/sim-2', KEY, [rendition('standard', 'webp')]);
    expect(rows()).toHaveLength(2);
  });

  it('stores the row only after the bytes land — a failed upload records nothing', async () => {
    vi.useFakeTimers();
    h.uploadFile.mockRejectedValue(new Error('AccessDenied'));

    const promise = svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);
    const expectation = expect(promise).rejects.toThrow('AccessDenied');
    await vi.runAllTimersAsync();
    await expectation;

    expect(h.uploadFile).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(rows()).toHaveLength(0);
  });

  it('retries a transient upload failure rather than losing the poster', async () => {
    vi.useFakeTimers();
    h.uploadFile.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValue('https://cdn.example/x');

    const promise = svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);
    await vi.runAllTimersAsync();
    await promise;

    expect(h.uploadFile).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(1);
  });
});

// ── storePoster: input validation ─────────────────────────────────────────────

describe('storePoster validation', () => {
  it('rejects an empty rendition set', async () => {
    await expect(svc.storePoster(SIM, PREFIX, KEY, [])).rejects.toThrow(/at least one rendition/);
    expect(h.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects two renditions that would occupy the same path', async () => {
    await expect(
      svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp', 'a'), rendition('standard', 'webp', 'b')]),
    ).rejects.toThrow(/duplicate rendition/);
    expect(h.uploadFile).not.toHaveBeenCalled();
  });

  it('rejects a rendition set that disagrees about transparency', async () => {
    await expect(
      svc.storePoster(SIM, PREFIX, KEY, [
        rendition('standard', 'png', 'a', true),
        rendition('compact', 'png', 'b', false),
      ]),
    ).rejects.toThrow(/disagree about transparency/);
  });

  it('rejects a non-PNG rendition of a transparent capture (formatsFor contract)', async () => {
    await expect(
      svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp', 'a', true)]),
    ).rejects.toThrow(/not permitted for a transparent poster/);
  });

  it('accepts a transparent PNG capture and records transparent=true', async () => {
    const record = await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'png', 'a', true)]);
    expect(record.transparent).toBe(true);
  });

  it('rejects empty bytes and impossible dimensions', async () => {
    await expect(
      svc.storePoster(SIM, PREFIX, KEY, [
        { size: 'standard', format: 'webp', bytes: Buffer.alloc(0), width: 10, height: 10, transparent: false },
      ]),
    ).rejects.toThrow(/has no bytes/);

    await expect(
      svc.storePoster(SIM, PREFIX, KEY, [
        { size: 'standard', format: 'webp', bytes: Buffer.from('x'), width: 0, height: 10, transparent: false },
      ]),
    ).rejects.toThrow(/invalid dimensions/);
  });

  it('rejects an incomplete key', async () => {
    await expect(
      svc.storePoster(SIM, PREFIX, keyWith({ configHash: '' }), [rendition('standard', 'webp')]),
    ).rejects.toThrow(/key.configHash is required/);
    await expect(
      svc.storePoster(SIM, PREFIX, keyWith({ aspectProfile: 'square' as never }), [rendition('standard', 'webp')]),
    ).rejects.toThrow(/unknown aspectProfile/);
  });
});

// ── Reads ─────────────────────────────────────────────────────────────────────

describe('getPoster / listPosters', () => {
  it('returns the stored record for a matching key and null for anything else', async () => {
    await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);

    const hit = await svc.getPoster(SIM, KEY);
    expect(hit).not.toBeNull();
    expect(hit!.identity).toBe(posterIdentityString(KEY));
    expect(hit!.key).toEqual(KEY);
    expect(hit!.packageRevision).toBe(KEY.packageRevision);

    expect(await svc.getPoster(SIM, keyWith({ configHash: 'cfg000000000000z' }))).toBeNull();
    expect(await svc.getPoster(SIM, keyWith({ qualityProfile: 'low' }))).toBeNull();
    expect(await svc.getPoster('sim-2', KEY)).toBeNull();
  });

  it('lists only the posters of the given simulation', async () => {
    await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);
    await svc.storePoster(SIM, PREFIX, keyWith({ variantKey: 'section-b' }), [rendition('standard', 'webp')]);
    await svc.storePoster('sim-2', 'simulations/proj-1/sim-2', KEY, [rendition('standard', 'webp')]);

    const list = await svc.listPosters(SIM);
    expect(list.map((r) => r.key.variantKey).sort()).toEqual(['section-a', 'section-b']);
  });

  it('drops malformed variant entries instead of failing the whole read', async () => {
    await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);
    const row = rows()[0];
    row.variants = [
      ...(row.variants as unknown[]),
      { size: 'gigantic', format: 'webp', path: 'x', checksum: 'y' },
      { size: 'compact', format: 'jpeg', path: 'x', checksum: 'y' },
      { size: 'compact', format: 'png' }, // no path / checksum
      null,
    ];

    const record = await svc.getPoster(SIM, KEY);
    expect(record!.variants).toHaveLength(1);
    expect(record!.variants[0].format).toBe('webp');
  });
});

// ── Revision invalidation ─────────────────────────────────────────────────────

describe('invalidate', () => {
  it('deletes rows and objects for every superseded revision and keeps the current one', async () => {
    const oldA = await svc.storePoster(SIM, PREFIX, keyWith({ packageRevision: 'revOLD' }), [
      rendition('standard', 'webp'),
      rendition('compact', 'webp'),
    ]);
    const oldB = await svc.storePoster(
      SIM,
      PREFIX,
      keyWith({ packageRevision: 'revOLD', variantKey: 'section-b' }),
      [rendition('standard', 'webp')],
    );
    const current = await svc.storePoster(SIM, PREFIX, keyWith({ packageRevision: 'revNEW' }), [
      rendition('standard', 'webp'),
    ]);

    const result = await svc.invalidate(SIM, 'revNEW');

    expect(result.deletedIdentities.sort()).toEqual([oldA.identity, oldB.identity].sort());
    expect(result.deletedObjects.sort()).toEqual(
      [...oldA.variants.map((v) => v.path), ...oldB.variants.map((v) => v.path)].sort(),
    );
    for (const path of result.deletedObjects) {
      expect(h.deleteWithFallback).toHaveBeenCalledWith(path);
    }
    expect(h.deleteWithFallback).not.toHaveBeenCalledWith(current.variants[0].path);

    expect(rows()).toHaveLength(1);
    expect(rows()[0].package_revision).toBe('revNEW');
  });

  it('leaves another simulation\'s posters of the same old revision alone', async () => {
    await svc.storePoster(SIM, PREFIX, keyWith({ packageRevision: 'revOLD' }), [rendition('standard', 'webp')]);
    const other = await svc.storePoster('sim-2', 'simulations/proj-1/sim-2', keyWith({ packageRevision: 'revOLD' }), [
      rendition('standard', 'webp'),
    ]);

    await svc.invalidate(SIM, 'revNEW');

    expect(rows()).toHaveLength(1);
    expect(rows()[0].simulation_id).toBe('sim-2');
    expect(h.deleteWithFallback).not.toHaveBeenCalledWith(other.variants[0].path);
  });

  it('is a no-op when every poster is already on the current revision', async () => {
    await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);
    const result = await svc.invalidate(SIM, KEY.packageRevision);
    expect(result).toEqual({ deletedIdentities: [], deletedObjects: [] });
    expect(h.deleteWithFallback).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it('refuses an empty simulation id or an empty revision (both would match every row)', async () => {
    await svc.storePoster(SIM, PREFIX, KEY, [rendition('standard', 'webp')]);

    await expect(svc.invalidate('', 'revNEW')).rejects.toThrow(/simulationId is required/);
    await expect(svc.invalidate('   ', 'revNEW')).rejects.toThrow(/simulationId is required/);
    await expect(svc.invalidate(SIM, '')).rejects.toThrow(/packageRevision is required/);

    expect(h.deleteWithFallback).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it('never deletes a stored path that does not parse back to its own identity', async () => {
    const record = await svc.storePoster(SIM, PREFIX, keyWith({ packageRevision: 'revOLD' }), [
      rendition('standard', 'webp'),
    ]);
    // A tampered/hand-repaired row: the variant now points somewhere else entirely.
    rows()[0].variants = [
      { ...record.variants[0], path: 'videos/other-project/master.mp4' },
      { ...record.variants[0], path: `${PREFIX}/posters/someone-elses-identity/standard.webp` },
    ];

    const result = await svc.invalidate(SIM, 'revNEW');

    expect(result.deletedObjects).toEqual([]);
    expect(h.deleteWithFallback).not.toHaveBeenCalled();
    // The row itself is still removed — it is genuinely stale, only its bytes are unaccounted for.
    expect(rows()).toHaveLength(0);
  });
});

// ── Orphan cleanup ────────────────────────────────────────────────────────────

describe('cleanupOrphans', () => {
  const liveKey = KEY;
  const staleIdentity = posterIdentityString(keyWith({ configHash: 'cfg00000000000ff' }));

  function objectsIn(...keys: string[]): string[] {
    return keys;
  }

  it('deletes only the objects whose identity is not live', async () => {
    const live = posterIdentityString(liveKey);
    h.listObjects.mockResolvedValue(
      objectsIn(
        `${PREFIX}/posters/${live}/standard.webp`,
        `${PREFIX}/posters/${live}/compact.webp`,
        `${PREFIX}/posters/${staleIdentity}/standard.webp`,
        `${PREFIX}/posters/${staleIdentity}/standard.avif`,
      ),
    );

    const result = await svc.cleanupOrphans(SIM, PREFIX, [liveKey]);

    expect(result.deleted.sort()).toEqual(
      [`${PREFIX}/posters/${staleIdentity}/standard.avif`, `${PREFIX}/posters/${staleIdentity}/standard.webp`].sort(),
    );
    expect(result.kept.sort()).toEqual(
      [`${PREFIX}/posters/${live}/compact.webp`, `${PREFIX}/posters/${live}/standard.webp`].sort(),
    );
    expect(h.deleteWithFallback).toHaveBeenCalledTimes(2);
    expect(h.listObjects).toHaveBeenCalledWith(`${PREFIX}/posters`);
  });

  it('never deletes an object it could not parse as a poster', async () => {
    const live = posterIdentityString(liveKey);
    h.listObjects.mockResolvedValue(
      objectsIn(
        `${PREFIX}/posters/${live}/standard.webp`,
        `${PREFIX}/posters/README.txt`,
        `${PREFIX}/posters/${staleIdentity}/standard.jxl`, // a format this build does not know
        `${PREFIX}/posters/${staleIdentity}/nested/deep/standard.webp`,
        `${PREFIX}/posters/`,
      ),
    );

    const result = await svc.cleanupOrphans(SIM, PREFIX, [liveKey]);

    expect(result.deleted).toEqual([]);
    expect(result.kept).toHaveLength(5);
    expect(h.deleteWithFallback).not.toHaveBeenCalled();
  });

  it('never deletes an object the listing placed outside the poster root', async () => {
    const live = posterIdentityString(liveKey);
    const foreign = `simulations/proj-1/sim-2/posters/${staleIdentity}/standard.webp`;
    h.listObjects.mockResolvedValue(objectsIn(`${PREFIX}/posters/${live}/standard.webp`, foreign));

    const result = await svc.cleanupOrphans(SIM, PREFIX, [liveKey]);

    expect(result.deleted).toEqual([]);
    expect(result.kept).toContain(foreign);
    expect(h.deleteWithFallback).not.toHaveBeenCalled();
  });

  it('refuses to delete anything when the listing failed', async () => {
    await svc.storePoster(SIM, PREFIX, keyWith({ configHash: 'cfg00000000000ff' }), [rendition('standard', 'webp')]);
    h.listObjects.mockRejectedValue(new Error('S3 ListObjectsV2 timed out'));

    await expect(svc.cleanupOrphans(SIM, PREFIX, [liveKey])).rejects.toThrow(/listing failed/);

    expect(h.deleteWithFallback).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1); // the stale row survives too — nothing was proven orphaned
  });

  it('drops the DB rows of identities that are no longer live', async () => {
    await svc.storePoster(SIM, PREFIX, liveKey, [rendition('standard', 'webp')]);
    await svc.storePoster(SIM, PREFIX, keyWith({ configHash: 'cfg00000000000ff' }), [rendition('standard', 'webp')]);
    h.listObjects.mockResolvedValue([]);

    const result = await svc.cleanupOrphans(SIM, PREFIX, [liveKey]);

    expect(result.deletedIdentities).toEqual([staleIdentity]);
    expect(rows()).toHaveLength(1);
    expect(rows()[0].identity).toBe(posterIdentityString(liveKey));
  });

  it('refuses an empty liveKeys set unless the caller opts in', async () => {
    await svc.storePoster(SIM, PREFIX, liveKey, [rendition('standard', 'webp')]);
    h.listObjects.mockResolvedValue([`${PREFIX}/posters/${posterIdentityString(liveKey)}/standard.webp`]);

    await expect(svc.cleanupOrphans(SIM, PREFIX, [])).rejects.toThrow(/empty liveKeys/);
    expect(h.deleteWithFallback).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);

    const result = await svc.cleanupOrphans(SIM, PREFIX, [], { allowEmptyLiveKeys: true });
    expect(result.deleted).toHaveLength(1);
    expect(rows()).toHaveLength(0);
  });

  it.each([
    ['', /empty storage prefix/],
    ['   ', /empty storage prefix/],
    ['/', /empty storage prefix/],
    ['///', /empty storage prefix/],
    ['simulations', /top-level prefix/],
    ['simulations/', /top-level prefix/],
    ['simulations//sim-1', /empty or relative segments/],
    ['simulations/../../etc', /empty or relative segments/],
    ['simulations/./sim-1', /empty or relative segments/],
    ['simulations/*', /wildcards/],
    ['simulations/sim-?', /wildcards/],
  ])('refuses to sweep with prefix %j', async (prefix, message) => {
    await expect(svc.cleanupOrphans(SIM, prefix, [liveKey])).rejects.toThrow(message);
    expect(h.listObjects).not.toHaveBeenCalled();
    expect(h.deleteWithFallback).not.toHaveBeenCalled();
  });

  it('refuses an empty simulation id', async () => {
    await expect(svc.cleanupOrphans('', PREFIX, [liveKey])).rejects.toThrow(/simulationId is required/);
    expect(h.listObjects).not.toHaveBeenCalled();
  });

  it('accepts the real simulation prefix shape', () => {
    expect(assertSweepablePrefix('simulations/proj-1/sim-1')).toBe('simulations/proj-1/sim-1');
    expect(assertSweepablePrefix('/simulations/proj-1/sim-1/')).toBe('simulations/proj-1/sim-1');
  });
});

// ── Variant selection ─────────────────────────────────────────────────────────

describe('selectPosterVariant preference order', () => {
  let record: PosterRecord;

  beforeEach(async () => {
    record = await svc.storePoster(SIM, PREFIX, KEY, [
      rendition('standard', 'avif', 'std-avif'),
      rendition('standard', 'webp', 'std-webp'),
      rendition('standard', 'png', 'std-png'),
      rendition('compact', 'png', 'cmp-png'),
    ]);
  });

  it('prefers webp when the viewer supports it, whatever order the variants were stored in', () => {
    expect(selectPosterVariant(record, 'standard', ['webp', 'avif', 'png'])!.format).toBe('webp');
    expect(selectPosterVariant(record, 'standard', ['png', 'avif', 'webp'])!.format).toBe('webp');
  });

  it('falls to avif, then png, as support narrows', () => {
    expect(selectPosterVariant(record, 'standard', ['avif', 'png'])!.format).toBe('avif');
    expect(selectPosterVariant(record, 'standard', ['png'])!.format).toBe('png');
  });

  it('honours the requested size before the format preference', () => {
    const compact = selectPosterVariant(record, 'compact', ['webp', 'avif', 'png'])!;
    expect(compact.size).toBe('compact');
    expect(compact.format).toBe('png'); // the only compact rendition stored
  });

  it('returns a same-size rendition even when no supported format matches, and null when the size is missing', async () => {
    expect(selectPosterVariant(record, 'standard', [])!.size).toBe('standard');

    const onlyStandard = await svc.storePoster(SIM, PREFIX, keyWith({ variantKey: 'section-z' }), [
      rendition('standard', 'webp'),
    ]);
    expect(selectPosterVariant(onlyStandard, 'compact', ['webp'])).toBeNull();
  });
});

// ── Migration 049 against a real Postgres engine ──────────────────────────────
// The service's guarantees (one row per identity, never a poster with no renditions) are only
// guarantees if the DDL enforces them, so this exercises the actual migration file — PGlite is real
// Postgres compiled to WASM, in-process, and touches nothing outside this test.

describe('migration 049 — sim_posters DDL', () => {
  const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
  const forward = () => readFileSync(join(MIGRATIONS, '049_sim_posters.sql'), 'utf-8');
  const rollback = () => readFileSync(join(MIGRATIONS, '049_sim_posters.rollback.sql'), 'utf-8');

  const VARIANTS = JSON.stringify([
    { size: 'standard', format: 'webp', path: 'p', checksum: 'c', contentType: 'image/webp', width: 1, height: 1, bytes: 1 },
  ]);

  let pg: PGlite;
  let simId: string;

  async function insertPoster(over: Record<string, unknown> = {}): Promise<void> {
    const cols: Record<string, unknown> = {
      simulation_id: simId,
      package_revision: 'rev',
      variant_key: 'section-a',
      config_hash: 'cfg',
      aspect_profile: 'wide',
      quality_profile: 'high',
      identity: 'rev__section-a__cfg__wide__high',
      variants: VARIANTS,
      transparent: false,
      ...over,
    };
    const keys = Object.keys(cols);
    await pg.query(
      `INSERT INTO sim_posters (${keys.join(', ')}) VALUES (${keys.map((k, i) => (k === 'variants' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})`,
      keys.map((k) => cols[k]),
    );
  }

  async function rejects(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error('expected the constraint to reject this row, but it was accepted');
  }

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE projects (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
      CREATE TABLE simulations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        storage_prefix TEXT NOT NULL,
        entry_file TEXT NOT NULL
      );
    `);
    await pg.exec(forward());
    const proj = await pg.query<{ id: string }>('INSERT INTO projects DEFAULT VALUES RETURNING id');
    const sim = await pg.query<{ id: string }>(
      `INSERT INTO simulations (project_id, name, storage_prefix, entry_file)
       VALUES ($1, 'sim', 'simulations/p/s', 'e') RETURNING id`,
      [proj.rows[0].id],
    );
    simId = sim.rows[0].id;
  });

  afterEach(async () => {
    await pg.close();
  });

  it('is re-runnable: applying the file twice does not error', async () => {
    await pg.exec(forward());
    await insertPoster();
    const n = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM sim_posters');
    expect(n.rows[0].n).toBe(1);
  });

  it('enforces one row per (simulation_id, identity)', async () => {
    await insertPoster();
    const msg = await rejects(() => insertPoster({ package_revision: 'rev-changed-but-same-identity' }));
    expect(msg).toMatch(/uniq_sim_posters_sim_identity|duplicate/i);
  });

  it('lets two simulations hold the same identity', async () => {
    await insertPoster();
    const proj = await pg.query<{ id: string }>('INSERT INTO projects DEFAULT VALUES RETURNING id');
    const other = await pg.query<{ id: string }>(
      `INSERT INTO simulations (project_id, name, storage_prefix, entry_file)
       VALUES ($1, 'sim2', 'simulations/p/s2', 'e') RETURNING id`,
      [proj.rows[0].id],
    );
    await insertPoster({ simulation_id: other.rows[0].id });
    const n = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM sim_posters');
    expect(n.rows[0].n).toBe(2);
  });

  it('rejects a poster with no renditions and a non-array variants blob', async () => {
    expect(await rejects(() => insertPoster({ variants: '[]', identity: 'a' }))).toMatch(/variants_array_chk|check/i);
    expect(await rejects(() => insertPoster({ variants: '{}', identity: 'b' }))).toMatch(/variants_array_chk|check/i);
  });

  it('rejects profiles outside the protocol vocabulary', async () => {
    expect(await rejects(() => insertPoster({ aspect_profile: 'square', identity: 'c' }))).toMatch(/check/i);
    expect(await rejects(() => insertPoster({ quality_profile: 'ultra', identity: 'd' }))).toMatch(/check/i);
  });

  it('deletes posters with their simulation', async () => {
    await insertPoster();
    await pg.query('DELETE FROM simulations WHERE id = $1', [simId]);
    const n = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM sim_posters');
    expect(n.rows[0].n).toBe(0);
  });

  it('accepts every SimPackageClass and refuses anything else', async () => {
    for (const cls of ['managed-presentable', 'managed-partial', 'legacy-cooperative', 'legacy-opaque', 'failed']) {
      await pg.query('UPDATE simulations SET package_class = $1, canary_at = now() WHERE id = $2', [cls, simId]);
    }
    await pg.query(`UPDATE simulations SET canary_report = '{"classification":"failed"}'::jsonb WHERE id = $1`, [simId]);
    const msg = await rejects(() =>
      pg.query('UPDATE simulations SET package_class = $1 WHERE id = $2', ['managed', simId]),
    );
    expect(msg).toMatch(/package_class_chk|check/i);
  });

  it('leaves the package unclassified by default — a legacy package reads as NULL, never as a class', async () => {
    const row = await pg.query<{ package_class: string | null; canary_report: unknown; canary_at: Date | null }>(
      'SELECT package_class, canary_report, canary_at FROM simulations WHERE id = $1',
      [simId],
    );
    expect(row.rows[0]).toEqual({ package_class: null, canary_report: null, canary_at: null });
  });

  it('round-trips through its rollback', async () => {
    await insertPoster();
    await pg.exec(rollback());

    const table = await pg.query<{ t: string | null }>(`SELECT to_regclass('sim_posters')::text AS t`);
    expect(table.rows[0].t).toBeNull();
    const cols = await pg.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'simulations' AND column_name IN ('package_class', 'canary_report', 'canary_at')`,
    );
    expect(cols.rows).toHaveLength(0);

    await pg.exec(forward());
    await insertPoster();
    const n = await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM sim_posters');
    expect(n.rows[0].n).toBe(1);
  });
});
