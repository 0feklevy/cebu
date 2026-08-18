// Baking a video's Anam persona, and healing videos that were never baked.
//
// The stateful (fast) start needs a saved persona that provably matches the video's current
// configuration — see personaFingerprint.ts for the invariant. Two paths write that:
//
//   • the editor's PUT /avatar/config and transcript propagation bake explicitly;
//   • a viewer's start on a project whose persona is missing or stale schedules a BACKGROUND bake
//     after the response, so the next viewer gets the one-round-trip path. This is how projects
//     that predate the invariant self-heal without anyone editing them.
//
// Rules this module enforces:
//   • the persona is marked baked ONLY after the vendor upsert returned success;
//   • the baked persona carries everything an ephemeral session would have carried — including the
//     caption transcript — so "make the stateful path stick" never means "the avatar forgets the video";
//   • the background bake never delays a response, never throws into a request, is single-flighted
//     per project (two viewers cannot mint two personas), and backs off after a failure;
//   • nothing here logs a prompt, a transcript, a persona body, a key or a vendor error string.
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { projects } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { upsertVideoPersona, type AvatarPersonaConfig, type BakedPersona } from './anamService.js';
import { bakedStateFor, hashTranscript, verifyStatefulPersona } from './personaFingerprint.js';

// Cap on the caption transcript inlined into a session's KNOWLEDGE block — bounds the
// per-session prompt size while covering the full script of typical videos.
export const TRANSCRIPT_KNOWLEDGE_MAX_CHARS = 24_000;

/** Wait this long after a failed bake before trying that project again. */
const BAKE_BACKOFF_MS = 5 * 60_000;

/**
 * The video's caption transcript is the avatar's DEFAULT knowledge: it goes into the KNOWLEDGE
 * block after any user-written knowledge, so the avatar can answer about the actual spoken content.
 * ONE definition, used by both the ephemeral start path and the bake — if they diverged, making the
 * stateful path stick would quietly change what the avatar knows.
 */
export function withTranscriptKnowledge(
  cfg: AvatarPersonaConfig | undefined,
  transcript: string | null | undefined,
): AvatarPersonaConfig {
  if (!transcript) return cfg ?? {};
  const userKnowledge = cfg?.knowledge?.trim();
  const block =
    'VIDEO TRANSCRIPT — the exact spoken content of the video the viewer is watching. ' +
    `Base your answers about the video on it:\n${transcript.slice(0, TRANSCRIPT_KNOWLEDGE_MAX_CHARS)}`;
  return { ...(cfg ?? {}), knowledge: userKnowledge ? `${userKnowledge}\n\n${block}` : block };
}

/** Re-read avatar_config and overwrite only `patch`'s keys (narrows the read-modify-write window
 *  against a concurrent editor save). Returns the merged config. */
export async function patchAvatarConfig(projectId: string, patch: Partial<AvatarPersonaConfig>): Promise<AvatarPersonaConfig> {
  const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { avatar_config: true } });
  const current = (row?.avatar_config as AvatarPersonaConfig | null) ?? {};
  const merged = { ...current, ...patch };
  await db.update(projects).set({ avatar_config: merged, updated_at: new Date() }).where(eq(projects.id, projectId));
  return merged;
}

export interface BakeInput {
  projectId: string;
  characterId: string;
  cfg: AvatarPersonaConfig;
  transcript: string | null;
  apiKey?: string;
}

/**
 * Upsert the vendor persona for this video and persist what went into it.
 * Throws whatever the vendor threw — callers decide whether that is fatal.
 */
export async function bakeProjectPersona(input: BakeInput): Promise<{ personaId: string; baked: BakedPersona }> {
  const stored: AvatarPersonaConfig = { ...input.cfg, transcriptHash: hashTranscript(input.transcript) };
  // The saved persona must know everything an inline persona would have known.
  const bakeCfg = withTranscriptKnowledge(stored, input.transcript);
  const personaId = await upsertVideoPersona(input.characterId, bakeCfg, input.apiKey, stored.personaId);
  // Reached only on a successful vendor upsert — this is the ONLY place a bake is recorded.
  const baked = bakedStateFor(stored, stored.personaBaked?.revision ?? 0);
  await patchAvatarConfig(input.projectId, { personaId, personaBaked: baked, transcriptHash: stored.transcriptHash });
  return { personaId, baked };
}

// ── Background self-heal ────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<void>>();
const backoffUntil = new Map<string, number>();

/** Bounded failure classification — a vendor error string can echo the persona body, so it is
 *  never logged; only this classification and the numeric status are. */
function failureClass(err: unknown): 'no_key' | 'timeout' | 'vendor_client' | 'vendor_server' | 'other' {
  const status = (err as { status?: number } | null)?.status;
  if (status === 503) return 'no_key';
  if (status === 504) return 'timeout';
  if (typeof status === 'number' && status >= 500) return 'vendor_server';
  if (typeof status === 'number' && status >= 400) return 'vendor_client';
  return 'other';
}

/**
 * Schedule a bake to run AFTER the current response. Returns true when one was scheduled.
 * Never throws, never delays the reply, at most one bake per project at a time.
 */
export function scheduleSelfHeal(input: BakeInput): boolean {
  const { projectId } = input;
  if (!projectId) return false;
  if (inFlight.has(projectId)) return false;                       // another viewer is already healing it
  if (Date.now() < (backoffUntil.get(projectId) ?? 0)) return false; // a failing bake must not hammer the vendor

  const run = (async () => {
    await new Promise((resolve) => setImmediate(resolve));          // let the token reach the viewer first
    try {
      // Re-read: an editor save (or another instance) may have healed this already.
      const row = await db.query.projects.findFirst({ where: eq(projects.id, projectId), columns: { avatar_config: true } });
      const fresh = (row?.avatar_config as AvatarPersonaConfig | null) ?? null;
      if (!fresh) return;
      const transcriptHash = hashTranscript(input.transcript);
      // Someone recorded a NEWER transcript than the one this start read — transcript propagation
      // owns that re-bake; baking here would record a stale revision as current.
      if (fresh.transcriptHash && fresh.transcriptHash !== transcriptHash) return;
      if (verifyStatefulPersona(fresh) === 'healthy') return;

      const { baked } = await bakeProjectPersona({ ...input, cfg: fresh });
      backoffUntil.delete(projectId);
      logger.info({ evt: 'avatar_persona_baked', projectId, revision: baked.revision, toolCount: baked.toolIds.length },
        '[Avatar] persona re-baked for the stateful start path');
    } catch (err) {
      backoffUntil.set(projectId, Date.now() + BAKE_BACKOFF_MS);
      logger.warn({ evt: 'avatar_persona_bake_failed', projectId, reason: failureClass(err), status: (err as { status?: number }).status ?? 0 },
        '[Avatar] persona re-bake failed — starts stay on the inline path until it succeeds');
    } finally {
      inFlight.delete(projectId);
    }
  })();

  inFlight.set(projectId, run);
  return true;
}

/** Test seam: resolve once every scheduled bake has settled. */
export async function pendingPersonaBakes(): Promise<void> {
  for (let i = 0; i < 10 && inFlight.size > 0; i++) {
    await Promise.allSettled([...inFlight.values()]);
  }
}

/** Test seam: forget in-flight bakes and back-off timers. */
export function resetPersonaBakeState(): void {
  inFlight.clear();
  backoffUntil.clear();
}
