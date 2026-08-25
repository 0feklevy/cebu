/**
 * Proving that two files are THE SAME FILE, well enough to store the bytes only once.
 *
 * ── WHY NAME + SIZE IS NOT ENOUGH, EVEN THOUGH IT IS WHERE EVERYONE STARTS ────────────────────
 * "Same filename and same byte count" is a fine way to FIND candidates and a terrible way to
 * decide. `chart.png` at 4,214,983 bytes is a description that thousands of genuinely different
 * images satisfy, and the cost of being wrong is not a wasted upload — it is one project silently
 * serving another project's picture, forever, with no error anywhere. So name and size narrow the
 * search; nothing but the content decides.
 *
 * ── THE FOUR MECHANISMS, AND WHAT EACH ONE ACTUALLY DEFENDS AGAINST ───────────────────────────
 * They are not four ways of saying the same thing. Each covers a failure the others cannot see:
 *
 *   1. DECLARED SIZE. Free, and rejects almost every non-match before a byte is read. On its own
 *      it proves nothing at all.
 *
 *   2. SHA-256 OVER THE COMPLETE OBJECT. The actual proof of identity. Accidental collisions do
 *      not occur, and deliberate ones are not currently constructible — which matters here
 *      because this is a MULTI-TENANT store, so "identical" is a claim one tenant makes about
 *      another tenant's bytes.
 *
 *   3. BYTE COUNT TAKEN IN THE SAME PASS AS THE HASH. The one people leave out. If the hash comes
 *      from the stream and the size comes from metadata, a TRUNCATED upload yields a perfectly
 *      self-consistent (hash, size) pair describing content that nobody has: the hash is honest
 *      about the half it saw, the size is honest about the whole, and together they are a lie.
 *      Counting during hashing makes the pair describe one set of bytes or fail.
 *
 *   4. THE TARGET OBJECT STILL EXISTS, AT THAT LENGTH. A blob row can outlive its bytes — this
 *      repo has a documented writer/deleter asymmetry — and reusing a row whose object is gone
 *      gives the new project a reference to nothing, which is worse than uploading again. So the
 *      last gate before reuse is a HEAD against storage, comparing the length it reports.
 *
 * A fifth mechanism — a full byte-for-byte comparison — is deliberately NOT here. It would cost a
 * complete download of the existing object on every dedup hit and defends only against an SHA-256
 * collision, the one risk in this list nobody can currently produce. An earlier draft shipped an
 * env flag for it that nothing consulted: a documented knob that does nothing is worse than no
 * knob, because an operator can set it and believe they bought certainty. If it is ever wanted,
 * it belongs in `claimBlob` alongside the code that does the comparing.
 */

import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

/** What makes two files the same file. The PAIR — never the hash alone. */
export interface ContentIdentity {
  /** Lowercase hex, 64 chars. */
  sha256: string;
  byteSize: number;
}

export class ContentTruncatedError extends Error {
  constructor(readonly declared: number, readonly actual: number) {
    super(`stream ended after ${actual} bytes but ${declared} were declared`);
    this.name = 'ContentTruncatedError';
  }
}

/**
 * Hash a stream and count it IN ONE PASS — mechanisms 2 and 3 together, because separately they
 * are exactly the trap described above.
 *
 * `declaredSize` is optional: some callers genuinely do not know the length up front. When it IS
 * supplied and the stream disagrees, this throws rather than returning the pair it observed — a
 * truncated upload must not be allowed to MINT an identity, because that identity could then be
 * matched by a later, equally truncated upload and the two would dedup onto each other.
 */
export async function identifyStream(
  stream: Readable | AsyncIterable<Uint8Array>,
  opts: { declaredSize?: number } = {},
): Promise<ContentIdentity> {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    byteSize += chunk.byteLength;
  }
  if (opts.declaredSize != null && opts.declaredSize !== byteSize) {
    throw new ContentTruncatedError(opts.declaredSize, byteSize);
  }
  return { sha256: hash.digest('hex'), byteSize };
}

