import { createHash } from 'crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * D-13 — viewer config freshness.
 *
 * The viewer re-polls its OWN config route with `If-None-Match` roughly once a minute, so an
 * editorial correction (a mis-placed b-roll clip, a re-trimmed overlay) reaches a viewer who is
 * already mid-watch. This module is the server half: the strong ETag, the conditional-request
 * answer, the micro-cache that makes the poll affordable, and the rule that says a revalidation
 * is not a view.
 *
 * WHAT THIS IS NOT. It is editorial freshness, never a takedown mechanism. Production HLS is
 * served from a public bucket (`security-001`), so a URL already handed out keeps working
 * regardless of what this route says; revocation is server-side and separate. Nothing here may
 * be read as "the viewer loses access within 60s".
 */

/** Bytes served, and the strong ETag over exactly those bytes. */
export interface ConfigSnapshot {
  /** The exact serialized JSON sent to the client — the ETag hashes THIS, not the object. */
  body: string;
  /** A strong ETag, quoted, ready for the `ETag` header. */
  etag: string;
}

/**
 * Everything `buildPlayerConfig` (or `buildPlaylistPlayConfig`) reads that varies BY VIEWER.
 *
 * THE CACHE KEY IS THIS WHOLE RECORD, AND THAT IS A SECURITY PROPERTY, NOT A TIDINESS ONE.
 * `buildPlayerConfig` is viewer-dependent: a cross-project branch edge emits the destination's
 * `share_token` only for a viewer who can reach it (`requireProjectAccess` / collaborator
 * membership, both resolved per requester). Keying the cache by `projectId` alone — the shape
 * first proposed for D-13 — would let one viewer's build be replayed to another, and hand an
 * anonymous viewer a share token minted for a collaborator. So every input that can change a
 * byte of the payload is part of the key, and a new viewer-dependent input MUST be added here at
 * the same time it is added to the builder.
 */
export interface ConfigAudience {
  /** Which route built it. Two surfaces that pass different arguments can never share an entry. */
  surface: 'player-config' | 'share' | 'permalink' | 'playlist-share' | 'playlist-permalink';
  /** Project or playlist id. */
  contentId: string;
  /** The requester the payload was built FOR — null is its own audience (anonymous), not a wildcard. */
  viewerId: string | null;
  /** Dubbed-language variant (migration 067); null is the source track. */
  language: string | null;
}

/**
 * Micro-cache TTL.
 *
 * This is what makes a 60s poll affordable on the 2-vCPU host (D-12): N viewers of one lecture
 * collapse into ONE `buildPlayerConfig` per 5s regardless of N, so cost scales with *projects
 * being watched*, not viewers. It also bounds how stale a served payload can be — 5s on top of
 * the poll interval, which is well inside the "the creator fixed a mistake" requirement.
 */
export const CONFIG_CACHE_TTL_MS = 5_000;

/**
 * Hard bound on distinct live audiences. Each entry is one serialized config and the key includes
 * the viewer, so an unbounded map is an unbounded memory footprint on the constraint host. At the
 * cap the expired set is swept first and, if that frees nothing, the oldest entries go — a miss
 * costs exactly one rebuild, which is what a cold start costs anyway.
 */
const CONFIG_CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  snapshot: ConfigSnapshot;
  /** Expiry stamp; `Date.now` is precise enough at a 5s granularity. */
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
/**
 * Single-flight. Without it, the first request after a TTL expiry lets every concurrent viewer of
 * the same lecture start its own build — the exact thundering herd the cache exists to prevent,
 * arriving at the one moment the cache is empty.
 */
const inFlight = new Map<string, Promise<ConfigSnapshot | null>>();

function cacheKey(a: ConfigAudience): string {
  // A space cannot occur in a uuid, a share token, a slug or a language code, so no two distinct
  // audiences can collide by concatenation.
  return [a.surface, a.contentId, a.viewerId ?? 'anon', a.language ?? ''].join(' ');
}

function evictIfNeeded(now: number): void {
  if (cache.size < CONFIG_CACHE_MAX_ENTRIES) return;
  for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  // Map iterates in insertion order, so this drops the oldest survivors first.
  for (const key of cache.keys()) {
    if (cache.size < CONFIG_CACHE_MAX_ENTRIES) break;
    cache.delete(key);
  }
}

/** Strong ETag over the exact bytes served. sha1, mirroring the sim-public asset route. */
export function strongEtag(body: string): string {
  return `"${createHash('sha1').update(body).digest('hex')}"`;
}

