/**
 * Proving two files are the same file — and, far more importantly, refusing to when they are not.
 *
 * The asymmetry runs through every test here. A missed dedup costs disk. A WRONG dedup points one
 * project at another project's bytes permanently, with no error raised anywhere and no way for
 * either owner to notice. So every "declines" case below is load-bearing and the "reuses" cases
 * are the easy half.
 */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  identifyStream,
  identifyBuffer,
  judgeReuse,
  isWellFormedSha256,
  blobStorageKey,
  strictCompareEnabled,
  ContentTruncatedError,
  type BlobRecord,
} from '../contentIdentity.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const blob = (over: Partial<BlobRecord> = {}): BlobRecord => ({
  id: 'blob-1', sha256: sha('hello'), byte_size: 5, storage_key: 'blobs/aa/bb/x', ...over,
});
const present = (byteSize: number | null = 5) => ({ exists: true, byteSize });

describe('identifying content', () => {
  it('agrees between the stream and the buffer path for the same bytes', () => {
    // Two code paths that disagree would dedup a file against itself only sometimes — the worst
    // possible failure mode, because it looks like flakiness rather than a bug.
    return (async () => {
      const bytes = Buffer.from('hello');
      const viaStream = await identifyStream(Readable.from([bytes]));
      const viaBuffer = identifyBuffer(bytes);
      expect(viaStream).toEqual(viaBuffer);
      expect(viaStream.sha256).toBe(sha('hello'));
      expect(viaStream.byteSize).toBe(5);
    })();
  });

  it('counts bytes across chunk boundaries, not per chunk', async () => {
    const id = await identifyStream(Readable.from([Buffer.from('he'), Buffer.from('l'), Buffer.from('lo')]));
    expect(id).toEqual({ sha256: sha('hello'), byteSize: 5 });
  });

  it('REFUSES to mint an identity for a truncated stream', async () => {
    // Mechanism 3, and the reason it exists. A hash from the stream plus a size from metadata is
    // a self-consistent pair describing content nobody has — and a second, equally truncated
    // upload would match it and dedup onto it.
    await expect(identifyStream(Readable.from([Buffer.from('he')]), { declaredSize: 5 }))
      .rejects.toBeInstanceOf(ContentTruncatedError);
  });

  it('refuses an over-long stream too, not just a short one', async () => {
    // A stream LONGER than declared is equally a mismatch: whatever was measured, it was not this.
    await expect(identifyStream(Readable.from([Buffer.from('hello world')]), { declaredSize: 5 }))
      .rejects.toBeInstanceOf(ContentTruncatedError);
  });

  it('reports both numbers, so an operator can see which end was wrong', async () => {
    const err = await identifyStream(Readable.from([Buffer.from('he')]), { declaredSize: 5 })
      .catch((e: ContentTruncatedError) => e);
    expect(err).toMatchObject({ declared: 5, actual: 2 });
  });

  it('hashes an empty object rather than treating it as absent', async () => {
    // Zero bytes is a legitimate file, and it has a well-known digest. Special-casing it to null
    // would make every empty upload a fresh one forever.
    const id = await identifyStream(Readable.from([]));
    expect(id.byteSize).toBe(0);
    expect(id.sha256).toBe(createHash('sha256').digest('hex'));
  });
});

