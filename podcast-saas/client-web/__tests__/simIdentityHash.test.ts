/**
 * Identity derivation: the config hash, the package revision, and the minted ids.
 *
 * `configHash` is one of the five axes the reveal invariant compares AND the key a poster is stored
 * under, so it has two contradictory-looking requirements at once: it must be STABLE across
 * cosmetically different spellings of the same configuration (or the same picture is captured twice
 * and every acknowledgement for it is refused), and it must SEPARATE any two configurations that
 * would look different (or a poster shows one thing and the live section another). Both directions
 * are asserted here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_PRESENTATION_CONFIG,
  __resetIdCounterForTests,
  canonicalizeConfig,
  computeConfigHash,
  derivePackageRevision,
  newActivationId,
  newDocumentId,
  newPlayerSessionId,
  type SimAspectProfile,
  type SimPresentationConfig,
  type SimQualityProfile,
} from 'shared/src/sim/simIdentity';
import { sha256Hex } from 'shared/src/sim/sha256';
import {
  formatsFor,
  parsePosterPath,
  posterDirectory,
  posterIdentityString,
  posterMatches,
  posterStoragePath,
  sanitizeVariant,
  selectPosterVariant,
  type PosterKey,
  type PosterRecord,
} from 'shared/src/sim/posterIdentity';

const cfg = (over: Partial<SimPresentationConfig> = {}): SimPresentationConfig =>
  ({ ...DEFAULT_PRESENTATION_CONFIG, ...over });

// ── the canonical form ────────────────────────────────────────────────────────────────────────

describe('canonicalizeConfig — the golden form', () => {
  it('pins the canonical string for the default configuration', () => {
    // Pinned deliberately. The canonical form is a WIRE format in every sense that matters: posters
    // are stored under hashes of it and children recompute it independently, so an innocuous-looking
    // change to field order or separators invalidates every stored poster and refuses every
    // acknowledgement until both sides are redeployed together.
    expect(canonicalizeConfig(DEFAULT_PRESENTATION_CONFIG)).toBe(
      'simpleUi:0|autoScript:1|quality:high|aspect:wide|transparent:0|hide:[]|init:{}',
    );
  });

  it('pins the default config hash', () => {
    expect(computeConfigHash(DEFAULT_PRESENTATION_CONFIG)).toBe('d5026c03b5478e2e');
  });

  it('is exactly the first 16 hex characters of the sha256 of the canonical form', () => {
    for (const c of [DEFAULT_PRESENTATION_CONFIG, cfg({ simpleUi: true, quality: 'low' })]) {
      expect(computeConfigHash(c)).toBe(sha256Hex(canonicalizeConfig(c)).slice(0, 16));
      expect(computeConfigHash(c)).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});

describe('canonicalizeConfig — what must NOT change the hash', () => {
  it('ignores the order of hideSelectors', () => {
    // The selector list is semantically a SET: a list that differs only in order describes the same
    // picture, and hashing it as a sequence would mint a second poster and a second canary run.
    const a = cfg({ hideSelectors: ['#hud', '.controls', 'button.play'] });
    const b = cfg({ hideSelectors: ['button.play', '#hud', '.controls'] });
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });

  it('ignores duplicate hideSelectors', () => {
    expect(computeConfigHash(cfg({ hideSelectors: ['#hud', '#hud', '.x'] })))
      .toBe(computeConfigHash(cfg({ hideSelectors: ['.x', '#hud'] })));
  });

  it('ignores the key order of initialState', () => {
    const a = cfg({ initialState: { zoom: 2, angle: 30, paused: false } });
    const b = cfg({ initialState: { paused: false, angle: 30, zoom: 2 } });
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });

  it('treats a missing initialState and an explicit null as the same', () => {
    expect(computeConfigHash(cfg({ initialState: null })))
      .toBe(computeConfigHash(cfg({ initialState: undefined })));
    const withoutKey = { ...DEFAULT_PRESENTATION_CONFIG };
    delete (withoutKey as Partial<SimPresentationConfig>).initialState;
    expect(computeConfigHash(withoutKey)).toBe(computeConfigHash(cfg({ initialState: null })));
  });

  it('treats a missing transparent and an explicit false as the same', () => {
    const withoutKey = { ...DEFAULT_PRESENTATION_CONFIG };
    delete (withoutKey as Partial<SimPresentationConfig>).transparent;
    expect(computeConfigHash(withoutKey)).toBe(computeConfigHash(cfg({ transparent: false })));
  });

  it('collapses -0 and 0 in initialState', () => {
    expect(computeConfigHash(cfg({ initialState: { pan: -0 } })))
      .toBe(computeConfigHash(cfg({ initialState: { pan: 0 } })));
  });

  it('is stable across repeated calls and across equal-but-distinct objects', () => {
    const a = cfg({ simpleUi: true, hideSelectors: ['#a'], initialState: { k: 'v' } });
    const b = cfg({ simpleUi: true, hideSelectors: ['#a'], initialState: { k: 'v' } });
    expect(computeConfigHash(a)).toBe(computeConfigHash(a));
    expect(computeConfigHash(a)).toBe(computeConfigHash(b));
  });
});

describe('canonicalizeConfig — what MUST change the hash', () => {
  const variants: [string, SimPresentationConfig][] = [
    ['simpleUi', cfg({ simpleUi: true })],
    ['hideSelectors', cfg({ hideSelectors: ['#hud'] })],
    ['autoScript', cfg({ autoScript: false })],
    ['quality', cfg({ quality: 'low' })],
    ['aspect', cfg({ aspect: 'portrait' })],
    ['initialState', cfg({ initialState: { zoom: 2 } })],
    ['transparent', cfg({ transparent: true })],
  ];

  const base = computeConfigHash(DEFAULT_PRESENTATION_CONFIG);
  for (const [field, variant] of variants) {
    it(`changes when ${field} changes`, () => {
      expect(computeConfigHash(variant)).not.toBe(base);
    });
  }

  it('separates every quality and aspect profile', () => {
    const qualities: SimQualityProfile[] = ['high', 'balanced', 'low'];
    const aspects: SimAspectProfile[] = ['wide', 'standard', 'portrait', 'native'];
    const hashes = qualities.flatMap((quality) => aspects.map((aspect) => computeConfigHash(cfg({ quality, aspect }))));
    expect(new Set(hashes).size).toBe(qualities.length * aspects.length);
  });

  it('distinguishes a pinned null value from no pin at all', () => {
    expect(computeConfigHash(cfg({ initialState: { camera: null } })))
      .not.toBe(computeConfigHash(cfg({ initialState: {} })));
  });

  it('distinguishes a value type change with the same text', () => {
    expect(computeConfigHash(cfg({ initialState: { n: 1 } })))
      .not.toBe(computeConfigHash(cfg({ initialState: { n: '1' } })));
    expect(computeConfigHash(cfg({ initialState: { b: true } })))
      .not.toBe(computeConfigHash(cfg({ initialState: { b: 'true' } })));
  });

  it('cannot be forged by putting the field separators inside a value', () => {
    // Every string is JSON-encoded before it reaches the joined form, so a selector or a key
    // containing '|', ':' or a quote cannot impersonate another field.
    const injected = cfg({ hideSelectors: ['x"]|init:{"forged'] });
    const plain = cfg({ hideSelectors: ['x'] });
    expect(computeConfigHash(injected)).not.toBe(computeConfigHash(plain));
    expect(canonicalizeConfig(injected)).toContain('\\"');
  });

  it('never collides across a matrix of structurally distinct configurations', () => {
    const configs: SimPresentationConfig[] = [];
    for (const simpleUi of [false, true]) {
      for (const autoScript of [false, true]) {
        for (const transparent of [false, true]) {
          for (const quality of ['high', 'balanced', 'low'] as SimQualityProfile[]) {
            for (const aspect of ['wide', 'standard', 'portrait', 'native'] as SimAspectProfile[]) {
              for (const hideSelectors of [[], ['#hud'], ['#hud', '.controls']]) {
                configs.push(cfg({ simpleUi, autoScript, transparent, quality, aspect, hideSelectors }));
              }
            }
          }
        }
      }
    }
    expect(configs).toHaveLength(288);
    expect(new Set(configs.map(canonicalizeConfig)).size).toBe(configs.length);
    expect(new Set(configs.map(computeConfigHash)).size).toBe(configs.length);
  });
});

describe('canonicalizeConfig — inputs it must refuse', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`throws on a non-finite initialState value (${String(bad)})`, () => {
      // Silently becoming null would produce two configurations with one hash — one poster serving
      // two different pictures, which is the exact failure posters exist to prevent.
      expect(() => canonicalizeConfig(cfg({ initialState: { zoom: bad } }))).toThrow(/zoom/);
      expect(() => computeConfigHash(cfg({ initialState: { zoom: bad } }))).toThrow(/not finite/);
    });
  }

  it('does not throw on a non-finite value hiding behind a string', () => {
    expect(() => computeConfigHash(cfg({ initialState: { zoom: 'NaN' } }))).not.toThrow();
  });
});

// ── package revision ──────────────────────────────────────────────────────────────────────────

describe('derivePackageRevision', () => {
  it('is deterministic and 16 lowercase hex characters', () => {
    const rev = derivePackageRevision('11111111-2222-3333-4444-555555555555', 'abc123');
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
    expect(rev).toBe(derivePackageRevision('11111111-2222-3333-4444-555555555555', 'abc123'));
  });

  it('changes when the bridge is regenerated', () => {
    const before = derivePackageRevision('sim-1', 'bridge_a');
    const after = derivePackageRevision('sim-1', 'bridge_b');
    expect(before).not.toBe(after);
  });

  it('changes between simulations', () => {
    expect(derivePackageRevision('sim-1', 'bridge_a')).not.toBe(derivePackageRevision('sim-2', 'bridge_a'));
  });

  it('treats a null and an undefined bridge hash identically', () => {
    expect(derivePackageRevision('sim-1', null)).toBe(derivePackageRevision('sim-1', undefined));
  });

  it('is unambiguous across the id and hash shapes it is actually given', () => {
    // Ids are UUIDs and bridge hashes are hex, so neither contains the space that separates them.
    const ids = ['11111111-2222-3333-4444-555555555555', '66666666-7777-8888-9999-000000000000', 'sim-1', 'sim-12'];
    const hashes = ['abc', 'abcd', null, 'deadbeef'];
    const revisions = ids.flatMap((id) => hashes.map((h) => derivePackageRevision(id, h)));
    expect(new Set(revisions).size).toBe(revisions.length);
  });
});

// ── id minting ────────────────────────────────────────────────────────────────────────────────

describe('id minting', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prefixes each id with its kind, so telemetry is readable', () => {
    expect(newPlayerSessionId()).toMatch(/^ps_/);
    expect(newDocumentId()).toMatch(/^doc_/);
    expect(newActivationId()).toMatch(/^act_/);
  });

  it('never collides across 10,000 activations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(newActivationId());
    expect(ids.size).toBe(10_000);
  });

  it('never collides even when the counter is reset under it', () => {
    // Two players on one page — the editor timeline and the section-editor preview do this by
    // design — mint from independent counters. A bare counter would collide, and a collision here
    // is a stale message that PASSES the identity check, which is the one outcome that must be
    // impossible.
    __resetIdCounterForTests();
    const first = Array.from({ length: 1_000 }, () => newActivationId());
    __resetIdCounterForTests();
    const second = Array.from({ length: 1_000 }, () => newActivationId());
    expect(new Set([...first, ...second]).size).toBe(2_000);
  });

  it('still mints unique ids without a crypto implementation', () => {
    // The generated child bridge and older embedded webviews may have no WebCrypto at all. These
    // ids are anti-COLLISION, never anti-forgery, so Math.random is an acceptable fallback — but it
    // must still not collide.
    vi.stubGlobal('crypto', undefined);
    const ids = new Set<string>();
    for (let i = 0; i < 5_000; i++) ids.add(newDocumentId());
    expect(ids.size).toBe(5_000);
  });

  it('mints different ids for the three kinds even at the same counter value', () => {
    __resetIdCounterForTests();
    const a = newPlayerSessionId();
    __resetIdCounterForTests();
    const b = newDocumentId();
    expect(a).not.toBe(b);
  });
});

// ── the config hash's second consumer: poster identity ────────────────────────────────────────

describe('poster identity is derived from the same hash', () => {
  const key = (over: Partial<PosterKey> = {}): PosterKey => ({
    packageRevision: 'rev_aaaa',
    variantKey: '11111111-2222-3333-4444-555555555555',
    configHash: computeConfigHash(DEFAULT_PRESENTATION_CONFIG),
    aspectProfile: 'wide',
    qualityProfile: 'high',
    ...over,
  });

  it('changes the stored path when the configuration changes', () => {
    // This is what makes poster invalidation automatic: a new configuration simply has no poster
    // yet, rather than silently reusing one that shows the old picture.
    const a = posterStoragePath('simulations/p/s', key(), 'standard', 'webp');
    const b = posterStoragePath('simulations/p/s', key({ configHash: computeConfigHash(cfg({ simpleUi: true })) }), 'standard', 'webp');
    expect(a).not.toBe(b);
  });

  it('keeps the path stable for two spellings of the same configuration', () => {
    const one = computeConfigHash(cfg({ hideSelectors: ['#hud', '.x'] }));
    const other = computeConfigHash(cfg({ hideSelectors: ['.x', '#hud', '#hud'] }));
    expect(posterStoragePath('p', key({ configHash: one }), 'standard', 'webp'))
      .toBe(posterStoragePath('p', key({ configHash: other }), 'standard', 'webp'));
  });

  it('stores posters under the simulation prefix so deleting the simulation removes them', () => {
    const path = posterStoragePath('simulations/proj/sim/', key(), 'compact', 'png');
    expect(path.startsWith('simulations/proj/sim/posters/')).toBe(true);
    expect(path.endsWith('/compact.png')).toBe(true);
    expect(posterDirectory('simulations/proj/sim', key())).toBe(`simulations/proj/sim/posters/${posterIdentityString(key())}`);
  });

  it('cannot be made to escape the prefix by a hostile variant key', () => {
    expect(sanitizeVariant('../../etc/passwd')).toBe('______etc_passwd');
    expect(sanitizeVariant('')).toBe('_');
    expect(sanitizeVariant('a'.repeat(200))).toHaveLength(128);
    const path = posterStoragePath('simulations/p/s', key({ variantKey: '../../secret' }), 'standard', 'webp');
    expect(path).not.toContain('..');
    expect(path.split('/').filter((s) => s === '..')).toEqual([]);
  });

  it('round-trips through parsePosterPath, and ignores unrelated objects', () => {
    const k = key();
    const path = posterStoragePath('simulations/p/s', k, 'standard', 'webp');
    expect(parsePosterPath(path)).toEqual({ identity: posterIdentityString(k), size: 'standard', format: 'webp' });
    expect(parsePosterPath('simulations/p/s/index.html')).toBeNull();
    expect(parsePosterPath('simulations/p/s/posters/ident/standard.txt')).toBeNull();
  });

  it('matches a stored record only for its exact identity', () => {
    const k = key();
    const record: PosterRecord = {
      key: k,
      identity: posterIdentityString(k),
      variants: [
        { size: 'standard', format: 'webp', path: 'p/standard.webp', checksum: 'c', contentType: 'image/webp', width: 1280, height: 720, bytes: 100 },
        { size: 'standard', format: 'png', path: 'p/standard.png', checksum: 'c', contentType: 'image/png', width: 1280, height: 720, bytes: 400 },
      ],
      transparent: false,
      capturedAt: '2026-01-01T00:00:00.000Z',
      packageRevision: k.packageRevision,
    };
    expect(posterMatches(record, k)).toBe(true);
    expect(posterMatches(record, key({ qualityProfile: 'low' }))).toBe(false);
    expect(posterMatches(record, key({ configHash: computeConfigHash(cfg({ transparent: true })) }))).toBe(false);

    expect(selectPosterVariant(record, 'standard', ['webp', 'png'])?.format).toBe('webp');
    expect(selectPosterVariant(record, 'standard', ['png'])?.format).toBe('png');
    // A rendition in an unexpected format still shows the right picture; none of the right size does not.
    expect(selectPosterVariant(record, 'standard', ['avif'])?.format).toBe('webp');
    expect(selectPosterVariant(record, 'compact', ['webp'])).toBeNull();
  });

  it('captures a transparent section as PNG only', () => {
    // A transparent simulation renders over video; a WebP/AVIF cover would paint an opaque
    // rectangle over the very video the section sits on top of.
    expect(formatsFor(true)).toEqual(['png']);
    expect(formatsFor(false)[0]).toBe('webp');
  });
});
