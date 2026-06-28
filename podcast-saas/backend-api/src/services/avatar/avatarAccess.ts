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
