import { and, eq, or, exists, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { collaborators, projects, playlists } from '../db/schema.js';

/**
 * Collaboration access (migration 042) — GitHub-style per-content invites.
 *
 * A collaborator on a project/playlist can edit it like the creator, EXCEPT:
 *   - deleting the project/playlist            (owner only)
 *   - managing collaborators (invite/remove)   (owner only; a collaborator may remove themself)
 *
 * Matching is by resolved user_id OR lowercased invited_email, so invites work
 * for people who haven't signed up yet (users.email is nullable — guard for it).
 */

export type CollabUser = { id: string; email: string | null };

/** SQL predicate: a collaborators row exists for (content_type, content_id) matching this user. */
export function collaboratorExists(
  contentType: 'project' | 'playlist',
  contentId: SQL | string,
  user: CollabUser,
): SQL {
  const idCond =
    typeof contentId === 'string'
      ? eq(collaborators.content_id, contentId)
      : sql`${collaborators.content_id} = ${contentId}`;
  const matchUser = user.email
    ? or(
        eq(collaborators.user_id, user.id),
        eq(collaborators.invited_email, user.email.toLowerCase()),
      )!
    : eq(collaborators.user_id, user.id);
  return exists(
    db
      .select({ one: sql`1` })
      .from(collaborators)
      .where(and(eq(collaborators.content_type, contentType), idCond, matchUser)),
  );
}

/** WHERE for "this specific project is editable by user" (creator OR collaborator). */
export function projectEditableWhere(projectId: string, user: CollabUser): SQL {
  return and(
    eq(projects.id, projectId),
    or(
      eq(projects.created_by, user.id),
      collaboratorExists('project', sql`${projects.id}`, user),
    ),
  )!;
}

/** WHERE fragment for listing/filtering: any project editable by user. */
export function projectsEditableByWhere(user: CollabUser): SQL {
  return or(
    eq(projects.created_by, user.id),
    collaboratorExists('project', sql`${projects.id}`, user),
  )!;
}

/** WHERE for "this specific playlist is editable by user" (creator OR collaborator). */
export function playlistEditableWhere(playlistId: string, user: CollabUser): SQL {
  return and(
    eq(playlists.id, playlistId),
    or(
      eq(playlists.created_by, user.id),
      collaboratorExists('playlist', sql`${playlists.id}`, user),
    ),
  )!;
}

/** WHERE fragment for listing: any playlist editable by user. */
export function playlistsEditableByWhere(user: CollabUser): SQL {
  return or(
    eq(playlists.created_by, user.id),
    collaboratorExists('playlist', sql`${playlists.id}`, user),
  )!;
}

/** Load a project the user may edit (creator or collaborator), or undefined. */
export async function editableProject(projectId: string, user: CollabUser) {
  return db.query.projects.findFirst({ where: projectEditableWhere(projectId, user) });
}

/** Load a playlist the user may edit (creator or collaborator), or undefined. */
export async function editablePlaylist(playlistId: string, user: CollabUser) {
  return db.query.playlists.findFirst({ where: playlistEditableWhere(playlistId, user) });
}

/**
 * Batch: of the given content ids, which is this user a collaborator on (by resolved
 * user_id only — invites are claimed to user_id at signup/invite time, so this is
 * complete for signed-in users; use where only a userId is available, no email).
 */
export async function collaboratorContentIds(
  contentType: 'project' | 'playlist',
  contentIds: string[],
  userId: string,
): Promise<Set<string>> {
  if (contentIds.length === 0) return new Set();
  const rows = await db.query.collaborators.findMany({
    where: and(
      eq(collaborators.content_type, contentType),
      inArray(collaborators.content_id, contentIds),
      eq(collaborators.user_id, userId),
    ),
    columns: { content_id: true },
  });
  return new Set(rows.map((r) => r.content_id));
}

/** Row-level check (async): is this user a collaborator on the given content? */
export async function isCollaborator(
  contentType: 'project' | 'playlist',
  contentId: string,
  user: CollabUser,
): Promise<boolean> {
  const matchUser = user.email
    ? or(
        eq(collaborators.user_id, user.id),
        eq(collaborators.invited_email, user.email.toLowerCase()),
      )!
    : eq(collaborators.user_id, user.id);
  const row = await db.query.collaborators.findFirst({
    where: and(
      eq(collaborators.content_type, contentType),
      eq(collaborators.content_id, contentId),
      matchUser,
    ),
  });
  return !!row;
}
