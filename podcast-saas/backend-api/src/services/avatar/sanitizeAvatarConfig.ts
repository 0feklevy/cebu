import type { AvatarPersonaConfig } from './anamService.js';

/**
 * Make a stored `avatar_config` safe to CONSUME — the guard the 2026-08-23 outage earned.
 *
 * ── THE MECHANISM THIS STOPS ─────────────────────────────────────────────────────────────────
 * `avatar_config` is a jsonb column written by several paths over months. The readers are typed
 * `AvatarPersonaConfig` and lean on optional chaining — `cfg?.systemPrompt?.trim()` — which
 * protects against null and undefined AND AGAINST NOTHING ELSE. A number or object in a string
 * field makes `.trim` undefined and the call a TypeError; the error carries no `status`, so the
 * start handler's catch answered `500 Avatar session failed` in ~50 milliseconds, for every
 * viewer of that project, without the vendor ever being called. Measured against production: the
 * failing 500 arrived ~55ms after the ghost-project 404 — far less than one vendor round trip,
 * which is what pointed here.
 *
 * ── WHY COERCE-AND-DROP RATHER THAN REJECT ───────────────────────────────────────────────────
 * The viewer at the receiving end did not write this row and cannot fix it. A wrong-typed field
 * is treated exactly like an absent one — the reader's own fallback chain (character defaults,
 * env, base persona) takes over — because that is what every reader already does for `undefined`,
 * and it is the difference between "the avatar uses its default voice" and "the avatar is dead
 * for this video".
 *
 * Unknown keys pass through untouched: this function's contract is "the KNOWN fields have their
 * DECLARED types", not "I know every field".
 */

const STRING_FIELDS = [
  'personaId', 'characterId', 'name', 'avatarName', 'avatarVariantName', 'avatarImageUrl',
  'systemPrompt', 'knowledge', 'greeting', 'languageCode', 'avatarId', 'avatarModel',
  'voiceId', 'voiceName', 'llmId', 'knowledgeGroupId', 'knowledgeToolId', 'transcriptDocId',
  'transcriptHash',
] as const;

const NUMBER_FIELDS = ['maxSessionLengthSeconds', 'voiceSensitivity'] as const;
const BOOLEAN_FIELDS = ['skipGreeting', 'uninterruptibleGreeting'] as const;

export function sanitizeAvatarPersonaConfig(
  raw: AvatarPersonaConfig | Record<string, unknown> | null | undefined,
): AvatarPersonaConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cfg = { ...(raw as Record<string, unknown>) };

  for (const k of STRING_FIELDS) {
    if (k in cfg && typeof cfg[k] !== 'string') delete cfg[k];
  }
  for (const k of NUMBER_FIELDS) {
    if (k in cfg && (typeof cfg[k] !== 'number' || !Number.isFinite(cfg[k] as number))) delete cfg[k];
  }
  for (const k of BOOLEAN_FIELDS) {
    if (k in cfg && typeof cfg[k] !== 'boolean') delete cfg[k];
  }
  // toolIds: keep only string members; a wrong-typed container is treated as absent.
  if ('toolIds' in cfg) {
    cfg.toolIds = Array.isArray(cfg.toolIds) ? (cfg.toolIds as unknown[]).filter((t) => typeof t === 'string') : undefined;
    if (!cfg.toolIds) delete cfg.toolIds;
  }
  // The two server-managed objects: shape-checked loosely — a non-object is dropped, an object is
  // passed through (their own readers guard their members).
  for (const k of ['personaBaked', 'personaDisplay', 'avatarCircles'] as const) {
    if (k in cfg && (typeof cfg[k] !== 'object' || cfg[k] === null || Array.isArray(cfg[k]))) delete cfg[k];
  }
  return cfg as AvatarPersonaConfig;
}
