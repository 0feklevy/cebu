/**
 * Adversarial tests for backfill-storage.ts.
 *
 * This script copies the whole local-disk media tree into the cloud bucket under IDENTICAL
 * keys. The bucket has no versioning, no object lock and no undo (see RevisionService.ts:325,
 * md-files/SIM-REBUILD-ROLLOUT.md:134), so every overwrite it performs is irreversible. The
 * properties below are the ones that stand between an operator with a stale local tree and a
 * silently corrupted production bucket:
 *
 *   1  a bare invocation writes NOTHING and exits non-zero
 *   2  the operator must name the target adapter, and a mismatch refuses (wrong .env loaded)
 *   3  the operator must name a key prefix; nothing outside it is ever considered
 *   4  the default posture is a report — --apply is the only thing that writes a byte
 *   5  the report distinguishes CREATE from OVERWRITE, because only overwrite destroys data
 *   6  a plan larger than the count cap refuses to apply rather than truncating silently
 *   7  --apply uploads exactly the planned keys, in plan order, and nothing else
 *   8  any failed upload yields a non-zero exit code
 *
 * Everything runs against in-memory fakes: no filesystem, no storage adapter, no database.
 * The script guards main() behind a direct-invocation check and imports db/storage lazily,
 * so importing it here executes nothing.
 */
import { describe, it, expect } from 'vitest';

import {
  DEFAULT_BACKFILL_LIMIT,
  contentTypeFor,
  parseBackfillArgs,
  planBackfill,
  runBackfill,
  type BackfillDeps,
  type LocalFile,
} from '../backfill-storage.js';

interface FakeOptions {
  local?: LocalFile[];
  remote?: string[];
  targetName?: string;
  failOn?: string;
}

function fakeDeps(o: FakeOptions = {}): BackfillDeps & { uploaded: string[]; lines: string[] } {
  const local = o.local ?? [];
  const uploaded: string[] = [];
  const lines: string[] = [];
  return {
    uploaded,
    lines,
    targetName: o.targetName ?? 'SupabaseStorageAdapter',
    async listLocalFiles(prefix: string) {
      // The fake walks everything; prefix scoping is the script's job, not the walker's.
      void prefix;
      return local;
    },
    async listRemoteKeys() {
      return o.remote ?? [];
    },
    async upload(key: string) {
      if (o.failOn && key === o.failOn) throw new Error('AccessDenied');
      uploaded.push(key);
    },
    log(line: string) {
      lines.push(line);
    },
  };
}

const F = (key: string, size = 10): LocalFile => ({ key, size });

describe('backfill-storage argument parsing', () => {
  it('defaults to NOT applying', () => {
    expect(parseBackfillArgs(['--target', 'X', '--prefix', 'videos/']).apply).toBe(false);
  });

  it('rejects a bare invocation — no target, no prefix', () => {
    const args = parseBackfillArgs([]);
    expect(args.errors.join(' ')).toMatch(/--target/);
    expect(args.errors.join(' ')).toMatch(/--prefix/);
  });

  it('rejects a non-positive or non-numeric cap instead of treating it as unlimited', () => {
    expect(parseBackfillArgs(['--target', 'X', '--prefix', 'p/', '--limit', '0']).errors.join(' ')).toMatch(/--limit/);
    expect(parseBackfillArgs(['--target', 'X', '--prefix', 'p/', '--limit', 'abc']).errors.join(' ')).toMatch(/--limit/);
  });

  it('rejects an empty prefix — "" would scope to the entire bucket', () => {
    expect(parseBackfillArgs(['--target', 'X', '--prefix', '']).errors.join(' ')).toMatch(/--prefix/);
  });

  it('normalises the prefix to a directory path, so it cannot spill into a sibling tree', () => {
    expect(parseBackfillArgs(['--target', 'X', '--prefix', 'videos']).prefix).toBe('videos/');
    expect(parseBackfillArgs(['--target', 'X', '--prefix', 'videos/']).prefix).toBe('videos/');
  });

  it('carries a count cap by default', () => {
    expect(parseBackfillArgs(['--target', 'X', '--prefix', 'p/']).limit).toBe(DEFAULT_BACKFILL_LIMIT);
  });
});

describe('backfill-storage planning', () => {
  it('does not treat a sibling directory as in-scope ("videos/" must not match "videos-old/")', () => {
    const plan = planBackfill({
      files: [F('videos/a.mp4'), F('videos-old/a.mp4')],
      existing: new Set<string>(),
      prefix: 'videos/',
      limit: 100,
    });
    expect(plan.candidates.map((c) => c.key)).toEqual(['videos/a.mp4']);
  });

  it('drops every key outside the requested prefix', () => {
    const plan = planBackfill({
      files: [F('videos/a.mp4'), F('hls/b/master.m3u8'), F('videos/nested/c.mp4')],
      existing: new Set<string>(),
      prefix: 'videos/',
      limit: 100,
    });
    expect(plan.candidates.map((c) => c.key)).toEqual(['videos/a.mp4', 'videos/nested/c.mp4']);
    expect(plan.outOfPrefix).toBe(1);
  });

  it('separates CREATE from OVERWRITE — only overwrite destroys data in an unversioned bucket', () => {
    const plan = planBackfill({
      files: [F('videos/a.mp4'), F('videos/b.mp4')],
      existing: new Set(['videos/b.mp4']),
      prefix: 'videos/',
      limit: 100,
    });
    expect(plan.creates).toBe(1);
    expect(plan.overwrites).toBe(1);
    expect(plan.candidates.find((c) => c.key === 'videos/b.mp4')?.disposition).toBe('overwrite');
  });

  it('reports the overflow beyond the cap rather than silently truncating', () => {
    const plan = planBackfill({
      files: [F('p/1'), F('p/2'), F('p/3')],
      existing: new Set<string>(),
      prefix: 'p/',
      limit: 2,
    });
    expect(plan.candidates).toHaveLength(2);
    expect(plan.overLimit).toBe(1);
  });

  it('orders candidates deterministically so two dry runs produce the same report', () => {
    const plan = planBackfill({
      files: [F('p/c'), F('p/a'), F('p/b')],
      existing: new Set<string>(),
      prefix: 'p/',
      limit: 10,
    });
    expect(plan.candidates.map((c) => c.key)).toEqual(['p/a', 'p/b', 'p/c']);
  });
});

