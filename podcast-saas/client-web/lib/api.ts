'use client';

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

export async function createShareToken(
  projectId: string,
): Promise<{ shareToken: string; shareUrl: string }> {
  const headers = await authHeaders();
  const r = await fetch(`${BASE}/api/v1/projects/${projectId}/share`, {
    method: 'POST',
    headers,
  });
  if (!r.ok) throw new Error(`Failed to create share link: ${r.status}`);
  return r.json() as Promise<{ shareToken: string; shareUrl: string }>;
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
