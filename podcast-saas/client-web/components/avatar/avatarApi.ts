'use client';

import { auth } from '../../lib/firebase';
import { parseAvatarDenial, type AvatarDenial } from 'shared/src/avatar/denial';

/**
 * A refusal the product can EXPLAIN, as opposed to a failure it can only apologise for.
 *
 * The distinction matters at exactly one moment: when `AVATAR_BUDGET_MODE=enforce` is switched on
 * and viewers start meeting the limiter. Without this, every denial arrives as an anonymous Error
 * and the popup shows its generic "couldn't start right now" screen with a Try again button that
 * is guaranteed to fail again immediately.
 */
export class AvatarDenialError extends Error {
  readonly denial: AvatarDenial;
  constructor(denial: AvatarDenial) {
    super(denial.message);
    this.name = 'AvatarDenialError';
    this.denial = denial;
  }
}

/** The denial behind a rejection, when there is one. Null for every other kind of failure. */
export const denialOf = (e: unknown): AvatarDenial | null =>
  e instanceof AvatarDenialError ? e.denial : null;

const BASE = process.env.NEXT_PUBLIC_API_URL ?? (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:8080');

async function authHeaders(): Promise<Record<string, string>> {
  const token = await auth.currentUser?.getIdToken().catch(() => null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonFetch<T>(path: string, init?: RequestInit, withAuth = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) };
  if (withAuth) Object.assign(headers, await authHeaders());
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // `parseAvatarDenial` returns null unless the body carries one of the three reasons the shared
    // module defines, and it REGENERATES the copy rather than trusting the string it was sent — so
    // this cannot become a route by which a proxy error or a stack trace reaches a viewer's screen.
    const denial = parseAvatarDenial(json);
    if (denial) throw new AvatarDenialError(denial);
    throw new Error((json as { message?: string }).message ?? `Request failed: ${res.status}`);
  }
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
export interface LibraryUploadResult {
  ok: boolean;
  accepted: Array<{ filename: string; visualType: LibraryItem['visual_type']; id: string }>;
  rejected: Array<{ filename: string; reason: string }>;
}

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
  // Voice band of this circle's character — drives the viewer's FFT/pitch speaker
  // fallback when the project has no scenes timeline. Defaults: host_a=male, host_b=female.
  voice?: 'male' | 'female';
}

