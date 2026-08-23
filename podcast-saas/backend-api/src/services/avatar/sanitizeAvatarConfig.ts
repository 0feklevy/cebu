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

/** Key NAMES the last sanitize dropped or coerced — for logging; never the values. */
export function sanitizeDroppedKeys(
  raw: AvatarPersonaConfig | Record<string, unknown> | null | undefined,
): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const clean = sanitizeAvatarPersonaConfig(raw) as Record<string, unknown>;
  return Object.keys(raw as Record<string, unknown>).filter(
    (k) => JSON.stringify((raw as Record<string, unknown>)[k]) !== JSON.stringify(clean[k]),
  );
}

export function sanitizeAvatarPersonaConfig(
  raw: AvatarPersonaConfig | Record<string, unknown> | null | undefined,
): AvatarPersonaConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const cfg = { ...(raw as Record<string, unknown>) };

  for (const k of STRING_FIELDS) {
    if (k in cfg && typeof cfg[k] !== 'string') delete cfg[k];
  }
  for (const k of NUMBER_FIELDS) {
    if (!(k in cfg)) continue;
    // Coerce rather than drop: '1800' meaning thirty minutes silently becoming the 600s default
    // is a worse failure than the wrong type itself. Anything non-finite after coercion goes.
    const n = typeof cfg[k] === 'number' ? (cfg[k] as number) : Number(cfg[k]);
    if (Number.isFinite(n)) cfg[k] = n; else delete cfg[k];
  }
  for (const k of BOOLEAN_FIELDS) {
    if (k in cfg && typeof cfg[k] !== 'boolean') delete cfg[k];
  }
  // toolIds: keep only string members; a wrong-typed container is treated as absent.
  if ('toolIds' in cfg) {
    cfg.toolIds = Array.isArray(cfg.toolIds) ? (cfg.toolIds as unknown[]).filter((t) => typeof t === 'string') : undefined;
    if (!cfg.toolIds) delete cfg.toolIds;
  }
  // The server-managed objects: a non-object is dropped outright.
  for (const k of ['personaBaked', 'personaDisplay', 'avatarCircles'] as const) {
    if (k in cfg && (typeof cfg[k] !== 'object' || cfg[k] === null || Array.isArray(cfg[k]))) delete cfg[k];
  }
  // personaBaked's members feed personaFingerprint, which spreads `[...(baked.toolIds ?? [])]` —
  // a non-array there is a statusless TypeError thrown BEFORE the start handler's try, so it
  // reaches the wire as a generic 500 with no diagnostic line at all (reviewer finding B4).
  if (cfg.personaBaked) {
    const b = { ...(cfg.personaBaked as Record<string, unknown>) };
    for (const k of ['fingerprint', 'transcriptHash']) if (k in b && typeof b[k] !== 'string') delete b[k];
    if ('revision' in b && (typeof b.revision !== 'number' || !Number.isFinite(b.revision))) delete b.revision;
    if ('toolIds' in b) {
      b.toolIds = Array.isArray(b.toolIds) ? (b.toolIds as unknown[]).filter((t) => typeof t === 'string') : undefined;
      if (!b.toolIds) delete b.toolIds;
    }
    cfg.personaBaked = b;
  }
  // personaDisplay's members are consumed with the SAME fragile pattern this module exists for
  // (`d.displayName?.trim()` in buildAvatarDisplay) — and they are WRITTEN from vendor data
  // (`look.displayName ?? ''`, where `??` happily passes an object through). A vendor shape
  // change must cost a cosmetic fallback, not a session.
  if (cfg.personaDisplay) {
    const d = { ...(cfg.personaDisplay as Record<string, unknown>) };
    for (const k of ['avatarId', 'displayName', 'variantName', 'imageUrl']) {
      if (k in d && typeof d[k] !== 'string') delete d[k];
    }
    cfg.personaDisplay = d;
  }
  return cfg as AvatarPersonaConfig;
}
