// Anam session tokens with a FULL, podcast-saas-controlled persona config.
// Everything you would normally set in the Anam dashboard's Personas page —
// system prompt, knowledge, first greeting, language, avatar, voice, LLM — is
// driven from here (per-video `avatar_config`), via the documented fields of
// POST /v1/auth/session-token's `personaConfig` (override / ephemeral mode).
import { CHARACTERS, DEFAULT_CHARACTER_ID } from './characters.js';
import { logger } from '../../lib/logger.js';

const ANAM_BASE = 'https://api.anam.ai/v1';

/**
 * Per-operation deadlines. Not one Anam call used to pass a `signal`: against a non-responding
 * socket a bare fetch was still pending after 12 seconds, holding a request, a database connection
 * and the viewer's popup for all of it. The shape below is the one already used by
 * services/course/transcript.ts:30-36 — an AbortController plus a timer, cleared on completion.
 *
 * Mutable so tests can shrink the deadlines; production values are these.
 */
export const ANAM_TIMEOUTS = {
  read:   8_000,    // GET personas / avatars / voices / llms / tools / knowledge listings
  mint:  15_000,    // POST /auth/session-token — a viewer is watching a spinner
  write: 20_000,    // persona / tool / knowledge-group upserts
  upload: 60_000,   // multipart document upload
};

type AnamOp = 'read' | 'mint' | 'write' | 'upload';

function timeoutError(op: AnamOp, ms: number): Error & { status: number; timedOut: true } {
  const err = new Error(`Anam ${op} timed out after ${ms}ms`) as Error & { status: number; timedOut: true };
  err.status = 504;
  err.timedOut = true;
  return err;
}

export function isAnamTimeout(err: unknown): boolean {
  return Boolean((err as { timedOut?: boolean } | null)?.timedOut);
}