export interface AvatarCirclesConfig {
  enabled: boolean;
  // when circles appear (default 'broll'); 'manual' / 'broll+manual' use the
  // user-marked manualSections ranges — alone or merged with b-roll windows
  visibility?: 'broll' | 'always' | 'none' | 'manual' | 'broll+manual';
  manualSections?: Array<{ id: string; start_sec: number; end_sec: number }>;
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
// default) decides which character to use. withAuth=true so an owner (or invited
// collaborator) can start the avatar on their own PRIVATE project — the server's
// optional-auth visibility gate masks private projects as 404 for anonymous
// callers, and without the token the owner IS anonymous here. Anonymous viewers
// of public/unlisted projects are unaffected (no token → no header).
// `signal` lets a caller CANCEL a start it no longer wants instead of letting it
// complete and binning the result. /avatar/start is the most expensive endpoint in
// the product — it mints a single-use token behind one to six vendor round-trips —
// so a start nobody is waiting for should be stopped, not merely ignored. (This
// wastes a mint, not a concurrency slot: the backend creates no Anam session, the
// SDK's startSession does, browser-side.)
export const startAvatarSession = (
  characterId?: string,
  projectId?: string,
  signal?: AbortSignal,
  /**
   * ONE POPUP OPEN, ONE MINT — the client half of the server's idempotency (anam-backend-003).
   *
   * The server has deduped concurrent starts for a while via `startIdempotencyKey`, but it
   * requires a caller-supplied `startKey` of 8+ characters and returns un-deduped without one —
   * and this function never sent one. So the mechanism existed, its tests passed by supplying a
   * key the product does not generate, and two simultaneous starts both minted. An adversarial
   * review caught the row being marked "fixed" when it was not.
   *
   * The caller passes the identity of the OPEN, not of the request: a React StrictMode double
   * mount, a double click, or a retry of the same popup open must collapse to one mint, while a
   * genuinely new open must not. `AvatarPopup` already creates exactly such a value per open.
   */
  startKey?: string,
) =>
  // `correlationId` is the backend's start-trace id (services/avatar/startTelemetry.ts).
  // It is the join key between the server's phase timings and the client's — without it
  // the two halves of a slow open cannot be lined up against each other.
  jsonFetch<{ provider: string; sessionToken: string; characterId: string; characterSource?: 'configured' | 'requested' | 'default'; voiceSensitivity?: number; avatarDisplay?: AvatarDisplay; correlationId?: string }>(
    '/api/v1/avatar/start',
    { method: 'POST', body: JSON.stringify({ character_id: characterId, projectId, startKey }), signal },
    true,
  );

/** True for the DOMException fetch raises when its AbortSignal fires. */
export const isAbortError = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

export const endAvatarSession = (characterId: string): void => {
  fetch(`${BASE}/api/v1/avatar/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ character_id: characterId }),
    keepalive: true,
    credentials: 'omit',
  }).catch(() => {});
};

// withAuth=true, for the SAME reason startAvatarSession and getPublicLibrary carry it, and it is
// the difference between b-rolls appearing and never appearing.
//
// Both endpoints run `allowedProjectForBillable` (avatar.controller.ts), which reads
// `request.dbUser` and answers 404 for a project whose visibility is `private` —
// `projects.visibility` is `notNull().default('private')` (db/schema.ts), so that is EVERY
// project until its owner publishes it. `request.dbUser` comes from firebaseAuthOptionalMiddleware
// reading the Authorization header, and without the header the project's OWN OWNER is anonymous
// here. The 404 was then swallowed by the `.catch()` below and returned as a perfectly ordinary
// "no visual for this message", so the failure was invisible: the avatar connected, listened and
// answered, and not one visual ever appeared. Not late — never.
//
// Anonymous viewers of public/unlisted projects are unaffected: no signed-in user means no
// token means no header, exactly as before.
export const analyzeVisual = (message: string, characterId: string, context?: string, projectId?: string) =>
  jsonFetch<VisualResultWithBank>(
    '/api/v1/avatar/visual/analyze',
    { method: 'POST', body: JSON.stringify({ message, characterId, context, projectId }) },
    true,
  ).catch(() => ({ type: 'none' } as VisualResultWithBank));

export const analyzeImage = (userMessage: string, characterId: string, context?: string, projectId?: string) =>
  jsonFetch<ImageAnalysisResult>(
    '/api/v1/avatar/image/analyze',
    { method: 'POST', body: JSON.stringify({ userMessage, characterId, conversationContext: context, projectId }) },
    true,
  ).catch(() => ({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' as const }));

// Loads memory AND mints the capability token used to persist turns. withAuth=true so an
// owner can load memory for their own private project; anonymous viewers of public/unlisted
// projects work with no token header. A denied (private) project returns no token.
export const getMemory = (projectId: string | undefined, sessionKey: string) =>
  jsonFetch<{ token: string | null; turns: Turn[]; profile: Record<string, unknown> }>(
    `/api/v1/avatar/memory?sessionKey=${encodeURIComponent(sessionKey)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    undefined,
    true,
  ).catch(() => ({ token: null, turns: [], profile: {} }));

export const saveMemory = (token: string | null, sessionKey: string, characterId: string, projectId: string | undefined, turns: Turn[]): void => {
  if (!token) return; // no capability token (private/denied) → don't attempt to persist
  fetch(`${BASE}/api/v1/avatar/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, sessionKey, characterId, projectId, turns }),
    keepalive: true,
  }).catch(() => {});
};

export const getPublicLibrary = (projectId: string, opts?: { scope?: string; type?: string }) => {
  const p = new URLSearchParams();
  if (opts?.scope) p.set('scope', opts.scope);
  if (opts?.type) p.set('type', opts.type);
  // withAuth=true for the same reason as startAvatarSession: a private project's
  // library is owner/collaborator-only, and the .catch below silently turned the
  // masked 404 into an empty library for the project's own owner.
  return jsonFetch<LibraryPage>(`/api/v1/avatar/projects/${projectId}/library?${p}`, {}, true).catch(() => ({ items: [], total: 0, typeCounts: {} }));
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

export const uploadLibraryFiles = async (
  projectId: string,
  files: File[],
  opts?: { characterId?: string; scope?: 'basic' | 'extended' },
): Promise<LibraryUploadResult> => {
  const form = new FormData();
  form.set('scope', opts?.scope ?? 'extended');
  if (opts?.characterId) form.set('characterId', opts.characterId);
  for (const file of files) form.append('files', file, file.name);
  const headers = await authHeaders();
  const res = await fetch(`${BASE}/api/v1/projects/${projectId}/avatar/library/upload`, { method: 'POST', headers, body: form });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { message?: string }).message ?? `Upload failed: ${res.status}`);
  return json as LibraryUploadResult;
};

export const patchLibraryVisual = (projectId: string, visualId: string, body: { caption?: string; altText?: string; scope?: string }) =>
  jsonFetch<{ ok: boolean }>(`/api/v1/projects/${projectId}/avatar/library/${visualId}`, { method: 'PATCH', body: JSON.stringify(body) }, true);

export const deleteLibraryVisual = async (projectId: string, visualId: string): Promise<void> => {
  const headers = await authHeaders();
  await fetch(`${BASE}/api/v1/projects/${projectId}/avatar/library/${visualId}`, { method: 'DELETE', headers });
};

export const editLibrarySimulation = (projectId: string, visualId: string, instructions: string) =>
  jsonFetch<{ ok: boolean; simulationUrl: string }>(`/api/v1/projects/${projectId}/avatar/library/${visualId}/edit-simulation`, { method: 'POST', body: JSON.stringify({ instructions }) }, true);
