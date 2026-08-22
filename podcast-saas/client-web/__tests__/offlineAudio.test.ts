/**
 * P3-B / A2.3 — "save for the drive", the half that needs no ruling about the service-worker
 * kill-switch.
 *
 * Every test here is about a failure the listener experiences in a car: a link that expired while
 * the page sat open, a progress bar that lies, or memory pinned by a recording nobody released.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CONFIRM_ABOVE_BYTES,
  formatBytes,
  looksExpired,
  releaseOffline,
  saveForOffline,
} from '../lib/offlineAudio';

/** A Response whose body streams in the given chunks. */
function streamingResponse(chunks: Uint8Array[], headers: Record<string, string> = {}, status = 200): Response {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
      }),
    },
    blob: async () => new Blob(chunks as BlobPart[]),
  } as unknown as Response;
}

beforeEachSetup();
function beforeEachSetup() {
  // jsdom has no createObjectURL. The identity of the URL does not matter to these tests; that one
  // is produced, and later revoked, does.
  if (!URL.createObjectURL) {
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => 'blob:test';
  }
  if (!URL.revokeObjectURL) {
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
  }
}

describe('an expired link is named, not left as a spinner', () => {
  it.each([401, 403])('recognises %s as expiry', (status) => {
    expect(looksExpired({ status } as Response)).toBe(true);
  });

  it('does not treat a 404 or a 500 as expiry', () => {
    // Those need different advice. "Reload and try again" for a missing file sends the listener
    // in a circle.
    expect(looksExpired({ status: 404 } as Response)).toBe(false);
    expect(looksExpired({ status: 500 } as Response)).toBe(false);
  });

  it('tells the listener to reload rather than reporting a status code', async () => {
    // The audio URL is a signed, time-limited capability. A page open for hours holds a stale one,
    // and an opaque 403 reads as "the app is broken" rather than "reload".
    const fetchImpl = vi.fn(async () => streamingResponse([], {}, 403));
    await expect(saveForOffline('https://x/a.m4a', { fetchImpl: fetchImpl as never }))
      .rejects.toThrow(/expired.*reload/i);
  });

  it('reports another failure with its status, since there is no better advice', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse([], {}, 500));
    await expect(saveForOffline('https://x/a.m4a', { fetchImpl: fetchImpl as never }))
      .rejects.toThrow(/500/);
  });
});

describe('progress that does not lie', () => {
  it('reports progress against a known Content-Length', async () => {
    const chunks = [new Uint8Array(50), new Uint8Array(50)];
    const seen: number[] = [];
    const fetchImpl = vi.fn(async () => streamingResponse(chunks, { 'content-length': '100' }));
    await saveForOffline('u', { fetchImpl: fetchImpl as never, onProgress: (p) => seen.push(p) });
    expect(seen[0]).toBeCloseTo(0.5, 5);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('reports NOTHING mid-flight when the total is unknown', async () => {
    // A chunked response has no Content-Length. Inventing a denominator produces a bar that races
    // to 90% and stops, which is worse than no bar — the listener waits for a number that will
    // never arrive rather than for a download they can see is still going.
    const seen: number[] = [];
    const fetchImpl = vi.fn(async () => streamingResponse([new Uint8Array(10), new Uint8Array(10)]));
    await saveForOffline('u', { fetchImpl: fetchImpl as never, onProgress: (p) => seen.push(p) });
    expect(seen, 'progress was reported without a total to measure against').toEqual([1]);
  });

  it('always finishes at exactly 1, so a bar can complete', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse([new Uint8Array(7)], { 'content-length': '100' }));
    const seen: number[] = [];
    await saveForOffline('u', { fetchImpl: fetchImpl as never, onProgress: (p) => seen.push(p) });
    // The chunks did not add up to the advertised length — servers do that. The bar still ends.
    expect(seen[seen.length - 1]).toBe(1);
  });

  it('never reports above 1 when the response is LONGER than advertised', async () => {
    const fetchImpl = vi.fn(async () => streamingResponse([new Uint8Array(500)], { 'content-length': '100' }));
    const seen: number[] = [];
    await saveForOffline('u', { fetchImpl: fetchImpl as never, onProgress: (p) => seen.push(p) });
    expect(Math.max(...seen)).toBe(1);
  });
});

describe('downloading without a streaming body still works', () => {
  it('falls back to a single read', async () => {
    // Older browsers and some test doubles have no `body`. The download must still complete; only
    // the progress reporting is lost.
    const res = {
      ok: true, status: 200,
      headers: { get: () => null },
      body: null,
      blob: async () => new Blob([new Uint8Array(42)]),
    } as unknown as Response;
    const out = await saveForOffline('u', { fetchImpl: (async () => res) as never });
    expect(out.bytes).toBe(42);
    expect(out.objectUrl).toBeTruthy();
  });
});

describe('memory is released', () => {
  it('revokes the object URL', () => {
    // An object URL pins its Blob until revoked — a 29 MB episode held forever by a tab the
    // listener left open.
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    releaseOffline('blob:abc');
    expect(spy).toHaveBeenCalledWith('blob:abc');
    spy.mockRestore();
  });

  it('is safe to call with nothing saved', () => {
    const spy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    releaseOffline(null);
    releaseOffline(undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('a size the listener can judge before spending their data', () => {
  it.each([
    [0, ''],
    [-1, ''],
    [1.5 * 1024 * 1024, '1.5 MB'],
    [29 * 1024 * 1024, '29.0 MB'],
    [150 * 1024 * 1024, '150 MB'],
  ])('%s bytes → "%s"', (bytes, expected) => {
    expect(formatBytes(bytes as number)).toBe(expected);
  });

  it('drops the decimal once it stops informing the decision', () => {
    // "Do I have room and signal for this?" does not turn on 0.1 MB at that scale.
    expect(formatBytes(120.4 * 1024 * 1024)).toBe('120 MB');
  });

  it('has a confirmation threshold below a plausible whole data allowance', () => {
    // A button that spends someone's month without saying so gets pressed once and never again.
    expect(CONFIRM_ABOVE_BYTES).toBeGreaterThan(20 * 1024 * 1024);
    expect(CONFIRM_ABOVE_BYTES).toBeLessThanOrEqual(100 * 1024 * 1024);
  });
});
