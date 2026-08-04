/**
 * Priority 5.2 / 5.3 — the safe presentation layer.
 *
 * The bulk of this file is policy coverage, not component coverage, and that is deliberate: the
 * component renders whatever `decidePresentation` returns, so a defect in the component is a
 * missing attribute, while a defect in the policy is a wrong frame on screen. The last section
 * walks the FULL cartesian product of the policy's boolean inputs and asserts the safety
 * invariants over all 32,768 of them — the combinations nobody thought to try are the ones that
 * produced every wrong-reveal incident this layer exists to close.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_MIN_LIVE_DWELL_MS, shouldRevealLive } from 'shared/src/sim/activationMachine';
import {
  DEFAULT_PRESENTATION_INPUTS,
  decidePresentation,
  type PresentationDecision,
  type PresentationInputs,
} from '../lib/sim/presentationPolicy';
import { SimPresentationLayers } from '../components/viewer/SimPresentationLayers';

const decide = (over: Partial<PresentationInputs> = {}): PresentationDecision =>
  decidePresentation({ ...DEFAULT_PRESENTATION_INPUTS, ...over });

/** A poster that exists AND has decoded — the only state in which a poster actually covers. */
const READY_POSTER = { posterAvailable: true, posterLoaded: true } as const;
/** Enough of the section left that a live reveal is worth making. */
const AMPLE = { remainingMs: 30_000 } as const;

afterEach(cleanup);

// ─── video → sim ────────────────────────────────────────────────────────────────────────────

