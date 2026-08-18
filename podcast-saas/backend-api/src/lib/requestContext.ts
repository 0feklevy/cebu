/**
 * observability-003 — the one correlation id, and the scope that carries it.
 *
 * THE PROBLEM THIS SOLVES. A single user-visible failure crosses a controller, a background job
 * and a vendor call, and until now nothing joined those three log lines. Threading an id through
 * as a parameter cannot fix it: `fetchWithRetry` takes a URL, the inline job driver takes a
 * payload, and neither will ever be handed a Fastify request. So the id lives in an
 * AsyncLocalStorage scope opened once per request, and a pino `mixin` (see logger.ts) stamps it
 * onto EVERY line emitted inside that scope — including lines from code that has never heard of it.
 *
 * WHAT PROPAGATES FOR FREE, and this is the point: AsyncLocalStorage follows promises, timers and
 * `setImmediate`. The inline queue driver schedules jobs with `setImmediate` inside the request
 * that enqueued them, so an inline job's logs already carry the id of the request that caused it,
 * with no change to the queue at all. What does NOT propagate is a durable pg-boss job — it runs
 * in another process — so that id has to ride in the payload; see the note at the bottom.
 *
 * WHY NOT REUSE `services/avatar/startTelemetry.ts`'s id. That one is a per-START id for one
 * endpoint's phase timings, minted inside the handler and returned to the client so a bug report
 * can be traced. This is a per-REQUEST id that every line inherits. They answer different
 * questions, so this keeps the same field NAME (`cid`) and the same shape (a v4 uuid) rather than
 * inventing a second vocabulary — an avatar start line and the request line around it read as one
 * story, and the avatar id remains the finer grain inside it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  /** The correlation id for the unit of work this scope covers. */
  readonly cid: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The id of the request/job currently being served, or undefined at module scope / boot. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.cid;
}

/** Run `fn` (and everything it awaits or schedules) inside a scope stamped with `cid`. */
export function runWithCorrelationId<T>(cid: string, fn: () => T): T {
  return storage.run({ cid }, fn);
}

/** A fresh id. v4 uuid, so it matches the avatar start id's shape and is safe in a log field. */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Longest inbound id accepted. Long enough for a uuid, a W3C traceparent or a typical vendor
 * request id; short enough that a caller cannot pad every log line in the request.
 */
const MAX_CORRELATION_ID_LENGTH = 128;

/**
 * Characters an id may contain. Deliberately closed, not a blocklist.
 *
 * An inbound `x-request-id` is attacker-controlled and it is stamped onto every structured line
 * for the request. A newline in it is a forged log RECORD, not a cosmetic problem: in any
 * line-delimited sink, `\n{"level":50,...}` is a second entry the attacker wrote. Length is the
 * other half — an unbounded header multiplies into every line the request emits.
 */
const CORRELATION_ID_RE = /^[A-Za-z0-9._:-]+$/;

/** An inbound id worth trusting as a log field, or undefined — never the caller's raw string. */
export function sanitizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length === 0 || value.length > MAX_CORRELATION_ID_LENGTH) return undefined;
  return CORRELATION_ID_RE.test(value) ? value : undefined;
}

/**
 * The payload field a DURABLE (cross-process) job must carry so the worker's lines join the
 * request that enqueued them. Exported here rather than in `queue/` so producer and consumer name
 * it from one place. See the report for the queue-side wiring, which this stream does not own.
 */
export const CORRELATION_PAYLOAD_KEY = 'cid' as const;
