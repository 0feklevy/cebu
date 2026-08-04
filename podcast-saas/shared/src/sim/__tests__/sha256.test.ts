/**
 * SHA-256 — the shared-side conformance suite.
 *
 * RELATIONSHIP TO client-web/__tests__/sha256.test.ts
 * That file pins the NIST vectors and spot-checks 17 padding lengths and a 500-string BMP/astral
 * fuzz. It is good coverage and this file does not restate it. What it CANNOT reach:
 *
 *   • It builds every padding-boundary input from `'x'.repeat(n)`, so JS string length and UTF-8
 *     byte length are always equal. An implementation that padded by `input.length` instead of
 *     `msg.length` passes all 17 of those cases. The multi-byte boundary sweep below decouples the
 *     two and is the only thing that would catch it.
 *   • It exercises ONE lone-surrogate shape. `utf8Bytes` has five distinct surrogate branches and
 *     the substitution rule is what keeps the function total; each branch is walked here.
 *   • It samples 17 lengths. A contiguous 0..200 sweep costs milliseconds and removes the question
 *     of whether the interesting length was one of the seventeen.
 *
 * The NIST vectors themselves ARE repeated, deliberately: they are the definition of the function,
 * and a package that owns an implementation must be able to prove it correct without depending on a
 * consumer's test suite to do it.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from '../sha256.js';

/** The encoder the BACKEND will really use. Every differential assertion is against this. */
const nodeSha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const utf8Len = (s: string): number => Buffer.byteLength(s, 'utf8');

describe('FIPS 180-4 vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the 448-bit vector', () => {
    const msg = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(msg.length * 8).toBe(448);
    expect(sha256Hex(msg)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('hashes the 896-bit vector', () => {
    const msg =
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno' +
      'ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';
    expect(msg.length * 8).toBe(896);
    expect(sha256Hex(msg)).toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
  });

  it("hashes one million 'a' characters", () => {
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    );
  });
});

