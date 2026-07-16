/**
 * Gate for the PRIVATE workspace lists (GET /api/v1/projects, GET /api/v1/playlists…).
 *
 * Those endpoints require authentication by design — they return the signed-in
 * user's own workspace. Calling them without a user guarantees a 401, which the
 * production browser audit (correctly) observes on every anonymous page view
 * (incident: production-audit run 29528323804).
 *
 * Rule: fetch only after Firebase auth initialization has completed AND a
 * signed-in user exists (getIdToken can then attach a valid token). Anonymous
 * visitors have no workspace — render the empty state without any network call.
 */
export function canLoadPrivateWorkspace(authLoading: boolean, user: unknown): boolean {
  return !authLoading && user != null;
}
