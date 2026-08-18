/**
 * The API's single error boundary, lifted out of `server.ts` so it can be tested directly.
 *
 * Behaviour is unchanged from the inline handler it replaces except for ONE addition, described
 * below. The 5xx-scrubbing rule it already carried stays exactly as it was: internal detail
 * (Postgres messages, storage paths, connection strings) is logged and never sent to a client.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { logger } from './logger.js';
import { safeRequestPath } from './logFields.js';
import { isUuidSyntaxError } from './uuidParam.js';

/**
 * THE ADDITION (backend-001). A malformed id in a path — `/api/v1/projects/banana/…` — reaches a
 * `uuid` column and Postgres refuses the query at bind time with SQLSTATE 22P02. That driver
 * error carries no `statusCode`, so `?? 500` below classified a BAD URL as a server fault: a 5xx
 * in the metrics, a paging-grade `logger.error`, and an "Internal server error" body.
 *
 * This is the net under the ~180 routes that have not adopted `requireUuidParams`. It is
 * deliberately weaker than that guard and does not replace it:
 *
 *   • it fires only AFTER a round trip to Postgres, which the guard avoids entirely;
 *   • it cannot know which parameter was bad, nor what this route calls "not found", so it
 *     answers a generic 400 rather than the route's own 404. On routes that 404-rather-than-403
 *     to avoid confirming a private resource's existence, that difference is observable — which
 *     is exactly why those routes should adopt the preHandler instead of leaning on this.
 *
 * Still logged, at `warn`: this is almost always a bad client id, but it is also what a genuine
 * server-side bug looks like if this service ever builds a malformed uuid itself. Downgrading
 * the STATUS must not make that invisible.
 *
 * NOTE THE PREDICATE'S NAME. It is `isUuidSyntaxError`, not "is 22P02", and that distinction is
 * load-bearing: 22P02 is also how Postgres reports a bad enum label, jsonb, integer or timestamp
 * — values this service writes itself. Matching the bare SQLSTATE here would have converted a
 * class of SERVER bugs into 400s logged at `warn`, invisible to the 5xx alarm. Anything not
 * provably a uuid parse failure falls through to the unchanged 500 path below.
 */
export function apiErrorHandler(err: Error, request: FastifyRequest, reply: FastifyReply): void {
  if (isUuidSyntaxError(err)) {
    logger.warn(
      // `safeRequestPath`, never `request.url`: the SSE routes carry the caller's Firebase id
      // token in `?token=`, and this warning fires on exactly the kind of bad URL a stream can
      // produce. See lib/logFields.ts.
      { err, method: request.method, path: safeRequestPath(request) },
      'Malformed identifier rejected by Postgres (22P02)',
    );
    reply.code(400).send({ error_type: 'invalid_identifier', message: 'Invalid identifier' });
    return;
  }

  const statusCode = (err as { statusCode?: number }).statusCode ?? 500;

  if (statusCode >= 500) {
    // Name the request. `{ err }` alone left an operator with a stack trace and no way to tell
    // which endpoint produced it — and, with observability-003 in place, the pino mixin adds the
    // correlation id here too, so this line joins the request line and any job the request started.
    logger.error(
      { err, method: request.method, path: safeRequestPath(request) },
      'Unhandled server error',
    );
  }

  // Default to a neutral type (was 'llm_error', which mislabelled every storage/DB
  // failure as an LLM error). For 5xx, return a generic message so internal detail
  // (Postgres/R2/fs paths, connection strings) is logged but never sent to clients.
  const error_type = (err as { error_type?: string }).error_type ?? 'server_error';
  const message = statusCode >= 500 ? 'Internal server error' : (err.message ?? 'Request failed');

  reply.code(statusCode).send({ error_type, message });
}
