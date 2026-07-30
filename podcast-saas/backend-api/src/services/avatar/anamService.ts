// Anam session tokens with a FULL, podcast-saas-controlled persona config.
// Everything you would normally set in the Anam dashboard's Personas page —
// system prompt, knowledge, first greeting, language, avatar, voice, LLM — is
// driven from here (per-video `avatar_config`), via the documented fields of
// POST /v1/auth/session-token's `personaConfig` (override / ephemeral mode).
import { createHash } from 'crypto';
import { CHARACTERS, DEFAULT_CHARACTER_ID } from './characters.js';
import { logger } from '../../lib/logger.js';

const ANAM_BASE = 'https://api.anam.ai/v1';

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
}

export interface SessionInfo { token: string; characterId: string; voiceSensitivity: number; }
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

// Anam session tokens are effectively single-use per stream — reusing one whose
// session was already consumed makes the engine refuse the WebSocket. So we only
// cache for a few seconds: just long enough to dedupe React StrictMode's
// double-mount (two near-simultaneous /start calls), never across real reopens.
interface CachedToken { token: string; issuedAt: number; }
const tokenCache = new Map<string, CachedToken>();
const TOKEN_REUSE_MS = 6000;

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

/** Test/ops seam: forget the resolved-LLM cache (e.g. after rotating the account). */
export function invalidateAnamLlmCache(): void { _llmIdCache.clear(); }

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
  defaultLlmId: string,
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
  let baseAvatar = '', baseVoice = '', baseLlm = '';
  if (entry.personaId && (!cfg?.avatarId || !cfg?.voiceId || !cfg?.llmId)) {
    const base = await getPersona(entry.personaId, key);
    baseAvatar = base?.avatarId ?? base?.avatar?.id ?? '';
    baseVoice  = base?.voiceId  ?? base?.voice?.id  ?? '';
    baseLlm    = base?.llmId    ?? base?.llm?.id    ?? '';
  }
  const avatarId = (cfg?.avatarId?.trim() || baseAvatar || ANAM_ENV.ANAM_AVATAR_ID).trim();
  const voiceId  = (cfg?.voiceId?.trim()  || baseVoice  || ANAM_ENV.ANAM_VOICE_ID).trim();
  const llmId    = (cfg?.llmId?.trim()    || baseLlm    || defaultLlmId).trim();

  if (avatarId && voiceId) {
    const pc: Record<string, unknown> = { name: cfg?.name?.trim() || entry.name, avatarId, voiceId, maxSessionLengthSeconds };
    if (llmId) pc.llmId = llmId;                       // the brain — required for a v4 (non-legacy) token
    if (cfg?.avatarModel) pc.avatarModel = cfg.avatarModel;
    if (systemPrompt) pc.systemPrompt = systemPrompt;
    if (cfg?.skipGreeting) pc.skipGreeting = true;
    else if (greeting) pc.initialMessage = greeting;
    if (cfg?.uninterruptibleGreeting) pc.uninterruptibleGreeting = true;
    if (cfg?.languageCode) pc.languageCode = cfg.languageCode;
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
  const res = await fetch(`${ANAM_BASE}/auth/session-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientLabel: 'podcast-saas-avatar', personaConfig }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail };
  }
  const data = (await res.json()) as { sessionToken: string };
  return { ok: true, token: data.sessionToken };
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

  // The brain to bake in so Anam mints a v4 (non-legacy) token.
  const defaultLlmId = await resolveDefaultLlmId(key);
  const personaConfig = await buildPersonaConfig(id, cfg, key, defaultLlmId);
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

  // Cache by the exact config + key so identical rapid requests (e.g. React
  // StrictMode double-mount) reuse one token, but different per-video configs
  // (or different BYOK keys) each get their own.
  const cacheKey = createHash('sha1').update(`${key.slice(-8)}:${JSON.stringify(personaConfig)}`).digest('hex');
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() - cached.issuedAt < TOKEN_REUSE_MS) {
    return { token: cached.token, characterId: id, voiceSensitivity };
  }

  let minted = await mintSessionToken(key, personaConfig);

  // Rebuild a full inline ephemeral persona (same brain, via the base character persona's
  // avatar/voice + the resolved llmId) when the stored persona is unusable. Two triggers:
  //   • 400 invalid_persona_configuration — a stale personaId (deleted/recreated in the dashboard);
  //   • a 200 "legacy" token — a persona that still exists but has NO llmId (pre-v4 data), which
  //     Anam mints happily but the browser SDK rejects. We detect it from the JWT `type` claim.
  const legacyMinted = minted.ok && tokenTypeClaim(minted.token) === 'legacy';
  const staleRejected = !minted.ok && minted.status === 400 &&
    /invalid_persona_configuration|persona not found/i.test(minted.detail);
  if (personaConfig.personaId && (staleRejected || legacyMinted)) {
    const fallback = await buildPersonaConfig(id, { ...(cfg ?? {}), personaId: undefined }, key, defaultLlmId);
    if (fallback.avatarId && fallback.voiceId && fallback.llmId) {
      logger.warn(
        { characterId: id, personaId: personaConfig.personaId, reason: staleRejected ? 'stale-400' : 'legacy-token' },
        '[Anam] stored persona unusable (stale or brainless/legacy) — retrying with an ephemeral avatar+voice persona carrying a brain. Repair the saved personaId / ANAM_PERSONA_ID_* env, and ensure it has an llmId.',
      );
      minted = await mintSessionToken(key, fallback);
    }
  }

  if (!minted.ok) {
    logger.warn({ status: minted.status, detail: minted.detail }, '[Anam] session-token request failed');
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

  tokenCache.set(cacheKey, { token: minted.token, issuedAt: Date.now() });
  return { token: minted.token, characterId: id, voiceSensitivity };
}

interface AnamPersona { id?: string; avatarId?: string; voiceId?: string; llmId?: string; avatar?: { id?: string }; voice?: { id?: string }; llm?: { id?: string }; }

export async function getPersona(personaId: string, apiKey?: string): Promise<AnamPersona | null> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key || !personaId) return null;
  const res = await fetch(`${ANAM_BASE}/personas/${personaId}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return null;
  return res.json() as Promise<AnamPersona>;
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
    fetch(url, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

  let res = existingPersonaId
    ? await doReq('PUT', `${ANAM_BASE}/personas/${existingPersonaId}`)
    : await doReq('POST', `${ANAM_BASE}/personas`);
  // The stored persona may have been deleted in Anam — fall back to create.
  if (!res.ok && existingPersonaId) res = await doReq('POST', `${ANAM_BASE}/personas`);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.warn({ status: res.status, detail }, '[Anam] persona upsert failed');
    const e = new Error(`Anam persona ${existingPersonaId ? 'update' : 'create'} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`) as Error & { status: number };
    e.status = res.status; throw e;
  }
  const data = (await res.json()) as { id: string };
  return data.id;
}

// ── Knowledge base (RAG) + tools ───────────────────────────────────────────────

const RAG_DESC = 'Search the uploaded knowledge documents to answer the viewer’s questions about this video. Use it whenever a question might be answered by the provided material.';

async function anamFetch(path: string, apiKey: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ANAM_BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${apiKey}`, ...(init?.headers ?? {}) } });
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
  });
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
    const res = await anamFetch(`/tools/${existingId}`, key, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
    if (res.ok) return existingId;
  }
  const res = await anamFetch('/tools', key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  if (!res.ok) throw new Error(`Anam knowledge tool create failed (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

// Multipart-upload a document into a knowledge group.
export async function uploadKnowledgeDocument(groupId: string, buffer: Buffer, filename: string, contentType: string, apiKey?: string): Promise<unknown> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) throw new Error('No Anam API key available.');
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: contentType || 'application/octet-stream' }), filename);
  const res = await anamFetch(`/knowledge/groups/${groupId}/documents`, key, { method: 'POST', body: fd });
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
  const res = await anamFetch(`/knowledge/documents/${docId}`, key, { method: 'DELETE' });
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

// Proxies Anam's resource-listing endpoints so the video-settings UI can offer
// pickers of the account's available avatars / voices / LLMs / personas.
// Anam caps perPage at 100, so we page through (up to a cap) to return them all.
export async function listAnamResource(
  kind: 'avatars' | 'voices' | 'llms' | 'personas',
  apiKey?: string,
): Promise<{ data: unknown[] }> {
  const key = apiKey || ANAM_ENV.ANAM_API_KEY;
  if (!key) return { data: [] };
  const PER_PAGE = 100;
  const MAX_PAGES = 6; // up to 600 items — plenty for any picker
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${ANAM_BASE}/${kind}?page=${page}&perPage=${PER_PAGE}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      logger.warn({ kind, status: res.status, detail }, '[Anam] resource list failed');
      break;
    }
    const json = (await res.json()) as { data?: unknown[]; meta?: { lastPage?: number } };
    const batch = json.data ?? [];
    all.push(...batch);
    if (batch.length < PER_PAGE || (json.meta?.lastPage != null && page >= json.meta.lastPage)) break;
  }
  return { data: all };
}
