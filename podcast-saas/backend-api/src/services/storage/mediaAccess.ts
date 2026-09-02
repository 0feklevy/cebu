// Per-object authorization for the media serve/proxy routes (security-002 —
// fiji's checkVideoAccess ported). Before this gate, /hls-public, /hls-proxy,
// /video-raw and /video-proxy were bare capability URLs: anyone who learned a
// key could stream a PRIVATE project's media.
//
// Allow order (cheapest first):
//   1. a valid scoped media token in the URL (minted by the storage adapters at
//      URL-build time — covers players, ffmpeg, and anonymous public viewers)
//   2. the owning project is public/unlisted (the key is the capability there —
//      that is the product meaning of 'unlisted', migration 036)
//   3. an authenticated owner or invited collaborator
// Everything else is denied.

import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { projects, video_files } from '../../db/schema.js';
import { isCollaborator, type CollabUser } from '../collabAccess.js';
import { mediaKeyScope, verifyMediaToken } from './mediaToken.js';
import { logger } from '../../lib/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProjectAccessRow = { id: string; visibility: string; created_by: string | null };

/**
 * Scopes last confirmed PUBLIC, and when.
 *
 * Only consulted when the database lookup itself fails — it is a fault-time fallback, never a
 * cache on the success path, so an unshare takes effect immediately while the database is healthy.
 * Bounded in size and in time: a fault that outlives the TTL fails closed, which is the safe
 * direction for a window nobody is watching.
 */
const publicKeyMemory = new Map<string, number>();
const PUBLIC_MEMORY_TTL_MS = 10 * 60 * 1000;
const PUBLIC_MEMORY_MAX = 5_000;

/** Exposed for tests; also called when the map would otherwise grow without bound. */
export function _resetPublicKeyMemory(): void {
  publicKeyMemory.clear();
}

/** Resolve a media key to its owning project's access fields, or null. */
async function resolveProjectForKey(key: string): Promise<ProjectAccessRow | null> {
  const parts = key.split('/');
  if (parts[0] === 'videos' && UUID_RE.test(parts[1] ?? '')) {
    const row = await db.query.projects.findFirst({
      where: eq(projects.id, parts[1]),
      columns: { id: true, visibility: true, created_by: true },
    });
    return row ?? null;
  }
  // Export masters live under `exports/{projectId}/…` — the project id is the scope, exactly
  // like `videos/{projectId}`.
  // Audio editions live under `editions/{projectId}/…` — project id second, like `videos/`.
  if (parts[0] === 'editions' && UUID_RE.test(parts[1] ?? '')) {
    const row = await db.query.projects.findFirst({
      where: eq(projects.id, parts[1]),
      columns: { id: true, visibility: true, created_by: true },
    });
    return row ?? null;
  }
  if (parts[0] === 'exports' && UUID_RE.test(parts[1] ?? '')) {
    const row = await db.query.projects.findFirst({
      where: eq(projects.id, parts[1]),
      columns: { id: true, visibility: true, created_by: true },
    });
    return row ?? null;
  }
  // Simulation packages: `simulations/{projectId}/{simId}/…`. The project id sits in the same
  // position as it does for `videos` and `exports`, so this needs no simulations-table lookup —
  // and `/sim-public/*` had NO project check at all until it started calling this gate, which
  // meant unsharing a project did not revoke access to its simulation (security-005,
  // simulation-007).
  if (parts[0] === 'simulations' && UUID_RE.test(parts[1] ?? '')) {
    const row = await db.query.projects.findFirst({
      where: eq(projects.id, parts[1]),
      columns: { id: true, visibility: true, created_by: true },
    });
    return row ?? null;
  }
  if (parts[0] === 'hls' && UUID_RE.test(parts[1] ?? '')) {
    const video = await db.query.video_files.findFirst({
      where: eq(video_files.id, parts[1]),
      columns: { project_id: true },
    });
    if (!video?.project_id) return null;
    const row = await db.query.projects.findFirst({
      where: eq(projects.id, video.project_id),
      columns: { id: true, visibility: true, created_by: true },
    });
    return row ?? null;
  }
  return null;
}

/** May this request stream the media under `key`? Never throws. */
export async function canServeMediaKey(
  key: string,
  token: string | null,
  user: CollabUser | null,
): Promise<boolean> {
  const scope = mediaKeyScope(key);
  if (!scope) return false;

  // 1. Scoped token — no DB hit; the normal path for every player/ffmpeg URL.
  //
  // A misconfigured ENCRYPTION_KEY makes `verifyMediaToken` THROW (security-004) rather than
  // verify against a truncated/empty secret. That must deny and stay denied: this function is
  // documented never to throw, and the fail-open branch below is justified by "the token path
  // already covers every URL we mint ourselves" — a claim that is exactly false when the signing
  // key is broken. So a key error is caught HERE and answered `false`, never allowed to fall
  // through into the availability-biased catch.
  try {
    if (token && verifyMediaToken(scope, token)) return true;
  } catch (err) {
    logger.error({ err, key }, '[mediaAccess] media token secret is unusable — denying');
    return false;
  }

  try {
    const project = await resolveProjectForKey(key);
    if (!project) return false;

    // 2. Public/unlisted: servable to anyone holding the (unguessable) key.
    if (project.visibility === 'public' || project.visibility === 'unlisted') {
      if (publicKeyMemory.size >= PUBLIC_MEMORY_MAX) publicKeyMemory.clear();
      publicKeyMemory.set(scope, Date.now());
      return true;
    }
    // A scope that has just been confirmed PRIVATE must not keep a stale public memory — that is
    // the "unshare then the database wobbles" case, and it is the one the memory could get wrong.
    publicKeyMemory.delete(scope);

    // 3. Private: require the owner or an invited collaborator.
    if (!user) return false;
    if (project.created_by === user.id) return true;
    return await isCollaborator('project', project.id, user);
  } catch (err) {
    // BOUNDED FAIL-OPEN (security-012). Ratified, not removed — but no longer unconditional.
    //
    // The availability argument is real: a database blip must not take down all playback, and the
    // token path above already covers every URL this product mints. But "allow anything we could
    // not check" also served a PRIVATE project's media to a caller with no token and no session,
    // for as long as the fault lasted — the one case the gate exists for.
    //
    // So the answer is now "allow what we have SEEN to be public, deny what we have never seen".
    // A key whose project was public at its last successful lookup keeps playing through a fault;
    // a key nobody has ever resolved is refused. That keeps the outage story (public content keeps
    // streaming) without keeping the hole (private content does not start streaming to strangers
    // the moment the database wobbles).
    const seenPublic = publicKeyMemory.get(scope);
    if (seenPublic !== undefined && Date.now() - seenPublic < PUBLIC_MEMORY_TTL_MS) {
      logger.error({ err, key }, '[mediaAccess] lookup failed — allowing (last seen public)');
      return true;
    }
    logger.error({ err, key }, '[mediaAccess] lookup failed and this key was never seen public — denying');
    return false;
  }
}
