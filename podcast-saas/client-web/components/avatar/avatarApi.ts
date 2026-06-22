'use client';

import { auth } from '../../lib/firebase';

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonFetch<T>(path: string, init?: RequestInit, withAuth = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) };
  if (withAuth) Object.assign(headers, await authHeaders());
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { message?: string }).message ?? `Request failed: ${res.status}`);
  return json as T;
}

// ── Shared types ──────────────────────────────────────────────────────────────

export interface ChartDataset { label: string; data: number[]; backgroundColor?: string | string[]; borderColor?: string; }

export type VisualResult =
  | { type: 'equation'; latex: string; caption: string }
  | { type: 'chart'; chartType: 'bar' | 'line' | 'pie'; title: string; labels: string[]; datasets: ChartDataset[]; caption: string }
  | { type: 'diagram'; html: string; caption: string }
  | { type: 'simulation'; html: string; caption: string; simulationUrl?: string }
  | { type: 'image'; dallePrompt: string; imageType: 'realistic' | 'diagram'; caption: string }
  | { type: 'image_ready'; imageUrl: string; imageType: 'realistic' | 'diagram'; caption: string }
  | { type: 'image_loading'; caption: string }
  | { type: 'none' };

export type VisualResultWithBank = VisualResult & { _fromBank?: boolean; bankId?: string; _intentRequestedType?: string | null };

export interface ImageAnalysisResult {
  shouldGenerate: boolean;
  imageUrl: string | null;
  altText: string;
  caption: string;
  imageType: 'realistic' | 'diagram';
}

export interface LibraryItem {
  id: string;
  project_id: string | null;
  project_title?: string | null;
  scope: 'basic' | 'extended';
  source: 'editor' | 'generated' | 'uploaded';
  character_id: string;
  visual_type: 'image' | 'equation' | 'chart' | 'diagram' | 'simulation';
  caption: string | null;
  alt_text: string | null;
  image_url: string | null;
  sim_entry_url: string | null;
  visual_spec: Record<string, unknown> | null;
  use_count: number;
  created_at?: string;
}

export interface LibraryPage { items: LibraryItem[]; total: number; typeCounts: Record<string, number>; }

export interface Turn { role: 'user' | 'persona'; content: string; }

// ── Per-video avatar persona config ─────────────────────────────────────────

export interface AvatarPersonaConfig {
  personaId?: string;        // saved Anam persona id for this video (server-managed)
  characterId?: string;
  name?: string;
  avatarName?: string;
  avatarVariantName?: string;
  avatarImageUrl?: string;
  systemPrompt?: string;
  knowledge?: string;
  greeting?: string;
  languageCode?: string;
  avatarId?: string;
  avatarModel?: string;
  voiceId?: string;
  voiceName?: string;
  llmId?: string;
  maxSessionLengthSeconds?: number;
  skipGreeting?: boolean;
  uninterruptibleGreeting?: boolean;
  voiceSensitivity?: number;
  knowledgeGroupId?: string;
  knowledgeToolId?: string;
  toolIds?: string[];
}

export interface AnamResource { id?: string; name?: string; label?: string; description?: string; [k: string]: unknown; }
export interface AnamTool { id: string; name: string; description: string; }
export interface KnowledgeDoc { id: string; filename: string; fileSize?: number; fileType?: string; }

export interface AvatarDisplay {
  displayName?: string;
  nametag?: string;
  portrait?: string;
  startingLabel?: string;
  leaveLabel?: string;
  emoji?: string;
  voiceSensitivity?: number;
}

export const listAvatarTools = (projectId: string) =>
  jsonFetch<{ tools: AnamTool[] }>(`/api/v1/projects/${projectId}/avatar/tools`, {}, true).catch(() => ({ tools: [] as AnamTool[] }));

export const listKnowledgeDocs = (projectId: string) =>
  jsonFetch<{ data: KnowledgeDoc[] }>(`/api/v1/projects/${projectId}/avatar/knowledge/documents`, {}, true).catch(() => ({ data: [] as KnowledgeDoc[] }));

