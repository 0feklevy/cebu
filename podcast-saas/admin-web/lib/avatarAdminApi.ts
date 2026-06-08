'use client';

// Direct-fetch client for the admin Avatar endpoints (not part of the generated
// AdminV1Api). Mirrors the auth pattern used by lib/api.ts.
import { auth } from './firebase';

const BASE = process.env.ADMIN_API_URL ?? 'http://localhost:8080';

async function authedFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers as Record<string, string>) },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { message?: string }).message ?? `Request failed: ${res.status}`);
  return json as T;
}

export interface AvatarConfig {
  anam_configured: boolean;
  anam_api_key: boolean;
  persona_einstein: boolean;
  persona_darwin: boolean;
  persona_napoleon: boolean;
  persona_archimedes: boolean;
  openai: boolean;
  default_character: string;
  characters: string[];
  byok_enabled: boolean;
}

export interface AvatarStats {
  total_visuals: number;
  by_type: Record<string, number>;
  by_scope: Record<string, number>;
  by_source: Record<string, number>;
  conversation_turns: number;
  profiles: number;
}

export interface AvatarGalleryItem {
  id: string;
  project_id: string | null;
  project_title: string | null;
  scope: string;
  source: string;
  character_id: string;
  visual_type: string;
  caption: string | null;
  alt_text: string | null;
  image_url: string | null;
  sim_entry_url: string | null;
  visual_spec: Record<string, unknown> | null;
  use_count: number;
  created_at: string;
}

export interface AvatarSession {
  session_key: string;
  character_id: string;
  project_id: string | null;
  turns: { role: string; content: string; created_at: string }[];
}

export const getAvatarConfig = () => authedFetch<AvatarConfig>('/api/admin/v1/avatar/config');
export const setAvatarByok = (enabled: boolean) =>
  authedFetch<{ ok: boolean; byok_enabled: boolean }>('/api/admin/v1/avatar/byok', { method: 'PUT', body: JSON.stringify({ enabled }) });
export const getAvatarStats = () => authedFetch<AvatarStats>('/api/admin/v1/avatar/stats');

export const getAvatarGallery = (opts: { page?: number; type?: string; scope?: string; source?: string; character?: string; q?: string }) => {
  const p = new URLSearchParams();
  if (opts.page) p.set('page', String(opts.page));
  if (opts.type) p.set('type', opts.type);
  if (opts.scope) p.set('scope', opts.scope);
  if (opts.source) p.set('source', opts.source);
  if (opts.character) p.set('character', opts.character);
  if (opts.q) p.set('q', opts.q);
  return authedFetch<{ items: AvatarGalleryItem[]; total: number; page: number; typeCounts: Record<string, number> }>(`/api/admin/v1/avatar/gallery?${p}`);
};

export const deleteAvatarVisual = (id: string) => authedFetch<{ ok: boolean }>(`/api/admin/v1/avatar/gallery/${id}`, { method: 'DELETE' });
export const patchAvatarVisual = (id: string, body: { caption?: string; scope?: string }) =>
  authedFetch<{ ok: boolean }>(`/api/admin/v1/avatar/gallery/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export const getAvatarConversations = (limit = 100) => authedFetch<{ sessions: AvatarSession[] }>(`/api/admin/v1/avatar/conversations?limit=${limit}`);
