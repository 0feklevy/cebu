// Minimal in-process fixed-window rate limiter (no external dependency).
//
// Per-process only — adequate as a cost-DoS speed bump on the single-node host for
// expensive, unauthenticated endpoints (e.g. billable avatar image generation). For
// multi-instance deployments this should move to a shared store (Redis); see review
// arch-008 (statelessness) and security-003.

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Returns true if the call is allowed, false if the per-key window is exhausted. */
export function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count++;
  return true;
}

// Bound memory: drop expired buckets periodically. unref so it never holds the process open.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k);
}, 60_000).unref();
