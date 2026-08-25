/**
 * Is this key REALLY inside an immutable revision? Verified against the revision table, not
 * inferred from the shape of the path.
 *
 * WHY PATH SHAPE IS NOT ENOUGH
 * `revisionIdFromKey` is positional: it accepts `simulations/<p>/<s>/revisions/<id>/<...>` where
 * `<id>` matches `^[A-Za-z0-9_-]{8,64}$`. Real revision ids are UUIDs (`sim_revisions.id` is
 * `uuid ... defaultRandom()`), but that pattern also accepts `chapter01`, `assets-v2`, `lecture-3`
 * — ordinary directory names. "Replace simulation" writes a customer's bundle verbatim under the
 * simulation prefix, so a customer whose package contains a top-level `revisions/` directory lands
 * exactly at the canonical depth and is handed `max-age=31536000, immutable` for a MUTABLE object.
 * The next replace overwrites those bytes and every viewer that cached them keeps the old copy for
 * a year with no revalidation path. The route percent-decodes its wildcard, so `%2F` arrives as a
 * real separator and the shape can also be requested directly.
 *
 * The positional parser fixed a narrower version of this (a first-match scan that also matched
 * `package/revisions/...`), and its own comment names the top-level-`revisions/` case — but the
 * canonical-depth check cannot distinguish a customer directory at that depth from ours. Only the
 * revision table can.
 *
 * FAIL CLOSED. Any doubt — unparseable key, non-UUID id, database error, no matching row — answers
 * "not a revision", which yields the pre-existing `no-cache` behaviour. Being wrong in that
 * direction costs a revalidation round trip; being wrong in the other direction poisons a URL for a
 * year.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { sim_revisions } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { revisionIdFromKey } from 'shared/sim/simRevision';

/**
 * Statuses whose bytes MAY be handed to an anonymous caller (simulation-007).
 *
 * `/sim-public/*` is unauthenticated and a revision prefix sits inside `simulations/`, so without
 * this gate the bytes of an aborted publication were served exactly like the active revision's —
 * indefinitely, because `RevisionService.gc()` has no production caller.
 *
 * THIS IS AN ALLOW-LIST, AND IT USED TO BE A DENY-LIST. The difference is what happens to a status
 * this build has never heard of. The old form read
 * `status === null || !NEVER_PUBLISHED.has(status)`, whose own comment conceded
 * "Unknown status ⇒ yes (legacy)" — so every status a given image did not recognise was PUBLIC.
 * That makes adding a new non-public status impossible to do safely: during any rolling deploy,
 * and on any image that has not been replaced yet, the new status would be served precisely
 * because it is new. The allow-list has to land first, in its own release, before a
 * `proof_pending` can exist at all.
 *
 * WHY `active`, `retired` AND `rolled_back`. Their bytes WERE served, `mustRetainBytes` keeps the
 * latter two for rollback, and a viewer whose page loaded a moment before a rollback still holds
 * their URLs — withdrawing those is a product decision about revocation, not a leak of unpublished
 * work, and it would turn an in-flight session into 404s. A corollary worth stating plainly
 * because it belongs in the runbook: **rollback is not revocation.** Recovery moves the active
 * pointer; it does not unpublish a URL that has already been handed out.
 *
 * WHY `canary_passed` IS NOT HERE, having previously been served. The comment that justified it
 * said "the pre-activation canary drives the real document over this route". Checked three
 * independent ways on 2026-08-25, and nothing does:
 *
 *   - `RevisionService.validate()` reads the revision's bytes back FROM STORAGE; that file
 *     contains no `fetch(`, no `http` and no `getSimPublicUrl` at all;
 *   - `sim-canary-publish.ts` consumes a `--report <path>` file — it never drives a browser;
 *   - `sim-canary.spec.ts` routes `${API_ORIGIN}/**` to an in-process server whose `localPathFor`
 *     maps only `/sim-public/__e2e/…` and 404s everything else, so a real revision key is
 *     unreachable there by construction.
 *
 * `shared/src/sim/simRevision.ts` says so outright in its own docs: `canary_passed` is "NOT proof
 * that a canary ran… the name is historical." It is a staging state on the way to `active`, and
 * nothing hands out a URL into one — `uploadSectionBridge` persists `sectionUrl` only inside the
 * `onActivated` transaction hook, and `migrate-sim-revisions.ts` states that "nothing will be
 * activated", so a migrated package resting in this state is not linked from anywhere either.
 */
const PUBLICLY_SERVED_STATUSES: ReadonlySet<string> = new Set([
  'active', 'retired', 'rolled_back',
]);

