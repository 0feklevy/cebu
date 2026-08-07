/**
 * Poster identity and storage paths — shared-side.
 *
 * RELATIONSHIP TO client-web/__tests__/simIdentityHash.test.ts
 * That file checks poster paths as a consequence of the config hash: one round-trip, one hostile
 * variant key, one transparent-capture case. Three exported functions have NO test in any
 * workspace — `parsePosterVariants`, `posterRootPrefix` and the `POSTER_SIZES` table — and this file
 * is where they are covered. `parsePosterVariants` in particular reads JSONB straight out of the
 * database, so its input is genuinely unknown at runtime (rows predate schema changes, and a
 * hand-repaired row is a real thing); it is the one function here that a malformed row reaches
 * directly.
 *
 * The path round-trip is also widened from one case to the full 4 x 3 x 2 x 3 matrix, because the
 * cleanup sweep parses EVERY object under the prefix and a shape it cannot parse is either an
 * orphan left forever or a live poster deleted.
 */
import { describe, it, expect } from 'vitest';
import {
  POSTER_CONTENT_TYPES,
  POSTER_FORMAT_ORDER,
  POSTER_SIZES,
  formatsFor,
  parsePosterPath,
  parsePosterVariants,
  posterDirectory,
  posterIdentityString,
  posterMatches,
  posterRootPrefix,
  posterStoragePath,
  sanitizeVariant,
  selectPosterVariant,
  type PosterFormat,
  type PosterKey,
  type PosterRecord,
  type PosterSizeName,
  type PosterVariantRecord,
} from '../posterIdentity.js';
import type { SimAspectProfile, SimQualityProfile } from '../simIdentity.js';

const ASPECTS: SimAspectProfile[] = ['wide', 'standard', 'portrait', 'native'];
const QUALITIES: SimQualityProfile[] = ['high', 'balanced', 'low'];
const SIZES: PosterSizeName[] = ['compact', 'standard'];

const PREFIX = 'simulations/proj-1/sim-1';

const key = (over: Partial<PosterKey> = {}): PosterKey => ({
  packageRevision: 'a3f9c1d0e7b45268',
  variantKey: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  configHash: '0123456789abcdef',
  aspectProfile: 'wide',
  qualityProfile: 'high',
  ...over,
});

describe('POSTER_SIZES', () => {
  it('offers exactly two sizes for every aspect profile', () => {
    // Two, not a ladder: a third intermediate size measurably doubles canary time for a difference
    // no one can see at these compression levels.
    expect(Object.keys(POSTER_SIZES).sort()).toEqual([...ASPECTS].sort());
    for (const aspect of ASPECTS) {
      const sizes = POSTER_SIZES[aspect];
      expect(sizes).toHaveLength(2);
      expect(sizes.map((s) => s.name).sort()).toEqual(['compact', 'standard']);
    }
  });

  it('makes compact exactly half of standard in both dimensions', () => {
    for (const aspect of ASPECTS) {
      const standard = POSTER_SIZES[aspect].find((s) => s.name === 'standard')!;
      const compact = POSTER_SIZES[aspect].find((s) => s.name === 'compact')!;
      expect(compact.width * 2).toBe(standard.width);
      expect(compact.height * 2).toBe(standard.height);
    }
  });

  it('gives every size a positive integer dimension', () => {
    for (const aspect of ASPECTS) {
      for (const size of POSTER_SIZES[aspect]) {
        expect(Number.isInteger(size.width)).toBe(true);
        expect(Number.isInteger(size.height)).toBe(true);
        expect(size.width).toBeGreaterThan(0);
        expect(size.height).toBeGreaterThan(0);
      }
    }
  });

  it('orients each profile the way its name claims', () => {
    // A portrait poster laid out landscape is letterboxed on a phone, which is the defect the
    // per-aspect capture exists to avoid.
    const isLandscape = (a: SimAspectProfile) => POSTER_SIZES[a][0].width > POSTER_SIZES[a][0].height;
    expect(isLandscape('wide')).toBe(true);
    expect(isLandscape('standard')).toBe(true);
    expect(isLandscape('portrait')).toBe(false);
    expect(isLandscape('native')).toBe(true);
  });
});

