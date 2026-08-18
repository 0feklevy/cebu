import pino from 'pino';
import { currentCorrelationId } from './requestContext.js';

/**
 * observability-003 — stamp the current correlation id onto EVERY line.
 *
 * A mixin rather than a per-call-site field, because the call sites that matter most are the ones
 * that will never be given a request: `fetchWithRetry`, the inline job handlers, the pg-boss error
 * listener. Those are exactly the lines an operator needs joined to the request that caused them.
 *
 * Emits nothing outside a request scope, so boot lines stay clean and a missing `cid` truthfully
 * means "not inside a correlated unit of work" rather than "we forgot".
 */
function correlationMixin(): Record<string, unknown> {
  const cid = currentCorrelationId();
  return cid ? { cid } : {};
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  mixin: correlationMixin,
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
