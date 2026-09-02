/**
 * An in-process cache for the TEXT files of a served simulation revision (night run 2026-09-03 §6).
 *
 * Every text asset of every simulation — the entry HTML, bridge.js, every CSS/JS/JSON — went
 * through `/sim-public/*` as one storage GET, one sha1 over the body and one brotli, per file, per
 * viewer, per load, and answered `no-cache` so even a 304 paid all of it. For a package of a few
 * hundred text files opened by a class, that is the request-serving process doing the same work
 * thousands of times.
 *
 * Only REVISION keys are cached. A revision's bytes are immutable by construction (a new
 * publication is a new revision under a new prefix), so a cached entry can never be stale — the
 * one property a cache in front of a mutable "Replace simulation" path could not have, which is
 * why legacy keys are deliberately left out.
 *
 * Bounded by bytes and by age. Age is belt-and-braces: nothing in a revision changes, but a bound
 * keeps a process that served ten thousand packages last week from carrying them forever.
 */
import { createHash } from 'node:crypto';

export interface SimTextEntry {
  /** The bytes as served — after any serve-time injection. */
  bytes: Buffer;
  etag: string;
  contentType: string;
}

interface Slot extends SimTextEntry { storedAt: number }

export class SimTextCache {
  private readonly slots = new Map<string, Slot>();
  private totalBytes = 0;
  hits = 0;
  misses = 0;

  constructor(
    private readonly opts: { maxBytes: number; ttlMs: number; maxEntryBytes: number } = {
      maxBytes: 64 * 1024 * 1024, ttlMs: 10 * 60 * 1000, maxEntryBytes: 4 * 1024 * 1024,
    },
  ) {}

  get(key: string, now = Date.now()): SimTextEntry | null {
    const slot = this.slots.get(key);
    if (!slot) { this.misses++; return null; }
    if (now - slot.storedAt > this.opts.ttlMs) { this.evict(key); this.misses++; return null; }
    // LRU: touching moves the entry to the newest position.
    this.slots.delete(key);
    this.slots.set(key, slot);
    this.hits++;
    return slot;
  }

  set(key: string, entry: SimTextEntry, now = Date.now()): void {
    if (entry.bytes.length > this.opts.maxEntryBytes) return;   // never let one file own the cache
    if (this.slots.has(key)) this.evict(key);
    while (this.totalBytes + entry.bytes.length > this.opts.maxBytes && this.slots.size > 0) {
      const oldest = this.slots.keys().next().value as string;
      this.evict(oldest);
    }
    this.slots.set(key, { ...entry, storedAt: now });
    this.totalBytes += entry.bytes.length;
  }

  private evict(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    this.slots.delete(key);
    this.totalBytes -= slot.bytes.length;
  }

  get size(): number { return this.slots.size; }
  get bytes(): number { return this.totalBytes; }
  clear(): void { this.slots.clear(); this.totalBytes = 0; }
}

/** Strong ETag over the exact bytes served — the same tag the uncached path computes. */
export function strongEtag(bytes: Buffer): string {
  return `"${createHash('sha1').update(bytes).digest('hex')}"`;
}

/** The process-wide instance `/sim-public/*` reads through. */
export const simTextCache = new SimTextCache();