describe('posterIdentityString and the storage path', () => {
  it('round-trips through parsePosterPath for the whole aspect x quality x size x format matrix', () => {
    const failures: string[] = [];
    let cases = 0;
    for (const aspectProfile of ASPECTS) {
      for (const qualityProfile of QUALITIES) {
        for (const size of SIZES) {
          for (const format of POSTER_FORMAT_ORDER) {
            cases++;
            const k = key({ aspectProfile, qualityProfile });
            const path = posterStoragePath(PREFIX, k, size, format);
            const parsed = parsePosterPath(path);
            if (!parsed) { failures.push(`unparsable: ${path}`); continue; }
            if (parsed.identity !== posterIdentityString(k)) failures.push(`identity: ${path}`);
            if (parsed.size !== size) failures.push(`size: ${path}`);
            if (parsed.format !== format) failures.push(`format: ${path}`);
          }
        }
      }
    }
    expect(cases).toBe(4 * 3 * 2 * 3);
    expect(failures).toEqual([]);
  });

  it('mints a distinct identity for every point in that matrix', () => {
    const identities = new Set<string>();
    for (const aspectProfile of ASPECTS) {
      for (const qualityProfile of QUALITIES) identities.add(posterIdentityString(key({ aspectProfile, qualityProfile })));
    }
    expect(identities.size).toBe(ASPECTS.length * QUALITIES.length);
  });

  it('returns null for anything that is not a poster path, rather than a wrong identity', () => {
    // The cleanup sweep lists everything under the prefix and deletes what it can attribute. An
    // unrelated object parsed into a plausible identity would be an unrelated object deleted.
    const notPosters = [
      `${PREFIX}/index.html`,
      `${PREFIX}/posters/`,
      `${PREFIX}/posters/ident/standard.txt`,
      `${PREFIX}/posters/ident/standard`,
      `${PREFIX}/postersident/standard.webp`,
      `${PREFIX}/posters/ident/sub/dir/standard.webp`.replace('/posters/', '/other/'),
      'posters/ident/standard.webp',
      '',
    ];
    for (const path of notPosters) expect(parsePosterPath(path)).toBeNull();
  });

  it('normalises a trailing slash on the prefix so one caller cannot mint a doubled path', () => {
    const k = key();
    expect(posterStoragePath(`${PREFIX}/`, k, 'standard', 'webp')).toBe(posterStoragePath(PREFIX, k, 'standard', 'webp'));
    expect(posterStoragePath(`${PREFIX}///`, k, 'standard', 'webp')).toBe(posterStoragePath(PREFIX, k, 'standard', 'webp'));
    expect(posterDirectory(`${PREFIX}/`, k)).toBe(posterDirectory(PREFIX, k));
    expect(posterRootPrefix(`${PREFIX}/`)).toBe(posterRootPrefix(PREFIX));
  });

  it('nests root prefix -> directory -> path, so deleting the simulation removes its posters', () => {
    // Posters live UNDER the simulation's own prefix on purpose: a top-level `posters/` would have
    // left every poster of every deleted simulation orphaned forever with no owner to attribute
    // them to.
    const k = key();
    const root = posterRootPrefix(PREFIX);
    const dir = posterDirectory(PREFIX, k);
    const path = posterStoragePath(PREFIX, k, 'compact', 'png');
    expect(root).toBe(`${PREFIX}/posters`);
    expect(dir.startsWith(`${root}/`)).toBe(true);
    expect(path.startsWith(`${dir}/`)).toBe(true);
    expect(path.startsWith(`${PREFIX}/`)).toBe(true);
  });

  it('holds every size and format of one identity in a single directory', () => {
    const k = key();
    const dir = posterDirectory(PREFIX, k);
    for (const size of SIZES) {
      for (const format of POSTER_FORMAT_ORDER) {
        expect(posterStoragePath(PREFIX, k, size, format)).toBe(`${dir}/${size}.${format}`);
      }
    }
  });
});

