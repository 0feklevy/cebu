'use client';

// The EDITOR's resident simulation slot (audit §9.3 Stages 1/3/4).
//
// WHY THIS IS NOT `viewer/SimPoolOverlay`. The pattern is the same and is deliberately borrowed —
// a frame keyed by PACKAGE so a section change is a postMessage rather than a navigation, an arm
// gate so a background boot never races the video's own, compositing that gates on "is this the
// package the playhead is in" rather than on the runtime's own presentation flag. What is NOT
// shared is everything around it: the viewer's overlay is written against viewer.css class names,
// `resolveAssetUrl`, its poster/stall policy and its prop types, and it renders up to
// `SIM_POOL_CAP = 4` frames. Importing it here would drag all of that into the editor to reuse
// ~40 lines of arrangement.
//
// WHY EXACTLY ONE FRAME. The editor is the one surface that legitimately runs two simulations at
// once — this slot and the section editor's preview panel — so its budget is one timeline document
// (`EDITOR_SIM_RESIDENT_CAP`), and the cap is structural here: this component renders `spec`, and
// `spec` is one package. There is no array to grow. Residency DECISIONS (which package, and when a
// warm one may boot) belong to the owner, because they have to move in lockstep with the runtime's
// document key — see VideoPlayer's residency effect.
//
// WHAT THIS OWNS
//   • the composited gate: `shown = active && visible`. A warm document reveals ITSELF (any paint
//     runs the runtime's reveal path), so "the runtime says visible" is not the same question as
//     "may the user see it". The viewer's pool answers it the same way, for the same reason.
//   • the `warm` lease, held for exactly as long as a non-active document is resident, so the
//     section editor's preview can see that the timeline is doing background work.
//   • the honest cue: while the playhead is inside a sim section whose document has not been
//     presented yet, SimSurface's `children` cover slot carries a spinner instead of leaving the
//     talking-head video playing bare under a section that is supposed to be a simulation. When the
//     browser cannot run the package AT ALL (audit P0.8) that same slot carries the reason instead
//     — a spinner that can never resolve is a worse lie than "this needs a newer browser".

import { memo, useEffect, useMemo } from 'react';
import type { SimPoolFrameSpec } from '../lib/simPool';
import { SIM_FADE_MS } from '../lib/sim/protocol';
import { SimSurface } from '../lib/sim/SimSurface';
import { acquireSimulationLease } from '../lib/sim/simulationLease';
import { FLOOR_MESSAGES, type MissingCapability } from '../lib/sim/browserFloor';

/** Owner id for the background-warm lease. One slot, so one id. */
export const EDITOR_WARM_LEASE_ID = 'editor-timeline-warm';

export interface EditorSimPoolProps {
  /** The resident package, or null when the slot is empty. */
  spec: SimPoolFrameSpec | null;
  /** True when the playhead is inside a section served by THIS package. */
  active: boolean;
  /** The runtime's presentation flag for the resident document. */
  visible: boolean;
  /** The runtime's pointer-input flag. */
  interactive: boolean;
  /**
   * The capability THIS browser is missing for THIS package (audit P0.8), or null when it can run.
   *
   * Decided by the owner, from `evaluateFloor`, because it is the AND of two facts this component
   * has neither of: what the package was recorded as needing at publication, and what the host
   * browser supports. Null is the answer for every capable browser and for every package with no
   * recorded requirement, which is what keeps this from being a blanket downgrade.
   */
  floorMissing?: MissingCapability | null;
  frameRef: (el: HTMLIFrameElement | null) => void;
  onLoad: () => void;
}

