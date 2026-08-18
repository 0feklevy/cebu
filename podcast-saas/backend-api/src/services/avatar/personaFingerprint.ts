// The durable persona invariant behind the fast (stateful) /avatar/start.
//
// A stateful mint is one vendor round-trip with a ~118-byte body: it names a persona that already
// lives in the Anam account. An ephemeral mint is three to six round-trips carrying a ~30 KB inline
// persona. The stateful shape is only CORRECT when the saved persona was baked from the very
// configuration the viewer is about to receive — same prompt, same greeting, same avatar/voice/brain,
// same attached tools, and the same caption transcript, because the transcript is what the avatar
// answers questions about.
//
// The endpoint used to approximate that with a single proxy — "was a RAG knowledge tool baked?" —
// and, when the answer was no, threw the pre-baked personaId away on EVERY start. That discard is
// the measured root cause of the slow start.
//
// Here the approximation is replaced by a recorded fact:
//
//   • personaFingerprint()  hashes every behaviour-changing field plus the transcript revision;
//   • bakedStateFor()       produces the record to persist — and callers may only persist it AFTER
//                           the vendor upsert returned success;
//   • verifyStatefulPersona() is the gate the start path consults, and it answers WHY when it says no.
//
// Cosmetic fields (display name, portrait, voice label, avatar circles) and per-session fields
// (maxSessionLengthSeconds, voiceSensitivity — both applied at token time, not baked) are excluded
// by construction: the field list below is an allowlist, so a new cosmetic field cannot silently
// start invalidating personas and dragging every start back onto the 30 KB path.
import { createHash } from 'crypto';
import { CHARACTERS, DEFAULT_CHARACTER_ID } from './characters.js';
import type { AvatarPersonaConfig, BakedPersona } from './anamService.js';

/** Bump when the meaning of the hashed fields changes — every project then re-bakes once. */
export const PERSONA_FINGERPRINT_VERSION = 1;

/** sha256 of a transcript, or '' when there is none. Never contains the text itself. */
export function hashTranscript(text: string | null | undefined): string {
  if (!text) return '';
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The exact tool ids a bake must attach, in the order upsertVideoPersona sends them:
 * the video's RAG knowledge tool first, then the selected system tools, deduped.
 */
export function desiredToolIds(cfg: AvatarPersonaConfig | undefined): string[] {
  const ids = [...(cfg?.knowledgeToolId ? [cfg.knowledgeToolId] : []), ...(cfg?.toolIds ?? [])];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.trim().length > 0))];
}

/**
 * The character a project's persona is baked as — always the CONFIG's own value, normalized the
 * same way the mint normalizes it (an unknown id resolves to the default).
 *
 * Deliberately not the request's `character_id`: that selects a session's character, and if it
 * could redefine what the project's persona IS, two clients disagreeing (the popup sends none, a
 * reconnect echoes the resolved one) would re-bake the persona back and forth forever and every
 * start would pay the inline-persona price.
 */
export function bakedCharacterId(cfg: AvatarPersonaConfig | undefined): string {
  const id = cfg?.characterId?.trim();
  return id && CHARACTERS[id] ? id : DEFAULT_CHARACTER_ID;
}

/**
 * Everything that changes how the avatar BEHAVES. Allowlisted on purpose (see the file header).
 * `transcriptHash` is a server-managed field written by transcript propagation, so the start path
 * can tell "the script changed" without reading captions.
 */
function behaviourInputs(cfg: AvatarPersonaConfig | undefined): Record<string, unknown> {
  return {
    v: PERSONA_FINGERPRINT_VERSION,
    characterId: bakedCharacterId(cfg),
    name: cfg?.name?.trim() ?? '',
    systemPrompt: cfg?.systemPrompt ?? '',
    knowledge: cfg?.knowledge ?? '',
    greeting: cfg?.greeting ?? '',
    skipGreeting: Boolean(cfg?.skipGreeting),
    uninterruptibleGreeting: Boolean(cfg?.uninterruptibleGreeting),
    languageCode: cfg?.languageCode ?? '',
    avatarId: cfg?.avatarId ?? '',
    avatarModel: cfg?.avatarModel ?? '',
    voiceId: cfg?.voiceId ?? '',
    llmId: cfg?.llmId ?? '',
    // Sorted: reordering the tool picker is not a behaviour change.
    toolIds: [...desiredToolIds(cfg)].sort(),
    transcriptHash: cfg?.transcriptHash ?? '',
  };
}

/** Stable hash of the semantic persona configuration. */
export function personaFingerprint(cfg: AvatarPersonaConfig | undefined): string {
  const inputs = behaviourInputs(cfg);
  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The record to persist alongside personaId — ONLY after a successful vendor upsert.
 * `previousRevision` keeps a monotonic counter so an operator can see how often a video re-bakes.
 */
export function bakedStateFor(
  cfg: AvatarPersonaConfig | undefined,
  previousRevision = 0,
): BakedPersona {
  return {
    fingerprint: personaFingerprint(cfg),
    toolIds: desiredToolIds(cfg),
    transcriptHash: cfg?.transcriptHash ?? '',
    revision: (Number.isFinite(previousRevision) ? Math.max(0, Math.trunc(previousRevision)) : 0) + 1,
    bakedAt: new Date().toISOString(),
  };
}

/**
 * Why the stateful path is (not) usable.
 *   healthy            — mint by personaId: 1 round-trip, small body.
 *   no_persona         — nothing baked yet for this video.
 *   never_fingerprinted— pre-invariant row: a persona id with no record of what went into it.
 *   config_changed     — a behaviour field or the transcript revision moved since the bake.
 *   tools_changed      — the bake did not actually carry the tool ids this config wants (the mint
 *                        retries without toolIds on a vendor 400, so these two can diverge).
 */
export type StatefulVerdict = 'healthy' | 'no_persona' | 'never_fingerprinted' | 'config_changed' | 'tools_changed';

export function verifyStatefulPersona(cfg: AvatarPersonaConfig | undefined): StatefulVerdict {
  if (!cfg?.personaId) return 'no_persona';
  const baked = cfg.personaBaked;
  if (!baked?.fingerprint) return 'never_fingerprinted';
  if (baked.fingerprint !== personaFingerprint(cfg)) return 'config_changed';
  const wanted = [...desiredToolIds(cfg)].sort();
  const actual = [...(baked.toolIds ?? [])].sort();
  if (wanted.length !== actual.length || wanted.some((id, i) => id !== actual[i])) return 'tools_changed';
  return 'healthy';
}