/** fetch with a deadline and real cancellation. Throws a 504-shaped error when the deadline hits. */
async function anamFetchDeadline(url: string, init: RequestInit, op: AnamOp): Promise<Response> {
  const ms = ANAM_TIMEOUTS[op];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw timeoutError(op, ms);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A short, bounded classification of a vendor failure body. The raw body is NEVER logged: a
 * validation error can quote the request back, and the request contains the system prompt and the
 * video transcript. Only a recognised snake_case error code (or 'unrecognized') passes.
 */
function vendorCode(detail: string): string {
  const match = /"(?:error|code|type)"\s*:\s*"([a-z0-9_.-]{1,64})"/i.exec(detail ?? '');
  return match ? match[1] : 'unrecognized';
}

export const ANAM_ENV = {
  ANAM_API_KEY:               process.env.ANAM_API_KEY ?? '',
  ANAM_PERSONA_ID_EINSTEIN:   process.env.ANAM_PERSONA_ID_EINSTEIN ?? process.env.ANAM_PERSONA_ID ?? '',
  ANAM_PERSONA_ID_DARWIN:     process.env.ANAM_PERSONA_ID_DARWIN ?? process.env.ANAM_PERSONA_ID ?? '',
  ANAM_PERSONA_ID_NAPOLEON:   process.env.ANAM_PERSONA_ID_NAPOLEON ?? '',
  ANAM_PERSONA_ID_ARCHIMEDES: process.env.ANAM_PERSONA_ID_ARCHIMEDES ?? '',
  // Optional default avatar/voice so a base persona isn't strictly required.
  ANAM_AVATAR_ID:             process.env.ANAM_AVATAR_ID ?? '',
  ANAM_VOICE_ID:              process.env.ANAM_VOICE_ID ?? '',
  // Anam v4 replaced `brainType` with `llmId`: a persona/session-token WITHOUT an llmId is
  // stamped "legacy" and the browser SDK refuses it ("Legacy session tokens are no longer
  // supported"), while POST /personas 400s with "Either brainType or llmId is required".
  // Pin a real Anam-hosted LLM id here (GET /v1/llms); when unset we resolve one dynamically.
  // (Never CUSTOMER_CLIENT_V1 — that DISABLES Anam's brain for a client-driven LLM, which this
  // app does not run, so the avatar would go mute.)
  ANAM_LLM_ID:                process.env.ANAM_LLM_ID ?? '',
};

const PERSONA_MAP: Record<string, { personaId: string; name: string }> = {
  einstein:   { personaId: ANAM_ENV.ANAM_PERSONA_ID_EINSTEIN,   name: 'Albert' },
  darwin:     { personaId: ANAM_ENV.ANAM_PERSONA_ID_DARWIN,     name: 'Charles' },
  napoleon:   { personaId: ANAM_ENV.ANAM_PERSONA_ID_NAPOLEON,   name: 'Napoleon' },
  archimedes: { personaId: ANAM_ENV.ANAM_PERSONA_ID_ARCHIMEDES, name: 'Archimedes' },
};

// One audio-reactive avatar circle shown during b-roll (bottom corner).
export interface AvatarCircleFace {
  speaker: 'host_a' | 'host_b';      // whose voice drives this circle (from the script timeline)
  side: 'left' | 'right';            // which bottom corner
  imageUrl?: string;                 // circular avatar face (uploaded or captured+cropped)
  label?: string;                    // display name
  voice?: 'male' | 'female';         // voice band — drives the viewer's FFT/pitch speaker fallback
}

// "Clean podcast-style radial visualizer" config + the 1–2 avatar circles.
// Stored per-video in avatar_config; the frame-style fields drive the Phase-2
// animated bars (Phase 1 renders static circles during b-roll).
export interface AvatarCirclesConfig {
  enabled: boolean;
  // when circles appear (default 'broll'); 'manual' / 'broll+manual' use the
  // user-marked manualSections ranges — alone or merged with b-roll windows
  visibility?: 'broll' | 'always' | 'none' | 'manual' | 'broll+manual';
  manualSections?: Array<{ id: string; start_sec: number; end_sec: number }>;
  count: 1 | 2;
  faces?: AvatarCircleFace[];
  // radial visualizer frame style
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

/**
 * What was ACTUALLY baked into `personaId`, recorded only after a successful vendor upsert.
 * The start path trusts a stored persona exactly as far as this record still describes the
 * current config (see services/avatar/personaFingerprint.ts).
 */
export interface BakedPersona {
  fingerprint: string;      // personaFingerprint() of the semantic config at bake time
  toolIds: string[];        // the exact tool ids attached to the vendor persona
  transcriptHash: string;   // the caption-transcript revision the persona knows
  revision: number;         // monotonic bake counter for this video
  bakedAt: string;          // ISO timestamp
}

/**
 * COSMETIC identity of the avatar a stateful session resolves to — the popup's name and portrait.
 * Deliberately separate from the persona fields: it is excluded from the fingerprint, so caching
 * a face can never invalidate a persona (and drag every start back onto the slow path).
 */
export interface PersonaDisplay {
  avatarId: string;
  displayName: string;
  variantName: string;
  imageUrl: string;
}

// Everything controllable from podcast-saas video settings.
export interface AvatarPersonaConfig {
  avatarCircles?: AvatarCirclesConfig; // audio-reactive circles shown during b-roll
  personaId?: string;                // saved Anam persona id for THIS video (server-managed)
  characterId?: string;
  name?: string;
  avatarName?: string;
  avatarVariantName?: string;
  avatarImageUrl?: string;
  systemPrompt?: string;             // overrides the character default brain
  knowledge?: string;                // appended to the system prompt
  greeting?: string;                 // → initialMessage (spoken first)
  languageCode?: string;             // ISO 639-1, e.g. "en", "es", "fr"
  avatarId?: string;                 // visual avatar (ephemeral mode)
  avatarModel?: string;              // cara-2 | cara-3 | cara-4-latest
  voiceId?: string;
  voiceName?: string;
  llmId?: string;
  maxSessionLengthSeconds?: number;
  skipGreeting?: boolean;
  uninterruptibleGreeting?: boolean;
  voiceSensitivity?: number;         // client-side end-of-speech sensitivity (0–1)
  knowledgeGroupId?: string;         // Anam knowledge group for this video (server-managed)
  knowledgeToolId?: string;          // the RAG tool wrapping that group (server-managed)
  transcriptDocId?: string;          // auto-uploaded caption-transcript doc id (server-managed)
  toolIds?: string[];                // selected system tools (end_call, change_language, …)
  transcriptHash?: string;           // revision of the caption transcript now propagated (server-managed)
  personaBaked?: BakedPersona;       // what personaId was baked from (server-managed)
  personaDisplay?: PersonaDisplay;   // cosmetic name/portrait of the resolved avatar (server-managed)
}

/**
 * A stored `personaId` this mint proved UNUSABLE at the vendor, and therefore must be replaced.
 *
 * verifyStatefulPersona() is purely local: it compares a fingerprint this server wrote against the
 * config this server holds. It cannot see a persona someone deleted in the Anam dashboard — the
 * fingerprint still matches, the config still looks healthy, and only the vendor's 400 (or a
 * brainless "legacy" token) reveals the truth. Before this record existed the discovery was
 * logged and dropped, so EVERY open of that video paid the doomed stateful mint plus the
 * ephemeral rebuild, forever. The caller persists this (clear personaId + personaBaked, then
 * re-bake) to make the repair durable across processes and restarts.
 */
export interface PersonaRepair {
  /** The stored persona id that is no longer usable. */
  personaId: string;
  /** stale-400: the vendor rejected it as missing/invalid. legacy-token: it exists but has no
   *  llmId brain, so the vendor mints a token the browser SDK refuses. */
  reason: 'stale-400' | 'legacy-token';
  /** true when THIS start paid the doomed vendor mint to find out; false when the in-process
   *  registry already knew and skipped it. A caller that keeps seeing `discovered: true` for the
   *  same project is a caller that is not persisting the repair. */
  discovered: boolean;
}

export interface SessionInfo {
  token: string;
  characterId: string;
  voiceSensitivity: number;
  /** The avatar the session ACTUALLY uses (ephemeral inline, or the saved persona's) — lets
   *  the popup show the real face/name instead of a stale hardcoded character default. */
  avatarId?: string;
  /** Ephemeral persona display name, when one was minted. */
  personaName?: string;
  /** Set when the config's stored personaId turned out to be unusable at the vendor and this
   *  session fell back to an inline persona. Persist the repair or the next open pays again. */
  personaRepair?: PersonaRepair;
}
export interface AvatarDisplay {
  displayName?: string;
  nametag?: string;
  portrait?: string;
  startingLabel?: string;
  leaveLabel?: string;
  voiceSensitivity?: number;
}

interface AnamAvatarResource {
  id?: string;
  displayName?: string;
  variantName?: string;
  imageUrl?: string;
  voiceId?: string;
  defaultVoiceId?: string;
  voice?: { id?: string };
  defaultVoice?: { id?: string };
  [key: string]: unknown;
}

interface AnamVoiceResource {
  id?: string;
  displayName?: string;
  description?: string;
}

// NOTE: there is deliberately no token cache here. Anam session tokens are effectively single-use
// per stream, and a cache keyed on the persona config is CONFIG-GLOBAL: every viewer of a given
// video produces the same config, so two people opening the same public video seconds apart were
// handed the same token and the second stream was refused. Deduping a double-mounted popup is a
// per-popup-open concern and lives in startIdempotency.ts, keyed on a client value scoped to the
// project and caller. See tokenReuse.test.ts.

function cleanLabel(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stringProp(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nestedId(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  if (value && typeof value === 'object') return stringProp(value as Record<string, unknown>, 'id');
  return undefined;
}

function linkedVoiceId(avatar: AnamAvatarResource): string | undefined {
  const rec = avatar as Record<string, unknown>;
  for (const key of ['voiceId', 'defaultVoiceId', 'voice_id', 'default_voice_id', 'defaultVoiceID']) {
    const value = stringProp(rec, key);
    if (value) return value;
  }
  for (const key of ['voice', 'defaultVoice', 'default_voice']) {
    const value = nestedId(rec, key);
    if (value) return value;
  }
  const voices = rec.voices;
  if (Array.isArray(voices)) {
    const first = voices[0];
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object') return stringProp(first as Record<string, unknown>, 'id');
  }
  return undefined;
}

function voiceForAvatar(avatar: AnamAvatarResource, voices: AnamVoiceResource[]): AnamVoiceResource | undefined {
  const explicit = linkedVoiceId(avatar);
  if (explicit) return voices.find((voice) => voice.id === explicit) ?? { id: explicit, displayName: avatar.displayName };

  const avatarName = cleanLabel(avatar.displayName);
  if (!avatarName) return undefined;
  return (
    voices.find((voice) => cleanLabel(voice.displayName) === avatarName) ??
    voices.find((voice) => cleanLabel(voice.displayName).startsWith(`${avatarName} `)) ??
    voices.find((voice) => cleanLabel(voice.description).includes(avatarName))
  );
}

export async function enrichAvatarConfigFromAnam(
  cfg: AvatarPersonaConfig,
  apiKey?: string,
  opts: { forceDefaultVoice?: boolean } = {},
): Promise<AvatarPersonaConfig> {
  if (!cfg.avatarId) return cfg;

  const [avatarResult, voiceResult] = await Promise.all([
    listAnamResource('avatars', apiKey),
    listAnamResource('voices', apiKey),
  ]);
  const avatars = avatarResult.data as AnamAvatarResource[];
  const voices = voiceResult.data as AnamVoiceResource[];
  const avatar = avatars.find((item) => item.id === cfg.avatarId);
  if (!avatar) return cfg;

  const next: AvatarPersonaConfig = {
    ...cfg,
    avatarName: cfg.avatarName || avatar.displayName || '',
    avatarVariantName: cfg.avatarVariantName || avatar.variantName || '',
    avatarImageUrl: cfg.avatarImageUrl || avatar.imageUrl || '',
  };

  if (opts.forceDefaultVoice || !next.voiceId) {
    const pairedVoice = voiceForAvatar(avatar, voices);
    next.voiceId = pairedVoice?.id ?? '';
    next.voiceName = pairedVoice?.displayName ?? '';
  } else if (next.voiceId && !next.voiceName) {
    next.voiceName = voices.find((voice) => voice.id === next.voiceId)?.displayName ?? '';
  }

  return next;
}

export function buildAvatarDisplay(_characterId: string, cfg: AvatarPersonaConfig | undefined, voiceSensitivity: number): AvatarDisplay | undefined {
  // A video that pinned an avatar carries its identity inline; a stateful session that resolved its
  // avatar on an earlier start carries it in the cosmetic `personaDisplay` record. Either way the
  // popup shows the face the session ACTUALLY uses without a vendor call on this request.
  if (!cfg?.avatarId && cfg?.personaDisplay?.avatarId) {
    const d = cfg.personaDisplay;
    const name = d.displayName?.trim() || cfg.name?.trim() || 'the avatar';
    const variantName = d.variantName?.trim();
    return {
      displayName: name,
      nametag: [name, variantName].filter(Boolean).join(' · ') || name,
      portrait: d.imageUrl?.trim() || undefined,
      startingLabel: `Connecting to ${name}...`,
      leaveLabel: 'End conversation',
      voiceSensitivity,
    };
  }
  if (!cfg?.avatarId) return { voiceSensitivity };
  const displayName = cfg.avatarName?.trim() || cfg.name?.trim() || 'the avatar';
  const variant = cfg.avatarVariantName?.trim();
  const nametag = [displayName, variant].filter(Boolean).join(' · ');
  return {
    displayName,
    nametag: nametag || displayName,
    portrait: cfg.avatarImageUrl?.trim() || undefined,
    startingLabel: `Connecting to ${displayName}...`,
    leaveLabel: 'End conversation',
    voiceSensitivity,
  };
}

// The Anam-hosted LLM ("brain") to bake into every persona/token so Anam mints a v4
// ephemeral/stateful token (never "legacy"). Env pin wins; otherwise resolve the account's
// first real hosted LLM from GET /v1/llms and cache it (per API-key suffix, 1h). Returns ''
// only when neither is available — callers surface a clear config error rather than mint a
// legacy token.
const _llmIdCache = new Map<string, { id: string; at: number }>();
const LLM_ID_CACHE_MS = 3_600_000;
export async function resolveDefaultLlmId(apiKey?: string): Promise<string> {
  // The env pin is a SERVER-account id — it is only valid for the server key. A BYOK caller
  // (their own Anam account) must resolve an llm from THEIR account, or the baked-in server
  // llm id would 400 as "llm not found" for them.
  const usingServerKey = !apiKey || apiKey === ANAM_ENV.ANAM_API_KEY;
  if (usingServerKey && ANAM_ENV.ANAM_LLM_ID) return ANAM_ENV.ANAM_LLM_ID;
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) return '';
  const ck = key.slice(-8);
  const cached = _llmIdCache.get(ck);
  if (cached && Date.now() - cached.at < LLM_ID_CACHE_MS) return cached.id;
  const { data } = await listAnamResource('llms', key).catch(() => ({ data: [] as unknown[] }));
  const llms = data as Array<{ id?: string; name?: string }>;
  // Prefer a real hosted LLM; NEVER CUSTOMER_CLIENT_V1 (that disables Anam's brain and would
  // make the avatar mute) — so if that's the only entry, resolve to '' (caller errors clearly).
  const pick = llms.find(l => l.id && l.id !== 'CUSTOMER_CLIENT_V1');
  const id = (pick?.id ?? '').trim();
  if (id) _llmIdCache.set(ck, { id, at: Date.now() });
  else logger.warn('[Anam] no hosted LLM found via GET /llms — set ANAM_LLM_ID; sessions will fail until a brain is configured');
  return id;
}

/** The `type` claim of an Anam session-token JWT ('ephemeral' | 'stateful' | 'legacy' | null).
 *  The browser SDK rejects 'legacy' tokens (a persona with no llmId brain), so we detect that
 *  server-side and refuse to hand one out. Read-only decode — no signature check needed. */
function tokenTypeClaim(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const t = (JSON.parse(json) as { type?: unknown }).type;
    return typeof t === 'string' ? t.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Test/ops seam: forget every per-process Anam cache — the resolved LLM, the live account
 *  default avatar/voice, the paged resource listings, and the unusable-persona registry.
 *  Use after rotating the account key or editing the Anam dashboard. */
export function invalidateAnamLlmCache(): void {
  _llmIdCache.clear();
  _defaultAvatarCache.clear();
  _resourceListCache.clear();
  _deadPersonaCache.clear();
}

// Live account defaults: when neither the video config, the base character persona, nor the
// ANAM_AVATAR_ID/ANAM_VOICE_ID env resolve an avatar/voice, fall back to the FIRST avatar
// (+ its paired voice) the account offers RIGHT NOW — so defaults track the Anam dashboard
// (renames, deletions, new avatars) instead of failing on stale env ids. Cached 1h per key.
interface DefaultAvatarVoice {
  avatarId: string; voiceId: string;
  avatarName: string; avatarVariantName: string; avatarImageUrl: string; voiceName: string;
}
const _defaultAvatarCache = new Map<string, { v: DefaultAvatarVoice | null; at: number }>();
export async function resolveDefaultAvatarVoice(apiKey?: string): Promise<DefaultAvatarVoice | null> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) return null;
  const ck = key.slice(-8);
  const cached = _defaultAvatarCache.get(ck);
  if (cached && Date.now() - cached.at < LLM_ID_CACHE_MS) return cached.v;
  const [avatarResult, voiceResult] = await Promise.all([
    listAnamResource('avatars', key),
    listAnamResource('voices', key),
  ]);
  const avatars = avatarResult.data as AnamAvatarResource[];
  const voices = voiceResult.data as AnamVoiceResource[];
  const avatar = avatars.find((a) => a.id && a.imageUrl) ?? avatars.find((a) => a.id);
  let v: DefaultAvatarVoice | null = null;
  if (avatar?.id) {
    const paired = voiceForAvatar(avatar, voices) ?? voices.find((x) => x.id);
    if (paired?.id) {
      v = {
        avatarId: avatar.id, voiceId: paired.id,
        avatarName: avatar.displayName ?? '', avatarVariantName: avatar.variantName ?? '',
        avatarImageUrl: avatar.imageUrl ?? '', voiceName: paired.displayName ?? '',
      };
    }
  }
  if (!v) logger.warn('[Anam] account has no usable avatar+voice pair — sessions will fail until one exists');
  _defaultAvatarCache.set(ck, { v, at: Date.now() });
  return v;
}

// A described avatar is a name, a variant and a portrait URL — cosmetics that change only when
// someone edits the Anam dashboard. Describing one costs a full paged account listing, so results
// are cached per {key, avatarId} with a TTL and a hard entry cap. `peekAvatarLook` is the
// synchronous read used on the request path: a hit means the popup gets the real face with no
// vendor call at all, a miss means the lookup happens after the response.
const AVATAR_LOOK_TTL_MS = 3_600_000;
const AVATAR_LOOK_MAX_ENTRIES = 500;
const _avatarLookCache = new Map<string, { v: PersonaDisplay; at: number }>();

function lookCacheKey(avatarId: string, apiKey?: string): string {
  return `${(apiKey || ANAM_ENV.ANAM_API_KEY).slice(-8)}:${avatarId}`;
}

/** Cached avatar identity, or undefined on a miss. Synchronous — safe on the response path. */
export function peekAvatarLook(avatarId: string, apiKey?: string): PersonaDisplay | undefined {
  if (!avatarId) return undefined;
  const hit = _avatarLookCache.get(lookCacheKey(avatarId, apiKey));
  if (!hit) return undefined;
  if (Date.now() - hit.at >= AVATAR_LOOK_TTL_MS) {
    _avatarLookCache.delete(lookCacheKey(avatarId, apiKey));
    return undefined;
  }
  return hit.v;
}

/** Look up an avatar's live display identity (name/variant/image) from the account listing. */
export async function describeAvatar(
  avatarId: string,
  apiKey?: string,
): Promise<{ displayName: string; variantName: string; imageUrl: string } | null> {
  if (!avatarId) return null;
  const { data } = await listAnamResource('avatars', apiKey);
  const avatar = (data as AnamAvatarResource[]).find((a) => a.id === avatarId);
  if (!avatar) return null;
  const look = { displayName: avatar.displayName ?? '', variantName: avatar.variantName ?? '', imageUrl: avatar.imageUrl ?? '' };
  if (_avatarLookCache.size >= AVATAR_LOOK_MAX_ENTRIES) {
    const oldest = _avatarLookCache.keys().next().value;   // insertion-ordered
    if (oldest) _avatarLookCache.delete(oldest);
  }
  _avatarLookCache.set(lookCacheKey(avatarId, apiKey), { v: { avatarId, ...look }, at: Date.now() });
  return look;
}

// ── Unusable-persona registry (anam-backend-010) ──────────────────────────────
//
// A persona deleted in the Anam dashboard is INVISIBLE to verifyStatefulPersona: that check is
// local (personaFingerprint.ts) and compares the fingerprint this server wrote against the config
// this server holds. Both still agree. Only the mint finds out — and the old code logged the
// finding and threw it away, so every subsequent open of that video repeated the discovery:
// a doomed stateful mint plus the ephemeral rebuild, two sequential vendor round trips.
//
// This registry is the in-process half of the repair: once a mint has proved a personaId dead,
// later starts in this process build the inline persona directly and skip the doomed hop. It is
// NOT the durable half — it dies with the process and every replica learns separately — which is
// why getSessionToken also reports the finding on SessionInfo.personaRepair for the caller to
// persist. Bounded and TTL'd in the same style as _avatarLookCache: a dashboard repair (adding an
// llmId back to a legacy persona) must heal on its own within the TTL rather than needing a deploy.
const DEAD_PERSONA_TTL_MS = 600_000;      // 10 min — long enough to cover a viewing session
const DEAD_PERSONA_MAX_ENTRIES = 500;
const _deadPersonaCache = new Map<string, { reason: PersonaRepair['reason']; at: number }>();

function deadKey(personaId: string, apiKey?: string): string {
  return `${(apiKey || ANAM_ENV.ANAM_API_KEY).slice(-8)}:${personaId}`;
}

/** Record that the vendor refused this stored persona. Called only after a real mint said so. */
export function markPersonaUnusable(personaId: string, apiKey: string | undefined, reason: PersonaRepair['reason']): void {
  if (!personaId) return;
  if (_deadPersonaCache.size >= DEAD_PERSONA_MAX_ENTRIES) {
    const oldest = _deadPersonaCache.keys().next().value;   // insertion-ordered
    if (oldest) _deadPersonaCache.delete(oldest);
  }
  _deadPersonaCache.set(deadKey(personaId, apiKey), { reason, at: Date.now() });
}

/** Why this persona is known-dead, or undefined. Synchronous — safe on the request path. */
export function peekUnusablePersona(personaId: string, apiKey?: string): PersonaRepair['reason'] | undefined {
  if (!personaId) return undefined;
  const k = deadKey(personaId, apiKey);
  const hit = _deadPersonaCache.get(k);
  if (!hit) return undefined;
  if (Date.now() - hit.at >= DEAD_PERSONA_TTL_MS) { _deadPersonaCache.delete(k); return undefined; }
  return hit.reason;
}

/** A stateful mint that SUCCEEDED with a non-legacy token proves the persona is alive again
 *  (re-created under the same id, or a dashboard repair) — stop condemning it. */
function clearPersonaUnusable(personaId: string, apiKey?: string): void {
  if (personaId) _deadPersonaCache.delete(deadKey(personaId, apiKey));
}

// Builds the personaConfig sent to Anam. v4 requires a COMPLETE persona at token time:
// either a pure stateful { personaId } (referencing a saved persona that itself carries an
// llmId), or a full inline EPHEMERAL persona that includes a brain (llmId). The old
// "personaId + inline systemPrompt/greeting overrides" hybrid is exactly what Anam now
// stamps "legacy", so we no longer emit it — when the video overrides the brain we resolve
// the base character persona's avatar/voice and mint a full ephemeral persona instead.
async function buildPersonaConfig(
  characterId: string,
  cfg: AvatarPersonaConfig | undefined,
  key: string,
  // B2: a THUNK, not a value. The stateful fast path below returns before any brain is needed,
  // so a resolved-and-discarded llm id was a free-looking `await` that costs up to six sequential
  // vendor round trips whenever ANAM_LLM_ID is unpinned or the caller is BYOK.
  resolveLlm: () => Promise<string>,
): Promise<Record<string, unknown>> {
  const maxSessionLengthSeconds = cfg?.maxSessionLengthSeconds ?? 600;

  // A per-video persona we created (upsertVideoPersona now always bakes in an llmId) →
  // pure v4 stateful config. No inline overrides (they'd revert it to the legacy hybrid).
  if (cfg?.personaId) {
    return { personaId: cfg.personaId, maxSessionLengthSeconds };
  }

  const entry = PERSONA_MAP[characterId] ?? PERSONA_MAP[DEFAULT_CHARACTER_ID];
  const character = CHARACTERS[characterId] ?? CHARACTERS[DEFAULT_CHARACTER_ID];

  let systemPrompt = (cfg?.systemPrompt?.trim() || character?.systemPrompt || '');
  if (cfg?.knowledge?.trim()) {
    systemPrompt += `\n\nKNOWLEDGE — facts and material you know and may draw on when relevant:\n${cfg.knowledge.trim()}`;
  }
  const greeting = cfg?.greeting?.trim() || character?.initialMessage;

  // Resolve avatar/voice/llm: explicit cfg → base character persona's values (fetched once) →
  // env / resolved default. A complete inline persona WITH a brain mints a non-legacy token.
  //
  // anam-backend-005: this GET used to fire whenever `!cfg.llmId` — and no video config
  // hand-picks an LLM, so that disjunct was true for every project and the base persona was
  // fetched even when the video already pinned BOTH an avatar and a voice. It is fetched now only
  // for what it is actually for: filling in a missing avatar or voice.
  //
  // Consequence, stated plainly: for a video that pins avatar+voice but no llmId, the brain now
  // comes from the account default (ANAM_LLM_ID, else the first hosted LLM from GET /llms)
  // instead of the base character persona's llmId. Both are brains on the same Anam account. The
  // base persona's own llm is still honoured — but only as a LAST resort below, when nothing else
  // supplies one, so the common case never pays a round trip for it.
  let baseAvatar = '', baseVoice = '', baseLlm = '';
  const needsBaseLook = !cfg?.avatarId?.trim() || !cfg?.voiceId?.trim();
  if (entry.personaId && needsBaseLook) {
    const base = await getPersona(entry.personaId, key);
    baseAvatar = base?.avatarId ?? base?.avatar?.id ?? '';
    baseVoice  = base?.voiceId  ?? base?.voice?.id  ?? '';
    baseLlm    = base?.llmId    ?? base?.llm?.id    ?? '';
  }
  let avatarId = (cfg?.avatarId?.trim() || baseAvatar || ANAM_ENV.ANAM_AVATAR_ID).trim();
  let voiceId  = (cfg?.voiceId?.trim()  || baseVoice  || ANAM_ENV.ANAM_VOICE_ID).trim();
  let llmId    = (cfg?.llmId?.trim()    || baseLlm    || '').trim();
  if (!llmId) llmId = (await resolveLlm()).trim();
  if (!llmId && entry.personaId && !needsBaseLook) {
    // Nothing pinned, and the account listing offered no hosted LLM. Only NOW is the base
    // persona's own brain worth a round trip — the alternative is failing the start outright.
    const base = await getPersona(entry.personaId, key);
    llmId = (base?.llmId ?? base?.llm?.id ?? '').trim();
  }

  // Live-account fallback: stale/absent character persona ids and no env avatar/voice →
  // resolve whatever the account offers NOW, so the default avatar always exists.
  let liveDefaultName = '';
  if (!avatarId || !voiceId) {
    const live = await resolveDefaultAvatarVoice(key).catch(() => null);
    if (live) {
      if (!avatarId) { avatarId = live.avatarId; liveDefaultName = live.avatarName; }
      if (!voiceId) voiceId = live.voiceId;
    }
  }

  if (avatarId && voiceId) {
    const pc: Record<string, unknown> = { name: cfg?.name?.trim() || liveDefaultName || entry.name, avatarId, voiceId, maxSessionLengthSeconds };
    if (llmId) pc.llmId = llmId;                       // the brain — required for a v4 (non-legacy) token
    if (cfg?.avatarModel) pc.avatarModel = cfg.avatarModel;
    if (systemPrompt) pc.systemPrompt = systemPrompt;
    if (cfg?.skipGreeting) pc.skipGreeting = true;
    else if (greeting) pc.initialMessage = greeting;
    if (cfg?.uninterruptibleGreeting) pc.uninterruptibleGreeting = true;
    if (cfg?.languageCode) pc.languageCode = cfg.languageCode;
    // Attach the RAG knowledge tool + selected system tools, mirroring upsertVideoPersona —
    // the ephemeral path must carry the same knowledge as a saved persona, or the avatar
    // silently loses the video transcript whenever the stateful persona can't be used
    // (stale-400 / legacy-token fallback, or a video that never baked a persona).
    const toolIds = [...new Set([...(cfg?.knowledgeToolId ? [cfg.knowledgeToolId] : []), ...(cfg?.toolIds ?? [])])];
    if (toolIds.length) pc.toolIds = toolIds;
    return pc;
  }

  // Couldn't assemble an inline persona (no avatar/voice anywhere) — reference the base
  // persona statefully (works when that dashboard persona already carries an llmId).
  if (entry.personaId) return { personaId: entry.personaId, maxSessionLengthSeconds };
  return {};   // caller raises the "no persona configured" error
}

export function isAnamConfigured(): boolean {
  return Boolean(
    ANAM_ENV.ANAM_API_KEY &&
    (PERSONA_MAP[DEFAULT_CHARACTER_ID]?.personaId || (ANAM_ENV.ANAM_AVATAR_ID && ANAM_ENV.ANAM_VOICE_ID)),
  );
}

async function mintSessionToken(key: string, personaConfig: Record<string, unknown>): Promise<{ ok: true; token: string } | { ok: false; status: number; detail: string }> {
  let res: Response;
  try {
    res = await anamFetchDeadline(`${ANAM_BASE}/auth/session-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientLabel: 'podcast-saas-avatar', personaConfig }),
    }, 'mint');
  } catch (err) {
    // A timed-out or failed mint is reported as a DEFINITE failure and is never retried here.
    // Unlike the GETs below, this POST is not idempotent: after an ambiguous timeout the vendor may
    // already have minted a token we never received, so a retry can mint twice — two billed
    // sessions, and a second concurrency slot held until it expires on its own. Fail fast and let
    // the viewer press start again, which is a decision a human makes once.
    return { ok: false, status: isAnamTimeout(err) ? 504 : 502, detail: isAnamTimeout(err) ? 'timeout' : 'network_error' };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail };
  }
  const data = (await res.json()) as { sessionToken: string };
  return { ok: true, token: data.sessionToken };
}

// Mint, retrying once WITHOUT toolIds on a 400 — if Anam rejects tool attachment on an
// ephemeral personaConfig, the video knowledge still rides inline in the systemPrompt
// KNOWLEDGE block (see the /avatar/start transcript default), so a degraded-but-working
// session beats a hard failure.
async function mintWithToolFallback(key: string, personaConfig: Record<string, unknown>) {
  let minted = await mintSessionToken(key, personaConfig);
  if (!minted.ok && minted.status === 400 && personaConfig.toolIds) {
    logger.warn({ code: vendorCode(minted.detail) }, '[Anam] session-token 400 with toolIds — retrying without them');
    const { toolIds: _toolIds, ...rest } = personaConfig;
    minted = await mintSessionToken(key, rest);
  }
  return minted;
}

export async function getSessionToken(characterId: string, cfg?: AvatarPersonaConfig, apiKey?: string): Promise<SessionInfo> {
  const id = CHARACTERS[characterId] ? characterId : DEFAULT_CHARACTER_ID;
  const voiceSensitivity = cfg?.voiceSensitivity ?? CHARACTERS[id]?.endOfSpeechSensitivity ?? 0.5;
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;

  if (!key) {
    const err = new Error('No Anam API key available. Set ANAM_API_KEY on the server, or add your own key in Settings → Avatar.') as Error & { status: number };
    err.status = 503;
    throw err;
  }

  // The brain to bake in so Anam mints a v4 (non-legacy) token — resolved LAZILY, and at most
  // once per start. A healthy project mints statefully by personaId and never looks at a brain,
  // so awaiting this up front bought nothing and cost a GET /llms paging crawl on every deploy's
  // first stateful start (the cache is per PROCESS) and on every BYOK start (the env pin is a
  // SERVER-account id, so a BYOK key can never use it).
  let llmIdPromise: Promise<string> | undefined;
  const resolveLlm = () => (llmIdPromise ??= resolveDefaultLlmId(key));

  let personaConfig = await buildPersonaConfig(id, cfg, key, resolveLlm);

  // anam-backend-010, in-process half: a persona this process has already watched the vendor
  // refuse is not worth a second doomed mint. Skip straight to the inline persona — but ONLY if a
  // complete one can be assembled, because when it cannot, that doomed mint is still this start's
  // only chance and must not be taken away from it.
  let personaRepair: PersonaRepair | undefined;
  const storedPersonaId = typeof personaConfig.personaId === 'string' ? personaConfig.personaId : '';
  const knownDeadReason = storedPersonaId ? peekUnusablePersona(storedPersonaId, key) : undefined;
  if (knownDeadReason) {
    const ephemeral = await buildPersonaConfig(id, { ...(cfg ?? {}), personaId: undefined }, key, resolveLlm);
    if (ephemeral.avatarId && ephemeral.voiceId && ephemeral.llmId) {
      personaRepair = { personaId: storedPersonaId, reason: knownDeadReason, discovered: false };
      personaConfig = ephemeral;
    }
  }
  if (!personaConfig.personaId && !(personaConfig.avatarId && personaConfig.voiceId)) {
    const err = new Error(`No Anam persona configured for "${id}". Set ANAM_PERSONA_ID_${id.toUpperCase()} (or choose an avatar+voice in the video's Avatar settings).`) as Error & { status: number };
    err.status = 503;
    throw err;
  }
  // Proactive brain guard: an inline (ephemeral) persona with NO llmId is exactly the
  // brainless persona Anam mints as a "legacy" token — fail loudly with a fixable message
  // instead of wasting a mint and handing the browser a token it will reject.
  if (personaConfig.avatarId && !personaConfig.llmId) {
    const err = new Error(`No Anam LLM (brain) available for "${id}". Set ANAM_LLM_ID (a real Anam-hosted LLM), or pick an LLM in the video's Avatar settings.`) as Error & { status: number };
    err.status = 503;
    throw err;
  }

  // The avatar this session will actually show — for the popup's name/portrait. Inline
  // (ephemeral) configs carry it directly; a stateful-personaId session leaves it to the
  // caller (the controller resolves the persona's avatar only when it needs the display).
  let resolvedAvatarId = (typeof personaConfig.avatarId === 'string' ? personaConfig.avatarId : '') || cfg?.avatarId || '';
  const personaName = typeof personaConfig.name === 'string' ? personaConfig.name : undefined;

  let minted = await mintWithToolFallback(key, personaConfig);

  // Rebuild a full inline ephemeral persona (same brain, via the base character persona's
  // avatar/voice + the resolved llmId) when the stored persona is unusable. Two triggers:
  //   • 400 invalid_persona_configuration — a stale personaId (deleted/recreated in the dashboard);
  //   • a 200 "legacy" token — a persona that still exists but has NO llmId (pre-v4 data), which
  //     Anam mints happily but the browser SDK rejects. We detect it from the JWT `type` claim.
  const legacyMinted = minted.ok && tokenTypeClaim(minted.token) === 'legacy';
  const staleRejected = !minted.ok && minted.status === 400 &&
    /invalid_persona_configuration|persona not found/i.test(minted.detail);
  if (personaConfig.personaId && minted.ok && !legacyMinted) {
    // It answered, and with a real v4 token: whatever we may have believed about this id before
    // (re-created under the same id, or an llmId added back in the dashboard), it is alive now.
    clearPersonaUnusable(String(personaConfig.personaId), key);
  }
  if (personaConfig.personaId && (staleRejected || legacyMinted)) {
    // anam-backend-010: record it in-process AND hand it to the caller. The old code only logged
    // here, and nothing outside this file read the flags — so the repair never became durable and
    // every single open of the video repeated these two round trips.
    const deadPersonaId = String(personaConfig.personaId);
    const reason: PersonaRepair['reason'] = staleRejected ? 'stale-400' : 'legacy-token';
    markPersonaUnusable(deadPersonaId, key, reason);
    personaRepair = { personaId: deadPersonaId, reason, discovered: true };
    const fallback = await buildPersonaConfig(id, { ...(cfg ?? {}), personaId: undefined }, key, resolveLlm);
    if (fallback.avatarId && fallback.voiceId && fallback.llmId) {
      logger.warn(
        { characterId: id, personaId: personaConfig.personaId, reason: staleRejected ? 'stale-400' : 'legacy-token' },
        '[Anam] stored persona unusable (stale or brainless/legacy) — retrying with an ephemeral avatar+voice persona carrying a brain. Repair the saved personaId / ANAM_PERSONA_ID_* env, and ensure it has an llmId.',
      );
      minted = await mintWithToolFallback(key, fallback);
      if (minted.ok && typeof fallback.avatarId === 'string') resolvedAvatarId = fallback.avatarId;
    }
  }

  if (!minted.ok) {
    // The raw body is not logged: a persona-validation error quotes the request back, and the
    // request carries the system prompt and the video transcript.
    logger.warn({ status: minted.status, code: vendorCode(minted.detail) }, '[Anam] session-token request failed');
    const err = new Error(`Anam API error (${minted.status})${minted.detail ? `: ${minted.detail.slice(0, 200)}` : ''}`) as Error & { status: number };
    err.status = minted.status;
    throw err;
  }

  // Never hand the browser a legacy token — it would throw "Legacy session tokens are no longer
  // supported". If we still have one here (e.g. a brainless base persona with no ephemeral
  // fallback available), fail with an actionable config error instead.
  if (tokenTypeClaim(minted.token) === 'legacy') {
    const err = new Error(`Anam returned a legacy session token for "${id}" — the persona has no llmId brain. Set ANAM_LLM_ID (a real Anam-hosted LLM) and make sure the referenced persona carries an llmId.`) as Error & { status: number };
    err.status = 503;
    throw err;
  }

  return { token: minted.token, characterId: id, voiceSensitivity, avatarId: resolvedAvatarId || undefined, personaName, personaRepair };
}

interface AnamPersona { id?: string; avatarId?: string; voiceId?: string; llmId?: string; avatar?: { id?: string }; voice?: { id?: string }; llm?: { id?: string }; }

export async function getPersona(personaId: string, apiKey?: string): Promise<AnamPersona | null> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key || !personaId) return null;
  // Idempotent read: a deadline here can only cost information, never a duplicate side effect.
  try {
    const res = await anamFetchDeadline(`${ANAM_BASE}/personas/${personaId}`, { headers: { Authorization: `Bearer ${key}` } }, 'read');
    if (!res.ok) return null;
    return await (res.json() as Promise<AnamPersona>);
  } catch {
    return null;
  }
}

// Create (or update) a real Anam persona for a video from the chosen settings —
// the avatar (look) is rebuilt with the character's brain/voice, saved in the
// account, and its id returned to store per-video. Avatar/voice/llm not chosen
// are inherited from the base character persona so a partial selection still works.
export async function upsertVideoPersona(
  characterId: string,
  cfg: AvatarPersonaConfig,
  apiKey?: string,
  existingPersonaId?: string,
): Promise<string> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) { const e = new Error('No Anam API key available.') as Error & { status: number }; e.status = 503; throw e; }
  const id = CHARACTERS[characterId] ? characterId : DEFAULT_CHARACTER_ID;
  const character = CHARACTERS[id];
  const baseEntry = PERSONA_MAP[id] ?? PERSONA_MAP[DEFAULT_CHARACTER_ID];

  let baseAvatar = '', baseVoice = '', baseLlm = '';
  if (baseEntry.personaId && (!cfg.avatarId || !cfg.voiceId || !cfg.llmId)) {
    const base = await getPersona(baseEntry.personaId, key);
    baseAvatar = base?.avatarId ?? base?.avatar?.id ?? '';
    baseVoice = base?.voiceId ?? base?.voice?.id ?? '';
    baseLlm = base?.llmId ?? base?.llm?.id ?? '';
  }
  const avatarId = (cfg.avatarId || baseAvatar || ANAM_ENV.ANAM_AVATAR_ID || '').trim();
  const voiceId = (cfg.voiceId || baseVoice || ANAM_ENV.ANAM_VOICE_ID || '').trim();
  // v4 requires a brain on every persona ("Either brainType or llmId is required" — brainType
  // is removed, so it MUST be an llmId). Fall back to the base persona's llm, then the account
  // default (env or GET /llms). Without one, Anam 400s the create — fail with a clear message.
  const llmId = (cfg.llmId || baseLlm || '').trim() || await resolveDefaultLlmId(key);
  if (!avatarId || !voiceId) {
    const e = new Error('Choose an avatar and a voice for this video (the base character persona has none to inherit).') as Error & { status: number };
    e.status = 400; throw e;
  }
  if (!llmId) {
    const e = new Error('No Anam LLM (brain) available for this persona. Set ANAM_LLM_ID on the server (or pick an LLM in Avatar settings) — Anam requires an llmId to create a persona.') as Error & { status: number };
    e.status = 400; throw e;
  }

  let systemPrompt = (cfg.systemPrompt?.trim() || character?.systemPrompt || '');
  if (cfg.knowledge?.trim()) {
    systemPrompt += `\n\nKNOWLEDGE — facts and material you know and may draw on when relevant:\n${cfg.knowledge.trim()}`;
  }

  const payload: Record<string, unknown> = {
    name: cfg.name?.trim() || `${character?.personaName ?? id} (video)`,
    avatarId, voiceId,
    skipGreeting: Boolean(cfg.skipGreeting),
    uninterruptibleGreeting: Boolean(cfg.uninterruptibleGreeting),
    initialMessage: cfg.skipGreeting ? null : (cfg.greeting?.trim() || character?.initialMessage || null),
  };
  payload.llmId = llmId;   // always present now (resolved above) — never a brainless/legacy persona
  if (cfg.avatarModel) payload.avatarModel = cfg.avatarModel;
  if (systemPrompt) payload.systemPrompt = systemPrompt;
  if (cfg.languageCode) payload.languageCode = cfg.languageCode;

  // Attach the knowledge RAG tool (so the avatar can search uploaded docs) plus
  // any selected system tools (end_call / change_language / skip_turn).
  const toolIds = [...(cfg.knowledgeToolId ? [cfg.knowledgeToolId] : []), ...(cfg.toolIds ?? [])];
  if (toolIds.length) payload.toolIds = [...new Set(toolIds)];

  const doReq = (method: string, url: string) =>
    anamFetchDeadline(url, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 'write');

  // A definite error response on the UPDATE means the stored persona is gone (deleted in the
  // dashboard) — falling back to a create is right. A TIMEOUT is not a definite error: the vendor
  // may have applied the update we never heard about, and creating on top of that would leave two
  // personas for one video. So the timeout propagates (anamFetchDeadline throws) and no create runs.
  let res = existingPersonaId
    ? await doReq('PUT', `${ANAM_BASE}/personas/${existingPersonaId}`)
    : await doReq('POST', `${ANAM_BASE}/personas`);
  if (!res.ok && existingPersonaId) res = await doReq('POST', `${ANAM_BASE}/personas`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.warn({ status: res.status, code: vendorCode(detail) }, '[Anam] persona upsert failed');
    const e = new Error(`Anam persona ${existingPersonaId ? 'update' : 'create'} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`) as Error & { status: number };
    e.status = res.status; throw e;
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

// ── Knowledge base (RAG) + tools ───────────────────────────────────────────────

const RAG_DESC = 'Search the uploaded knowledge documents to answer the viewer’s questions about this video. Use it whenever a question might be answered by the provided material.';

async function anamFetch(path: string, apiKey: string, init?: RequestInit, op: AnamOp = 'read'): Promise<Response> {
  return anamFetchDeadline(`${ANAM_BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${apiKey}`, ...(init?.headers ?? {}) } }, op);
}