function EditorSimPoolInner({
  spec, active, visible, interactive, floorMissing = null, frameRef, onLoad,
}: EditorSimPoolProps) {
  const warming = spec !== null && !active;

  // The page-wide broker (P1.1), at the rank it already has for exactly this case. Held only while
  // a NON-active document is resident: the moment the playhead enters its section the document is
  // no longer background work and the lease is released by this effect's cleanup. 'warm' outranks
  // nothing, so holding it can never block the preview or the timeline — it is the signal that lets
  // the OTHER surfaces' `simulationLeaseAllows` answers stay true statements about the page.
  useEffect(() => {
    if (!warming) return;
    const lease = acquireSimulationLease({ id: EDITOR_WARM_LEASE_ID, priority: 'warm' });
    return () => lease.release();
  }, [warming, spec?.key]);

  // Composited only for the package the playhead is actually in. A warm document that paints flips
  // the runtime's `visible` on its own (maybeReveal → reveal), and a legacy one flips it at the
  // bounded ceiling; neither is permission to put it over the video.
  //
  // `!floorMissing` is part of the gate and not only of the cover. The bounded reveal ceiling exists
  // precisely for documents that never announce themselves, so on a browser that cannot run this
  // package it would fire on schedule and composite an iframe that is guaranteed to be blank over
  // the video. The floor is the one input that says the frame will NEVER be worth showing.
  const shown = active && visible && !floorMissing;

  // The cover answers "why is there no simulation here yet", and only that question. It is NOT
  // rendered for a warm document: a spinner over the talking head while nothing is due would be a
  // lie about the state of the timeline.
  const covered = active && !shown;
  const cover = useMemo(() => {
    if (!covered) return null;
    return (
      <div
        className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
        aria-hidden
        data-testid="editor-sim-cover"
        data-floor-missing={floorMissing ?? undefined}
      >
        {floorMissing
          // NO SPINNER HERE, deliberately. Every other cover in this product spins because
          // something is on its way; this one is up because nothing is, and for the rest of the
          // section. An animation would keep promising a frame that cannot arrive, and the editor
          // is exactly where that lie costs the most — the author would spend the wait wondering
          // what they broke in a package that is fine everywhere else.
          ? <p className="text-xs text-white/55 max-w-[28ch] text-center px-4 leading-relaxed">{FLOOR_MESSAGES[floorMissing]}</p>
          : (
            <>
              <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mb-3" />
              <p className="text-xs text-white/40">Loading simulation…</p>
            </>
          )}
      </div>
    );
  }, [covered, floorMissing]);

  if (!spec) return null;

  return (
    <div
      className="absolute inset-0"
      style={{ zIndex: 5, pointerEvents: shown ? 'auto' : 'none' }}
      data-testid="editor-sim-slot"
    >
      {/*
        The black backdrop is its own layer, fading in lockstep with the frame.
        It used to be the frame's PARENT, with the frame pinned opaque, so that the two composited
        as a single fading unit (a backdrop that did not fade would sit as a black rectangle over
        the video for the whole destroy grace). That arrangement cannot host the cover: CSS opacity
        applies to the whole subtree, so a spinner inside the fading wrapper is invisible during
        exactly the wait it exists to explain. Two sibling layers on one duration reach the same
        endpoints, and the viewer composites its pool the same way (`.sim-overlay` + the frame's own
        transition).
      */}
      <div
        className="absolute inset-0"
        style={{
          background: '#0e0e0e',
          opacity: shown ? 1 : 0,
          transition: `opacity ${SIM_FADE_MS}ms ease`,
        }}
        aria-hidden
      />
      {/*
        `key` is the PACKAGE. A same-package section change must not remount — that is the whole
        point of Stage 2 — while a genuinely different package (or a regeneration, which mints a new
        revision path) gets a clean element, and with it a clean runtime generation.

        SimSurface owns every rule that must hold for a hosted simulation frame anywhere: the
        boot-hide fragment (dropping it turns a hash-only src change into a reload), the origin
        rebase, and the inert/aria-hidden/untabbable state of a frame the user cannot see. It is
        given `shown`, not the raw runtime flag, so a warm document is out of the accessibility tree
        and out of the tab order for as long as it is invisible.
      */}
      <SimSurface
        key={spec.key}
        src={spec.src}
        bootHide={spec.bootHide}
        visible={shown}
        interactive={interactive}
        frameRef={frameRef}
        onLoad={onLoad}
        className="absolute inset-0 w-full h-full border-0"
      >
        {cover}
      </SimSurface>
    </div>
  );
}

export const EditorSimPool = memo(EditorSimPoolInner);