/**
 * May a revision in this status be handed to an anonymous caller?
 *
 * `null` stays public, and that is deliberate rather than an oversight. It does not mean "unknown
 * status" — `sim_revisions.status` is `TEXT NOT NULL`, so a verified row always has one. It means
 * the key is not a verified revision at all: a legacy non-revision path, or a transient database
 * fault. The caller guards with `revision.verified && !isRevisionStatusPublic(...)` for exactly
 * that reason, and `revisionServingFacts` documents why a fault must leave the gate open —
 * failing closed there would 404 every revisioned simulation on the platform on a database blip,
 * and this gate is a publication check, not a secrecy boundary.
 */
export function isRevisionStatusPublic(status: string | null): boolean {
  return status === null || PUBLICLY_SERVED_STATUSES.has(status);
}

/** Real revision ids are database UUIDs. Cheap pre-filter so ordinary paths never reach the DB. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical layout: simulations/<projectId>/<simulationId>/revisions/<revisionId>/<...> */
const SIMULATION_ID_SEGMENT = 2;

export interface RevisionCoords {
  simulationId: string;
  revisionId: string;
}

/**
 * The (simulation, revision) pair a key claims to belong to, or null when the key is not shaped
 * like a revision at all. Shape only — this makes no claim that either id exists.
 */
export function revisionCoordsFromKey(key: string): RevisionCoords | null {
  const revisionId = revisionIdFromKey(key);
  if (!revisionId || !UUID_RE.test(revisionId)) return null;
  const simulationId = key.split('/')[SIMULATION_ID_SEGMENT];
  if (!simulationId || !UUID_RE.test(simulationId)) return null;
  return { simulationId, revisionId };
}

/**
 * Positive and negative answers are both cached, briefly.
 *
 * A revision's existence is effectively immutable once created, but `gc()` can delete one, so a
 * positive is not cached forever. A negative is cached too, because legacy keys are the common case
 * on this hot path and re-querying for every asset of every legacy package would put a database
 * round trip in front of static file serving. The TTL is short enough that a newly published
 * revision starts getting immutable caching within a minute.
 */
const TTL_MS = 60_000;
const MAX_ENTRIES = 5_000;
const cache = new Map<string, { verified: boolean; status: string | null; at: number }>();

/** Test-only: drop memoised answers so a suite's rows are not shadowed by an earlier suite's. */
export function resetRevisionIdentityCacheForTest(): void {
  cache.clear();
}

function remember(cacheKey: string, facts: RevisionServingFacts): RevisionServingFacts {
  // Bounded, and oldest-first: Map preserves insertion order, so the first key is the oldest.
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, { verified: facts.verified, status: facts.status, at: Date.now() });
  return facts;
}

/** What one lookup learns about the revision a key claims to be inside. */
export interface RevisionServingFacts {
  /**
   * True only when the key names a revision row that exists AND belongs to the simulation in the
   * same key. Both halves matter: without the simulation check, one project's real revision id
   * would grant immutable caching under another simulation's prefix.
   */
  verified: boolean;
  /** The row's `status`, or null when the key is not a verified revision. */
  status: string | null;
}

const UNVERIFIED: RevisionServingFacts = { verified: false, status: null };

/**
 * The revision row behind a key — existence AND status — in ONE round trip.
 *
 * Two callers need two different facts about the same row (cache policy needs "is this immutable?",
 * the public route needs "was this ever published?"), and the hot path can afford one query, not
 * two.
 */
export async function revisionServingFacts(key: string): Promise<RevisionServingFacts> {
  const coords = revisionCoordsFromKey(key);
  if (!coords) return UNVERIFIED;

  const cacheKey = `${coords.simulationId}/${coords.revisionId}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return { verified: hit.verified, status: hit.status };

  try {
    const rows = await db
      .select({ id: sim_revisions.id, status: sim_revisions.status })
      .from(sim_revisions)
      .where(and(
        eq(sim_revisions.id, coords.revisionId),
        eq(sim_revisions.simulation_id, coords.simulationId),
      ))
      .limit(1);
    const row = rows[0];
    return remember(cacheKey, row
      ? { verified: true, status: typeof row.status === 'string' ? row.status : null }
      : UNVERIFIED);
  } catch (err) {
    // Not cached: a transient database fault must not pin "mutable" for the whole TTL, and must
    // never pin "immutable" at all.
    //
    // It also leaves the status gate OPEN for the duration of the fault — deliberately. Failing
    // closed here would 404 every revisioned simulation on the platform on a database blip, and the
    // bytes it would be protecting are already reachable in exactly this state today; the gate is a
    // publication check, not a secrecy boundary, and nothing an unauthenticated caller can send
    // induces this branch.
    logger.warn({ err, key }, 'revision identity check failed — serving as mutable');
    return UNVERIFIED;
  }
}

/** Back-compat shorthand for the cache-policy caller, which only asks the existence half. */
export async function isVerifiedRevisionKey(key: string): Promise<boolean> {
  return (await revisionServingFacts(key)).verified;
}
