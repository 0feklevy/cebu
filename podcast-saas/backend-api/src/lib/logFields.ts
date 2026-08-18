/**
 * Values that are safe to put in a structured log line.
 *
 * This stream adds logging in several places at once (observability-003/004/005/007/008), and the
 * failure mode of "log more" is logging a secret. One accessor, used everywhere, is the mechanism
 * that keeps that from happening by accident.
 */
import type { FastifyRequest } from 'fastify';

/**
 * The request path, WITHOUT the query string. Never `request.url`.
 *
 * `middleware/firebase-auth.ts` accepts the Firebase id token in `?token=` (EventSource cannot set
 * an Authorization header, so `client-web/components/SectionEditor.tsx` sends it there). Any log
 * field built from `request.url` therefore contains a live credential on the SSE routes.
 *
 * Prefers the matched ROUTE pattern — `/api/v1/projects/:id/sections` — which is both free of
 * user data and better for aggregation: one bucket per endpoint instead of one per resource id.
 * When no route matched (404s, and requests that failed before routing) it falls back to the raw
 * path truncated at the first `?`.
 */
export function safeRequestPath(request: FastifyRequest): string {
  const routePattern = request.routeOptions?.url;
  if (typeof routePattern === 'string' && routePattern) return routePattern;
  const url = typeof request.url === 'string' ? request.url : '';
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}
