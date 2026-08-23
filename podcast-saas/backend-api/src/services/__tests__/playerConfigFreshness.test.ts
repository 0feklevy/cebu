/**
 * D-13 — the server half of viewer config freshness.
 *
 * The two claims worth testing here are not "does the ETag change when the payload changes" (it
 * is a hash; it does). They are the two corrections the external reviewer forced onto the original
 * proposal, both of which are silent-failure shaped:
 *
 *   1. THE CACHE MUST BE KEYED BY THE FULL AUDIENCE VARIANT, NEVER BY `projectId` ALONE.
 *      `buildPlayerConfig` is viewer-dependent — a cross-project branch edge emits the
 *      destination's `share_token` only for a viewer who can reach it — so a per-project cache
 *      hands an anonymous viewer a token minted for a collaborator. A test that only checked "the
 *      cache returns the same bytes twice" passes just as happily with the broken key.
 *
 *   2. A REVALIDATION IS NOT A VIEW. The share and permalink routes bump `view_count` on every
 *      GET, so a 60s poll would report one viewer of a one-hour lecture as ~60.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';

import {
  CONFIG_CACHE_TTL_MS,
  configSnapshot,
  etagMatches,
  isConfigRevalidation,
  resetConfigCache,
  sendConfigSnapshot,
  strongEtag,
  type ConfigAudience,
} from '../playerConfigFreshness.js';

const AUDIENCE: ConfigAudience = {
  surface: 'player-config', contentId: 'proj-1', viewerId: null, language: null,
};

beforeEach(() => {
  resetConfigCache();
  vi.useRealTimers();
});

describe('configSnapshot — the ETag describes the bytes that were served', () => {
  it('hashes the exact serialization it returns as the body', async () => {
    const snap = await configSnapshot(AUDIENCE, async () => ({ segments: [], broll_clips: [] }));
    expect(snap).not.toBeNull();
    expect(snap!.body).toBe(JSON.stringify({ segments: [], broll_clips: [] }));
    expect(snap!.etag).toBe(strongEtag(snap!.body));
    // Strong, quoted — a weak tag would let an intermediary answer 304 for a payload that only
    // "semantically" matches, which for a viewer config means the wrong clip list.
    expect(snap!.etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it('changes when a b-roll clip moves — the whole point of the poll', async () => {
    const a = await configSnapshot(AUDIENCE, async () => ({ broll_clips: [{ id: 'c1', at: 10 }] }));
    resetConfigCache();
    const b = await configSnapshot(AUDIENCE, async () => ({ broll_clips: [{ id: 'c1', at: 25 }] }));
    expect(a!.etag).not.toBe(b!.etag);
  });

  it('passes a null build straight through and does NOT cache the negative', async () => {
    const build = vi.fn(async () => null);
    expect(await configSnapshot(AUDIENCE, build)).toBeNull();
    expect(await configSnapshot(AUDIENCE, build)).toBeNull();
    // Twice, not once: caching "gone" would keep answering 404 for up to 5s after a restore.
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe('the micro-cache is what makes a 60s poll affordable', () => {
  it('collapses N viewers of one audience into ONE build inside the TTL', async () => {
    const build = vi.fn(async () => ({ segments: ['s1'] }));
    const first = await configSnapshot(AUDIENCE, build);
    const second = await configSnapshot(AUDIENCE, build);
    const third = await configSnapshot(AUDIENCE, build);
    expect(build).toHaveBeenCalledTimes(1);
    expect(second!.etag).toBe(first!.etag);
    expect(third!.body).toBe(first!.body);
  });

  it('rebuilds once the TTL has elapsed', async () => {
    vi.useFakeTimers();
    const build = vi.fn(async () => ({ segments: ['s1'] }));
    await configSnapshot(AUDIENCE, build);
    vi.advanceTimersByTime(CONFIG_CACHE_TTL_MS + 1);
    await configSnapshot(AUDIENCE, build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('single-flights a cold key — concurrent viewers do not each start a build', async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    const build = vi.fn(async () => { await gate; return { segments: ['s1'] }; });

    const inFlight = [
      configSnapshot(AUDIENCE, build),
      configSnapshot(AUDIENCE, build),
      configSnapshot(AUDIENCE, build),
    ];
    release(null);
    const [a, b, c] = await Promise.all(inFlight);

    // The thundering herd this prevents arrives at exactly the moment the cache is empty, which
    // is the moment a plain read-through cache offers no protection at all.
    expect(build).toHaveBeenCalledTimes(1);
    expect(b!.etag).toBe(a!.etag);
    expect(c!.etag).toBe(a!.etag);
  });
});

describe('SECURITY — the cache key is the full audience variant', () => {
  /** A payload that carries a share token only for the viewer it was built for. */
  const buildFor = (viewerId: string | null) => async () => ({
    branching: { edges: [{ dest_project_token: viewerId === 'collab' ? 'SECRET-TOKEN' : null }] },
  });

  it('never replays a collaborator build to an anonymous viewer of the same project', async () => {
    const collab = await configSnapshot(
      { ...AUDIENCE, viewerId: 'collab' }, buildFor('collab'),
    );
    const anon = await configSnapshot(
      { ...AUDIENCE, viewerId: null }, buildFor(null),
    );

    expect(collab!.body).toContain('SECRET-TOKEN');
    expect(anon!.body).not.toContain('SECRET-TOKEN');
    expect(anon!.etag).not.toBe(collab!.etag);
  });

  it('separates two signed-in viewers of the same project', async () => {
    const build = vi.fn(async () => ({ segments: [] }));
    await configSnapshot({ ...AUDIENCE, viewerId: 'user-a' }, build);
    await configSnapshot({ ...AUDIENCE, viewerId: 'user-b' }, build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('separates language variants — a /he viewer must not be served the source track', async () => {
    const build = vi.fn(async () => ({ segments: [] }));
    await configSnapshot({ ...AUDIENCE, language: null }, build);
    await configSnapshot({ ...AUDIENCE, language: 'he' }, build);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('separates surfaces, so two routes that pass different arguments cannot share an entry', async () => {
    const build = vi.fn(async () => ({ segments: [] }));
    await configSnapshot({ ...AUDIENCE, surface: 'player-config' }, build);
    await configSnapshot({ ...AUDIENCE, surface: 'share' }, build);
    await configSnapshot({ ...AUDIENCE, surface: 'permalink' }, build);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('separates projects — the key is not a constant', async () => {
    const build = vi.fn(async () => ({ segments: [] }));
    await configSnapshot({ ...AUDIENCE, contentId: 'proj-1' }, build);
    await configSnapshot({ ...AUDIENCE, contentId: 'proj-2' }, build);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe('etagMatches — RFC 9110 weak comparison', () => {
  it('matches an exact tag, a W/ prefixed tag, a list, and *', () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"zzz", W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('*', '"abc"')).toBe(true);
  });

  it('does not match a different tag, or no header at all', () => {
    expect(etagMatches('"other"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
    expect(etagMatches('', '"abc"')).toBe(false);
  });
});

describe('isConfigRevalidation — a re-poll is not a view', () => {
  it('is true exactly when the request carries a usable If-None-Match', () => {
    expect(isConfigRevalidation({ headers: { 'if-none-match': '"abc"' } })).toBe(true);
    expect(isConfigRevalidation({ headers: { 'if-none-match': ['"abc"'] } as never })).toBe(true);
    expect(isConfigRevalidation({ headers: {} })).toBe(false);
    expect(isConfigRevalidation({ headers: { 'if-none-match': '   ' } })).toBe(false);
  });
});

describe('sendConfigSnapshot', () => {
  /**
   * Header names are LOWERCASED on write and read, exactly as Fastify's reply does. A fake that
   * kept `Vary` and `vary` as two entries would have let `addVary` look correct while writing a
   * second header the real server would have merged — the bug it exists to prevent.
   */
  function fakeReply(initial: Record<string, string> = {}) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(initial)) headers[k.toLowerCase()] = v;
    const reply = {
      statusCode: 200,
      body: undefined as unknown,
      headers,
      header(name: string, value: string) { headers[name.toLowerCase()] = value; return reply; },
      getHeader(name: string) { return headers[name.toLowerCase()]; },
      code(n: number) { reply.statusCode = n; return reply; },
      send(payload?: unknown) { reply.body = payload; return reply; },
    };
    return reply;
  }

  it('sends the exact bytes with the tag and a private, revalidate-always cache policy', () => {
    const reply = fakeReply();
    sendConfigSnapshot({ headers: {} }, reply as unknown as FastifyReply, { body: '{"a":1}', etag: '"t"' });
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toBe('{"a":1}');
    expect(reply.getHeader('etag')).toBe('"t"');
    // `private` because the payload is viewer-specific; a shared proxy caching it would be the
    // same cross-audience leak the cache key exists to prevent.
    expect(reply.getHeader('cache-control')).toBe('private, no-cache');
    expect(reply.getHeader('vary')).toBe('Authorization');
  });

  it('answers 304 with NO body when the tag still matches', () => {
    const reply = fakeReply();
    sendConfigSnapshot(
      { headers: { 'if-none-match': 'W/"t"' } },
      reply as unknown as FastifyReply,
      { body: '{"a":1}', etag: '"t"' },
    );
    expect(reply.statusCode).toBe(304);
    expect(reply.body).toBeUndefined();
    expect(reply.getHeader('etag')).toBe('"t"');
  });

  it('APPENDS to Vary rather than replacing what CORS already put there', () => {
    // @fastify/cors sets `Vary: Origin` before the handler runs (it does whenever `origin` is not
    // `*`, which is this app's configuration). Overwriting it would tell a cache that one
    // origin's CORS response is good for every origin.
    const reply = fakeReply({ vary: 'Origin' });
    sendConfigSnapshot({ headers: {} }, reply as unknown as FastifyReply, { body: '{}', etag: '"t"' });
    expect(reply.getHeader('vary')).toBe('Origin, Authorization');
  });

  it('does not duplicate a field that is already listed', () => {
    const reply = fakeReply({ vary: 'Origin, authorization' });
    sendConfigSnapshot({ headers: {} }, reply as unknown as FastifyReply, { body: '{}', etag: '"t"' });
    expect(reply.getHeader('vary')).toBe('Origin, authorization');
  });

  it('leaves a Vary of * alone — it already varies by everything', () => {
    const reply = fakeReply({ vary: '*' });
    sendConfigSnapshot({ headers: {} }, reply as unknown as FastifyReply, { body: '{}', etag: '"t"' });
    expect(reply.getHeader('vary')).toBe('*');
  });
});
