// Resolving WHICH avatar a session shows — without holding the session token hostage to it.
//
// A stateful session references a persona by id, and the persona (not the request) decides which
// avatar appears. The popup wants that avatar's name and portrait, so the handler used to ask the
// vendor twice — GET /personas/:id, then a full account avatar listing — AFTER the token had been
// minted and BEFORE the response was sent. Up to four extra round-trips of pure cosmetics on the
// critical path of a viewer staring at a spinner.
//
// The feature is kept, the wait is not. Order of preference at request time:
//   1. the video pinned an avatar → its name/portrait are already in avatar_config;
//   2. persisted `personaDisplay` → written by this module on an earlier start;
//   3. a bounded in-process cache of avatar looks (anamService.peekAvatarLook);
//   4. nothing yet → answer now, resolve after the response, and persist for next time.
//
// Only cosmetics are stored here, in a field the persona fingerprint deliberately ignores, so
// remembering a face can never invalidate a persona.
import { logger } from '../../lib/logger.js';
import { describeAvatar, getPersona, type PersonaDisplay } from './anamService.js';
import { patchAvatarConfig } from './personaBake.js';

const inFlight = new Map<string, Promise<void>>();

export interface DisplayResolveInput {
  projectId: string;
  /** The avatar the session resolved to, when the mint already told us. */
  avatarId?: string;
  /** Stateful sessions expose the avatar only through the persona. */
  personaId?: string;
  apiKey?: string;
}

/**
 * Resolve the session's avatar identity AFTER the response and persist it.
 * Returns true when a resolve was scheduled. Never throws, never blocks.
 */
export function scheduleDisplayResolve(input: DisplayResolveInput): boolean {
  const { projectId } = input;
  if (!projectId) return false;
  if (!input.avatarId && !input.personaId) return false;
  if (inFlight.has(projectId)) return false;

  const run = (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    try {
      const avatarId = input.avatarId || (input.personaId ? (await getPersona(input.personaId, input.apiKey))?.avatarId ?? '' : '');
      if (!avatarId) return;
      const look = await describeAvatar(avatarId, input.apiKey);
      if (!look) return;
      // Coerced, not `??`-defaulted: `??` passes any non-null value through, and this object is
      // PERSISTED into avatar_config — a vendor shape change must not become stored poison.
      const str = (v: unknown): string => (typeof v === 'string' ? v : '');
      const personaDisplay: PersonaDisplay = {
        avatarId,
        displayName: str(look.displayName),
        variantName: str(look.variantName),
        imageUrl: str(look.imageUrl),
      };
      await patchAvatarConfig(projectId, { personaDisplay });
    } catch {
      // Cosmetic only: a viewer already has a working session, and the next start retries.
      logger.debug({ evt: 'avatar_display_resolve_failed', projectId }, '[Avatar] avatar identity resolve skipped');
    } finally {
      inFlight.delete(projectId);
    }
  })();

  inFlight.set(projectId, run);
  return true;
}

/** Test seam: resolve once every scheduled identity lookup has settled. */
export async function pendingDisplayResolves(): Promise<void> {
  for (let i = 0; i < 10 && inFlight.size > 0; i++) {
    await Promise.allSettled([...inFlight.values()]);
  }
}

/** Test seam. */
export function resetDisplayResolveState(): void {
  inFlight.clear();
}
