/**
 * Path-parameter identity checking, in ONE place.
 *
 * THE BUG THIS EXISTS FOR (backend-001). Every `:id` in this API is handed straight to a
 * comparison against a `uuid` column — `db.query.projects.findFirst({ where: eq(projects.id,
 * request.params.id) })` and its ~180 siblings. Postgres does not silently miss on a malformed
 * uuid; it REFUSES THE QUERY at bind time with SQLSTATE 22P02 `invalid input syntax for type
 * uuid`. (Verified against real Postgres, not reasoned: a well-formed-but-absent uuid returns
 * zero rows, `'not-a-uuid'` raises 22P02.) That error carries no `statusCode`, so the global
 * error handler's `?? 500` turned every `/api/v1/projects/banana/player-config` into a
 * paging-grade 5xx with an "Internal server error" body — for what is simply a bad URL.
 *
 * TWO LAYERS, DELIBERATELY, because they answer different questions:
 *
 *   1. `requireUuidParams` — a preHandler a route opts into. It answers BEFORE the database is
 *      touched, and it answers with the route's OWN not-found body, so a malformed id is
 *      indistinguishable from an absent one. That indistinguishability is the point on the
 *      routes that 404-instead-of-403 to avoid confirming a private project's existence.
 *   2. `isMalformedIdentifierError` — the 22P02 predicate the global error handler uses as a
 *      net under every route that has NOT adopted (1). It cannot know which parameter was bad
 *      or what that route calls "not found", so it answers a generic 400. Strictly better than
 *      a 500; strictly worse than (1).
 *
 * WHY A REGEX AND NOT `z.string().uuid()`: these are path parameters, and this API validates
 * bodies with zod but has no schema layer on paths at all (no route `schema`, no global hook).
 * A preHandler is the seam that already exists. The pattern is the same one
 * `services/storage/mediaAccess.ts` and `services/avatar/startTelemetry.ts` already use, so
 * "what this codebase calls a uuid" stays one answer.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Canonical 8-4-4-4-12 hex. Version and variant nibbles are NOT checked, matching the existing
 * `UUID_RE` in `mediaAccess.ts` / `startTelemetry.ts`. This is what this system EMITS.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is `value` a canonical UUID string? */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

const HEX32_RE = /^[0-9a-f]{32}$/i;

/**
 * Would POSTGRES accept `value` as a `uuid` literal? Not the same question as `isUuid`, and the
 * guard below must ask THIS one.
 *
 * An earlier draft accepted only the canonical spelling, on the reasoning that this system only
 * ever emits canonical uuids so no real client could send anything else. **That reasoning was
 * wrong, and it was caught by an adversarial reviewer who checked it against a real database
 * instead of believing it.** Postgres documents — and PGlite confirms — that it also accepts the
 * braced form, a fully hyphenless 32-hex string, and a hyphen after any group of four digits. All
 * of those resolve to the SAME ROW today. Rejecting them would not have been a stricter guard; it
 * would have been a silent behaviour regression that turned working URLs into 404s, and because
 * the guard deliberately answers with the route's own "not found" body, the breakage would have
 * been indistinguishable from "that project does not exist" — the hardest possible thing to
 * diagnose from a bug report.
 *
 * Normalising (strip one layer of braces, strip hyphens, expect 32 hex) covers every documented
 * alternative form. It is very slightly MORE permissive than Postgres for pathological hyphen
 * placement, and that direction is deliberate: anything this lets through still hits the database
 * and is caught by `isUuidSyntaxError` as a 400. The guard exists to stop a 500, not to be the
 * system's authority on uuid syntax.
 */
export function isPgUuidLiteral(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const unbraced = value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value;
  return HEX32_RE.test(unbraced.replace(/-/g, ''));
}

/** SQLSTATE 22P02 — `invalid_text_representation`. What a malformed uuid becomes at bind time. */
export const PG_INVALID_TEXT_REPRESENTATION = '22P02';

/**
 * Did Postgres refuse to parse a client-supplied literal **as a uuid**?
 *
 * THE CODE ALONE IS NOT ENOUGH, and an earlier draft that tested only `code === '22P02'` was a
 * real regression. 22P02 is `invalid_text_representation` — Postgres raises it for a bad integer,
 * numeric, timestamp, boolean, jsonb value or **enum label**, not only for a uuid. This schema has
 * 20 `pgEnum`s, 39 `jsonb` columns, 93 integer/numeric columns and 92 timestamp columns, and the
 * values bound into those are overwhelmingly written by US, not by a caller. So a server-side bug
 * — an enum label that drifted from its type, a malformed jsonb payload — would have been
 * relabelled as `invalid_identifier`, answered 400, logged at `warn` instead of `error`, and
 * dropped out of the 5xx metric that `ops/release/src/asset-audit.ts` raises a HIGH finding on.
 * A server fault would have been reported as the caller's bad URL and then hidden from the alarm
 * that exists to catch it.
 *
 * So the message must also name the uuid type. Postgres says `invalid input syntax for type
 * uuid: "…"`. Anything else keeps today's behaviour and stays a 500 — the safe direction, because
 * an unrecognised server error being loud is the failure mode we want.
 */
export function isUuidSyntaxError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null | undefined;
  if (e?.code !== PG_INVALID_TEXT_REPRESENTATION) return false;
  return typeof e.message === 'string' && /\btype uuid\b/i.test(e.message);
}

/**
 * A preHandler that rejects malformed uuid path parameters before any query runs.
 *
 * Absent parameters are SKIPPED rather than rejected — a guard listing `['id', 'videoId']` is
 * reusable across sibling routes where only one of the two is present, and a parameter the route
 * does not declare is not this guard's business.
 *
 * @param names   the path parameters that name a uuid primary key
 * @param message the route's own not-found body, so a malformed id and an absent one are
 *                byte-identical to a caller
 */
export function requireUuidParams(
  names: string | readonly string[],
  message = 'Not found',
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const list = typeof names === 'string' ? [names] : names;
  return async function uuidParamGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const params = request.params as Record<string, unknown> | undefined;
    for (const name of list) {
      const value = params?.[name];
      if (value === undefined) continue;
      // `isPgUuidLiteral`, NOT `isUuid` — see that function. Rejecting a spelling Postgres would
      // have resolved turns a working URL into a 404 that reads as "does not exist".
      if (!isPgUuidLiteral(value)) {
        await reply.code(404).send({ message });
        return;
      }
    }
  };
}