describe('sanitizeVariant — the only unbounded component of a storage path', () => {
  it('replaces every character outside [A-Za-z0-9_-]', () => {
    expect(sanitizeVariant('a/b')).toBe('a_b');
    expect(sanitizeVariant('a.b')).toBe('a_b');
    expect(sanitizeVariant('a b')).toBe('a_b');
    expect(sanitizeVariant('sec-1_2')).toBe('sec-1_2');
    expect(sanitizeVariant('é日🌍')).toMatch(/^_+$/);
  });

  it('never lets a hostile key escape the prefix or open a new directory', () => {
    const hostile = ['../../etc/passwd', '..', '../', 'a/../../b', '/absolute', 'x?y=z', 'a\nb'];
    for (const variantKey of hostile) {
      const path = posterStoragePath(PREFIX, key({ variantKey }), 'standard', 'webp');
      expect(path.startsWith(`${PREFIX}/posters/`)).toBe(true);
      expect(path.split('/').filter((s) => s === '..')).toEqual([]);
      // Exactly the segments the grammar allows: prefix(3) + posters + identity + file.
      expect(path.split('/')).toHaveLength(PREFIX.split('/').length + 3);
    }
  });

  it('bounds the length, so a pathological key cannot produce an unstorable path', () => {
    expect(sanitizeVariant('a'.repeat(500))).toHaveLength(128);
    expect(sanitizeVariant('a'.repeat(128))).toHaveLength(128);
    expect(sanitizeVariant('a'.repeat(127))).toHaveLength(127);
  });

  it("substitutes '_' for a key that sanitises to nothing, so no path component is ever empty", () => {
    // An empty component would produce '…/posters//standard.webp', which parses back to a different
    // identity than it was written for.
    expect(sanitizeVariant('')).toBe('_');
    const path = posterStoragePath(PREFIX, key({ variantKey: '' }), 'standard', 'webp');
    expect(path).not.toContain('//');
    expect(parsePosterPath(path)).not.toBeNull();
  });

  it('is applied by posterIdentityString, not merely available next to it', () => {
    expect(posterIdentityString(key({ variantKey: 'a/b' }))).toContain('a_b');
    expect(posterIdentityString(key({ variantKey: 'a/b' }))).not.toContain('a/b');
  });
});

