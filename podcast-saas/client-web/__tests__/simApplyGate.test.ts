/**
 * The same-document apply gate — the rule that decides whether an activation may be presented
 * immediately or must wait for the bridge's SCRIPT_APPLIED acknowledgement.
 *
 * THE ORIGINAL HAZARD: `painted` is a per-DOCUMENT flag, so after the first section of a package
 * had painted, every later section switch was revealed instantly — potentially showing the PREVIOUS
 * section's frozen frame while the new body was still being applied.
 *
 * WHAT AUDIT P0.5 ADDED, and why several expectations below were deliberately changed:
 * the gate had ONE capability signal, `ackCapable`, learned in-session from the first ack it
 * happens to see. Before that first ack there is no evidence, and the gate resolved the absence of
 * evidence as "reveal" — twice over. It revealed any first activation (`lastScript === null`) and
 * it revealed any switch on a document that had not acknowledged yet. Both are false for the
 * documents the resident pool exists to create: a pooled frame boots, paints its scene and freezes
 * long before the section it was mounted for is entered, so at its FIRST requested activation the
 * canvas is already full of pixels belonging to the boot scene, the default sub-simulation, or a
 * warm pass. Those pixels were revealed on sight.
 *
 * Capability is now KNOWN before the first activation, recorded at publication from the assembled
 * bridge (shared/src/sim/bridgeCapability.ts → sim_revisions.metadata →
 * simulations.bridge_ack_capable → PlayerConfig `bridge_ack_capable` → `packageAckCapable`), so the
 * gate reasons over THREE capability states and the pixels actually on the canvas.
 */
import { describe, it, expect } from 'vitest';
import { applyGateFor, capabilityOf, type ApplyGateDecision, type ApplyGateMeta } from '../lib/simApplyGate';

/**
 * The default document is the AUDITED one: dynamic, painted, mid-session on section A.
 * `painted: true` is the whole point — an unpainted document has no wrong pixels to protect.
 */
const meta = (over: Partial<ApplyGateMeta> = {}): ApplyGateMeta => ({
  dynamic: true, ackCapable: true, painted: true, lastScript: 'section-A', ...over,
});

/** Capability inputs that produce each of the three states, for the combination sweep. */
const CAPABILITY_INPUTS: ReadonlyArray<[string, Partial<ApplyGateMeta>, 'capable' | 'incapable' | 'unknown']> = [
  ['in-session ack observed', { ackCapable: true }, 'capable'],
  ['package recorded acking', { ackCapable: null, packageAckCapable: true }, 'capable'],
  ['package recorded silent', { ackCapable: null, packageAckCapable: false }, 'incapable'],
  ['no record, no evidence', { ackCapable: null }, 'unknown'],
  ['record absent (undefined)', { ackCapable: null, packageAckCapable: undefined }, 'unknown'],
];

describe('capabilityOf — three states, and the third is not a boolean in disguise', () => {
  for (const [name, over, expected] of CAPABILITY_INPUTS) {
    it(`${name} → ${expected}`, () => {
      expect(capabilityOf(meta(over))).toBe(expected);
    });
  }

  it('EVIDENCE OUTRANKS THE RECORD: a document that has acked is capable whatever the row says', () => {
    // A republished package viewed from a cached PlayerConfig can carry a stale `false`. The
    // document in front of us has actually answered; that cannot be stale.
    expect(capabilityOf(meta({ ackCapable: true, packageAckCapable: false }))).toBe('capable');
  });

  it('a MISSING record is never read as "cannot acknowledge"', () => {
    // The defaulting mistake this whole three-state design exists to make impossible: `?? false`
    // anywhere on this path restores the hole, because "unknown" would then license a reveal.
    expect(capabilityOf(meta({ ackCapable: null, packageAckCapable: null }))).not.toBe('incapable');
  });
});

