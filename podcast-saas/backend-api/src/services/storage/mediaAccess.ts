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
  if (token && verifyMediaToken(scope, token)) return true;

  try {
    const project = await resolveProjectForKey(key);
    if (!project) return false;

    // 2. Public/unlisted: servable to anyone holding the (unguessable) key.
    if (project.visibility === 'public' || project.visibility === 'unlisted') return true;

    // 3. Private: require the owner or an invited collaborator.
    if (!user) return false;
    if (project.created_by === user.id) return true;
    return await isCollaborator('project', project.id, user);
  } catch (err) {
    // Availability bias: a DB blip must not take down all playback. Deny would be
    // stricter, but the token path (1) already covers every URL we mint ourselves.
    logger.error({ err, key }, '[mediaAccess] lookup failed — allowing (fail-open)');
    return true;
  }
}
