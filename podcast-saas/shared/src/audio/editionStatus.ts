/**
 * The audio edition's status, in the ONE vocabulary both sides speak.
 *
 * WHY THIS FILE EXISTS. The creator's podcast row was permanently stuck: it said "Building — this
 * takes a few minutes", then flipped back to "Create podcast" a second later, forever, while the
 * build ran perfectly on the server.
 *
 * Three vocabularies had grown for one fact, and nothing forced them to agree:
 *
 *   the database  →  none | processing | ready | failed        (schema.ts)
 *   the POST ack  →  queued                                    (202, before any row exists)
 *   the client    →  none | queued | building | ready | failed (client-v1.ts)
 *
 * The GET route returned the DATABASE value verbatim. So while a build was running the client
 * received `processing` — a value it has never heard of. Its `running` test is
 * `status === 'queued' || status === 'building'`, which `processing` fails; so the row rendered as
 * idle, the polling interval was cleared, and the finished podcast appeared only if the creator
 * happened to reload the page.
 *
 * The intersection of what the server could send while building and what the client recognised as
 * building was EMPTY. The only reason "Building" ever appeared at all is the client's own
 * optimistic write on click, which the first poll then overwrote.
 *
 * WHAT LET IT SHIP. `AudioEditionStatus.status` was typed `'none' | 'queued' | … | string`. That
 * trailing `| string` collapses the union to `string`, so every one of these values type-checked
 * and the declared vocabulary was decoration. `shared/src/generated/` is hand-maintained
 * (CLAUDE.md §5) — nothing regenerates it from the routes — so this is exactly the silent drift
 * that file warns about, and the type was the one thing that could have caught it.
 *
 * The mapping now lives here, is exhaustive over the database's own values, and is asserted by
 * tests on both sides.
 */

/** What the database stores. Mirrors the comment on `project_audio_editions.status`. */
export const EDITION_DB_STATUSES = ['none', 'processing', 'ready', 'failed'] as const;
export type EditionDbStatus = (typeof EDITION_DB_STATUSES)[number];

/**
 * What crosses the wire. `queued` is real and has no database row behind it: the POST answers 202
 * before any row exists, and the client shows it until the first poll replaces it.
 */
export const EDITION_WIRE_STATUSES = ['none', 'queued', 'building', 'ready', 'failed'] as const;
export type EditionWireStatus = (typeof EDITION_WIRE_STATUSES)[number];

/** Wire statuses that mean "work is happening, keep polling". */
export const EDITION_IN_FLIGHT: readonly EditionWireStatus[] = ['queued', 'building'];

/**
 * Translate a stored status into the wire vocabulary.
 *
 * An UNRECOGNISED status maps to `none` rather than to `building`, and the distinction is not
 * cosmetic: `building` tells the client to poll forever on a value nobody can clear, which is a
 * spinner that never ends. `none` leaves the creator with a button they can press. A missing row
 * is also `none` — never having started and no longer being tracked look the same from here, and
 * both are answered by the same action.
 */
export function editionWireStatus(stored: string | null | undefined): EditionWireStatus {
  switch (stored) {
    case 'processing': return 'building';
    case 'ready': return 'ready';
    case 'failed': return 'failed';
    case 'none':
    case null:
    case undefined: return 'none';
    default: return 'none';
  }
}

/** Does this wire status mean a build is in flight? */
export function isEditionInFlight(status: string | null | undefined): boolean {
  return status === 'queued' || status === 'building';
}