/** Same contract for bytes already in memory. */
export function identifyBuffer(buf: Uint8Array, opts: { declaredSize?: number } = {}): ContentIdentity {
  if (opts.declaredSize != null && opts.declaredSize !== buf.byteLength) {
    throw new ContentTruncatedError(opts.declaredSize, buf.byteLength);
  }
  return { sha256: createHash('sha256').update(buf).digest('hex'), byteSize: buf.byteLength };
}

/** A 64-char lowercase hex digest, and nothing else. Guards the DB's own CHECK from the app side. */
export function isWellFormedSha256(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/** What a stored blob claims about itself, as read from the DB row. */
export interface BlobRecord {
  id: string;
  sha256: string;
  byte_size: number;
  storage_key: string;
}

/** What storage says about the object when asked directly. Null when it is not there at all. */
export interface StorageProbe {
  exists: boolean;
  byteSize: number | null;
}

/**
 * Why a reuse decision went the way it did.
 *
 * Never a bare boolean. "Dedup is not working" and "dedup correctly declined" look identical from
 * the outside, and an operator who cannot tell them apart will eventually turn the feature off to
 * find out.
 */
export type ReuseVerdict =
  | { reuse: true; blob: BlobRecord }
  | { reuse: false; why: 'no-candidate' | 'hash-mismatch' | 'size-mismatch' | 'bytes-missing' | 'size-drift' | 'malformed-hash' };

/**
 * The decision itself — pure, so every branch is testable without a database or a bucket.
 *
 * Order matters: the cheap disqualifiers run before the ones that cost a network round trip, and
 * the storage probe is LAST because it is the only one that touches the outside world.
 */
export function judgeReuse(input: {
  incoming: ContentIdentity;
  candidate: BlobRecord | null;
  probe: StorageProbe | null;
}): ReuseVerdict {
  const { incoming, candidate, probe } = input;
  if (!candidate) return { reuse: false, why: 'no-candidate' };

  // A malformed digest on either side is not a mismatch to be reported, it is a row that should
  // not exist. Refusing to reuse it is the conservative reading, and the sweeper can flag it.
  if (!isWellFormedSha256(candidate.sha256) || !isWellFormedSha256(incoming.sha256)) {
    return { reuse: false, why: 'malformed-hash' };
  }
  // Mechanism 2.
  if (candidate.sha256 !== incoming.sha256) return { reuse: false, why: 'hash-mismatch' };
  // Mechanism 1, checked even though the lookup was keyed on the pair: a caller may hand us a
  // candidate found some other way, and a size check that only runs when the query happened to
  // include it is a check that cannot be relied upon.
  if (candidate.byte_size !== incoming.byteSize) return { reuse: false, why: 'size-mismatch' };

  // Mechanism 4. `null` means the caller did not probe — which is not the same as "it is there",
  // so it is refused rather than assumed. An unprobed reuse is how a project ends up pointing at
  // an object that was swept away last week.
  if (!probe || !probe.exists) return { reuse: false, why: 'bytes-missing' };
  if (probe.byteSize != null && probe.byteSize !== candidate.byte_size) {
    // The object is there but is not the length we recorded. Something rewrote the key under us;
    // whatever it now holds, it is not the file this row describes.
    return { reuse: false, why: 'size-drift' };
  }

  return { reuse: true, blob: candidate };
}


/**
 * The storage key a blob gets. Content-addressed, so the key cannot outlive its meaning: if the
 * bytes change the key changes, and no project can be pointed at a key whose content moved.
 *
 * Sharded two levels by the digest's own prefix — flat buckets with hundreds of thousands of
 * sibling keys list slowly on every adapter this product supports.
 */
export function blobStorageKey(identity: ContentIdentity, ext = ''): string {
  const h = identity.sha256;
  const suffix = ext && !ext.startsWith('.') ? `.${ext}` : ext;
  return `blobs/${h.slice(0, 2)}/${h.slice(2, 4)}/${h}${suffix}`;
}
