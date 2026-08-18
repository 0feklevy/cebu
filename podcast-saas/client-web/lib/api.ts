'use client';

import { z } from 'zod';
import { ClientV1Api } from 'shared/src/generated/client-v1';
import type { StartedExport } from 'shared/src/generated/client-v1';
import { auth } from './firebase';

export function getApiClient(): ClientV1Api {
  return new ClientV1Api({
    baseURL: process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080'),
    getToken: async () => auth.currentUser?.getIdToken() ?? null,
  });
}

export const api = new ClientV1Api({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080'),
  getToken: async () => auth.currentUser?.getIdToken() ?? null,
});

// ── Share token helpers ────────────────────────────────────────────────────

const BASE = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

async function authHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * The share endpoints are the one project boundary `ClientV1Api` does not cover, so these two
 * schemas are all that stands between the server's JSON and the link a user copies out of the
 * share sheet (types-010). They used to be `as` casts, which the compiler cannot enforce: a body
 * missing `shareToken` rendered `/v/undefined` and a numeric one rendered a plausible link to
 * nothing, in both cases with the button flipped to its "shared" state and no error anywhere.
 *
 * `.min(1)` on purpose — an empty token is not a token, and it would build `${origin}/v/`, which
 * resolves to a real (wrong) page rather than a 404.
 */
const ShareLinkSchema = z.object({
  shareToken: z.string().min(1),
  shareUrl:   z.string().min(1),
});
const ShareStatusSchema = z.object({
  shareToken: z.string().min(1).nullable(),
  shareUrl:   z.string().min(1).nullable(),
});
export type ShareLink = z.infer<typeof ShareLinkSchema>;
export type ShareStatus = z.infer<typeof ShareStatusSchema>;

const NOT_SHARED: ShareStatus = { shareToken: null, shareUrl: null };

export async function createShareToken(projectId: string): Promise<ShareLink> {
  const headers = await authHeaders();
  const r = await fetch(`${BASE}/api/v1/projects/${projectId}/share`, {
    method: 'POST',
    headers,
  });
  if (!r.ok) throw new Error(`Failed to create share link: ${r.status}`);
  const parsed = ShareLinkSchema.safeParse(await r.json().catch(() => null));
  if (!parsed.success) throw new Error('The server returned an unusable share link.');
  return parsed.data;
}

/**
 * Read the project's current share state. Unlike creation this runs unattended on page load, so a
 * failure of any kind — transport, status, or shape — resolves to "not shared" rather than
 * throwing: that is what the caller already did with its `.catch(() => {})`. What is new is that a
 * malformed token can no longer be ADOPTED. Previously a non-string flowed through
 * `if (d.shareToken) setShareToken(d.shareToken)` and became the copied link.
 */
export async function getShareToken(projectId: string): Promise<ShareStatus> {
  try {
    const headers = await authHeaders();
    const r = await fetch(`${BASE}/api/v1/projects/${projectId}/share`, { headers });
    if (!r.ok) return NOT_SHARED;
    const parsed = ShareStatusSchema.safeParse(await r.json().catch(() => null));
    return parsed.success ? parsed.data : NOT_SHARED;
  } catch {
    return NOT_SHARED;
  }
}

export async function revokeShareToken(projectId: string): Promise<void> {
  const headers = await authHeaders();
  const r = await fetch(`${BASE}/api/v1/projects/${projectId}/share`, {
    method: 'DELETE',
    headers,
  });
  if (!r.ok && r.status !== 204) throw new Error(`Failed to revoke share link: ${r.status}`);
}

// ── Linear video export: start, with degraded-quality consent ──────────────
//
// This stands BESIDE the generated `api.startProjectExport` deliberately, and the export flow must
// use THIS one. Two things the generated method cannot express until it is regenerated:
//
//   1. The POST body `{ allow_degraded: true }` — the caller's explicit consent to an export whose
//      simulations render as still images.
//   2. The 409 `{ code: 'degraded_only', warnings: [...] }` refusal — `ClientV1Api.request()`
//      throws `Error(message)` on any non-OK response, which DISCARDS the code and the warnings;
//      the consent dialog needs both.
//
// TODO(reconcile): when the generated client gains the body parameter and a typed refusal, delete
// this and route through it.

/**
 * The server's "I can complete this export, but only with substitutions" answer. Not a failure:
 * a question. The flow must put it to the user and re-POST with `allow_degraded: true` only on an
 * explicit yes.
 */
export class DegradedOnlyError extends Error {
  readonly code = 'degraded_only';
  /** The plan's honest record of what would be substituted, verbatim. */
  readonly warnings: string[];
  constructor(message: string, warnings: string[]) {
    super(message);
    this.name = 'DegradedOnlyError';
    this.warnings = warnings;
  }
}

/**
 * Duck-typed on `code`, not `instanceof`: the hook must recognise the refusal even across module
 * mocks and bundler duplication, where `instanceof` silently answers false.
 */
export function isDegradedOnlyRefusal(err: unknown): err is { code: 'degraded_only'; message: string; warnings?: string[] } {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === 'degraded_only';
}

export async function startProjectExport(
  projectId: string,
  opts: { allowDegraded?: boolean } = {},
): Promise<StartedExport> {
  const headers = await authHeaders();
  const body = opts.allowDegraded ? JSON.stringify({ allow_degraded: true }) : undefined;
  const r = await fetch(`${BASE}/api/v1/projects/${projectId}/export`, {
    method: 'POST',
    headers: body !== undefined ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ message: r.statusText })) as
      { message?: string; code?: string; warnings?: string[] };
    if (r.status === 409 && err.code === 'degraded_only') {
      throw new DegradedOnlyError(
        err.message ?? 'This export can only complete with substitutions.',
        err.warnings ?? [],
      );
    }
    throw new Error(err.message ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<StartedExport>;
}
