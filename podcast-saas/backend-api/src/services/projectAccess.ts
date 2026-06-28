import type { Project } from '../db/schema.js';

/** The fields needed to decide access — a subset of a project row. */
export type AccessProject = Pick<Project, 'created_by' | 'visibility' | 'share_token'>;

/**
 * Decide whether a requester may access a project's media/config **by project id**
 * (the Fastify analogue of fiji's checkVideoAccess). Used to gate player-config and
 * captions so drafts aren't world-readable by id (review fiji-contracts-002).
 *
 *   public            → anyone
 *   owner             → the creator (authenticated)
 *   valid share token → anyone presenting the project's current share token (the link)
 *   private/unlisted otherwise → denied
 *
 * Callers should return 404 (not 403) on denial so a private project's existence isn't
 * revealed. Course pages and /share/:token use their own gates and don't call this.
 */
export function requireProjectAccess(
  project: AccessProject,
  requesterUserId: string | null | undefined,
  shareToken?: string | null,
): boolean {
  if (project.visibility === 'public') return true;
  if (requesterUserId && project.created_by === requesterUserId) return true;
  if (shareToken && project.share_token && shareToken === project.share_token) return true;
  return false;
}
