'use client';

import { auth } from './firebase';
import { LibraryShareStateSchema } from 'shared/src/types/library-view';
import type { LibraryMaterialType, LibraryShareState } from 'shared/src/types/library-view';

/**
 * The four authenticated wrappers for the owner's library link.
 *
 * Shaped after `lib/api.ts`'s share-token helpers, including the lesson those carry (types-010):
 * the READ path resolves any failure — transport, status or shape — to a not-shared sentinel,
 * because it runs unattended on mount. That is what stops a malformed body being ADOPTED and
 * rendered as a plausible link to nothing; previously a non-string token flowed through
 * `if (d.shareToken) …` and became the copied URL. The WRITE paths throw, because a person is
 * waiting for an answer and silence would be a lie.
 */

const BASE = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

export const NOT_SHARED: LibraryShareState = {
  slug: null, url: null, cleanUrl: null, includeTypes: null, expiresAt: null, createdAt: null,
  title: null,
};

async function authHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function endpoint(projectId: string): string {
  return `${BASE}/api/v1/projects/${projectId}/library-share`;
}

/** Current link state. Never throws — an unattended read must not break the editor. */
export async function getLibraryShare(projectId: string): Promise<LibraryShareState> {
  try {
    const r = await fetch(endpoint(projectId), { headers: await authHeaders() });
    if (!r.ok) return NOT_SHARED;
    const parsed = LibraryShareStateSchema.safeParse(await r.json().catch(() => null));
    return parsed.success ? parsed.data : NOT_SHARED;
  } catch {
    return NOT_SHARED;
  }
}

/** Mint (idempotent). Throws on failure — the user pressed a button and is waiting. */
export async function createLibraryShare(projectId: string): Promise<LibraryShareState> {
  const r = await fetch(endpoint(projectId), { method: 'POST', headers: await authHeaders() });
  if (!r.ok) throw new Error(`Could not create the library link (${r.status}).`);
  const parsed = LibraryShareStateSchema.safeParse(await r.json().catch(() => null));
  if (!parsed.success || !parsed.data.url) throw new Error('The server returned an unusable library link.');
  return parsed.data;
}

export async function updateLibraryShare(
  projectId: string,
  patch: { includeTypes?: LibraryMaterialType[]; expiresAt?: string | null },
): Promise<LibraryShareState> {
  const r = await fetch(endpoint(projectId), {
    method: 'PATCH',
    headers: { ...(await authHeaders()), 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`Could not update the library link (${r.status}).`);
  const parsed = LibraryShareStateSchema.safeParse(await r.json().catch(() => null));
  if (!parsed.success) throw new Error('The server returned an unusable library link.');
  return parsed.data;
}

export async function revokeLibraryShare(projectId: string): Promise<void> {
  const r = await fetch(endpoint(projectId), { method: 'DELETE', headers: await authHeaders() });
  if (!r.ok && r.status !== 204) throw new Error(`Could not switch off the library link (${r.status}).`);
}