describe('the reuse decision', () => {
  it('reuses when hash, size and the object in storage all agree', () => {
    const v = judgeReuse({ incoming: { sha256: sha('hello'), byteSize: 5 }, candidate: blob(), probe: present() });
    expect(v).toEqual({ reuse: true, blob: blob() });
  });

  it('declines when there is no candidate at all', () => {
    expect(judgeReuse({ incoming: { sha256: sha('hello'), byteSize: 5 }, candidate: null, probe: present() }))
      .toEqual({ reuse: false, why: 'no-candidate' });
  });

  it('declines on a hash mismatch even when the SIZES are identical', () => {
    // The exact case that makes "same name, same size" unusable on its own: two different files
    // of the same length. This is the assertion that stands between a viewer and someone else's
    // picture.
    const v = judgeReuse({
      incoming: { sha256: sha('world'), byteSize: 5 },
      candidate: blob({ sha256: sha('hello'), byte_size: 5 }),
      probe: present(),
    });
    expect(v).toEqual({ reuse: false, why: 'hash-mismatch' });
  });

  it('declines on a size mismatch even when the HASH matches', () => {
    // Cannot happen from an honest pair — which is why meeting it means something is wrong, and
    // the conservative answer is to store the bytes again rather than resolve the contradiction.
    const v = judgeReuse({
      incoming: { sha256: sha('hello'), byteSize: 9 },
      candidate: blob({ sha256: sha('hello'), byte_size: 5 }),
      probe: present(),
    });
    expect(v).toEqual({ reuse: false, why: 'size-mismatch' });
  });

  it('declines when the object is GONE from storage', () => {
    // Mechanism 4. A blob row can outlive its bytes; reusing one hands the new project a
    // reference to nothing, which is strictly worse than uploading again.
    const v = judgeReuse({
      incoming: { sha256: sha('hello'), byteSize: 5 }, candidate: blob(),
      probe: { exists: false, byteSize: null },
    });
    expect(v).toEqual({ reuse: false, why: 'bytes-missing' });
  });

  it('declines when the caller did not probe at all — absence of evidence is not presence', () => {
    // `null` must never read as "assume it is there". An unprobed reuse is how a project ends up
    // pointing at an object swept away last week.
    const v = judgeReuse({ incoming: { sha256: sha('hello'), byteSize: 5 }, candidate: blob(), probe: null });
    expect(v).toEqual({ reuse: false, why: 'bytes-missing' });
  });

  it('declines when storage holds a DIFFERENT length than the row records', () => {
    // Something rewrote the key underneath us. Whatever is there now, it is not this file.
    const v = judgeReuse({
      incoming: { sha256: sha('hello'), byteSize: 5 }, candidate: blob(), probe: present(4096),
    });
    expect(v).toEqual({ reuse: false, why: 'size-drift' });
  });

  it('tolerates a probe that cannot report a length', () => {
    // Some adapters answer existence without a size. That is weaker evidence, not contrary
    // evidence, and refusing every dedup on those backends would disable the feature outright.
    const v = judgeReuse({ incoming: { sha256: sha('hello'), byteSize: 5 }, candidate: blob(), probe: present(null) });
    expect(v).toEqual({ reuse: true, blob: blob() });
  });

  it('declines a malformed digest on EITHER side rather than comparing it', () => {
    const bad = ['', 'ABC', sha('hello').toUpperCase(), sha('hello').slice(0, 63), `${sha('hello')}0`];
    for (const s of bad) {
      expect(judgeReuse({ incoming: { sha256: sha('hello'), byteSize: 5 }, candidate: blob({ sha256: s }), probe: present() }),
        `candidate ${s}`).toEqual({ reuse: false, why: 'malformed-hash' });
      expect(judgeReuse({ incoming: { sha256: s, byteSize: 5 }, candidate: blob(), probe: present() }),
        `incoming ${s}`).toEqual({ reuse: false, why: 'malformed-hash' });
    }
  });

  it('never answers with a bare boolean — every refusal names its reason', () => {
    // An operator who cannot tell "dedup declined correctly" from "dedup is broken" will turn the
    // feature off to find out.
    const v = judgeReuse({ incoming: { sha256: sha('x'), byteSize: 1 }, candidate: null, probe: null });
    expect(v.reuse).toBe(false);
    expect('why' in v && typeof v.why).toBe('string');
  });
});

describe('the digest shape guard', () => {
  it('accepts exactly 64 lowercase hex characters', () => {
    expect(isWellFormedSha256(sha('anything'))).toBe(true);
  });
  it('rejects uppercase, wrong length, non-hex and non-strings', () => {
    for (const v of [sha('a').toUpperCase(), sha('a').slice(1), `${sha('a')}f`, 'zz', 42, null, undefined, {}]) {
      expect(isWellFormedSha256(v), String(v)).toBe(false);
    }
  });
});

describe('the storage key', () => {
  it('is content-addressed, so a key cannot outlive its meaning', () => {
    const k = blobStorageKey({ sha256: sha('hello'), byteSize: 5 });
    expect(k).toContain(sha('hello'));
  });

  it('shards two levels by the digest prefix', () => {
    const h = sha('hello');
    expect(blobStorageKey({ sha256: h, byteSize: 5 })).toBe(`blobs/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}`);
  });

  it('different content lands on a different key', () => {
    expect(blobStorageKey({ sha256: sha('a'), byteSize: 1 }))
      .not.toBe(blobStorageKey({ sha256: sha('b'), byteSize: 1 }));
  });

  it('normalises the extension whether or not a dot was supplied', () => {
    const h = sha('hello');
    expect(blobStorageKey({ sha256: h, byteSize: 5 }, 'mp4')).toBe(`blobs/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}.mp4`);
    expect(blobStorageKey({ sha256: h, byteSize: 5 }, '.mp4')).toBe(`blobs/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}.mp4`);
  });
});

describe('the strict byte-comparison switch', () => {
  it('is OFF unless an operator turns it on', () => {
    // It costs a full download of the existing object on every dedup hit, and defends only against
    // an SHA-256 collision — the one risk here nobody can currently produce.
    expect(strictCompareEnabled({})).toBe(false);
    expect(strictCompareEnabled({ MEDIA_DEDUP_STRICT_COMPARE: '1' })).toBe(false);
    expect(strictCompareEnabled({ MEDIA_DEDUP_STRICT_COMPARE: 'yes' })).toBe(false);
  });
  it('takes an explicit true', () => {
    expect(strictCompareEnabled({ MEDIA_DEDUP_STRICT_COMPARE: 'true' })).toBe(true);
  });
});