describe('applyGateFor — KNOWN-CAPABLE packages hold until the matching acknowledgement', () => {
  const capable = (over: Partial<ApplyGateMeta> = {}) => meta({ ackCapable: true, ...over });

  it('a switch to a DIFFERENT section waits for the acknowledgement', () => {
    expect(applyGateFor(capable(), 'section-B')).toBe('await-ack');
  });

  it('THE P0.5 FIX: a FIRST activation on a painted document waits too', () => {
    // WAS 'reveal-now', on the reasoning that a first activation has "nothing to switch away
    // from". A pooled document has drawn its boot scene; that is exactly something to switch away
    // from, and it is not the section being requested.
    expect(applyGateFor(capable({ lastScript: null }), 'section-A')).toBe('await-ack');
  });

  it('the record alone is enough — the FIRST activation of a session can now wait on purpose', () => {
    // Before the record existed this case was unreachable: `ackCapable` is null until an ack has
    // been seen, and on a first activation none has. This is the input that closes the hole.
    expect(applyGateFor(meta({ ackCapable: null, packageAckCapable: true, lastScript: null }), 'section-A'))
      .toBe('await-ack');
  });

  it('re-entering the SAME section reveals immediately (already applied — no flicker on re-entry)', () => {
    expect(applyGateFor(capable({ lastScript: 'section-B' }), 'section-B')).toBe('reveal-now');
  });

  it('REGRESSION: a SLOW body is never force-revealed — the decision does not depend on time', () => {
    // A modern body may legitimately take >200ms (the generation prompt tells bodies to poll for
    // async-built controls). 'await-ack' carries no deadline that could substitute for the ack.
    expect(applyGateFor(capable(), 'slow-section')).toBe('await-ack');
  });
});

describe('applyGateFor — KNOWN-SILENT packages are never made to wait on silence', () => {
  const silent = (over: Partial<ApplyGateMeta> = {}) =>
    meta({ ackCapable: null, packageAckCapable: false, ...over });

  it('a switch reveals immediately — no ack is ever coming', () => {
    expect(applyGateFor(silent(), 'section-B')).toBe('reveal-now');
  });

  it('a first activation reveals immediately', () => {
    expect(applyGateFor(silent({ lastScript: null }), 'section-A')).toBe('reveal-now');
  });

  it('a torn-down document reveals immediately (it can never ack)', () => {
    expect(applyGateFor(silent({ lastScript: null, stopped: true }), 'section-A')).toBe('reveal-now');
  });

  it('REGRESSION: no blind ceiling — a proven-silent switch is not delayed at all', () => {
    // The first implementation waited 200ms for ANY dynamic bridge and then force-revealed an
    // unacknowledged frame. A bridge proven unable to answer must neither wait nor be revealed
    // blind: it is revealed because there is nothing to wait FOR, which is a different reason.
    expect(applyGateFor(silent(), 'section-B')).toBe('reveal-now');
    expect(applyGateFor(meta({ ackCapable: false }), 'section-B')).toBe('reveal-now');
  });
});

describe('applyGateFor — UNKNOWN packages hold behind a bounded cover, never a reveal', () => {
  const unknown = (over: Partial<ApplyGateMeta> = {}) => meta({ ackCapable: null, ...over });

  it('THE CHANGED EXPECTATION (was simApplyGate.test.ts:55-57): a switch no longer reveals', () => {
    // THE OLD TEST PINNED THE HOLE AS CORRECT BEHAVIOUR. It read: "a bridge that has never acked
    // reveals immediately (stored pre-ack bridge)" — reasoning that `ackCapable === null` on a
    // switch identifies a pre-v2.1 bridge, because a modern one would have acked on its first
    // activation. That inference is only valid if the first activation itself was gated, and it
    // was not: the `lastScript === null` shortcut revealed it without ever asking for an ack, so
    // null here meant "nobody has asked" at least as often as it meant "it cannot answer".
    //
    // Silence is not proof. A slow body is silent; a wedged one is silent; a pre-ack bridge is
    // silent. The gate now refuses to pick between them by revealing, and holds behind a bounded
    // cover instead — resolved by the ack if one comes, and by an explicit, REPORTED deadline that
    // selects a cover rather than a frame if one does not (audit §21 rule 7).
    expect(applyGateFor(unknown(), 'section-B')).toBe('await-ack-bounded');
  });

  it('a first activation on a painted document holds too', () => {
    expect(applyGateFor(unknown({ lastScript: null }), 'section-A')).toBe('await-ack-bounded');
  });

  it('a torn-down document holds — its frozen frame is the previous section with the UI restored', () => {
    expect(applyGateFor(unknown({ lastScript: null, stopped: true }), 'section-A')).toBe('await-ack-bounded');
  });

  it('re-entering the SAME section still reveals — those pixels ARE this section', () => {
    expect(applyGateFor(unknown({ lastScript: 'section-B' }), 'section-B')).toBe('reveal-now');
  });
});