describe('formatsFor — transparency forces PNG', () => {
  it('captures a transparent section as PNG only', () => {
    // A transparent simulation renders over video. A WebP cover would paint an opaque rectangle over
    // the video the section is supposed to sit on top of — the "black box over the video" defect.
    expect(formatsFor(true)).toEqual(['png']);
  });

  it('prefers WebP first for an opaque section', () => {
    // AVIF is smaller but decodes slowly enough on weak devices that using it FIRST for a cover
    // that must appear instantly is the wrong trade.
    expect(formatsFor(false)).toEqual(['webp', 'avif', 'png']);
    expect(formatsFor(false)[0]).toBe('webp');
  });

  it('names a content type for every format it can emit', () => {
    for (const format of POSTER_FORMAT_ORDER) {
      expect(POSTER_CONTENT_TYPES[format]).toMatch(/^image\//);
    }
    expect(Object.keys(POSTER_CONTENT_TYPES).sort()).toEqual([...POSTER_FORMAT_ORDER].sort());
  });
});

describe('parsePosterVariants — reading a JSONB column whose contents are genuinely unknown', () => {
  const good = (over: Partial<PosterVariantRecord> = {}): Record<string, unknown> => ({
    size: 'standard',
    format: 'webp',
    path: `${PREFIX}/posters/i/standard.webp`,
    checksum: 'deadbeef',
    contentType: 'image/webp',
    width: 1280,
    height: 720,
    bytes: 4096,
    ...over,
  });

  it('returns an empty list for anything that is not an array', () => {
    for (const raw of [null, undefined, 0, '', 'x', {}, true, new Date()]) {
      expect(parsePosterVariants(raw)).toEqual([]);
    }
  });

  it('keeps a well-formed entry verbatim', () => {
    const [record] = parsePosterVariants([good()]);
    expect(record).toEqual({
      size: 'standard', format: 'webp', path: `${PREFIX}/posters/i/standard.webp`,
      checksum: 'deadbeef', contentType: 'image/webp', width: 1280, height: 720, bytes: 4096,
    });
  });

  it('drops a malformed entry WITHOUT dropping the good ones beside it', () => {
    // One bad variant must not make an otherwise usable poster unreadable, and must not make a
    // whole player-config render fail because of one row.
    const raw = [
      null,
      'not an object',
      42,
      good({ size: 'huge' as PosterSizeName }),
      good({ format: 'gif' as PosterFormat }),
      good({ path: '' }),
      { ...good(), path: 123 },
      good({ checksum: '' }),
      { ...good(), checksum: null },
      good({ path: `${PREFIX}/posters/i/compact.png`, size: 'compact', format: 'png' }),
      good(),
    ];
    const out = parsePosterVariants(raw);
    expect(out).toHaveLength(2);
    expect(out.map((v) => `${v.size}.${v.format}`)).toEqual(['compact.png', 'standard.webp']);
  });

  it('fills a missing contentType from the format rather than emitting undefined', () => {
    const entry = good();
    delete entry.contentType;
    expect(parsePosterVariants([entry])[0].contentType).toBe('image/webp');
    const avif = good({ format: 'avif' });
    delete avif.contentType;
    expect(parsePosterVariants([avif])[0].contentType).toBe('image/avif');
  });

  it('coerces missing or non-numeric dimensions to 0 rather than NaN', () => {
    // NaN survives JSON.stringify as null and compares false with itself; a 0 is at least a value a
    // caller can test.
    const entry = { ...good(), width: 'wide', height: undefined, bytes: null };
    const [record] = parsePosterVariants([entry]);
    expect(record.width).toBe(0);
    expect(record.height).toBe(0);
    expect(record.bytes).toBe(0);
  });

  it('validates only the four fields it claims to — the path is NOT parsed', () => {
    // Stated so nobody downstream treats `path` as validated. It is required to be a non-empty
    // string and nothing more; a caller building a public URL from it must check the grammar
    // itself, with parsePosterPath.
    const [record] = parsePosterVariants([good({ path: 'anything-at-all' })]);
    expect(record.path).toBe('anything-at-all');
    expect(parsePosterPath(record.path)).toBeNull();
  });
});

describe('selectPosterVariant', () => {
  const variants: PosterVariantRecord[] = [
    { size: 'standard', format: 'png', path: 'p/standard.png', checksum: 'a', contentType: 'image/png', width: 1280, height: 720, bytes: 9 },
    { size: 'standard', format: 'webp', path: 'p/standard.webp', checksum: 'b', contentType: 'image/webp', width: 1280, height: 720, bytes: 4 },
    { size: 'standard', format: 'avif', path: 'p/standard.avif', checksum: 'c', contentType: 'image/avif', width: 1280, height: 720, bytes: 3 },
    { size: 'compact', format: 'png', path: 'p/compact.png', checksum: 'd', contentType: 'image/png', width: 640, height: 360, bytes: 5 },
  ];
  const record = { variants };

  it('honours the module preference order, not the caller-supplied order', () => {
    // A caller listing what the browser supports has no opinion about which is BEST; the trade-off
    // between size and decode cost belongs to this module.
    expect(selectPosterVariant(record, 'standard', ['avif', 'png', 'webp'])!.format).toBe('webp');
    expect(selectPosterVariant(record, 'standard', ['png', 'avif'])!.format).toBe('avif');
    expect(selectPosterVariant(record, 'standard', ['png'])!.format).toBe('png');
  });

  it('falls back to any rendition of the right size when none is supported', () => {
    // A poster in an unexpected format still shows the RIGHT picture; the browser either decodes it
    // or falls through to the no-poster path, both of which beat showing a differently-sized one.
    const chosen = selectPosterVariant(record, 'compact', []);
    expect(chosen).not.toBeNull();
    expect(chosen!.size).toBe('compact');
  });

  it('never returns a rendition of the wrong size', () => {
    for (const size of SIZES) {
      for (const supported of [[], ['webp'], ['png', 'avif'], POSTER_FORMAT_ORDER] as PosterFormat[][]) {
        const chosen = selectPosterVariant(record, size, supported);
        if (chosen) expect(chosen.size).toBe(size);
      }
    }
  });

  it('returns null when the size is absent entirely', () => {
    expect(selectPosterVariant({ variants: [] }, 'standard', POSTER_FORMAT_ORDER)).toBeNull();
    expect(selectPosterVariant({ variants: variants.filter((v) => v.size === 'standard') }, 'compact', POSTER_FORMAT_ORDER))
      .toBeNull();
  });
});

describe('posterMatches — invalidation is automatic because the identity IS the key', () => {
  const record: PosterRecord = {
    key: key(),
    identity: posterIdentityString(key()),
    variants: [],
    transparent: false,
    capturedAt: '2026-01-01T00:00:00.000Z',
    packageRevision: key().packageRevision,
  };

  it('matches its own key', () => {
    expect(posterMatches(record, key())).toBe(true);
  });

  it('stops matching when ANY axis of the key changes', () => {
    const axes: Partial<PosterKey>[] = [
      { packageRevision: 'ffffffffffffffff' },
      { variantKey: 'another-section' },
      { configHash: 'ffffffffffffffff' },
      { aspectProfile: 'portrait' },
      { qualityProfile: 'low' },
    ];
    for (const over of axes) expect(posterMatches(record, key(over))).toBe(false);
    expect(axes).toHaveLength(Object.keys(key()).length);
  });
});
