/**
 * The identity model — shared-side.
 *
 * RELATIONSHIP TO client-web/__tests__/simIdentityHash.test.ts
 * That file covers `canonicalizeConfig` / `computeConfigHash` / `derivePackageRevision` / id minting
 * thoroughly, and this file does not restate it. Two things it does not touch at all:
 *
 *   • `variantParamOf` and `variantKeyFor` have NO test in any workspace. They decide the dispatch
 *     key of every pooled section and the poster key of every capture, and the rule they encode
 *     ("the ?section= URL param is authoritative, never sim_script, never the row id") was arrived
 *     at by fixing a real defect: duplicated sections keep the ORIGINAL's URL, and `sim_script` is
 *     the literal 'main' on every generated row. Keying on either one served the wrong
 *     sub-simulation. That rule is now only enforced by this file.
 *   • Id minting under REAL WebCrypto. client-web's suite runs in jsdom and its interesting case is
 *     the `Math.random` fallback for an environment with no crypto. The server takes the other
 *     branch, and that is the branch tested here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_PRESENTATION_CONFIG,
  canonicalizeConfig,
  computeConfigHash,
  derivePackageRevision,
  newActivationId,
  newDocumentId,
  newPlayerSessionId,
  variantKeyFor,
  variantParamOf,
  __resetIdCounterForTests,
  type SimAspectProfile,
  type SimPresentationConfig,
  type SimQualityProfile,
} from '../simIdentity.js';
import { sha256Hex } from '../sha256.js';

// ── variantParamOf ────────────────────────────────────────────────────────────────────────────

describe('variantParamOf — the URL parameter that names the sub-simulation', () => {
  const CASES: Record<string, { url: string; expect: string | null }> = {
    'absolute URL': { url: 'https://api.example.com/sim-public/p/s/index.html?section=abc', expect: 'abc' },
    'root-relative path (a stored value from before the URL shape changed)': {
      url: '/sim-public/p/s/index.html?section=abc',
      expect: 'abc',
    },
    'bare relative filename': { url: 'index.html?section=s2', expect: 's2' },
    'section after another parameter': { url: 'sim.html?v=1&section=s2', expect: 's2' },
    'section before another parameter': { url: 'sim.html?section=s2&v=1', expect: 's2' },
    'percent-encoded value': { url: '?section=a%20b', expect: 'a b' },
    'plus is a space in a query string': { url: '?section=a+b', expect: 'a b' },
    'value containing a slash': { url: '?section=a/b', expect: 'a/b' },
    'trailing fragment is not part of the value': { url: '?section=a#frag', expect: 'a' },
    'first wins when the parameter repeats': { url: '?section=a&section=b', expect: 'a' },
    'no query at all': { url: '/sim-public/p/s/index.html', expect: null },
    'a different parameter': { url: '?v=1', expect: null },
    'the name is case-sensitive': { url: '?SECTION=a', expect: null },
    'a parameter merely ENDING in section does not match': { url: '?xsection=a', expect: null },
    'in the fragment, not the query': { url: '#section=a', expect: null },
    'query inside a fragment is not a query': { url: 'x#a?section=b', expect: null },
    'empty string': { url: '', expect: null },
    'present but empty': { url: '?section=', expect: '' },
  };

  for (const [name, c] of Object.entries(CASES)) {
    it(`reads ${name}`, () => {
      expect(variantParamOf(c.url)).toBe(c.expect);
    });
  }

  describe('the regex fallback, for stored values the URL parser refuses', () => {
    // The fallback is not decoration: these shapes really do throw ERR_INVALID_URL even with a
    // base, and a stored row containing one must still yield its variant rather than crash the
    // player-config build for the whole project.
    const MALFORMED: Record<string, { url: string; expect: string | null }> = {
      'empty authority': { url: 'http://?section=abc', expect: 'abc' },
      'protocol-relative with empty host': { url: '//?section=abc', expect: 'abc' },
      'unterminated IPv6 literal': { url: 'http://[?section=a%20b', expect: 'a b' },
      'non-numeric port': { url: '//host:notaport/x?section=s9', expect: 's9' },
      'malformed and carrying no section': { url: 'http://', expect: null },
    };

    for (const [name, c] of Object.entries(MALFORMED)) {
      it(`recovers the variant from a URL with an ${name}`, () => {
        expect(() => variantParamOf(c.url)).not.toThrow();
        expect(variantParamOf(c.url)).toBe(c.expect);
      });
    }

    it('really is reaching the fallback — the URL constructor rejects these inputs', () => {
      // Guards the test above from becoming vacuous if a future Node stops throwing: the fallback
      // cases would then silently be testing the primary path instead.
      for (const url of ['http://?section=abc', '//?section=abc', 'http://[?section=a%20b']) {
        expect(() => new URL(url, 'http://x')).toThrow();
      }
    });
  });

  it('never throws, whatever it is handed', () => {
    const hostile = ['', ' ', '?', '#', '??section=a', '%', '?section=%', '?section=%zz', 'a'.repeat(5000)];
    for (const url of hostile) {
      expect(() => variantParamOf(url)).not.toThrow();
    }
  });
});

// ── variantKeyFor ─────────────────────────────────────────────────────────────────────────────

describe('variantKeyFor — the dispatch key, and what must never become it', () => {
  it('prefers the ?section= parameter over everything else', () => {
    const key = variantKeyFor({
      id: 'row-uuid-1',
      simulation_url: '/sim-public/p/s/index.html?section=sec-original',
      sim_script: 'main',
    });
    expect(key).toBe('sec-original');
  });

  it('gives a DUPLICATED section the SAME key as its original — they share one package body', () => {
    // A copy keeps the original's URL. Its own row id has no body in the bridge, so keying on the
    // row id would dispatch to a variant the package cannot serve.
    const url = '/sim-public/p/s/index.html?section=sec-original';
    const original = variantKeyFor({ id: 'row-uuid-1', simulation_url: url, sim_script: 'main' });
    const copy = variantKeyFor({ id: 'row-uuid-2-a-copy', simulation_url: url, sim_script: 'main' });
    expect(copy).toBe(original);
    expect(copy).not.toBe('row-uuid-2-a-copy');
  });

  it("never returns the literal 'main' — it is a legacy entry-point name, not a section identity", () => {
    // Every generated row persists sim_script = 'main'. If that became the key, every section of
    // every package would share one key and a pooled document would serve whichever section
    // happened to be pooled first.
    const rows = [
      { id: 'row-a', simulation_url: null, sim_script: 'main' },
      { id: 'row-b', simulation_url: '/x/index.html', sim_script: 'main' },
      { id: 'row-c', simulation_url: '/x/index.html?v=1', sim_script: 'main' },
      { id: 'row-d', simulation_url: '/x/index.html?section=', sim_script: 'main' },
    ];
    const keys = rows.map(variantKeyFor);
    expect(keys).not.toContain('main');
    // …and distinct rows without a URL param stay distinct.
    expect(new Set(keys).size).toBe(rows.length);
  });

  it('falls back to a REAL named script when the URL carries no parameter', () => {
    expect(variantKeyFor({ id: 'row-a', simulation_url: '/x/index.html', sim_script: 'orbit' })).toBe('orbit');
    expect(variantKeyFor({ id: 'row-a', simulation_url: null, sim_script: 'orbit' })).toBe('orbit');
  });

  it('falls back to the row id only when there is nothing else', () => {
    expect(variantKeyFor({ id: 'row-a' })).toBe('row-a');
    expect(variantKeyFor({ id: 'row-a', simulation_url: null, sim_script: null })).toBe('row-a');
    expect(variantKeyFor({ id: 'row-a', simulation_url: '', sim_script: '' })).toBe('row-a');
  });

  it('treats an EMPTY ?section= as absent rather than as a variant named ""', () => {
    // An empty key would be indistinguishable from "no key" downstream, and would mint a poster
    // path with an empty component.
    expect(variantKeyFor({ id: 'row-a', simulation_url: '/x/i.html?section=', sim_script: 'main' })).toBe('row-a');
    expect(variantKeyFor({ id: 'row-a', simulation_url: '/x/i.html?section=', sim_script: 'orbit' })).toBe('orbit');
  });

  it('always returns a non-empty string, for every combination of missing fields', () => {
    const urls = [undefined, null, '', '/x/i.html', '/x/i.html?section=', '/x/i.html?section=s1', 'http://'];
    const scripts = [undefined, null, '', 'main', 'orbit'];
    for (const simulation_url of urls) {
      for (const sim_script of scripts) {
        const key = variantKeyFor({ id: 'row-a', simulation_url, sim_script });
        expect(key.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── canonicalizeConfig / computeConfigHash ────────────────────────────────────────────────────

const cfg = (over: Partial<SimPresentationConfig> = {}): SimPresentationConfig => ({
  ...DEFAULT_PRESENTATION_CONFIG,
  ...over,
});

describe('canonicalizeConfig — hideSelectors is a SET, including under a unicode sort', () => {
  it('is invariant to the order of selectors that sort differently as UTF-16 code units', () => {
    // `Array.prototype.sort` orders by code unit, so an astral selector sorts after every BMP one.
    // Whatever the order, the canonical form must be the same — otherwise two spellings of one
    // picture mint two posters and two canary runs.
    const selectors = ['#hud', '.a', '𝄞marker', 'é-panel', '日本', '.z'];
    const forward = canonicalizeConfig(cfg({ hideSelectors: [...selectors] }));
    const reversed = canonicalizeConfig(cfg({ hideSelectors: [...selectors].reverse() }));
    const shuffled = canonicalizeConfig(cfg({ hideSelectors: ['日本', '.z', '#hud', '𝄞marker', 'é-panel', '.a'] }));
    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it('deduplicates before sorting, so a repeated selector cannot change the hash', () => {
    const once = computeConfigHash(cfg({ hideSelectors: ['#hud', '.controls'] }));
    const twice = computeConfigHash(cfg({ hideSelectors: ['.controls', '#hud', '#hud', '.controls', '#hud'] }));
    expect(twice).toBe(once);
  });

  it('still distinguishes selectors that differ only in whitespace or case', () => {
    // Deduplication is exact-string, not semantic. Two selectors that a browser would treat alike
    // are still different pictures as far as the mechanical hide is concerned.
    const a = computeConfigHash(cfg({ hideSelectors: ['.a > .b'] }));
    const b = computeConfigHash(cfg({ hideSelectors: ['.a>.b'] }));
    const c = computeConfigHash(cfg({ hideSelectors: ['.A > .b'] }));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('computeConfigHash — every semantic field is load-bearing', () => {
  /**
   * A total record over the mutable fields: adding a field to SimPresentationConfig without giving
   * it a distinguishing value here is a COMPILE error, so a new axis cannot silently drop out of
   * the hash.
   */
  const MUTATIONS: Record<keyof SimPresentationConfig, SimPresentationConfig> = {
    simpleUi: cfg({ simpleUi: true }),
    hideSelectors: cfg({ hideSelectors: ['#hud'] }),
    autoScript: cfg({ autoScript: false }),
    quality: cfg({ quality: 'low' }),
    aspect: cfg({ aspect: 'portrait' }),
    initialState: cfg({ initialState: { zoom: 2 } }),
    transparent: cfg({ transparent: true }),
  };

  const base = computeConfigHash(DEFAULT_PRESENTATION_CONFIG);

  for (const [field, mutated] of Object.entries(MUTATIONS) as [keyof SimPresentationConfig, SimPresentationConfig][]) {
    it(`changes when ${field} changes`, () => {
      expect(computeConfigHash(mutated)).not.toBe(base);
    });
  }

  it('produces a distinct hash for each of the seven single-field mutations', () => {
    const hashes = Object.values(MUTATIONS).map(computeConfigHash);
    expect(new Set([...hashes, base]).size).toBe(hashes.length + 1);
  });

  it('is exactly the first 16 hex characters of the canonical form digest', () => {
    for (const c of [DEFAULT_PRESENTATION_CONFIG, ...Object.values(MUTATIONS)]) {
      expect(computeConfigHash(c)).toBe(sha256Hex(canonicalizeConfig(c)).slice(0, 16));
      expect(computeConfigHash(c)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('separates every quality and aspect profile, with no two profiles sharing a hash', () => {
    const qualities: SimQualityProfile[] = ['high', 'balanced', 'low'];
    const aspects: SimAspectProfile[] = ['wide', 'standard', 'portrait', 'native'];
    const hashes = new Set<string>();
    for (const quality of qualities) {
      for (const aspect of aspects) hashes.add(computeConfigHash(cfg({ quality, aspect })));
    }
    expect(hashes.size).toBe(qualities.length * aspects.length);
  });
});

describe('canonicalizeConfig — non-finite initial state is refused, and the refusal names the key', () => {
  const BAD: Record<string, number> = { NaN: NaN, Infinity: Infinity, '-Infinity': -Infinity };

  for (const [name, value] of Object.entries(BAD)) {
    it(`throws on ${name}, naming the offending key so the author can fix the section`, () => {
      // A rejection that cannot say WHICH pin is broken leaves the author guessing across an
      // arbitrary-sized initialState object.
      expect(() => canonicalizeConfig(cfg({ initialState: { zoom: 1, theta: value } }))).toThrow(
        /initialState\.theta/,
      );
    });
  }

  it('checks every key, not just the first', () => {
    expect(() => canonicalizeConfig(cfg({ initialState: { a: 1, b: 2, c: NaN } }))).toThrow(/initialState\.c/);
  });

  it('accepts the finite extremes and the non-number pin types', () => {
    expect(() =>
      canonicalizeConfig(
        cfg({
          initialState: {
            max: Number.MAX_VALUE,
            min: -Number.MAX_VALUE,
            eps: Number.EPSILON,
            zero: -0,
            flag: false,
            label: 'x',
            nothing: null,
          },
        }),
      ),
    ).not.toThrow();
  });
});

// ── derivePackageRevision ─────────────────────────────────────────────────────────────────────

describe('derivePackageRevision — golden vectors', () => {
  // WHY A FROZEN VALUE. Every other test here asserts format, determinism and injectivity, and all
  // of them pass if the delimiter byte changes — which would silently re-key every stored revision,
  // every poster identity and every canary verdict in the product. The delimiter is the whole point
  // of the function (with a space, ('a b','c') and ('a','b c') collide), and it is derived
  // independently by the backend, the player and the generated bridge, so drift between them
  // refuses every acknowledgement. Only a value pinned from outside the implementation catches that.
  //
  // Computed with node:crypto: sha256(`${id}\u0000${bridgeHash}`).slice(0, 16).
  it('matches a value computed independently of this implementation', () => {
    expect(derivePackageRevision('11111111-1111-4111-8111-111111111111', 'abcdef0123456789'))
      .toBe('65aba498e70aa033');
  });

  it('pins the no-bridge sentinel too', () => {
    expect(derivePackageRevision('11111111-1111-4111-8111-111111111111', null))
      .toBe('b52ca63540d61bd9');
  });
});

describe('derivePackageRevision', () => {
  const UUID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
  const HEX = 'a3f9c1d0e7b45268';

  it('is 16 lowercase hex characters and deterministic', () => {
    expect(derivePackageRevision(UUID, HEX)).toMatch(/^[0-9a-f]{16}$/);
    expect(derivePackageRevision(UUID, HEX)).toBe(derivePackageRevision(UUID, HEX));
  });

  it('changes when the bridge is regenerated and when the simulation differs', () => {
    const base = derivePackageRevision(UUID, HEX);
    expect(derivePackageRevision(UUID, 'b3f9c1d0e7b45268')).not.toBe(base);
    expect(derivePackageRevision('4f2504e0-4f89-11d3-9a0c-0305e82c3301', HEX)).not.toBe(base);
  });

  it('treats a null and an undefined bridge hash as the same "no bridge yet"', () => {
    expect(derivePackageRevision(UUID, null)).toBe(derivePackageRevision(UUID, undefined));
  });

  it('is injective across a realistic matrix of ids and bridge hashes', () => {
    const revisions = new Set<string>();
    let count = 0;
    for (let i = 0; i < 40; i++) {
      for (const bridge of [null, `${HEX.slice(0, 15)}${i.toString(16)}`]) {
        revisions.add(derivePackageRevision(`3f2504e0-4f89-11d3-9a0c-0305e82c33${i.toString().padStart(2, '0')}`, bridge));
        count++;
      }
    }
    expect(revisions.size).toBe(count);
  });

  it('frames the two inputs unambiguously — a shifted split does NOT collide', () => {
    // The two inputs are joined by a U+0000 delimiter, which is what makes the concatenation
    // injective. A more obvious separator would not be: with a space, ('a b', 'c') and
    // ('a', 'b c') both render "a b c" and two different packages would share one revision.
    // This is the assertion that keeps the delimiter from being "tidied up" into a space or a dash.
    expect(derivePackageRevision('a b', 'c')).not.toBe(derivePackageRevision('a', 'b c'));
    expect(derivePackageRevision('x', 'y')).not.toBe(derivePackageRevision('xy', ''));
    expect(derivePackageRevision('', 'xy')).not.toBe(derivePackageRevision('x', 'y'));
  });

  it('pins the exact composition: id, U+0000 delimiter, bridge hash', () => {
    // Written with an explicit escape, never a literal control character: the delimiter is
    // invisible in every editor and diff, so a source file that contains a raw NUL is one bad
    // copy/paste away from silently becoming a space. Pinning the composition here is what makes
    // a change to it visible — the backend, the player and the bridge each derive this string
    // independently, and all three must produce the identical value or every acknowledgement that
    // carries a packageRevision is refused.
    const NUL = String.fromCharCode(0);
    expect(derivePackageRevision(UUID, HEX)).toBe(sha256Hex(UUID + NUL + HEX).slice(0, 16));
    expect(derivePackageRevision(UUID, null)).toBe(sha256Hex(UUID + NUL + 'no-bridge').slice(0, 16));
    expect(derivePackageRevision(UUID, HEX)).not.toBe(sha256Hex(UUID + ' ' + HEX).slice(0, 16));
    expect(derivePackageRevision(UUID, HEX)).not.toBe(sha256Hex(UUID + HEX).slice(0, 16));
  });
});

// ── id minting, under the server's real WebCrypto ─────────────────────────────────────────────

describe('id minting on the server', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetIdCounterForTests();
  });

  it('takes the WebCrypto branch, not the Math.random fallback', () => {
    // client-web's suite covers the fallback (jsdom, crypto removed). This asserts the other
    // branch is the one the backend actually runs.
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    newActivationId();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('prefixes each id with its kind so telemetry is readable', () => {
    expect(newPlayerSessionId()).toMatch(/^ps_/);
    expect(newDocumentId()).toMatch(/^doc_/);
    expect(newActivationId()).toMatch(/^act_/);
  });

  it('never collides across 20,000 activations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20_000; i++) ids.add(newActivationId());
    expect(ids.size).toBe(20_000);
  });

  it('never collides even when the counter is reset under it, as a second player on the page does', () => {
    // Two players on one page each mint from their own module instance in the browser, but in one
    // process the counter is shared and can wrap or be reset. The random suffix is what keeps ids
    // unique through that, so the counter is reset deliberately here.
    const ids = new Set<string>();
    for (let round = 0; round < 50; round++) {
      __resetIdCounterForTests();
      for (let i = 0; i < 100; i++) ids.add(newActivationId());
    }
    expect(ids.size).toBe(50 * 100);
  });

  it('keeps the three kinds distinct even at the same counter value', () => {
    __resetIdCounterForTests();
    const a = newPlayerSessionId();
    __resetIdCounterForTests();
    const b = newDocumentId();
    __resetIdCounterForTests();
    const c = newActivationId();
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