describe('backfill-storage execution', () => {
  it('a bare invocation writes nothing and exits non-zero', async () => {
    const deps = fakeDeps({ local: [F('videos/a.mp4')] });
    const code = await runBackfill(parseBackfillArgs([]), deps);
    expect(code).not.toBe(0);
    expect(deps.uploaded).toEqual([]);
  });

  it('writes nothing without --apply, however complete the arguments are', async () => {
    const deps = fakeDeps({ local: [F('videos/a.mp4'), F('videos/b.mp4')] });
    const code = await runBackfill(parseBackfillArgs(['--target', 'SupabaseStorageAdapter', '--prefix', 'videos/']), deps);
    expect(code).toBe(0);
    expect(deps.uploaded).toEqual([]);
    expect(deps.lines.join('\n')).toMatch(/--apply/);
  });

  it('refuses to write when the resolved adapter is not the one the operator named', async () => {
    const deps = fakeDeps({ local: [F('videos/a.mp4')], targetName: 'R2StorageAdapter' });
    const code = await runBackfill(
      parseBackfillArgs(['--target', 'SupabaseStorageAdapter', '--prefix', 'videos/', '--apply']),
      deps,
    );
    expect(code).not.toBe(0);
    expect(deps.uploaded).toEqual([]);
    expect(deps.lines.join('\n')).toMatch(/R2StorageAdapter/);
  });

  it('refuses to write to the local-disk adapter (that is the SOURCE, not a target)', async () => {
    const deps = fakeDeps({ local: [F('videos/a.mp4')], targetName: 'LocalStorageAdapter' });
    const code = await runBackfill(
      parseBackfillArgs(['--target', 'LocalStorageAdapter', '--prefix', 'videos/', '--apply']),
      deps,
    );
    expect(code).not.toBe(0);
    expect(deps.uploaded).toEqual([]);
  });

  it('refuses to apply a plan that exceeds the cap instead of uploading the first N', async () => {
    const deps = fakeDeps({ local: [F('videos/a'), F('videos/b'), F('videos/c')] });
    const code = await runBackfill(
      parseBackfillArgs(['--target', 'SupabaseStorageAdapter', '--prefix', 'videos/', '--limit', '2', '--apply']),
      deps,
    );
    expect(code).not.toBe(0);
    expect(deps.uploaded).toEqual([]);
    expect(deps.lines.join('\n')).toMatch(/--limit/);
  });

  it('with --apply uploads exactly the in-prefix keys and nothing else', async () => {
    const deps = fakeDeps({ local: [F('videos/a.mp4'), F('hls/x/master.m3u8'), F('videos/b.mp4')] });
    const code = await runBackfill(
      parseBackfillArgs(['--target', 'SupabaseStorageAdapter', '--prefix', 'videos/', '--apply']),
      deps,
    );
    expect(code).toBe(0);
    expect(deps.uploaded).toEqual(['videos/a.mp4', 'videos/b.mp4']);
  });

  it('exits non-zero when any single upload fails', async () => {
    const deps = fakeDeps({ local: [F('videos/a.mp4'), F('videos/b.mp4')], failOn: 'videos/a.mp4' });
    const code = await runBackfill(
      parseBackfillArgs(['--target', 'SupabaseStorageAdapter', '--prefix', 'videos/', '--apply']),
      deps,
    );
    expect(code).not.toBe(0);
    expect(deps.uploaded).toEqual(['videos/b.mp4']);
  });

  it('refuses even a dry run when the remote listing fails — a report that cannot name the overwrites understates the damage', async () => {
    const deps = fakeDeps({ local: [F('videos/a.mp4')] });
    deps.listRemoteKeys = async () => { throw new Error('ListObjects denied'); };
    const code = await runBackfill(parseBackfillArgs(['--target', 'SupabaseStorageAdapter', '--prefix', 'videos/']), deps);
    expect(code).not.toBe(0);
    expect(deps.uploaded).toEqual([]);
  });

  it('says an empty plan probably means a wrong prefix, not an empty tree', async () => {
    const deps = fakeDeps({ local: [F('videos/a.mp4')] });
    await runBackfill(parseBackfillArgs(['--target', 'SupabaseStorageAdapter', '--prefix', 'vid']), deps);
    expect(deps.lines.join('\n')).toMatch(/no local file matched/);
    expect(deps.uploaded).toEqual([]);
  });

  it('names every object it would overwrite, so the operator can read the report first', async () => {
    const deps = fakeDeps({ local: [F('videos/live.mp4')], remote: ['videos/live.mp4'] });
    await runBackfill(parseBackfillArgs(['--target', 'SupabaseStorageAdapter', '--prefix', 'videos/']), deps);
    const out = deps.lines.join('\n');
    expect(out).toMatch(/OVERWRITE/);
    expect(out).toMatch(/videos\/live\.mp4/);
  });
});

describe('content types', () => {
  it('maps HLS playlists and segments, not just video containers', () => {
    expect(contentTypeFor('a/master.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(contentTypeFor('a/seg0.ts')).toBe('video/mp2t');
    expect(contentTypeFor('a/no-extension')).toBe('application/octet-stream');
  });
});