export const uploadKnowledgeDoc = async (projectId: string, file: File): Promise<{ ok: boolean }> => {
  const headers = await authHeaders();
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${BASE}/api/v1/projects/${projectId}/avatar/knowledge/documents`, { method: 'POST', headers, body: fd });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j as { message?: string }).message ?? `Upload failed: ${res.status}`); }
  return res.json();
};

export const deleteKnowledgeDoc = async (projectId: string, docId: string): Promise<void> => {
  const headers = await authHeaders();
  await fetch(`${BASE}/api/v1/projects/${projectId}/avatar/knowledge/documents/${docId}`, { method: 'DELETE', headers });
};

export const getAvatarConfig = (projectId: string) =>
  jsonFetch<{ config: AvatarPersonaConfig }>(`/api/v1/projects/${projectId}/avatar/config`, {}, true);

export const saveAvatarConfig = (projectId: string, config: AvatarPersonaConfig) =>
  jsonFetch<{ ok: boolean; config: AvatarPersonaConfig; personaId?: string; personaError?: string }>(`/api/v1/projects/${projectId}/avatar/config`, { method: 'PUT', body: JSON.stringify(config) }, true);

export const listAnamResources = (projectId: string, kind: 'avatars' | 'voices' | 'llms' | 'personas') =>
  jsonFetch<{ data: AnamResource[] }>(`/api/v1/projects/${projectId}/avatar/anam-resources?kind=${kind}`, {}, true).catch(() => ({ data: [] }));

// ── Avatar circles (audio-reactive overlays shown during b-roll) ────────────

export interface AvatarCircleFace {
  speaker: 'host_a' | 'host_b';
  side: 'left' | 'right';
  imageUrl?: string;
  label?: string;
}

export interface AvatarCirclesConfig {
  enabled: boolean;
  visibility?: 'broll' | 'always' | 'none'; // when circles appear (default 'broll')
  count: 1 | 2;
  faces?: AvatarCircleFace[];
  barStyle?: 'bars' | 'solid' | 'gradient';
  numberOfBars?: number;
  sensitivity?: number;
  barWidth?: number;
  innerRadius?: number;
  smoothness?: number;
  minHeight?: number;
  maxHeight?: number;
  rotationOffset?: number;
  lowFreqCutPct?: number;
  highFreqCutPct?: number;
  colorMode?: 'solid' | 'gradient';
  barColor?: string;
  gradientEnd?: string;
  background?: string;
  roundedBars?: boolean;
  circleSize?: number;
  circleOpacity?: number;
  circleLayout?: 'corners' | 'right-stack';
  circleSideInsetPct?: number;
  circleBottomPct?: number;
  circleGapPct?: number;
  showCenterCircle?: boolean;
}

export const getAvatarCircles = (projectId: string) =>
  jsonFetch<{ config: AvatarCirclesConfig | null }>(`/api/v1/projects/${projectId}/avatar/circles`, {}, true)
    .catch(() => ({ config: null }));

export const saveAvatarCircles = (projectId: string, config: AvatarCirclesConfig) =>
  jsonFetch<{ ok: boolean; config: AvatarCirclesConfig }>(`/api/v1/projects/${projectId}/avatar/circles`, { method: 'PUT', body: JSON.stringify(config) }, true);

export const uploadCircleFace = async (projectId: string, file: Blob, filename = 'face.jpg'): Promise<{ url: string }> => {
  const headers = await authHeaders();
  const fd = new FormData();
  fd.append('file', file, filename);
  const res = await fetch(`${BASE}/api/v1/projects/${projectId}/avatar/circle-face`, { method: 'POST', headers, body: fd });
  if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error((j as { message?: string }).message ?? `Upload failed: ${res.status}`); }
  return res.json();
};

export const getByokStatus = () =>
  jsonFetch<{ byokEnabled: boolean; hasKey: boolean }>(`/api/v1/avatar/byok-status`, {}, true).catch(() => ({ byokEnabled: false, hasKey: false }));

export const saveMyAnamKey = (apiKey: string) =>
  jsonFetch<{ ok: boolean; hasKey: boolean }>(`/api/v1/avatar/my-key`, { method: 'PUT', body: JSON.stringify({ apiKey }) }, true);

// ── Public conversation endpoints ───────────────────────────────────────────

// characterId optional — when omitted, the video's saved config (or the server
// default) decides which character to use.
export const startAvatarSession = (characterId?: string, projectId?: string) =>
  jsonFetch<{ provider: string; sessionToken: string; characterId: string; voiceSensitivity?: number; avatarDisplay?: AvatarDisplay }>(
    '/api/v1/avatar/start',
    { method: 'POST', body: JSON.stringify({ character_id: characterId, projectId }) },
  );

export const endAvatarSession = (characterId: string): void => {
  fetch(`${BASE}/api/v1/avatar/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character_id: characterId }),
    keepalive: true,
    credentials: 'omit',
  }).catch(() => {});
};

