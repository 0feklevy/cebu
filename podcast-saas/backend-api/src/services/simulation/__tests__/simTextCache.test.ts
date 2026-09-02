import { describe, it, expect } from 'vitest';
import { SimTextCache, strongEtag } from '../simTextCache.js';

const entry = (text: string) => ({ bytes: Buffer.from(text), etag: strongEtag(Buffer.from(text)), contentType: 'text/plain' });

describe('SimTextCache', () => {
  it('returns what was stored, counts hits and misses, and never exceeds its byte budget', () => {
    const c = new SimTextCache({ maxBytes: 10, ttlMs: 60_000, maxEntryBytes: 10 });
    expect(c.get('a')).toBeNull();
    c.set('a', entry('aaaa'));           // 4 bytes
    c.set('b', entry('bbbb'));           // 8
    expect(c.get('a')?.bytes.toString()).toBe('aaaa');
    c.set('c', entry('cccc'));           // 12 > 10 → evicts the least recently used: 'b' (a was just touched)
    expect(c.get('b')).toBeNull();
    expect(c.get('a')).not.toBeNull();
    expect(c.get('c')).not.toBeNull();
    expect(c.bytes).toBeLessThanOrEqual(10);
    expect(c.hits).toBe(3);
    expect(c.misses).toBe(2);
  });

  it('refuses an entry larger than the per-entry ceiling rather than letting one file own the cache', () => {
    const c = new SimTextCache({ maxBytes: 100, ttlMs: 60_000, maxEntryBytes: 3 });
    c.set('big', entry('abcd'));
    expect(c.get('big')).toBeNull();
    expect(c.size).toBe(0);
  });

  it('expires by age', () => {
    const c = new SimTextCache({ maxBytes: 100, ttlMs: 1000, maxEntryBytes: 100 });
    c.set('a', entry('a'), 0);
    expect(c.get('a', 999)).not.toBeNull();
    expect(c.get('a', 1001)).toBeNull();
    expect(c.size).toBe(0);
  });

  it('strongEtag is the quoted sha1 the uncached path uses', () => {
    expect(strongEtag(Buffer.from('hello'))).toBe('"aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d"');
  });
});