// Ensure a knowledge group exists for this video; returns its id.
export async function ensureKnowledgeGroup(name: string, apiKey?: string, existingId?: string): Promise<string> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) throw new Error('No Anam API key available.');
  if (existingId) {
    const res = await anamFetch(`/knowledge/groups/${existingId}`, key);
    if (res.ok) return existingId; // still exists
  }
  const res = await anamFetch('/knowledge/groups', key, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.slice(0, 120) }),
  }, 'write');
  if (!res.ok) throw new Error(`Anam knowledge group create failed (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

// Ensure a SERVER_RAG tool wraps the group; returns its id.
export async function ensureKnowledgeTool(groupId: string, name: string, apiKey?: string, existingId?: string): Promise<string> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) throw new Error('No Anam API key available.');
  const toolName = `Knowledge_${name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)}`;
  const config = {
    name: toolName, type: 'server', subtype: 'knowledge', description: RAG_DESC,
    parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'The search query to find relevant information in the uploaded documents.' } } },
    documentFolderIds: [groupId],
  };
  const body = JSON.stringify({ name: toolName, type: 'SERVER_RAG', description: RAG_DESC, config });
  if (existingId) {
    const res = await anamFetch(`/tools/${existingId}`, key, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body }, 'write');
    if (res.ok) return existingId;
  }
  const res = await anamFetch('/tools', key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }, 'write');
  if (!res.ok) throw new Error(`Anam knowledge tool create failed (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

// Multipart-upload a document into a knowledge group.
export async function uploadKnowledgeDocument(groupId: string, buffer: Buffer, filename: string, contentType: string, apiKey?: string): Promise<unknown> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) throw new Error('No Anam API key available.');
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: contentType || 'application/octet-stream' }), filename);
  const res = await anamFetch(`/knowledge/groups/${groupId}/documents`, key, { method: 'POST', body: fd }, 'upload');
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Anam document upload failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }
  return res.json().catch(() => ({}));
}