/**
 * Serialize and hash a freshly built config, reusing a cached build for the SAME audience when one
 * is younger than {@link CONFIG_CACHE_TTL_MS}.
 *
 * `build` resolving to null/undefined (content gone) is passed straight through and never cached:
 * a negative is cheap to recompute and caching it would keep answering 404 for up to 5s after a
 * restore.
 *
 * THE CALLER MUST HAVE FINISHED AUTHORIZING BEFORE IT CALLS THIS. This function knows nothing
 * about who may read what; it only guarantees that a payload built for one audience is never
 * handed to another.
 */
export async function configSnapshot(
  audience: ConfigAudience,
  build: () => Promise<unknown>,
): Promise<ConfigSnapshot | null> {
  const key = cacheKey(audience);

  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.snapshot;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const run = (async (): Promise<ConfigSnapshot | null> => {
    const config = await build();
    if (config === null || config === undefined) return null;
    const body = JSON.stringify(config);
    const snapshot: ConfigSnapshot = { body, etag: strongEtag(body) };
    const now = Date.now();
    evictIfNeeded(now);
    cache.set(key, { snapshot, expiresAt: now + CONFIG_CACHE_TTL_MS });
    return snapshot;
  })().finally(() => { inFlight.delete(key); });

  inFlight.set(key, run);
  return run;
}

/**
 * Weak-comparison `If-None-Match` check (RFC 9110 13.1.2): strip any `W/` prefix from the
 * candidates, honour `*`, and compare the opaque tags byte-for-byte. Deliberately the same rule
 * the sim-public asset route already uses, so the two conditional-GET surfaces cannot drift.
 */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}

/** The raw `If-None-Match` value, flattened — Fastify types the header as string or string[]. */
function ifNoneMatchOf(request: Pick<FastifyRequest, 'headers'>): string | undefined {
  const header = request.headers['if-none-match'];
  return Array.isArray(header) ? header[0] : header;
}

/**
 * Is this request a freshness revalidation rather than someone opening the video?
 *
 * A conditional GET is by definition a client that already holds this payload, so it is a re-poll
 * of a session that was already counted, not a new view. Without this gate the D-13 poll turns one
 * viewer of a one-hour lecture into ~60 views on the share and permalink routes, which both bump
 * `view_count` on every GET. The signal is the header itself rather than a client-supplied flag so
 * a fourth surface cannot forget to send it — and a forged `If-None-Match` buys a viewer nothing
 * but the suppression of their own view.
 */
export function isConfigRevalidation(request: Pick<FastifyRequest, 'headers'>): boolean {
  const value = ifNoneMatchOf(request);
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Answer a config request from a snapshot: `304` when the client's tag still matches, otherwise
 * the exact bytes the tag was computed over.
 *
 * `private, no-cache` plus `Vary: Authorization` because this payload is viewer-specific — a
 * shared proxy that cached it would be the same cross-audience leak the cache key exists to
 * prevent. `no-cache` still permits the 304: it means "revalidate before reuse", not "do not
 * store".
 *
 * CALL THIS ONLY AFTER AUTHORIZATION HAS PASSED. A viewer whose access was revoked must be
 * refused by the route's own gate before the conditional check is ever reached, or the 304 hands
 * them a stale allow.
 */
export function sendConfigSnapshot(
  request: Pick<FastifyRequest, 'headers'>,
  reply: FastifyReply,
  snapshot: ConfigSnapshot,
): FastifyReply {
  reply
    .header('ETag', snapshot.etag)
    .header('Cache-Control', 'private, no-cache');
  addVary(reply, 'Authorization');

  if (etagMatches(ifNoneMatchOf(request), snapshot.etag)) return reply.code(304).send();

  return reply.header('Content-Type', 'application/json; charset=utf-8').send(snapshot.body);
}

/**
 * Add one field to `Vary` without discarding what is already there.
 *
 * `reply.header('Vary', …)` REPLACES, and @fastify/cors has already set `Vary: Origin` on these
 * routes by the time a handler runs (it does whenever `origin` is not `*`, which is this app's
 * configuration). Overwriting it would tell a cache that one origin's CORS response is good for
 * every origin — a bug introduced by a header that was only meant to describe the payload.
 */
function addVary(reply: FastifyReply, field: string): void {
  const existing = reply.getHeader('vary');
  const current = Array.isArray(existing) ? existing.join(', ') : String(existing ?? '');
  if (!current) { reply.header('Vary', field); return; }
  if (current === '*') return;
  const already = current
    .split(',')
    .some((part) => part.trim().toLowerCase() === field.toLowerCase());
  if (!already) reply.header('Vary', `${current}, ${field}`);
}

/** Test seam only — drops every cached build so one test's payload cannot leak into the next. */
export function resetConfigCache(): void {
  cache.clear();
  inFlight.clear();
}