describe('applyGateFor — pixels, not activation counts, are what the gate protects', () => {
  it('an UNPAINTED document reveals on a first activation whatever the capability', () => {
    // Nothing has been drawn, so nothing on screen can be the wrong sub-simulation. Holding here
    // would delay every cold entry, and for a package that can never acknowledge it would delay it
    // forever — making a whole class of simulations undisplayable to protect a frame that does not
    // exist. `painted` is what separates this from the pooled case above.
    for (const [, over] of CAPABILITY_INPUTS) {
      expect(applyGateFor(meta({ ...over, painted: false, lastScript: null }), 'section-A')).toBe('reveal-now');
    }
  });

  it('omitting `painted` reads as unpainted — absent evidence of pixels is not evidence of pixels', () => {
    const m: ApplyGateMeta = { dynamic: true, ackCapable: true, lastScript: null };
    expect(applyGateFor(m, 'section-A')).toBe('reveal-now');
  });

  it('the same document, once painted, holds the identical activation', () => {
    const m: ApplyGateMeta = { dynamic: true, ackCapable: true, painted: true, lastScript: null };
    expect(applyGateFor(m, 'section-A')).toBe('await-ack');
  });
});

describe('applyGateFor — a non-dynamic bridge never uses the in-place gate', () => {
  it('a load-time-locked document navigates to a per-section URL, so there is no wrong frame', () => {
    expect(applyGateFor(meta({ dynamic: false }), 'section-B')).toBe('reveal-now');
    expect(applyGateFor(meta({ dynamic: null }), 'section-B')).toBe('reveal-now');
  });

  it('and that outranks every other input, including stopped and unknown capability', () => {
    expect(applyGateFor(meta({ dynamic: false, ackCapable: null, stopped: true }), 'section-A')).toBe('reveal-now');
  });
});

describe('applyGateFor — a TORN-DOWN document is not a fresh one', () => {
  // The deferred exit stop runs the section's cleanup: whatever it hid is restored (full UI back)
  // while the canvas still holds that section's frozen frame. The player records that by nulling
  // lastScript — which reads as a genuine first activation, and used to reveal IMMEDIATELY.
  it('a stopped document waits for the ack even though lastScript is null', () => {
    expect(applyGateFor(meta({ lastScript: null, stopped: true }), 'section-A')).toBe('await-ack');
  });

  it('re-entering the SAME section after a teardown still waits — the body must re-apply', () => {
    expect(applyGateFor(meta({ lastScript: null, stopped: true }), 'section-B')).toBe('await-ack');
  });

  it('stopped is checked BEFORE the same-section shortcut, or the shortcut would defeat it', () => {
    // The ordering is the protection. A stopped document re-entering the section it just tore down
    // matches `lastScript === nextScript` as soon as the player rewrites lastScript, and that
    // branch reveals.
    expect(applyGateFor(meta({ lastScript: 'section-A', stopped: true }), 'section-A')).toBe('await-ack');
  });
});

