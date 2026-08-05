/**
 * RUM ingestion endpoint (Priority 8.9).
 *
 * UNAUTHENTICATED BY NECESSITY
 * Anonymous viewers are most of the traffic, so requiring auth would sample only logged-in users —
 * a biased sample is worse than no sample, because it looks like data. Everything about this
 * handler is therefore a bound on what a hostile caller can do: the payload is validated before it
 * is looked at, every field is length- or range-capped, batch size is capped, and the response
 * carries no information back.
 *
 * IT ALWAYS RETURNS 204
 * Even for a rejected batch. A client cannot act on a rejection — it has already discarded the
 * events — and distinguishing "stored" from "rejected" in the response would hand an attacker a
 * probe for the validator's shape. Rejections are counted in the logs, where operators can see
 * them and viewers cannot.
 *
 * IT NEVER THROWS
 * A measurement endpoint that can 500 is a measurement endpoint that can page someone at 3am about
 * data nobody is waiting for. Failures are logged and swallowed.
 */

import type { FastifyInstance } from 'fastify';
import { ingestBatch } from '../services/simulation/RumService.js';
import { logger } from '../lib/logger.js';
import { rateLimit } from '../lib/rateLimit.js';
import { RUM_MAX_EVENTS_PER_BATCH } from 'shared/sim/rumEvents';

/** Refuse an oversized body before parsing it, so a hostile caller cannot make us allocate it. */
const MAX_BODY_BYTES = 256 * 1024;

export function registerSimRumRoutes(app: FastifyInstance): void {
  app.post(
    '/sim-rum',
    {
      // Same posture as /sim-public: this is called from a cross-origin page context and must not
      // inherit frame/CSP defaults meant for app routes.
      helmet: false,
      bodyLimit: MAX_BODY_BYTES,
    },
    async (request, reply) => {
      // The response is decided before any work happens, so no code path below can change it.
      reply
        .header('Access-Control-Allow-Origin', '*')
        .header('Cache-Control', 'no-store')
        .code(204);

      // Rate limited per PEER, not per `request.ip`. The route is unauthenticated with a wildcard
      // CORS origin, so without this any page on the internet could drive unbounded durable growth
      // in the same Postgres the player reads from. Generous enough that an honest client — which
      // flushes at most every 30s — never approaches it.
      //
      // `request.ip` IS NOT USABLE AS A LIMITER KEY HERE. The app runs with `trustProxy: true`, so
      // it is the leftmost X-Forwarded-For entry — a value the caller writes. A limiter keyed on it
      // hands out a fresh bucket for every forged header, which is not a weaker bound but no bound
      // at all. The socket address is the one thing the peer cannot choose.
      //
      // The cost of being wrong here is not just row growth: every request past the limiter reaches
      // the ingestion gate, and a connection pool of ten is a small target.
      const peer = request.socket.remoteAddress ?? 'unknown';
      if (!rateLimit(`sim-rum:${peer}`, 20, 60_000)) {
        // Still 204: the response must not become a probe for the limiter's shape either.
        return reply.send();
      }

      try {
        const result = await ingestBatch(request.body);
        if (result.rejected) {
          // Sampled logging would hide a systematic client bug behind a low rate; this is cheap
          // because a well-behaved fleet produces none of them at all.
          logger.warn({ reason: result.rejected }, 'sim-rum: batch rejected');
        }
      } catch (err) {
        // Swallowed on purpose. Nothing downstream is waiting on this, and a 500 here would turn a
        // measurement problem into a viewer-visible one.
        logger.error({ err }, 'sim-rum: ingest failed');
      }
      return reply.send();
    },
  );

  // Preflight: the player posts JSON cross-origin, so browsers will OPTIONS this first.
  app.options('/sim-rum', { helmet: false }, async (_request, reply) =>
    reply
      .header('Access-Control-Allow-Origin', '*')
      .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
      .header('Access-Control-Allow-Headers', 'content-type')
      .header('Access-Control-Max-Age', '86400')
      .code(204)
      .send());
}

export { RUM_MAX_EVENTS_PER_BATCH };
