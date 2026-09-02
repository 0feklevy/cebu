/**
 * Whether an authenticated request should refresh `users.last_seen_at`.
 *
 * Once per five minutes per user is plenty for "when were they last here"; once per request was a
 * row write on every API call (night run 2026-09-03 §7). Null (never seen) always writes.
 */
export const LAST_SEEN_DEBOUNCE_MS = 5 * 60 * 1000;

export function shouldTouchLastSeen(lastSeenAt: Date | string | null | undefined, now: Date): boolean {
  if (!lastSeenAt) return true;
  const t = lastSeenAt instanceof Date ? lastSeenAt.getTime() : Date.parse(String(lastSeenAt));
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t >= LAST_SEEN_DEBOUNCE_MS;
}
