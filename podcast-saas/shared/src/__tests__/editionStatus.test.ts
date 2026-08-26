/**
 * The audio edition's status vocabulary — the seam where three lists disagreed.
 *
 * The creator's podcast row said "Building — this takes a few minutes", flipped back to "Create
 * podcast" a second later, and stayed there forever while the build ran perfectly. The GET route
 * returned the DATABASE's `processing`; the client's in-flight test recognised only `queued` and
 * `building`. The set of values the server could send while building, intersected with the set the
 * client would treat as building, was EMPTY.
 *
 * These tests are about that intersection, not about the mapping function's prettiness.
 */
import { describe, expect, it } from 'vitest';
import {
  EDITION_DB_STATUSES,
  EDITION_IN_FLIGHT,
  EDITION_WIRE_STATUSES,
  editionWireStatus,
  isEditionInFlight,
} from '../audio/editionStatus.js';

describe('every stored status has a wire status', () => {
  it.each(EDITION_DB_STATUSES)('%s maps into the wire vocabulary', (stored) => {
    // Exhaustive over the database's OWN list, so adding a status to the schema without teaching
    // this function about it fails here rather than in a creator's browser.
    expect(EDITION_WIRE_STATUSES).toContain(editionWireStatus(stored));
  });

  it('translates processing to building — THE regression', () => {
    // Not "some value": this exact pair is the bug. `processing` reaching a client unchanged is
    // what made a running build look like no build at all.
    expect(editionWireStatus('processing')).toBe('building');
  });

  it('a missing row and an absent status both read as none', () => {
    expect(editionWireStatus(null)).toBe('none');
    expect(editionWireStatus(undefined)).toBe('none');
    expect(editionWireStatus('none')).toBe('none');
  });

  it('passes ready and failed through unchanged', () => {
    expect(editionWireStatus('ready')).toBe('ready');
    expect(editionWireStatus('failed')).toBe('failed');
  });

  it('an UNKNOWN status is none, never building', () => {
    // The choice matters. `building` would tell the client to poll a value nothing can ever
    // clear — a spinner with no end — while `none` leaves a button the creator can press.
    expect(editionWireStatus('teleporting')).toBe('none');
    expect(editionWireStatus('')).toBe('none');
  });
});

describe('the in-flight set is the SAME set on both sides', () => {
  it('recognises every wire status the server can send while work is happening', () => {
    // The property that was false in production: at least one stored status must produce an
    // in-flight wire status, or a running build is invisible to the client by construction.
    const inFlightFromDb = EDITION_DB_STATUSES
      .map(editionWireStatus)
      .filter((w) => isEditionInFlight(w));
    expect(inFlightFromDb).toContain('building');
  });

  it('agrees with EDITION_IN_FLIGHT for every wire status', () => {
    for (const s of EDITION_WIRE_STATUSES) {
      expect(isEditionInFlight(s)).toBe(EDITION_IN_FLIGHT.includes(s));
    }
  });

  it('queued is in flight even though no row carries it', () => {
    // The POST answers 202 before any row exists. If this were dropped, the click would show
    // nothing at all until the first poll landed.
    expect(isEditionInFlight('queued')).toBe(true);
  });

  it('settled statuses are not in flight', () => {
    expect(isEditionInFlight('ready')).toBe(false);
    expect(isEditionInFlight('failed')).toBe(false);
    expect(isEditionInFlight('none')).toBe(false);
    expect(isEditionInFlight(null)).toBe(false);
  });

  it('the raw database value is NOT in flight — it must be translated first', () => {
    // A caller that forgets `editionWireStatus` gets `false`, which is the bug. Pinned so the
    // fix cannot be "make isEditionInFlight also accept processing" — that would leave the wire
    // carrying a value the contract does not declare.
    expect(isEditionInFlight('processing')).toBe(false);
  });
});