export async function listKnowledgeDocuments(groupId: string, apiKey?: string): Promise<{ data: unknown[] }> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key || !groupId) return { data: [] };
  const res = await anamFetch(`/knowledge/groups/${groupId}/documents`, key);
  if (!res.ok) return { data: [] };
  const json = (await res.json()) as unknown[] | { data?: unknown[] };
  return { data: Array.isArray(json) ? json : (json.data ?? []) };
}

export async function deleteKnowledgeDocument(docId: string, apiKey?: string): Promise<boolean> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) return false;
  const res = await anamFetch(`/knowledge/documents/${docId}`, key, { method: 'DELETE' }, 'write');
  return res.ok;
}

// Returns the account's SYSTEM tools (end_call, change_language, skip_turn).
export async function listSystemTools(apiKey?: string): Promise<Array<{ id: string; name: string; description: string }>> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) return [];
  const res = await anamFetch('/tools', key);
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: Array<{ id: string; name: string; description: string; type: string }> };
  const list = json.data ?? [];
  return list.filter((t) => t.type === 'SYSTEM').map((t) => ({ id: t.id, name: t.name, description: t.description }));
}

// anam-backend-007: one listing is a SEQUENTIAL paged crawl — up to six round trips before the
// caller sees anything — and it had no cache at all. Bounded and evicting in the same style as
// _avatarLookCache above.
//
// Honest about what this buys, because a per-process cache is easy to oversell:
//   • it is per PROCESS, so every replica warms independently and a deploy resets all of them;
//   • the TTL is short (5 min) on purpose — these lists back the settings PICKERS, and an operator
//     who adds a voice in the Anam dashboard must see it without waiting an hour;
//   • so on a low-traffic deploy with more than 5 minutes between starts, the hit rate is ~0.
// What it reliably collapses is BURSTS: enrichAvatarConfigFromAnam and resolveDefaultAvatarVoice
// each ask for `avatars` + `voices`, so one ephemeral start can crawl the same two listings twice;
// opening the video-settings panel fires avatars + voices + llms and refetches on every reopen;
// and several viewers starting the same unbaked video within a few minutes now share one crawl.
// It does NOT speed up the healthy stateful start, which already touches none of this.
//
// Callers that must see a dashboard edit immediately (the settings-picker proxy route) pass
// `{ fresh: true }`: that bypasses the read and refreshes the entry. Note the precedent — the
// live-defaults path above already caches the same two listings for a full HOUR — so five
// minutes is the tighter of the two staleness windows this file accepts.
const RESOURCE_LIST_TTL_MS = 300_000;
const RESOURCE_LIST_MAX_ENTRIES = 64;      // 4 kinds × a handful of BYOK keys
const _resourceListCache = new Map<string, { v: unknown[]; at: number }>();

