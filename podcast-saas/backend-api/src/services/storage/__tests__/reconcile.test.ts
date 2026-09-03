/**
 * The reconciliation core: what the database names is referenced, what a family rule calls
 * redundant is redundant, everything else under the prefix is an orphan, and rows without an
 * object are dangling. Ages and the never-delete list are pinned.
 */
import { describe, it, expect } from 'vitest';
import {
  deletable, exportSectionsRule, inlineCaptionsRule, isUnderAny, olderThan, parseAge, reconcileFamily, supersededRule,
  type BucketObject,
} from '../reconcile.js';

const obj = (key: string, size = 10, lastModified: string | null = '2026-08-01T00:00:00.000Z'): BucketObject => ({ key, size, lastModified });

describe('reconcileFamily', () => {
  it('classifies referenced / orphan / dangling and totals the bytes', () => {
    const r = reconcileFamily('crop', 'crop/', [obj('crop/v1.json'), obj('crop/v9.json', 30)], { keys: new Set(['crop/v1.json', 'crop/v2.json']), prefixes: new Set<string>() });
    expect(r.referenced.map((o) => o.key)).toEqual(['crop/v1.json']);
    expect(r.orphans.map((o) => o.key)).toEqual(['crop/v9.json']);
    expect(r.dangling).toEqual(['crop/v2.json']);
    expect(r.bytes).toBe(40);
  });

  it('a prefix a row names covers everything under it', () => {
    const r = reconcileFamily('dubs', 'dubs/', [obj('dubs/v1/he/hls/d1/seg0.ts'), obj('dubs/v1/he/hls/d2/seg0.ts')], { keys: new Set(), prefixes: new Set(['dubs/v1/he/hls/d1']) });
    expect(r.referenced).toHaveLength(1);
    expect(r.orphans.map((o) => o.key)).toEqual(['dubs/v1/he/hls/d2/seg0.ts']);
  });

  it('the family rule wins: a superseded thumbnail under a project prefix is redundant, the current one referenced', () => {
    const refs = { keys: new Set(['thumbnails/p1/cur.jpg']), prefixes: new Set(['thumbnails/p1']) };
    const r = reconcileFamily('thumbnails', 'thumbnails/', [obj('thumbnails/p1/cur.jpg'), obj('thumbnails/p1/old.jpg'), obj('thumbnails/p9/x.jpg')], refs, supersededRule('thumbnail'));
    expect(r.referenced.map((o) => o.key)).toEqual(['thumbnails/p1/cur.jpg']);
    expect(r.redundant.map((o) => [o.key, o.reason])).toEqual([['thumbnails/p1/old.jpg', 'a superseded thumbnail']]);
    expect(r.orphans.map((o) => o.key)).toEqual(['thumbnails/p9/x.jpg']);
  });

  it('sections/ of a finished export with a master are redundant; an unfinished export keeps them', () => {
    const rule = exportSectionsRule(new Set(['exports/p1/e1']));
    const refs = { keys: new Set(['exports/p1/e1/master.mp4']), prefixes: new Set(['exports/p1/e1', 'exports/p1/e2']) };
    const r = reconcileFamily('exports', 'exports/', [obj('exports/p1/e1/master.mp4'), obj('exports/p1/e1/sections/s1.mp4'), obj('exports/p1/e2/sections/s1.mp4')], refs, rule);
    expect(r.redundant.map((o) => o.key)).toEqual(['exports/p1/e1/sections/s1.mp4']);
    expect(r.referenced.map((o) => o.key).sort()).toEqual(['exports/p1/e1/master.mp4', 'exports/p1/e2/sections/s1.mp4']);
  });

  it('a stored VTT for a video whose captions are inline is redundant', () => {
    const rule = inlineCaptionsRule(new Set(['v1']));
    const refs = { keys: new Set(['captions/p1/v1/a.vtt', 'captions/p1/v2/b.vtt']), prefixes: new Set<string>() };
    const r = reconcileFamily('captions', 'captions/', [obj('captions/p1/v1/a.vtt'), obj('captions/p1/v2/b.vtt')], refs, rule);
    expect(r.redundant.map((o) => o.key)).toEqual(['captions/p1/v1/a.vtt']);
    expect(r.referenced.map((o) => o.key)).toEqual(['captions/p1/v2/b.vtt']);
  });
});

describe('ages and guards', () => {
  it('parses 7d / 36h / 90m and refuses anything else', () => {
    expect(parseAge('7d')).toBe(7 * 86_400_000);
    expect(parseAge('36h')).toBe(36 * 3_600_000);
    expect(parseAge('90m')).toBe(90 * 60_000);
    expect(() => parseAge('soon')).toThrow(/age must look like/);
  });

  it('olderThan keeps only objects with a known age past the grace', () => {
    const now = Date.parse('2026-09-03T00:00:00Z');
    const xs = [obj('a', 1, '2026-08-01T00:00:00.000Z'), obj('b', 1, '2026-09-02T00:00:00.000Z'), obj('c', 1, null)];
    expect(olderThan(xs, 7 * 86_400_000, now).map((o) => o.key)).toEqual(['a']);
  });

  it('never deletes under blobs/, hls/, editions/, videos/, nor the multipart family', () => {
    expect(deletable('thumbnails', 'thumbnails/')).toBe(true);
    expect(deletable('videos', 'videos/')).toBe(false);
    expect(deletable('editions', 'editions/')).toBe(false);
    expect(deletable('anything', 'hls/')).toBe(false);
    expect(deletable('anything', 'blobs/')).toBe(false);
    expect(deletable('multipart', 'multipart/')).toBe(false);
  });

  it('isUnderAny normalises the trailing slash so "abc" never matches "abcdef/"', () => {
    expect(isUnderAny('thumbnails/p1/x.jpg', new Set(['thumbnails/p1']))).toBe(true);
    expect(isUnderAny('thumbnails/p10/x.jpg', new Set(['thumbnails/p1']))).toBe(false);
  });
});
