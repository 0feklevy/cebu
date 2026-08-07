/**
 * SHA-256 conformance for shared/src/sim/sha256.
 *
 * This implementation is not an optimisation or a convenience — it is the ONLY hash that the
 * backend (node:crypto available), the browser player (WebCrypto, but async-only) and the generated
 * child bridge (neither) can all compute synchronously and identically. `configHash` is one of the
 * five axes the reveal invariant compares, so a digest that disagrees between those three either
 * rejects every legitimate acknowledgement or, if someone "fixes" that by loosening the comparison,
 * silently readmits the stale-frame defect the whole protocol exists to close.
 *
 * So this file checks the standard FIPS 180-4 / NIST vectors AND differential-tests against
 * node:crypto, which is the encoder the backend will actually use in production.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256Hex } from 'shared/src/sim/sha256';

const nodeSha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256Hex — standard NIST vectors', () => {
  it('hashes the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the 448-bit example (one block after padding)', () => {
    const msg = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';
    expect(msg.length * 8).toBe(448);
    expect(sha256Hex(msg)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('hashes the 896-bit example (two blocks after padding)', () => {
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

describe('sha256Hex — UTF-8 encoding agrees with node:crypto', () => {
  const cases: Record<string, string> = {
    'two-byte (Latin-1 supplement)': 'héllo wörld',
    'three-byte (CJK)': '日本語のテキスト',
    'four-byte (emoji, surrogate pair)': 'a 🌍 b 👩‍🚀 c',
    'mixed widths': 'ascii-é-日-🌍',
    'combining marks': 'égalité',
    'RTL': 'مرحبا بالعالم',
    'NUL and control bytes': 'a\u0000b\u0007c\u001bd',
    'selector-like config text': 'simpleUi:1|hide:["#hud",".controls > button"]',
  };

  for (const [name, input] of Object.entries(cases)) {
    it(`matches node:crypto for ${name}`, () => {
      expect(sha256Hex(input)).toBe(nodeSha(input));
    });
  }

  it('encodes a LONE surrogate as U+FFFD, exactly as node does', () => {
    // A lone surrogate is not representable in UTF-8. The implementation substitutes U+FFFD and so
    // does Node's encoder; if they diverged, a section id that survived a bad copy/paste would hash
    // differently on the two sides and every acknowledgement for it would be refused.
    expect(sha256Hex('\uD800')).toBe(nodeSha('\uD800'));
    expect(sha256Hex('\uDFFF')).toBe(nodeSha('\uDFFF'));
    expect(sha256Hex('a\uD800b')).toBe(nodeSha('a\uD800b'));
    expect(sha256Hex('\uD800')).toBe(sha256Hex('�'));
  });
});

describe('sha256Hex — padding boundaries', () => {
  // 55/56 and 119/120 are where the 8-byte length field stops fitting in the current block and an
  // extra block is appended. Off-by-one padding bugs live here and nowhere else.
  const lengths = [0, 1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129, 1000];
  for (const n of lengths) {
    it(`matches node:crypto at byte length ${n}`, () => {
      const input = 'x'.repeat(n);
      expect(sha256Hex(input)).toBe(nodeSha(input));
    });
  }
});

describe('sha256Hex — differential fuzz against node:crypto', () => {
  /** Deterministic LCG so a failure is reproducible rather than a story about a flake. */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it('agrees on 500 pseudo-random strings drawn from the full BMP + astral planes', () => {
    const rand = lcg(0x5eed1234);
    const mismatches: string[] = [];
    for (let i = 0; i < 500; i++) {
      const len = Math.floor(rand() * 200);
      let s = '';
      for (let j = 0; j < len; j++) {
        const r = rand();
        if (r < 0.5) s += String.fromCharCode(32 + Math.floor(rand() * 95));
        else if (r < 0.8) s += String.fromCharCode(0x80 + Math.floor(rand() * 0x7f00));
        else s += String.fromCodePoint(0x10000 + Math.floor(rand() * 0xffff));
      }
      if (sha256Hex(s) !== nodeSha(s)) mismatches.push(JSON.stringify(s));
    }
    expect(mismatches).toEqual([]);
  });
});

describe('sha256Hex — shape and purity', () => {
  it('always returns 64 lowercase hex characters', () => {
    for (const input of ['', 'a', 'a'.repeat(1000), '🌍']) {
      expect(sha256Hex(input)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is pure — repeated calls on the same input are identical', () => {
    const input = 'simpleUi:1|autoScript:0|quality:low';
    expect(sha256Hex(input)).toBe(sha256Hex(input));
  });

  it('is sensitive to a single-bit input change', () => {
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abc '));
  });
});
