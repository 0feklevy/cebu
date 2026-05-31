'use client';

import { ClientV1Api } from 'shared/src/generated/client-v1';
import { auth } from './firebase';

export function getApiClient(): ClientV1Api {
  return new ClientV1Api({
    baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
    getToken: async () => auth.currentUser?.getIdToken() ?? null,
  });
}

export const api = new ClientV1Api({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
  getToken: async () => auth.currentUser?.getIdToken() ?? null,
});

// ── Share token helpers ────────────────────────────────────────────────────

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

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
