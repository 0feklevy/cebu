/**
 * Avatar viewer endpoints stay open to anonymous viewers of public/unlisted projects
 * (unlisted is reached via a share link, where the avatar is part of viewing), but a
 * PRIVATE project's avatar surface (persona, library, conversation memory) is owner-only
 * (review security-004). Intentionally more permissive than requireProjectAccess, which
 * denies unlisted-by-id — here unlisted is treated like public for the viewer experience.
 */
export function avatarProjectAllowed(
  project: { visibility: string | null; created_by: string | null },
  userId: string | null | undefined,
): boolean {
  if (project.visibility !== 'private') return true;
  return !!userId && project.created_by === userId;
}

/**
 * Async variant that also admits invited collaborators (migration 042) to a
 * private project's avatar surface. Falls back to the sync gate first so the
 * common cases (public/unlisted/owner) never touch the collaborators table.
 */
export async function avatarProjectAllowedAsync(
  projectId: string,
  project: { visibility: string | null; created_by: string | null },
  user: { id: string; email: string | null } | null | undefined,
): Promise<boolean> {
  if (avatarProjectAllowed(project, user?.id ?? null)) return true;
  if (!user) return false;
  const { isCollaborator } = await import('../collabAccess.js');
  return isCollaborator('project', projectId, user);
}