describe('policy: video → sim', () => {
  it('covers with the target poster while the section is not yet presented', () => {
    const d = decide({ intent: 'sim', outgoingValid: true, outgoingKind: 'video', ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.reason).toBe('awaiting-presentation-poster');
    expect(d.cover).toBe('poster');
    expect(d.coverOpacity).toBe('opaque');
    expect(d.beneathCover).toBe('outgoing');
    expect(d.prepareIncoming).toBe(true);
  });

  it('mounts the incoming frame behind an opaque, decoded poster so the reveal has no flash', () => {
    const d = decide({ intent: 'sim', outgoingValid: true, ...READY_POSTER, ...AMPLE });
    expect(d.incoming).toBe('covered');
  });

  it('keeps the incoming frame hidden while the poster exists but has not decoded', () => {
    const d = decide({ intent: 'sim', outgoingValid: true, posterAvailable: true, posterLoaded: false, ...AMPLE });
    expect(d.incoming).toBe('hidden');
    expect(d.layer).toBe('poster');
  });

  it('holds the still-playing video when the section has no poster at all', () => {
    const d = decide({ intent: 'sim', outgoingValid: true, outgoingKind: 'video', ...AMPLE });
    expect(d.layer).toBe('outgoing');
    expect(d.reason).toBe('awaiting-presentation-outgoing');
    expect(d.incoming).toBe('hidden');
    expect(d.prepareIncoming).toBe(true);
  });

  it('goes live once the matching SECTION_PRESENTED has landed', () => {
    const d = decide({ intent: 'sim', presented: true, outgoingValid: true, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('live');
    expect(d.reason).toBe('presented-live');
    expect(d.incoming).toBe('revealed');
    expect(d.cover).toBe('none');
  });
});

// ─── sim → video ────────────────────────────────────────────────────────────────────────────

describe('policy: sim → video', () => {
  it('shows the video and hides the outgoing frame', () => {
    const d = decide({ intent: 'video', outgoingValid: true, outgoingKind: 'video', presented: true, ...AMPLE });
    expect(d.layer).toBe('outgoing');
    expect(d.reason).toBe('exit-to-video');
    expect(d.incoming).toBe('hidden');
    expect(d.prepareIncoming).toBe(false);
  });

  it('covers when the video frame is not valid yet', () => {
    const d = decide({ intent: 'video', outgoingValid: false });
    expect(d.layer).toBe('poster');
    expect(d.reason).toBe('exit-to-video-no-frame');
    expect(d.cover).toBe('neutral');
    expect(d.beneathCover).toBe('opaque');
  });

  it('keeps Minimal UI on until the iframe is fully covered', () => {
    const base = { intent: 'video', outgoingValid: true, simpleUi: true } as const;
    expect(decide({ ...base, iframeFullyCovered: false }).minimalUiActive).toBe(true);
    expect(decide({ ...base, iframeFullyCovered: true }).minimalUiActive).toBe(false);
  });

  it('treats a reduced-motion hard cut as fully covered immediately', () => {
    // No fade means no in-between frame: the cover lands whole in the same paint, so waiting for a
    // transitionend that will never fire would strand Minimal UI on forever.
    const d = decide({ intent: 'video', outgoingValid: true, simpleUi: true, reducedMotion: true, iframeFullyCovered: false });
    expect(d.incoming).toBe('hidden');
    expect(d.minimalUiActive).toBe(false);
  });

  it('never releases Minimal UI on the ENTRY side, however covered the frame is', () => {
    // Releasing the hides while the frame paints behind an opaque cover would flash the section's
    // full chrome at the exact moment the cover is removed.
    const d = decide({ intent: 'sim', simpleUi: true, iframeFullyCovered: true, outgoingValid: true, ...READY_POSTER, ...AMPLE });
    expect(d.incoming).toBe('covered');
    expect(d.minimalUiActive).toBe(true);
  });
});

// ─── A → B on one package (shared document) ─────────────────────────────────────────────────

describe("policy: A → B within one package", () => {
  it("shows B's poster while the shared document is reconfigured", () => {
    const d = decide({ intent: 'sim', samePackage: true, outgoingValid: false, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.reason).toBe('same-package-poster');
    expect(d.cover).toBe('poster');
  });

  it('never prepares a separate incoming document — there is not one', () => {
    const d = decide({ intent: 'sim', samePackage: true, ...READY_POSTER, ...AMPLE });
    expect(d.prepareIncoming).toBe(false);
    expect(d.incoming).toBe('hidden');
  });

  it('falls back to the valid video beneath when B has no poster', () => {
    const d = decide({ intent: 'sim', samePackage: true, outgoingValid: true, outgoingKind: 'video', ...AMPLE });
    expect(d.layer).toBe('outgoing');
    expect(d.reason).toBe('same-package-outgoing');
  });

  it('falls back to a neutral cover when B has no poster and nothing beneath is valid', () => {
    const d = decide({ intent: 'sim', samePackage: true, outgoingValid: false, ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.reason).toBe('same-package-cover');
    expect(d.cover).toBe('neutral');
    expect(d.beneathCover).toBe('opaque');
  });

  it("releases A's Minimal UI only once the shared frame is covered", () => {
    const base = { intent: 'sim', samePackage: true, simpleUi: true, ...READY_POSTER, ...AMPLE } as const;
    expect(decide({ ...base, iframeFullyCovered: false }).minimalUiActive).toBe(true);
    expect(decide({ ...base, iframeFullyCovered: true }).minimalUiActive).toBe(false);
  });

  it('reveals B once the shared document acknowledges it', () => {
    const d = decide({ intent: 'sim', samePackage: true, presented: true, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('live');
  });
});

// ─── package A → package B ──────────────────────────────────────────────────────────────────

describe('policy: package A → package B', () => {
  it("prepares B behind B's poster", () => {
    const d = decide({ intent: 'sim', samePackage: false, outgoingValid: true, outgoingKind: 'sim', ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.prepareIncoming).toBe(true);
    expect(d.incoming).toBe('covered');
  });

  it('still prepares B while the outgoing simulation is what the user sees', () => {
    const d = decide({ intent: 'sim', samePackage: false, outgoingValid: true, outgoingKind: 'sim', ...AMPLE });
    expect(d.layer).toBe('outgoing');
    expect(d.prepareIncoming).toBe(true);
    expect(d.incoming).toBe('hidden');
  });
});

// ─── seeks and edge entry points ────────────────────────────────────────────────────────────

describe('policy: seeks and edge entry points', () => {
  it('cold seek with nothing valid and no poster covers opaquely', () => {
    const d = decide({ intent: 'sim', outgoingValid: false, outgoingKind: 'none', ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.reason).toBe('awaiting-presentation-cover');
    expect(d.cover).toBe('neutral');
    expect(d.coverOpacity).toBe('opaque');
    expect(d.beneathCover).toBe('opaque');
  });

  it('cold seek with a poster shows it', () => {
    const d = decide({ intent: 'sim', outgoingValid: false, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.cover).toBe('poster');
  });

  it('backward seek into an already-seen section stays covered until the NEW activation presents', () => {
    // Re-entry mints a new activationId, so `mayReveal` is false again even though the identical
    // scene was on screen a moment ago. Nothing in the policy may shortcut that.
    const d = decide({ intent: 'sim', presented: false, outgoingValid: true, ...READY_POSTER, ...AMPLE });
    expect(d.layer).not.toBe('live');
    expect(d.incoming).not.toBe('revealed');
  });

  it('sim-first project has no outgoing content and covers', () => {
    const d = decide({ intent: 'sim', outgoingValid: false, outgoingKind: 'none', ...READY_POSTER, ...AMPLE });
    expect(d.beneathCover).toBe('opaque');
    expect(d.layer).toBe('poster');
  });

  it('post-roll sim holds the frozen last video frame beneath', () => {
    const d = decide({ intent: 'sim', outgoingValid: true, outgoingKind: 'video', ...READY_POSTER, ...AMPLE });
    expect(d.beneathCover).toBe('outgoing');
    const live = decide({ ...{ intent: 'sim', outgoingValid: true, outgoingKind: 'video' }, presented: true, ...READY_POSTER, ...AMPLE });
    expect(live.layer).toBe('live');
  });
});

// ─── transparent sections ───────────────────────────────────────────────────────────────────

describe('policy: transparent sections', () => {
  it('uses a transparent cover so the video beneath survives', () => {
    const d = decide({ intent: 'sim', transparentSection: true, outgoingValid: true, outgoingKind: 'video', ...READY_POSTER, ...AMPLE });
    expect(d.coverOpacity).toBe('transparent');
    expect(d.beneathCover).toBe('outgoing');
  });

  it('NEVER exposes the incoming unprepared frame through poster alpha', () => {
    // The rule this whole layer exists for: a transparent cover may not authorise the
    // mount-behind-the-cover optimisation, because there is nothing covering anything.
    const d = decide({ intent: 'sim', transparentSection: true, outgoingValid: true, ...READY_POSTER, ...AMPLE });
    expect(d.incoming).toBe('hidden');
  });

  it('goes opaque when a transparent section has nothing valid beneath it', () => {
    const d = decide({ intent: 'sim', transparentSection: true, outgoingValid: false, ...READY_POSTER, ...AMPLE });
    expect(d.coverOpacity).toBe('opaque');
    expect(d.beneathCover).toBe('opaque');
  });

  it('does not make an EXIT cover transparent on account of the target section', () => {
    const d = decide({ intent: 'video', transparentSection: true, outgoingValid: false });
    expect(d.coverOpacity).toBe('opaque');
  });
});

// ─── late reveal / dwell ────────────────────────────────────────────────────────────────────

describe('policy: minimum live dwell', () => {
  it('stays on the poster when too little of the section is left', () => {
    const d = decide({ intent: 'sim', presented: true, remainingMs: SIM_MIN_LIVE_DWELL_MS - 1, ...READY_POSTER });
    expect(d.layer).toBe('poster');
    expect(d.reason).toBe('insufficient-dwell-poster');
    expect(d.incoming).toBe('covered');
  });

  it('reveals exactly at the threshold', () => {
    const d = decide({ intent: 'sim', presented: true, remainingMs: SIM_MIN_LIVE_DWELL_MS, ...READY_POSTER });
    expect(d.layer).toBe('live');
  });

  it('honours a caller-supplied threshold', () => {
    const over = { intent: 'sim', presented: true, remainingMs: 4_000, ...READY_POSTER } as const;
    expect(decide({ ...over, minDwellMs: 2_000 }).layer).toBe('live');
    expect(decide({ ...over, minDwellMs: 8_000 }).layer).toBe('poster');
  });

  it('holds the outgoing content when a late section has no poster', () => {
    const d = decide({ intent: 'sim', presented: true, remainingMs: 100, outgoingValid: true, outgoingKind: 'video' });
    expect(d.layer).toBe('outgoing');
    expect(d.reason).toBe('insufficient-dwell-outgoing');
  });

  it('reveals a late section anyway when there is nothing better to show', () => {
    const d = decide({ intent: 'sim', presented: true, remainingMs: 100, outgoingValid: false });
    expect(d.layer).toBe('live');
    expect(d.reason).toBe('insufficient-dwell-no-alternative');
  });
});

// ─── failure, context loss, retry, poster-only ──────────────────────────────────────────────

describe('policy: failure and recovery', () => {
  it('raises the recovery surface on a failed activation', () => {
    const d = decide({ intent: 'sim', failure: true, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('recovery');
    expect(d.reason).toBe('failed-awaiting-recovery');
    expect(d.showRecoveryActions).toBe(true);
    expect(d.cover).toBe('poster');
    expect(d.prepareIncoming).toBe(false);
  });

  it('keeps the surface but drops the actions while a retry is in flight', () => {
    const d = decide({ intent: 'sim', failure: true, retrying: true, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('recovery');
    expect(d.reason).toBe('retry-in-flight');
    expect(d.showRecoveryActions).toBe(false);
    expect(d.prepareIncoming).toBe(true);
  });

  it('never reveals a failed activation, even if it somehow reports presented', () => {
    const d = decide({ intent: 'sim', failure: true, presented: true, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('recovery');
    expect(d.incoming).not.toBe('revealed');
  });

  it('covers a visible simulation the moment its context is lost', () => {
    const d = decide({ intent: 'sim', presented: true, contextLost: true, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.reason).toBe('context-lost-covered');
    expect(d.incoming).not.toBe('revealed');
  });

  it('drops to the valid outgoing content on context loss with no poster', () => {
    const d = decide({ intent: 'sim', presented: true, contextLost: true, outgoingValid: true, outgoingKind: 'video', ...AMPLE });
    expect(d.layer).toBe('outgoing');
    expect(d.reason).toBe('context-lost-outgoing');
  });

  it('covers opaquely on context loss with neither poster nor valid content', () => {
    const d = decide({ intent: 'sim', presented: true, contextLost: true, outgoingValid: false, ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.cover).toBe('neutral');
  });
});

describe('policy: poster-only fallback', () => {
  it('a constrained device stays on the poster for the rest of the section', () => {
    const d = decide({ intent: 'sim', posterOnlyMode: true, presented: true, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.reason).toBe('poster-only-device');
    expect(d.incoming).toBe('hidden');
    expect(d.prepareIncoming).toBe(false);
  });

  it('dismisses the recovery surface — choosing poster-only is how the user leaves it', () => {
    const d = decide({ intent: 'sim', failure: true, posterOnlyMode: true, ...READY_POSTER, ...AMPLE });
    expect(d.layer).toBe('poster');
    expect(d.showRecoveryActions).toBe(false);
  });

  it('is never a dead end when the poster turns out to be missing', () => {
    expect(decide({ intent: 'sim', posterOnlyMode: true, outgoingValid: true, ...AMPLE }).reason)
      .toBe('poster-only-no-poster-outgoing');
    expect(decide({ intent: 'sim', posterOnlyMode: true, outgoingValid: false, ...AMPLE }).reason)
      .toBe('poster-only-no-poster-cover');
  });
});

describe('policy: reduced motion', () => {
  it('cross-fades by default and hard-cuts under the preference', () => {
    expect(decide({ intent: 'sim', ...AMPLE }).crossFade).toBe(true);
    expect(decide({ intent: 'sim', reducedMotion: true, ...AMPLE }).crossFade).toBe(false);
  });

  it('does not change WHICH layer is shown', () => {
    const base = { intent: 'sim', presented: true, outgoingValid: true, ...READY_POSTER, ...AMPLE } as const;
    const a = decide(base);
    const b = decide({ ...base, reducedMotion: true });
    expect(b.layer).toBe(a.layer);
    expect(b.incoming).toBe(a.incoming);
  });
});

// ─── exhaustive invariants ──────────────────────────────────────────────────────────────────

const FLAGS = [
  'presented', 'samePackage', 'outgoingValid', 'posterAvailable', 'posterLoaded',
  'transparentSection', 'failure', 'retrying', 'posterOnlyMode', 'contextLost',
  'simpleUi', 'iframeFullyCovered', 'reducedMotion',
] as const;
type Flag = (typeof FLAGS)[number];

function everyInput(): PresentationInputs[] {
  const out: PresentationInputs[] = [];
  for (let mask = 0; mask < 1 << FLAGS.length; mask++) {
    const flags = Object.fromEntries(
      FLAGS.map((f, k) => [f, ((mask >> k) & 1) === 1]),
    ) as Record<Flag, boolean>;
    for (const intent of ['sim', 'video'] as const) {
      for (const remainingMs of [0, 30_000]) {
        out.push({
          ...DEFAULT_PRESENTATION_INPUTS,
          ...flags,
          intent,
          remainingMs,
          outgoingKind: flags.outgoingValid ? 'video' : 'none',
        });
      }
    }
  }
  return out;
}

describe('policy invariants across every input combination', () => {
  const cases = everyInput();

  it('covers the whole boolean space', () => {
    expect(cases).toHaveLength((1 << FLAGS.length) * 4);
  });

  it('holds every safety invariant', () => {
    const min = SIM_MIN_LIVE_DWELL_MS;
    const violations: string[] = [];
    const check = (ok: boolean, name: string, i: PresentationInputs, d: PresentationDecision) => {
      if (!ok) violations.push(`${name}: ${JSON.stringify({ in: i, out: d })}`);
    };

    for (const i of cases) {
      const d = decidePresentation(i);

      // The reveal invariant. Nothing but a matching acknowledgement may put a live frame on screen.
      check(d.layer !== 'live' || i.presented, 'live implies presented', i, d);
      check((d.incoming === 'revealed') === (d.layer === 'live'), 'revealed iff live', i, d);
      check(d.incoming !== 'revealed' || i.presented, 'revealed implies presented', i, d);

      // The transparent-poster rule, stated three ways so a partial regression cannot slip through.
      check(
        d.incoming !== 'covered' || (d.coverOpacity === 'opaque' && d.cover !== 'none'),
        'covered implies an opaque cover exists', i, d,
      );
      check(
        d.incoming !== 'covered' || d.cover === 'neutral' || i.posterLoaded,
        'covered implies the cover has decoded', i, d,
      );
      check(d.coverOpacity !== 'transparent' || d.beneathCover === 'outgoing', 'transparent cover sits on valid content', i, d);
      // Scoped to a SHOWING cover: with `cover === 'none'` there is no cover, and the incoming
      // frame's visibility is governed by the reveal invariant above instead.
      check(
        d.cover === 'none' || d.coverOpacity !== 'transparent' || d.incoming === 'hidden',
        'a showing transparent cover never covers the incoming frame', i, d,
      );
      check(d.beneathCover !== 'outgoing' || i.outgoingValid, 'outgoing beneath implies it is valid', i, d);

      // Layer/cover consistency.
      check((d.cover !== 'none') === (d.layer === 'poster' || d.layer === 'recovery'), 'cover iff top layer', i, d);
      check(d.cover !== 'poster' || i.posterAvailable, 'poster cover implies a poster exists', i, d);
      check(d.layer !== 'outgoing' || i.outgoingValid, 'outgoing layer implies valid outgoing content', i, d);
      check(d.layer !== 'recovery' || i.failure, 'recovery implies a failure', i, d);
      check(!d.showRecoveryActions || (i.failure && !i.retrying), 'actions only on an un-retried failure', i, d);

      // Preparation.
      check(!d.prepareIncoming || (i.intent === 'sim' && !i.posterOnlyMode && !i.samePackage), 'prepare only cross-package, sim intent, unconstrained', i, d);

      // Dwell: a live reveal is either timely, or the only thing left to show.
      check(
        d.layer !== 'live' || shouldRevealLive(i.remainingMs, min) || (!i.posterAvailable && !i.outgoingValid),
        'late live reveal only with no alternative', i, d,
      );

      // Minimal UI and motion.
      check(!d.minimalUiActive || i.simpleUi, 'minimal UI only when configured', i, d);
      check(d.crossFade === !i.reducedMotion, 'cross-fade follows the motion preference', i, d);
    }

    expect(violations.slice(0, 5)).toEqual([]);
  });

  it('is total — every combination yields a known layer and a known reason', () => {
    const layers = new Set<string>();
    const reasons = new Set<string>();
    for (const i of cases) {
      const d = decidePresentation(i);
      layers.add(d.layer);
      reasons.add(d.reason);
    }
    expect([...layers].sort()).toEqual(['live', 'outgoing', 'poster', 'recovery']);
    // Every declared reason must be reachable; an unreachable one is dead policy nobody is testing.
    expect([...reasons].sort()).toEqual([
      'awaiting-presentation-cover',
      'awaiting-presentation-outgoing',
      'awaiting-presentation-poster',
      'context-lost-covered',
      'context-lost-outgoing',
      'exit-to-video',
      'exit-to-video-no-frame',
      'failed-awaiting-recovery',
      'insufficient-dwell-no-alternative',
      'insufficient-dwell-outgoing',
      'insufficient-dwell-poster',
      'poster-only-device',
      'poster-only-no-poster-cover',
      'poster-only-no-poster-outgoing',
      'presented-live',
      'retry-in-flight',
      'same-package-cover',
      'same-package-outgoing',
      'same-package-poster',
    ]);
  });

  it('is a pure function of its inputs', () => {
    for (const i of cases.slice(0, 512)) {
      expect(decidePresentation({ ...i })).toEqual(decidePresentation({ ...i }));
    }
  });
});

// ─── the component ──────────────────────────────────────────────────────────────────────────

const IFRAME = <iframe data-testid="sim-frame" title="Interactive simulation" />;

function renderLayers(props: Partial<React.ComponentProps<typeof SimPresentationLayers>> = {}) {
  return render(
    <SimPresentationLayers
      intent="sim"
      presented={false}
      outgoingValid
      outgoingKind="video"
      remainingMs={30_000}
      incoming={IFRAME}
      {...props}
    />,
  );
}

const root = () => screen.getByTestId('sim-presentation');
const incomingLayer = () => screen.getByTestId('sim-layer-incoming');

describe('SimPresentationLayers', () => {
  it('renders the bottom and middle layers always, and the top layer only when covering', () => {
    renderLayers({ posterSrc: '/p.png' });
    expect(screen.getByTestId('sim-layer-bottom')).toBeTruthy();
    expect(incomingLayer()).toBeTruthy();
    expect(screen.getByTestId('sim-layer-cover')).toBeTruthy();

    cleanup();
    renderLayers({ presented: true });
    expect(screen.queryByTestId('sim-layer-cover')).toBeNull();
  });

  it('keeps the incoming iframe hidden, inert and unfocusable until it is presented', () => {
    renderLayers();
    const layer = incomingLayer();
    expect(layer.getAttribute('data-visibility')).toBe('hidden');
    expect(layer.hasAttribute('inert')).toBe(true);
    expect(layer.getAttribute('aria-hidden')).toBe('true');
  });

  it('reveals it only when `presented` flips — never on a timer', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderLayers();
      // A minute of wall clock changes nothing: there is no path from elapsed time to a reveal.
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(incomingLayer().getAttribute('data-visibility')).toBe('hidden');
      expect(root().getAttribute('data-layer')).not.toBe('live');

      rerender(
        <SimPresentationLayers
          intent="sim"
          presented
          outgoingValid
          outgoingKind="video"
          remainingMs={30_000}
          incoming={IFRAME}
        />,
      );
      expect(incomingLayer().getAttribute('data-visibility')).toBe('revealed');
      expect(incomingLayer().hasAttribute('inert')).toBe(false);
      expect(root().getAttribute('data-layer')).toBe('live');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never unmounts the incoming document across a transition', () => {
    // The resident pool's entire value is that documents survive section changes. A presentation
    // layer that hid a frame by unmounting it would throw away a warmed, handshaken document.
    const { rerender } = renderLayers({ presented: true });
    const before = screen.getByTestId('sim-frame');
    rerender(
      <SimPresentationLayers
        intent="video"
        presented={false}
        outgoingValid={false}
        remainingMs={0}
        incoming={IFRAME}
      />,
    );
    expect(screen.getByTestId('sim-frame')).toBe(before);
  });

  it('treats the poster as covering only after its bytes decode', () => {
    renderLayers({ posterSrc: '/poster.webp' });
    const cover = screen.getByTestId('sim-layer-cover');
    expect(cover.getAttribute('data-poster-loaded')).toBe('false');
    expect(incomingLayer().getAttribute('data-visibility')).toBe('hidden');

    fireEvent.load(screen.getByTestId('sim-poster'));
    expect(screen.getByTestId('sim-layer-cover').getAttribute('data-poster-loaded')).toBe('true');
    expect(incomingLayer().getAttribute('data-visibility')).toBe('covered');
  });

  it('falls back when the poster fails to load rather than holding a blank cover', () => {
    renderLayers({ posterSrc: '/gone.webp' });
    expect(root().getAttribute('data-layer')).toBe('poster');
    fireEvent.error(screen.getByTestId('sim-poster'));
    expect(root().getAttribute('data-layer')).toBe('outgoing');
    expect(root().getAttribute('data-reason')).toBe('awaiting-presentation-outgoing');
  });

  it('re-evaluates decode state when the poster URL changes', () => {
    const { rerender } = renderLayers({ posterSrc: '/a.webp' });
    fireEvent.load(screen.getByTestId('sim-poster'));
    expect(incomingLayer().getAttribute('data-visibility')).toBe('covered');

    rerender(
      <SimPresentationLayers
        intent="sim"
        presented={false}
        outgoingValid
        outgoingKind="video"
        remainingMs={30_000}
        posterSrc="/b.webp"
        incoming={IFRAME}
      />,
    );
    expect(screen.getByTestId('sim-layer-cover').getAttribute('data-poster-loaded')).toBe('false');
    expect(incomingLayer().getAttribute('data-visibility')).toBe('hidden');
  });

  it('keeps a transparent cover transparent and the incoming frame hidden beneath it', () => {
    renderLayers({ posterSrc: '/t.png', transparentSection: true });
    fireEvent.load(screen.getByTestId('sim-poster'));
    expect(screen.getByTestId('sim-layer-cover').getAttribute('data-opacity')).toBe('transparent');
    expect(screen.getByTestId('sim-layer-bottom').getAttribute('data-fill')).toBe('outgoing');
    expect(incomingLayer().getAttribute('data-visibility')).toBe('hidden');
  });

  it('paints an opaque base when nothing beneath is valid', () => {
    renderLayers({ outgoingValid: false, outgoingKind: 'none' });
    expect(screen.getByTestId('sim-layer-bottom').getAttribute('data-fill')).toBe('opaque');
  });

  it('renders the recovery surface, and a spinner instead of actions while retrying', () => {
    const { rerender } = renderLayers({ failure: true, recovery: <button data-testid="retry-btn">Retry</button> });
    expect(root().getAttribute('data-layer')).toBe('recovery');
    expect(screen.getByTestId('retry-btn')).toBeTruthy();

    rerender(
      <SimPresentationLayers
        intent="sim"
        presented={false}
        outgoingValid
        remainingMs={30_000}
        failure
        retrying
        recovery={<button data-testid="retry-btn">Retry</button>}
        incoming={IFRAME}
      />,
    );
    expect(screen.queryByTestId('retry-btn')).toBeNull();
    expect(screen.getByTestId('sim-recovery')).toBeTruthy();
  });

  it('renders the cover fallback slot inside a neutral cover', () => {
    renderLayers({ outgoingValid: false, coverFallback: <div data-testid="waiting" /> });
    expect(screen.getByTestId('waiting')).toBeTruthy();
  });

  it('hard-cuts under an explicit reduced-motion override', () => {
    renderLayers({ reducedMotion: true });
    expect(root().className).toContain('no-motion');
    expect(root().getAttribute('data-cross-fade')).toBe('false');
  });

  it('hard-cuts under the OS reduced-motion preference', () => {
    const listeners: ((e: MediaQueryListEvent) => void)[] = [];
    const matchMedia = vi.fn((query: string) => ({
      matches: query.includes('reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => void listeners.push(cb),
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', { value: matchMedia, configurable: true, writable: true });
    try {
      renderLayers();
      expect(root().getAttribute('data-cross-fade')).toBe('false');
      // The preference can change mid-session; the subscription must act on it.
      act(() => { listeners.forEach((cb) => cb({ matches: false } as MediaQueryListEvent)); });
      expect(root().getAttribute('data-cross-fade')).toBe('true');
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', { value: original, configurable: true, writable: true });
      else Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'matchMedia');
    }
  });

  it('reports Minimal UI as active until the frame is covered on exit', () => {
    const seen: boolean[] = [];
    const onChange = (active: boolean) => void seen.push(active);
    const { rerender } = renderLayers({ intent: 'video', simpleUi: true, onMinimalUiActiveChange: onChange });
    expect(root().getAttribute('data-minimal-ui')).toBe('active');

    rerender(
      <SimPresentationLayers
        intent="video"
        presented={false}
        outgoingValid
        remainingMs={0}
        simpleUi
        iframeFullyCovered
        incoming={IFRAME}
        onMinimalUiActiveChange={onChange}
      />,
    );
    expect(root().getAttribute('data-minimal-ui')).toBe('inactive');
    expect(seen).toEqual([true, false]);
  });

  it('reports the decision to the caller so the pool knows what to prepare', () => {
    const decisions: PresentationDecision[] = [];
    renderLayers({ onDecision: (d) => void decisions.push(d), posterSrc: '/p.webp' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0].layer).toBe('poster');
    expect(decisions[0].prepareIncoming).toBe(true);
    expect(root().getAttribute('data-prepare-incoming')).toBe('true');
  });

  it('does not prepare a distinct document during a same-package handover', () => {
    renderLayers({ samePackage: true, posterSrc: '/b.webp' });
    expect(root().getAttribute('data-prepare-incoming')).toBe('false');
    expect(root().getAttribute('data-reason')).toBe('same-package-poster');
  });

  it('stays poster-only on a constrained device for the whole section', () => {
    const { rerender } = renderLayers({ posterOnlyMode: true, posterSrc: '/p.webp' });
    fireEvent.load(screen.getByTestId('sim-poster'));
    for (const remainingMs of [30_000, 12_000, 500]) {
      rerender(
        <SimPresentationLayers
          intent="sim"
          presented
          outgoingValid
          remainingMs={remainingMs}
          posterOnlyMode
          posterSrc="/p.webp"
          incoming={IFRAME}
        />,
      );
      expect(root().getAttribute('data-layer')).toBe('poster');
      expect(incomingLayer().getAttribute('data-visibility')).toBe('hidden');
    }
  });
});

describe('SimPresentationLayers: cached posters', () => {
  const realComplete = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'complete');
  const realNatural = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'naturalWidth');

  beforeEach(() => {
    // jsdom never loads images, so `complete` is the only way to simulate the browser case where a
    // cached poster is already decoded when React attaches it and NO load event will ever fire.
    Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
    Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 1280 });
  });

  afterEach(() => {
    if (realComplete) Object.defineProperty(HTMLImageElement.prototype, 'complete', realComplete);
    if (realNatural) Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', realNatural);
  });

  it('treats an already-complete image as decoded without waiting for a load event', () => {
    renderLayers({ posterSrc: '/cached.webp' });
    expect(screen.getByTestId('sim-layer-cover').getAttribute('data-poster-loaded')).toBe('true');
    expect(incomingLayer().getAttribute('data-visibility')).toBe('covered');
  });
});