// Proxies Anam's resource-listing endpoints so the video-settings UI can offer
// pickers of the account's available avatars / voices / LLMs / personas.
// Anam caps perPage at 100, so we page through (up to a cap) to return them all.
export async function listAnamResource(
  kind: 'avatars' | 'voices' | 'llms' | 'personas',
  apiKey?: string,
  opts: { fresh?: boolean } = {},
): Promise<{ data: unknown[] }> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) return { data: [] };
  const cacheKey = `${kind}:${key.slice(-8)}`;
  if (!opts.fresh) {
    const hit = _resourceListCache.get(cacheKey);
    if (hit && Date.now() - hit.at < RESOURCE_LIST_TTL_MS) return { data: [...hit.v] };
    if (hit) _resourceListCache.delete(cacheKey);
  }
  const PER_PAGE = 100;
  const MAX_PAGES = 6; // up to 600 items — plenty for any picker
  const all: unknown[] = [];
  // A crawl that stopped on a timeout or a vendor error returns a PARTIAL list. Serving that is
  // fine (every consumer degrades to "fewer options"); pinning it for five minutes is not.
  let complete = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
    // Idempotent, paged read: on a deadline or a vendor error we return the pages already
    // collected rather than failing the caller — every consumer degrades to "no options" cleanly.
    let res: Response;
    try {
      res = await anamFetchDeadline(`${ANAM_BASE}/${kind}?page=${page}&perPage=${PER_PAGE}`, {
        headers: { Authorization: `Bearer ${key}` },
      }, 'read');
    } catch (err) {
      logger.warn({ kind, page, timedOut: isAnamTimeout(err) }, '[Anam] resource list aborted');
      complete = false;
      break;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.warn({ kind, status: res.status, code: vendorCode(detail) }, '[Anam] resource list failed');
      complete = false;
      break;
    }
    const json = (await res.json()) as { data?: unknown[]; meta?: { lastPage?: number } };
    const batch = json.data ?? [];
    all.push(...batch);
    if (batch.length < PER_PAGE || (json.meta?.lastPage != null && page >= json.meta.lastPage)) break;
  }
  if (complete) {
    if (_resourceListCache.size >= RESOURCE_LIST_MAX_ENTRIES) {
      const oldest = _resourceListCache.keys().next().value;   // insertion-ordered
      if (oldest) _resourceListCache.delete(oldest);
    }
    _resourceListCache.set(cacheKey, { v: [...all], at: Date.now() });
  }
  return { data: all };
}