export const analyzeVisual = (message: string, characterId: string, context?: string, projectId?: string) =>
  jsonFetch<VisualResultWithBank>(
    '/api/v1/avatar/visual/analyze',
    { method: 'POST', body: JSON.stringify({ message, characterId, context, projectId }) },
  ).catch(() => ({ type: 'none' } as VisualResultWithBank));

export const analyzeImage = (userMessage: string, characterId: string, context?: string, projectId?: string) =>
  jsonFetch<ImageAnalysisResult>(
    '/api/v1/avatar/image/analyze',
    { method: 'POST', body: JSON.stringify({ userMessage, characterId, conversationContext: context, projectId }) },
  ).catch(() => ({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' as const }));

export const getMemory = (sessionKey: string) =>
  jsonFetch<{ turns: Turn[]; profile: Record<string, unknown> }>(`/api/v1/avatar/memory?sessionKey=${encodeURIComponent(sessionKey)}`)
    .catch(() => ({ turns: [], profile: {} }));

export const saveMemory = (sessionKey: string, characterId: string, projectId: string | undefined, turns: Turn[]): void => {
  fetch(`${BASE}/api/v1/avatar/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionKey, characterId, projectId, turns }),
    keepalive: true,
  }).catch(() => {});
};

export const getPublicLibrary = (projectId: string, opts?: { scope?: string; type?: string }) => {
  const p = new URLSearchParams();
  if (opts?.scope) p.set('scope', opts.scope);
  if (opts?.type) p.set('type', opts.type);
  return jsonFetch<LibraryPage>(`/api/v1/avatar/projects/${projectId}/library?${p}`).catch(() => ({ items: [], total: 0, typeCounts: {} }));
};

// ── Authenticated editor library management ─────────────────────────────────

export const getProjectLibrary = (projectId: string, opts?: { scope?: string; type?: string; q?: string; page?: number }) => {
  const p = new URLSearchParams();
  if (opts?.scope) p.set('scope', opts.scope);
  if (opts?.type) p.set('type', opts.type);
  if (opts?.q) p.set('q', opts.q);
  if (opts?.page) p.set('page', String(opts.page));
  return jsonFetch<LibraryPage>(`/api/v1/projects/${projectId}/avatar/library?${p}`, {}, true);
};

export const generateLibraryImage = (projectId: string, body: { prompt: string; caption?: string; characterId?: string; scope?: string }) =>
  jsonFetch<{ ok: boolean; item: LibraryItem; imageUrl: string }>(`/api/v1/projects/${projectId}/avatar/library/generate-image`, { method: 'POST', body: JSON.stringify(body) }, true);

export const generateLibrarySimulation = (projectId: string, body: { prompt: string; caption?: string; characterId?: string; scope?: string }) =>
  jsonFetch<{ ok: boolean; item: LibraryItem; simulationUrl: string }>(`/api/v1/projects/${projectId}/avatar/library/generate-simulation`, { method: 'POST', body: JSON.stringify(body) }, true);

export const patchLibraryVisual = (projectId: string, visualId: string, body: { caption?: string; altText?: string; scope?: string }) =>
  jsonFetch<{ ok: boolean }>(`/api/v1/projects/${projectId}/avatar/library/${visualId}`, { method: 'PATCH', body: JSON.stringify(body) }, true);

export const deleteLibraryVisual = async (projectId: string, visualId: string): Promise<void> => {
  const headers = await authHeaders();
  await fetch(`${BASE}/api/v1/projects/${projectId}/avatar/library/${visualId}`, { method: 'DELETE', headers });
};

export const editLibrarySimulation = (projectId: string, visualId: string, instructions: string) =>
  jsonFetch<{ ok: boolean; simulationUrl: string }>(`/api/v1/projects/${projectId}/avatar/library/${visualId}/edit-simulation`, { method: 'POST', body: JSON.stringify({ instructions }) }, true);
