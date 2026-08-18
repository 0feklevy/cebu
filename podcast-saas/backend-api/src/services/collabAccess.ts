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
 * AUTHORIZATION IS BY RESOLVED user_id ONLY (security-003 follow-up).
 *
 * `invited_email` records WHO AN INVITATION IS ADDRESSED TO. It is not a credential and must never
 * be matched against the requester's address to grant access. An email on a user row is only ever
 * "the string this account was registered with" — Firebase mints that string for whoever types it
 * into a sign-up form — so authorizing on it means anyone who LEARNS an invited address inherits
 * the invitation, which is broad EDIT authority over someone else's content.
 *
 * The address becomes authority at exactly one place: the migration-042 claim in
 * `firebaseAuthMiddleware`, which binds `user_id` only for a token asserting
 * `email_verified === true`. Reading `user_id` here is what makes that gate mean something —
 * a63aa4e added the gate, but while this file still matched on the raw column the gate was simply
 * routed around: the claim UPDATE never ran and access was granted anyway.
 *
 * So `user_id` is the single source of collaborator authority, and the verified claim is its single
 * writer. Anything that sets `user_id` without proof of the address reopens the hole.
 * Covered by `__tests__/collabAccess.verifiedIdentity.test.ts`.
 */

/**
 * `email` is carried because callers pass `request.dbUser` wholesale — it is deliberately NOT read
 * by anything in this module. See the note above before reintroducing an email match here.
 */
export type CollabUser = { id: string; email: string | null };

/**
 * The ONE predicate deciding which collaborator rows belong to a user. Both the SQL-fragment path
 * and the row-level path go through it so they cannot drift apart — they previously carried
 * duplicate copies of the matching rule, and a fix to one would have left the other open.
 */
function collaboratorIsUser(user: CollabUser): SQL {
  return eq(collaborators.user_id, user.id);
}

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
  return exists(
    db
      .select({ one: sql`1` })
      .from(collaborators)
      .where(and(eq(collaborators.content_type, contentType), idCond, collaboratorIsUser(user))),
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
 * Batch: of the given content ids, which is this user a collaborator on. Matches resolved user_id,
 * which is now simply what every check in this module does — this function was already correct when
 * the others were not, and it is the shape they were fixed to.
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
  const row = await db.query.collaborators.findFirst({
    where: and(
      eq(collaborators.content_type, contentType),
      eq(collaborators.content_id, contentId),
      collaboratorIsUser(user),
    ),
  });
  return !!row;
}
