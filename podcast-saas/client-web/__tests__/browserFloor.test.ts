/**
 * The browser capability floor (audit P0.8).
 *
 * The property that matters is NOT "older Safari gets a poster" — it is "older Safari gets a poster
 * for exactly the packages that cannot run there, and nothing else". A blanket downgrade would be
 * easy to write and would silently break working content, so most of this file is about the cases
 * that must stay runnable.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  supportsImportMaps,
  detectBrowserCapabilities,
  evaluateFloor,
  importMapRequirement,
  sectionRequirements,
  FLOOR_MESSAGES,
} from '../lib/sim/browserFloor';

// ── supportsImportMaps: feature detection, never a UA guess ────────────────────────────────────

type SupportsFn = ((t: string) => boolean) | undefined;

const original = Object.getOwnPropertyDescriptor(HTMLScriptElement, 'supports');

function setSupports(fn: SupportsFn): void {
  if (fn === undefined) {
    // Delete rather than assign undefined: the code asks `typeof supports !== 'function'`, and an
    // own property holding undefined and a missing property must behave identically.
    delete (HTMLScriptElement as unknown as Record<string, unknown>).supports;
    return;
  }
  Object.defineProperty(HTMLScriptElement, 'supports', {
    value: fn, configurable: true, writable: true,
  });
}

afterEach(() => {
  if (original) Object.defineProperty(HTMLScriptElement, 'supports', original);
  else delete (HTMLScriptElement as unknown as Record<string, unknown>).supports;
});

describe('supportsImportMaps', () => {
  it('is true only when the browser answers true for the exact "importmap" token', () => {
    const asked: string[] = [];
    setSupports((t) => { asked.push(t); return t === 'importmap'; });
    expect(supportsImportMaps()).toBe(true);
    // Pinning the token: asking for the wrong feature name would answer a different question and
    // could pass by accident against a permissive stub.
    expect(asked).toEqual(['importmap']);
  });

  it('is false when the browser answers false', () => {
    setSupports(() => false);
    expect(supportsImportMaps()).toBe(false);
  });

  it('is false when HTMLScriptElement.supports does not exist at all', () => {
    // Safari 16.3 is exactly this case: no `supports`, no import maps. Treating "cannot ask" as
    // "cannot do" is the conservative direction — a false negative costs a poster, a false
    // positive costs the permanently blank frame this module exists to prevent.
    setSupports(undefined);
    expect(supportsImportMaps()).toBe(false);
  });

  it('is false when supports throws rather than answering', () => {
    setSupports(() => { throw new Error('nope'); });
    expect(supportsImportMaps()).toBe(false);
  });

  it('is false for a non-boolean truthy answer', () => {
    // `=== true` and not a truthiness check: a stub returning a string must not read as support.
    setSupports((() => 'yes') as unknown as (t: string) => boolean);
    expect(supportsImportMaps()).toBe(false);
  });

  it('detectBrowserCapabilities reports what supportsImportMaps found', () => {
    setSupports((t) => t === 'importmap');
    expect(detectBrowserCapabilities()).toEqual({ importMaps: true });
    setSupports(() => false);
    expect(detectBrowserCapabilities()).toEqual({ importMaps: false });
  });
});

// ── evaluateFloor: only the packages that actually need it ─────────────────────────────────────

const CAN = { importMaps: true };
const CANNOT = { importMaps: false };

describe('evaluateFloor', () => {
  it('blocks a package that needs import maps on a browser without them', () => {
    expect(evaluateFloor({ requiresImportMaps: true }, CANNOT))
      .toEqual({ runnable: false, missing: 'import-maps' });
  });

  it('runs the same package on a browser that has them', () => {
    expect(evaluateFloor({ requiresImportMaps: true }, CAN)).toEqual({ runnable: true });
  });

  it('runs a package that does NOT need import maps, even without them', () => {
    // THE REGRESSION THIS GUARDS. A blanket "old Safari → poster" would fail here, and it would
    // fail invisibly: the package works, the user just never sees it.
    expect(evaluateFloor({ requiresImportMaps: false }, CANNOT)).toEqual({ runnable: true });
  });

  it('treats an UNKNOWN requirement as runnable, not as a requirement', () => {
    // Packages published before detection existed carry no flag. Guessing "requires" would
    // poster-only every legacy package on an older browser for a need it may not have; guessing
    // "does not require" degrades to exactly today's behaviour, which is the honest default.
    expect(evaluateFloor({}, CANNOT)).toEqual({ runnable: true });
    expect(evaluateFloor(undefined, CANNOT)).toEqual({ runnable: true });
    expect(evaluateFloor(null, CANNOT)).toEqual({ runnable: true });
  });

  it('never blocks on a capable browser regardless of requirements', () => {
    for (const req of [{ requiresImportMaps: true }, { requiresImportMaps: false }, {}, undefined, null]) {
      expect(evaluateFloor(req, CAN)).toEqual({ runnable: true });
    }
  });

  it('normalises the wire value in ONE place, whichever surface is asking', () => {
    // The two surfaces reach the floor from different shapes: the editor holds the section row and
    // the viewer holds the flag on its own player state. They used to normalise it separately — one
    // through `sectionRequirements`, one as a hand-written object literal in the viewer shell — so
    // "what does an absent value mean" had two answers that were merely equal today. Both now
    // bottom out here, and the three states must survive the trip identically from either side.
    for (const wire of [true, false, null, undefined] as const) {
      expect(importMapRequirement(wire)).toEqual(sectionRequirements({ simulation_id: 's', requires_import_maps: wire }));
    }
    // UNKNOWN is `null` on the way out, never `undefined` and never coerced to `false`: the floor
    // has to be able to tell "no record" from "recorded as not needing them".
    expect(importMapRequirement(undefined)).toEqual({ requiresImportMaps: null });
    expect(importMapRequirement(null)).toEqual({ requiresImportMaps: null });
    expect(importMapRequirement(false)).toEqual({ requiresImportMaps: false });
    expect(importMapRequirement(true)).toEqual({ requiresImportMaps: true });
    // …and an absent section is the same UNKNOWN, not a requirement.
    expect(sectionRequirements(null)).toEqual({ requiresImportMaps: null });
    expect(sectionRequirements(undefined)).toEqual({ requiresImportMaps: null });
  });

  it('names a capability, not a browser, in the user-facing message', () => {
    // The message may mention a version as a hint, but the KEY is the missing capability — the
    // audit is explicit that capability, not user-agent, is the thing being decided on.
    expect(FLOOR_MESSAGES['import-maps']).toBeTruthy();
    expect(Object.keys(FLOOR_MESSAGES)).toEqual(['import-maps']);
  });
});