describe('THE PROPERTY: no combination reveals pixels that could belong to another section', () => {
  // Exhaustive over (dynamic × capability × painted × stopped × first/same/different section).
  // A property rather than a list because the hole was a MISSING case, and a list of cases someone
  // thought of is exactly what fails to catch one nobody did.
  const DYNAMIC = [true, false, null] as const;
  const PAINTED = [true, false] as const;
  const STOPPED = [true, false] as const;
  const TARGETS: ReadonlyArray<[string, string | null, string]> = [
    ['first activation', null, 'section-A'],
    ['same section', 'section-A', 'section-A'],
    ['different section', 'section-A', 'section-B'],
  ];

  it('sweeps every combination and finds no unsafe reveal', () => {
    const unsafe: string[] = [];
    let combos = 0;
    for (const dynamic of DYNAMIC) {
      for (const [capName, capOver, cap] of CAPABILITY_INPUTS) {
        for (const painted of PAINTED) {
          for (const stopped of STOPPED) {
            for (const [label, lastScript, next] of TARGETS) {
              combos += 1;
              const m: ApplyGateMeta = { dynamic, painted, stopped, lastScript, ...capOver } as ApplyGateMeta;
              const decision: ApplyGateDecision = applyGateFor(m, next);
              if (decision !== 'reveal-now') continue;

              // A reveal is safe only when one of these is true:
              //   • the document navigates rather than switching in place (a fresh document);
              //   • it has drawn nothing at all, so there are no pixels to be wrong;
              //   • the bridge is PROVEN unable to acknowledge, so no evidence can ever exist and
              //     the alternative is making it undisplayable;
              //   • the section already on the canvas IS the one being asked for, and it was not
              //     torn down underneath us.
              const navigates = dynamic !== true;
              const noPixels = !painted;
              const provenSilent = cap === 'incapable';
              const alreadyThis = lastScript === next && !stopped;
              if (navigates || noPixels || provenSilent || alreadyThis) continue;
              unsafe.push(`dynamic=${dynamic} cap=${capName} painted=${painted} stopped=${stopped} ${label}`);
            }
          }
        }
      }
    }
    expect(combos, 'the sweep stopped covering the space').toBe(180);
    expect(unsafe, `these combinations reveal unverified pixels:\n${unsafe.join('\n')}`).toEqual([]);
  });

  it('and every hold is one of the two hold kinds — nothing falls through to a fourth answer', () => {
    const seen = new Set<ApplyGateDecision>();
    for (const [, capOver] of CAPABILITY_INPUTS) {
      for (const stopped of [true, false]) {
        seen.add(applyGateFor(meta({ ...capOver, stopped, lastScript: null }), 'section-B'));
      }
    }
    for (const d of seen) expect(['reveal-now', 'await-ack', 'await-ack-bounded']).toContain(d);
    expect(seen.has('await-ack'), 'the proven-capable hold is unreachable').toBe(true);
    expect(seen.has('await-ack-bounded'), 'the unknown hold is unreachable').toBe(true);
  });
});

describe('call-site ordering — the gate decision must be taken BEFORE lastScript is updated', () => {
  // The extraction bug (audited RELEASE_BLOCKER): the player set meta.lastScript = script and
  // THEN called applyGateFor(meta, script), so lastScript === nextScript always held and the
  // gate always returned 'reveal-now' — the whole ack machinery was dead code. This pins the
  // ordering contract the player must honour.
  it('deciding AFTER the write always yields reveal-now (the bug) — proving order matters', () => {
    const m = meta({ lastScript: 'A' });
    // BUG ORDER: write then decide.
    m.lastScript = 'B';
    expect(applyGateFor(m, 'B')).toBe('reveal-now');   // wrong for a real A→B switch
  });

  it('deciding BEFORE the write yields await-ack for a genuine switch (the fix)', () => {
    const m = meta({ lastScript: 'A' });
    // FIX ORDER: decide first, then write.
    const decision = applyGateFor(m, 'B');
    m.lastScript = 'B';
    expect(decision).toBe('await-ack');
  });
});


// The SOURCE INVARIANT block that used to live here grepped useProjectPlayer.ts for the gate call
// and the terminal reveal. Both moved into lib/sim/SimRuntimeClient.ts during the shared-runtime
// migration, where they are pinned by EXECUTION in simRuntimeClient.test.ts rather than by string
// match, and __tests__/transitionOrder.test.ts asserts that no surface calls applyGateFor directly.
