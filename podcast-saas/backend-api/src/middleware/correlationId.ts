/**
 * observability-003 — open one correlation scope per request, and log one line when it closes.
 *
 * Two things happen here, and the first is what makes the other four observability findings
 * useful:
 *
 *   1. An `onRequest` hook opens an AsyncLocalStorage scope (lib/requestContext.ts) carrying a
 *      single id. Everything downstream — route handler, middleware, service, `fetchWithRetry`,
 *      any inline job the handler schedules — emits log lines stamped with that id by the pino
 *      mixin, without any of it being passed the id. That is the join an operator has never had.
 *
 *   2. An `onResponse` hook writes the request-completion line. The server runs Fastify with
 *      `logger: false` ("use pino directly"), which in practice meant NO request line existed at
 *      all: a failing request left behind only whatever a service happened to log. The completion
 *      line is the anchor the id hangs off.
 *
 * WHY THE SCOPE IS OPENED IN A HOOK AND NOT AROUND THE HANDLER. Fastify continues its hook chain
 * from inside `done()`, so calling `done` within `storage.run(...)` puts every later hook, the
 * handler, and the error handler inside the scope. Wrapping only the handler would leave
 * authentication — the place observability-004 logs from — outside it.
 *
 * THE QUERY STRING IS NEVER LOGGED. `client-web/components/SectionEditor.tsx` puts the caller's
 * Firebase id token in `?token=` because EventSource cannot set an Authorization header, and
 * `middleware/firebase-auth.ts` reads it from there. `request.url` therefore contains a live
 * credential on every SSE stream, so the completion line carries `path` — `request.routeOptions.url`
 * when the router matched (already parameterised, so ids do not explode log cardinality), else the
 * raw path with the query cut off.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { logger } from '../lib/logger.js';
import { safeRequestPath } from '../lib/logFields.js';
import {
  newCorrelationId,
  runWithCorrelationId,
  sanitizeCorrelationId,
} from '../lib/requestContext.js';

/** The response header the id is echoed on, and the first inbound header consulted. */
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Inbound headers read for the CALLER'S OWN id, in order. `x-request-id` is the near-universal
 * spelling; `x-correlation-id` is what we emit, so a client that echoes ours back is also honoured.
 *
 * Recorded ALONGSIDE our id, never adopted as it. `deploy/nginx/nginx.conf` neither sets nor strips
 * these headers, so their value arrives straight from the public internet — and the correlation id
 * is the log's join key. A caller who could choose it could pin one value across a flood, collapsing
 * every line into a single thread exactly when the log matters most, or reuse a value observed
 * elsewhere and interleave with another request's story. That is the same mistake as
 * `trustProxy: true` (config/trustProxy.ts) — deriving something load-bearing from a value the
 * caller writes — and minting our own costs nothing, because `clientRequestId` still carries theirs
 * for anyone joining from the client side.
 */
const INBOUND_HEADERS = [CORRELATION_HEADER, 'x-request-id'] as const;

/**
 * Paths whose completion line is logged at `debug` instead of `info`.
 *
 * `deploy/docker-compose.yml` curls `/health` on the container healthcheck interval and the
 * platform load balancer polls it as well. At `info` those are thousands of identical lines a day
 * sitting on top of the events this whole stream exists to make findable — the classic way a new
 * request log gets turned off again a week later.
 *
 * Exact matches only: `/healthcare/:id` is an ordinary route and must stay at `info`. And the
 * demotion applies to SUCCESSFUL polls only — a health check answering 5xx still goes to `warn`
 * below, which is the one health line anybody wants to see.
 */
const QUIET_PATHS: ReadonlySet<string> = new Set(['/health', '/health/ready']);

declare module 'fastify' {
  interface FastifyRequest {
    /** The id stamped on every log line for this request, and echoed to the caller. Minted here. */
    correlationId: string;
    /** The id the CALLER sent, if any and if loggable. Never the correlation id. */
    clientRequestId?: string;
  }
}

/** The caller's own id, if they sent one that is safe to log. Never becomes our `cid`. */
function clientRequestId(request: FastifyRequest): string | undefined {
  for (const header of INBOUND_HEADERS) {
    const raw = request.headers[header];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const accepted = sanitizeCorrelationId(value);
    if (accepted) return accepted;
  }
  return undefined;
}

/** Install the correlation scope and the request-completion line on `app`. */
export function registerCorrelationId(app: FastifyInstance): void {
  app.decorateRequest('correlationId', '');

  app.decorateRequest('clientRequestId', undefined);

  app.addHook('onRequest', (request, reply, done) => {
    const cid = newCorrelationId();
    request.correlationId = cid;
    request.clientRequestId = clientRequestId(request);
    // Set before the scope so the caller gets the id even on a request that dies in a later hook.
    void reply.header(CORRELATION_HEADER, cid);
    runWithCorrelationId(cid, done);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const payload = {
      cid: request.correlationId,
      // Present only when the caller sent one, so its absence is not noise on every line.
      ...(request.clientRequestId ? { clientRequestId: request.clientRequestId } : {}),
      method: request.method,
      path: safeRequestPath(request),
      statusCode: reply.statusCode,
      // `elapsedTime` is Fastify's own measurement from request start to response end.
      durationMs: Math.round(reply.elapsedTime),
    };
    // 5xx is the server's fault and should be visible at the default level even when `info` is
    // filtered out; 4xx is usually the caller's and stays at info with everything else.
    if (reply.statusCode >= 500) logger.warn(payload, 'request completed');
    else if (QUIET_PATHS.has(payload.path)) logger.debug(payload, 'request completed');
    else logger.info(payload, 'request completed');
    done();
  });
}