describe('padding — a contiguous sweep, not a sample', () => {
  it('agrees with node:crypto at every ASCII length from 0 to 200', () => {
    const mismatches: number[] = [];
    for (let n = 0; n <= 200; n++) {
      const input = 'x'.repeat(n);
      if (sha256Hex(input) !== nodeSha(input)) mismatches.push(n);
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees at the multi-block lengths a config string never reaches but a bridge body might', () => {
    const mismatches: number[] = [];
    for (const n of [255, 256, 257, 511, 512, 513, 1023, 1024, 1025, 4095, 4096]) {
      const input = 'x'.repeat(n);
      if (sha256Hex(input) !== nodeSha(input)) mismatches.push(n);
    }
    expect(mismatches).toEqual([]);
  });
});

describe('padding is computed from BYTE length, never from string length', () => {
  /**
   * The whole hazard: for `'x'.repeat(n)` the two are identical, so every boundary test built that
   * way is blind to the confusion. Each input below sits exactly on a padding boundary in BYTES
   * while its `.length` is somewhere else entirely.
   */
  const BOUNDARY_BYTES = [55, 56, 63, 64, 65, 119, 120, 127, 128];

  /** `é` is 2 UTF-8 bytes, `日` is 3, `𝄞` is 4 (and 2 UTF-16 code units). */
  const FILLERS: Record<string, string> = { 'two-byte é': 'é', 'three-byte 日': '日', 'four-byte 𝄞': '𝄞' };

  for (const [name, filler] of Object.entries(FILLERS)) {
    const width = utf8Len(filler);
    it(`agrees on ${name} padded to each boundary byte length`, () => {
      const mismatches: string[] = [];
      for (const target of BOUNDARY_BYTES) {
        // Pad with ASCII so the byte total lands exactly on the boundary for any filler width.
        const fillers = Math.floor(target / width);
        const input = filler.repeat(fillers) + 'a'.repeat(target - fillers * width);
        if (utf8Len(input) !== target) throw new Error(`test built a ${utf8Len(input)}-byte input for ${target}`);
        // The property that matters: byte length is on the boundary, string length is NOT.
        if (input.length === target && width !== 1) mismatches.push(`${target}: input length did not diverge`);
        if (sha256Hex(input) !== nodeSha(input)) mismatches.push(`${target} bytes / ${input.length} chars`);
      }
      expect(mismatches).toEqual([]);
    });
  }
});

describe('UTF-8 encoding — every width boundary in utf8Bytes', () => {
  /** The exact code points where the encoder changes how many bytes it emits. */
  const WIDTH_BOUNDARIES: Record<string, { cp: number; bytes: number }> = {
    'NUL (lowest 1-byte)': { cp: 0x0000, bytes: 1 },
    'U+007F (highest 1-byte)': { cp: 0x007f, bytes: 1 },
    'U+0080 (lowest 2-byte)': { cp: 0x0080, bytes: 2 },
    'U+07FF (highest 2-byte)': { cp: 0x07ff, bytes: 2 },
    'U+0800 (lowest 3-byte)': { cp: 0x0800, bytes: 3 },
    'U+FFFF (highest 3-byte)': { cp: 0xffff, bytes: 3 },
    'U+10000 (lowest 4-byte, first astral)': { cp: 0x10000, bytes: 4 },
    'U+10FFFF (highest code point)': { cp: 0x10ffff, bytes: 4 },
  };

  for (const [name, { cp, bytes }] of Object.entries(WIDTH_BOUNDARIES)) {
    it(`encodes ${name} as ${bytes} byte(s), identically to node`, () => {
      const s = String.fromCodePoint(cp);
      expect(utf8Len(s)).toBe(bytes);
      expect(sha256Hex(s)).toBe(nodeSha(s));
      // Also in the middle of a string, where the surrounding bytes shift the block alignment.
      const embedded = `hide:["#a${s}b"]`;
      expect(sha256Hex(embedded)).toBe(nodeSha(embedded));
    });
  }
});

describe('surrogates — every branch of the substitution rule', () => {
  /**
   * `utf8Bytes` is deliberately TOTAL: it never throws on an unpaired surrogate, it substitutes
   * U+FFFD. That is only safe if it substitutes in exactly the cases node does — otherwise a
   * section id that survived a bad copy/paste hashes differently on the two sides and every
   * acknowledgement carrying it is refused for a config-mismatch that is really an encoder bug.
   */
  const CASES: Record<string, string> = {
    'valid pair (astral)': '🌍',
    'lone HIGH surrogate, mid-string': 'a\uD800b',
    'lone HIGH surrogate at end of input (the i+1 >= length branch)': 'a\uD800',
    'HIGH followed by another HIGH (next is not a low surrogate)': '\uD800\uD801',
    'lone LOW surrogate, mid-string': 'a\uDC00b',
    'lone LOW surrogate at start': '\uDFFFa',
    'HIGH after a valid pair': '🌍\uD800',
    'pair split across a longer run': 'x🌍y\uDC00z\uD800',
  };

  for (const [name, input] of Object.entries(CASES)) {
    it(`matches node:crypto for ${name}`, () => {
      expect(sha256Hex(input)).toBe(nodeSha(input));
    });
  }

  it('substitutes U+FFFD rather than dropping the unit — a drop would alias two different ids', () => {
    // If an unpaired surrogate were simply skipped, 'a\uD800b' and 'ab' would hash the same, and two
    // sections whose ids differed only by a mangled character would share one poster.
    expect(sha256Hex('a\uD800b')).toBe(sha256Hex('a�b'));
    expect(sha256Hex('a\uD800b')).not.toBe(sha256Hex('ab'));
  });

  it('is stable across the two unpaired-surrogate halves — both collapse to the same replacement', () => {
    expect(sha256Hex('\uD800')).toBe(sha256Hex('\uDC00'));
    expect(sha256Hex('\uD800')).toBe(nodeSha('\uD800'));
  });
});

describe('differential fuzz over CONFIG-SHAPED strings', () => {
  /**
   * client-web fuzzes uniformly-random BMP/astral text. This one draws from the alphabet the
   * function is actually fed in production — canonicalized config strings, CSS selectors, hex
   * revisions and UUID section ids — because that is where a boundary bug would actually bite, and
   * because the separator characters `| : , [ ] " { }` appear in it constantly.
   */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  const ATOMS = [
    'simpleUi:1', 'simpleUi:0', 'autoScript:1', 'quality:balanced', 'aspect:portrait',
    'transparent:1', 'hide:["#hud",".controls > button"]', 'init:{"zoom":1.5,"theta":-0}',
    '|', ':', ',', '[', ']', '"', '{', '}', '\\', '\u0020', '\n', '\t',
    '3f2504e0-4f89-11d3-9a0c-0305e82c3301', 'a3f9c1d0e7b45268', 'é', '日', '🌍', '�',
  ];

  it('agrees with node:crypto on 2000 generated config-shaped strings', () => {
    const rand = lcg(0xc0ffee01);
    const mismatches: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const parts = Math.floor(rand() * 12);
      let s = '';
      for (let j = 0; j < parts; j++) s += ATOMS[Math.floor(rand() * ATOMS.length)];
      if (sha256Hex(s) !== nodeSha(s)) mismatches.push(JSON.stringify(s));
    }
    expect(mismatches).toEqual([]);
  });

  it('never collides across 5000 distinct inputs', () => {
    // Not a proof of collision resistance — a check that the implementation is not silently
    // truncating or reusing state between calls, both of which show up instantly as duplicates.
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (let i = 0; i < 5000; i++) {
      const input = `simpleUi:${i & 1}|hide:["#a${i}"]|init:{"n":${i}}`;
      const digest = sha256Hex(input);
      const prior = seen.get(digest);
      if (prior !== undefined) collisions.push(`${prior} vs ${input}`);
      seen.set(digest, input);
    }
    expect(collisions).toEqual([]);
    expect(seen.size).toBe(5000);
  });
});

describe('shape', () => {
  it('always returns 64 lowercase hex characters, including for astral and empty input', () => {
    for (const input of ['', 'a', '🌍', '\uD800', 'x'.repeat(4096)]) {
      expect(sha256Hex(input)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('carries no state between calls — interleaving two inputs does not change either digest', () => {
    const a = sha256Hex('abc');
    const b = sha256Hex('x'.repeat(1000));
    expect(sha256Hex('abc')).toBe(a);
    expect(sha256Hex('x'.repeat(1000))).toBe(b);
    expect(a).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
