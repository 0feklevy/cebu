'use client';

import { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { useEditorPlayback } from '../hooks/useEditorPlayback';
import { HLS_OPTS } from '../hooks/useSegmentedPlaybackCore';
import { simDestroyGraceMs } from '../lib/simLifecycle';
import { SIM_FADE_MS } from '../lib/sim/protocol';
import { useSimRuntime } from '../lib/sim/useSimRuntime';
import { simulationLeaseAllows, subscribeSimulationLease, timelineActionOnLeaseFree } from '../lib/sim/simulationLease';
import {
  ASSUMED_CAPABILITIES, detectBrowserCapabilities, evaluateFloor, sectionRequirements,
  type BrowserCapabilities,
} from '../lib/sim/browserFloor';
import {
  EDITOR_WARM_LEAD_SEC, packageKeyOf, planEditorResidency, planWindowResidency,
  simDocumentSwitch, simScriptFor,
  type SimOccurrence, type SimPoolFrameSpec,
} from '../lib/simPool';
import { getStoredSelection, type SimStartScriptParams } from '../lib/simUiControls';
import type { Clip } from '../hooks/useClipSequence';
import type { TimelineSection, ImageFile } from 'shared/src/generated/client-v1';
import { EditorSimPool } from './EditorSimPool';
import { ImageOverlay } from './ImageOverlay';
import { AvatarCirclesOverlay } from './viewer/AvatarCirclesOverlay';
import type { AvatarCirclesConfig } from './viewer/types';

export type { Clip };

const IS_DEV = process.env.NODE_ENV === 'development';

/**
 * The bounded reveal ceiling this surface passes at every `startPaintRecovery()` (audit §9.3
 * Stage 1).
 *
 * The runtime's default is `SIM_LEGACY_REVEAL_MS = 800`, and because the editor never calls
 * `enableModern` that ceiling's `reveal(true)` force-bypasses the `!painted` guard: 800 ms after a
 * document loads, whatever it has drawn — usually nothing — was composited over the video. The
 * default is correct AT THE RUNTIME LAYER (it is what keeps a pre-v4 package, which can never emit
 * SIM_PAINTED, displayable at all), so the fix belongs here, in the caller.
 *
 * 12 s is the paint poll's own budget: `startPaintRecovery` pings 40 times at 300 ms. Setting the
 * ceiling to exactly that means the editor force-reveals only once it has stopped asking — never
 * while an answer is still plausible. The viewer neuters the same ceiling for the same reason
 * (`SIM_PAINT_POLL_MAX_MS`, useProjectPlayer.ts).
 */
const EDITOR_SIM_REVEAL_CEILING_MS = 12_000;

/**
 * How long a warm mount waits before taking the slot from the outgoing document (Stage 4).
 *
 * There is ONE timeline document, so warming the next package means navigating the frame the
 * previous section was just displaying. The exit crossfade is still running at that instant, and
 * swapping under it would show the incoming blank document through the fade. Longer than the fade,
 * and short enough that the whole warm lead is not spent waiting.
 */
const EDITOR_WARM_SETTLE_MS = SIM_FADE_MS + 120;

export interface VideoPlayerHandle {
  seek(globalSec: number): void;
}

interface SingleClipProps {
  src?: string | null;
  hlsUrl?: string | null;
  hlsStatus?: string;
  clips?: undefined;
  flush?: boolean;
  currentTime: number;
  onTimeUpdate: (t: number) => void;
  sectionLabel?: string | null;
}

export interface ActiveImageSectionData {
  section: TimelineSection;
  image: ImageFile;
  globalStart: number;
  duration: number;
}

interface MultiClipProps {
  clips: Clip[];
  src?: undefined;
  hlsUrl?: undefined;
  hlsStatus?: undefined;
  flush?: boolean;
  timelineDuration?: number;
  currentTime: number;
  onTimeUpdate: (t: number) => void;
  sectionLabel?: string | null;
  activeSimSection?: TimelineSection | null;
  /**
   * Every sim section on the timeline in absolute-time order (audit §9.3 Stage 4). The playhead
   * position is this surface's own clock, so the OWNER supplies the layout and this surface decides
   * what to warm from it.
   */
  simOccurrences?: SimOccurrence[];
  activeBrollSection?: TimelineSection | null;
  brollHlsUrl?: string | null;
  activeImageSection?: ActiveImageSectionData | null;
  avatarCircles?: AvatarCirclesConfig | null;
}

type Props = SingleClipProps | MultiClipProps;

// ── Multi-clip player (dual-buffer) ──────────────────────────────────────────

interface MultiClipPlayerProps {
  clips: Clip[];
  timelineDuration?: number;
  onTimeUpdate: (t: number) => void;
  sectionLabel?: string | null;
  activeSimSection?: TimelineSection | null;
  simOccurrences?: SimOccurrence[];
  activeBrollSection?: TimelineSection | null;
  brollHlsUrl?: string | null;
  activeImageSection?: ActiveImageSectionData | null;
  avatarCircles?: AvatarCirclesConfig | null;
  flush?: boolean;
  imperativeRef: React.RefObject<VideoPlayerHandle | null>;
}

function MultiClipPlayer({ clips, timelineDuration, onTimeUpdate, sectionLabel, activeSimSection, simOccurrences, activeBrollSection, brollHlsUrl, activeImageSection, avatarCircles, flush = false, imperativeRef }: MultiClipPlayerProps) {
  const [speed, setSpeed] = useState(1);
  // scrubDisplay: non-null while the user is dragging the seek bar — used for
  // visual feedback only; the actual seek fires once on mouseup/touchend.
  const [scrubDisplay, setScrubDisplay] = useState<number | null>(null);

  // ── broll overlay state ───────────────────────────────────────────────────
  const brollVideoRef = useRef<HTMLVideoElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brollHlsRef   = useRef<any>(null);

  // ── sim residency state ───────────────────────────────────────────────────
  // The DOCUMENT lifecycle — handshake, paint, reveal policy, the ack gate, the deferred
  // teardown, the message listener — belongs to the shared runtime (lib/sim/SimRuntimeClient).
  // What stays here is the three things the runtime deliberately has no notion of: which URL this
  // surface has mounted, WHY it is mounted (the playhead is in its section, or it is warming ahead
  // of one), and the destroy grace that finally UNMOUNTS the iframe.
  //
  // simUrl is the ONE resident timeline document (`EDITOR_SIM_RESIDENT_CAP`). It changes only when
  // the resident PACKAGE changes — a same-package section hop keeps it, which is what turns that
  // boundary into a postMessage instead of a reload (audit §9.3 Stage 2).
  const [simUrl, setSimUrl] = useState<string | null>(null);
  // The boot-hide selectors the resident document was MOUNTED with. Kept beside the URL rather than
  // re-derived per render: the hide list rides in the src fragment, so re-deriving it would rewrite
  // the fragment of a document nobody is booting (harmless, but a same-document navigation on every
  // exit for nothing).
  const residentBootHideRef = useRef<string[] | null>(null);
  // The sim URL the timeline currently WANTS (null outside a sim section). Distinct from simUrl,
  // which stays set through the destroy grace so a fast re-entry re-uses the live document.
  const activeSimUrlRef = useRef<string | null>(null);
  // What the mounted document SHOULD be running. The runtime posts startScript immediately, and a
  // document whose bridge has not booted yet simply drops it — so the desired activation is
  // re-applied the moment SIM_READY lands (see the ready effect below). This is the old
  // pendingSimRef/SIM_READY dance without the hand-rolled listener. (sim-race fix)
  //
  // The SECTION is stored, not a resolved script name: which name a document must be sent depends
  // on what that document turns out to be (`simScriptFor`), and a fresh one has not said yet.
  const desiredSimRef = useRef<{
    section: Pick<TimelineSection, 'id' | 'simulation_url' | 'sim_script'>;
    params: SimStartScriptParams;
    /**
     * WHAT PUBLICATION RECORDED ABOUT THIS PACKAGE'S BRIDGE (audit P0.5): does it post
     * SCRIPT_APPLIED? Carried on the DESIRE rather than re-derived at apply time because
     * `activateDesired` runs from three places (the boundary, SIM_READY, the lease release) and
     * only the boundary has the section row in hand.
     *
     * `null` is UNKNOWN and is a state, not a "no" — `?? null` rather than `?? false` is
     * load-bearing, exactly as it is on the viewer's own call to `setPackageAckCapable`.
     */
    ackCapable: boolean | null;
  } | null>(null);
  // Stage 4: the pending warm mount. One timer, cleared by the residency effect's cleanup — which
  // is what makes a seek or a scrub cancel warming for free.
  const simWarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // (P1.1c) True when a lease-blocked window skipped an activation this document still owes:
  // entering a sim section (or a fresh SIM_READY) while the section editor's preview holds the
  // page lease records the desire here, and the lease-release re-evaluation turns it into the
  // real activate. Without it, a boundary crossed DURING a preview never started its script.
  //
  // MIRRORED INTO STATE, because it is also a PRESENTATION fact and not only a bookkeeping one. A
  // document that owes an activation has not been told what to run: what it is painting is its boot
  // scene, its default sub-simulation, or whatever a previous section left on it. The runtime's own
  // reveal path cannot know that — `holding` is only set by a gated ACTIVATION, and the whole point
  // here is that no activation was ever posted — so the first paint runs
  // `onPainted → maybeReveal → reveal(false)` and the slot composites content that belongs to no
  // section. The owner is the only layer that knows an activation is outstanding, so the owner
  // withholds the composite. Written only through `setPendingLeaseActivation` so the ref and the
  // state cannot drift.
  const pendingLeaseActivationRef = useRef(false);
  const [leaseActivationPending, setLeaseActivationPending] = useState(false);
  const setPendingLeaseActivation = useCallback((pending: boolean) => {
    pendingLeaseActivationRef.current = pending;
    setLeaseActivationPending(pending);
  }, []);
  /**
   * (P1.1c) A document MOUNT the lease refused, replayed when the lease frees.
   *
   * The reuse path could record its desire in the flag above and let the lease-release sync post the
   * activation, because the document it needs is already resident. The NAVIGATE path cannot: there
   * is nothing to activate until a different document is mounted, and mounting is exactly what must
   * not happen while the preview holds the page. `attach()` resets every per-document flag —
   * including the `phase: 'suspended'` the lease-driven `suspend()` just set — so a mount here boots
   * a SECOND WebGL document, un-suspends the timeline out from under the preview, and then reveals
   * itself on its first paint. That is the two-concurrent-simulations state the broker exists to
   * make impossible, reached through the one branch that never asked it.
   */
  const pendingLeaseMountRef = useRef<{ src: string; bootHide: string[] | null } | null>(null);
  // Last observed blocked-state, so the broker subscription and the compatibility CustomEvent
  // delivering the same transition twice cannot double-suspend or double-restore.
  const timelineLeaseBlockedRef = useRef(false);
  // Bumped on every lease change, purely so the residency effect below re-decides whether a warm
  // boot is allowed now. Lease changes are page events (a preview opening or closing), not a
  // per-frame signal, so this is a handful of renders per session.
  const [leaseEpoch, setLeaseEpoch] = useState(0);
  // (D2b) Destroy-on-leave: after the overlay hides, keep the paused iframe mounted for a grace
  // window (45s desktop / 700ms touch-or-low-memory), then clear simUrl so the iframe unmounts and
  // its WebGL context is truly freed. Cancelled on re-entry. The >=700ms floor is what guarantees
  // the 200ms fade — and the runtime's 280ms deferred stopScript — complete before the unmount.
  const simDestroyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── shared playback engine (viewer-quality) ───────────────────────────────
  const hook = useEditorPlayback(clips, onTimeUpdate, timelineDuration);
  // The lease sync below reads the engine through a ref: `hook` is a fresh object every render,
  // and putting it in the subscription effect's deps would re-subscribe on every frame tick.
  const hookRef = useRef(hook);
  hookRef.current = hook;

  useImperativeHandle(imperativeRef, () => ({
    seek: (globalSec: number) => hook.seek(globalSec),
  }));

  // ── simulation runtime ────────────────────────────────────────────────────
  // documentKey is the RAW url on purpose: resolveSimUrl adds only page-stable device hints and
  // the #simboot fragment, so a Minimal-UI change rewrites the fragment of a document that never
  // reloads — keying on the resolved src would reset its ready/painted flags and cancel its
  // in-flight timers for nothing.
  const { state: simState, runtime: simRuntime, frameRef: simFrameRef, onFrameLoad: onSimFrameLoad } =
    useSimRuntime(simUrl, {
      // The editor playback engine pauses as soon as the user grabs a control inside the sim.
      onUserInteraction: () => hook.pause(),
    });

  // ── residency identity ────────────────────────────────────────────────────
  // Package identity, not URL identity. Every section URL of one package carries its own
  // `?section=<id>&v=<hash>`, so a URL comparison is false at EVERY sim→sim boundary — including
  // between two sections of the same package, which is the case simPool.ts is designed for.
  const residentKey = simUrl ? packageKeyOf(simUrl) : null;
  const activeSimSpec = useMemo<SimPoolFrameSpec | null>(() => {
    const url = activeSimSection?.simulation_url ?? null;
    if (!url) return null;
    // The minimal-UI boot hint rides in the FRAGMENT (#simboot=…) so the sim paints already-minimal.
    const hide = activeSimSection?.simple_ui ? getStoredSelection(activeSimSection.sim_meta)?.hide : null;
    return { key: packageKeyOf(url), src: url, bootHide: hide?.length ? hide : null };
  }, [activeSimSection]);
  // Is the resident document the one the playhead is actually inside? Everything composited is
  // gated on this and not on the runtime's own `visible`, because a warm document reveals itself
  // (any paint runs the reveal path) long before it is allowed on screen.
  const simIsActive = residentKey !== null && activeSimSpec?.key === residentKey;

  // ── The browser capability floor (audit P0.8) ─────────────────────────────
  //
  // The editor is the surface where "it never appears" costs the most: the author is looking at
  // their own package and has no way to tell a browser that cannot run it from a package that is
  // broken. So the same verdict the viewer computes is computed here, from the same two inputs —
  // what publication recorded about the package, and what this browser actually supports.
  //
  // Detected ONCE PER MOUNT, in an effect: the answer is a property of the browser build and cannot
  // change while the page is open, and calling it during render would answer `false` under SSR and
  // remount the iframe on hydration.
  const [browserCaps, setBrowserCaps] = useState<BrowserCapabilities>(ASSUMED_CAPABILITIES);
  useEffect(() => { setBrowserCaps(detectBrowserCapabilities()); }, []);
  const simFloorMissing = useMemo(() => {
    const verdict = evaluateFloor(sectionRequirements(activeSimSection), browserCaps);
    return verdict.runnable ? null : verdict.missing;
  }, [activeSimSection, browserCaps]);

  /**
   * May the resident document be PRESENTED at all? (audit P1.1c)
   *
   * The runtime's `visible` answers "has this document painted and is nothing holding it", which is
   * a different question from "may the user see it", and the two came apart in both directions:
   *
   *   • AN OUTSTANDING ACTIVATION. A lease-blocked boundary — or a SIM_READY that landed mid-preview
   *     — records the desire WITHOUT posting it, exactly as it should. But `holding` is set only by
   *     a gated activation, so `onPainted → maybeReveal → reveal(false)` presented a document that
   *     had been sent no `startScript` at all: the package's boot scene, standing in for a section.
   *     The owner is the only layer that knows an activation is owed, so the owner withholds.
   *
   *   • THE LEASE ITSELF. `suspend()` cancels a pending APPLY bound, but the legacy paint-recovery
   *     ceiling is a different timer and force-reveals (`reveal(true)`) on schedule — so a document
   *     suspended before it ever handshook composited itself 12 s into someone else's preview.
   *     Reading the broker here is the same rule the activate/resume paths follow, applied to the
   *     one thing they do not cover. `leaseEpoch` is the reactive edge: it is bumped by the lease
   *     subscription below, which is how a lease change re-renders this at all.
   *
   * The two terms OVERLAP TODAY and that is deliberate, not an oversight: an activation is owed
   * exactly while the lease refuses one, so the second term cannot currently be observed on its own
   * (removing it changes no test). It stays because the two are different statements — "someone
   * else owns the screen" and "this document has not been told what to run" — and only the first is
   * a property of the broker. A future path that defers an activation for any other reason would be
   * covered by the second and by nothing else.
   */
  const timelineMayPresent = useMemo(
    () => simulationLeaseAllows('timeline-visible'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leaseEpoch],
  );
  const simPresentable = simState.visible && timelineMayPresent && !leaseActivationPending;

  // A package the browser cannot run is never composited, whatever the runtime's reveal path says
  // (the bounded ceiling reveals documents that never announce themselves — which is exactly this
  // one). The slot shows the reason in its cover instead.
  const showSimOverlay = simIsActive && simPresentable && !simFloorMissing;

  const cancelSimDestroy = () => {
    if (simDestroyTimerRef.current) { clearTimeout(simDestroyTimerRef.current); simDestroyTimerRef.current = null; }
  };

  const scheduleSimDestroy = () => {
    cancelSimDestroy();
    simDestroyTimerRef.current = setTimeout(() => {
      simDestroyTimerRef.current = null;
      if (activeSimUrlRef.current) return;   // a sim became active again — keep the live iframe
      // Unmounts the iframe → frees the WebGL context. The runtime detaches with the element and
      // resets every per-document flag, so a future mount re-runs the whole handshake.
      residentBootHideRef.current = null;
      setSimUrl(null);
    }, simDestroyGraceMs());
  };

  /** Take the slot for `spec` — the only two places a document is ever mounted go through here. */
  const mountResident = useCallback((spec: { src: string; bootHide: string[] | null }) => {
    residentBootHideRef.current = spec.bootHide;
    setSimUrl(spec.src);
  }, []);

  const cancelWarmMount = () => {
    if (simWarmTimerRef.current) { clearTimeout(simWarmTimerRef.current); simWarmTimerRef.current = null; }
  };

  // Native `load` of a fresh document: the runtime clears its readiness/paint flags, and this
  // surface arms the handshake poll plus the bounded reveal ceiling. Module-heavy sims (three.js
  // over a CDN) only emit SIM_READY through the bridge's own 3s timeout, and without the ceiling
  // the overlay stayed hidden while the iframe was visibly rendering. (sim-reliability fix)
  const handleSimFrameLoad = useCallback(() => {
    onSimFrameLoad();
    simRuntime.startPaintRecovery({ legacyCeilingMs: EDITOR_SIM_REVEAL_CEILING_MS });
  }, [onSimFrameLoad, simRuntime]);

  /**
   * (P1.2) The section identity the live document was last ACTIVATED for.
   *
   * The boundary effect re-runs for two different kinds of change and used to treat them the same:
   * a real move (a different section, a different document) and a pure POLICY change on the section
   * already running (`simple_ui`, `auto_script`, `sim_meta.uiControls`). Only the first is an
   * activation. This is how the two are told apart — see the policy branch in the effect below.
   */
  const activatedForRef = useRef<{ sectionId: string; url: string } | null>(null);

  /**
   * Apply the recorded desire to the live document. One helper for all three paths that do it (the
   * boundary, SIM_READY, and the lease release) because the SCRIPT NAME is not a property of the
   * section alone: a dynamic v2 bridge is addressed by the section's variant key, a legacy one only
   * understands its stored entry-point name, and which of the two a document is is not known until
   * it has said so. Resolving it once, at apply time, is what keeps the three paths from drifting.
   */
  const activateDesired = useCallback(() => {
    const desired = desiredSimRef.current;
    if (!desired) return;
    activatedForRef.current = { sectionId: desired.section.id, url: desired.section.simulation_url ?? '' };
    // BEFORE the activation, because it is the input that decides whether this document's FIRST
    // activation may be revealed on sight or must hold for the acknowledgement — and in-session
    // evidence, by definition, does not exist at that moment (audit P0.5).
    //
    // The editor needs this for exactly the reason the viewer does, and had no route to it: the
    // timeline slot warms a document long before the playhead enters its section, so by the time
    // the section IS entered the canvas is full of the boot scene's pixels and the gate holds. With
    // no record the gate could only answer UNKNOWN, and a warm-then-dispatch document skips
    // `startPaintRecovery` below (it has already painted), so nothing armed a ceiling and
    // `EditorSimPool`'s `covered = active && !shown` spinner ran for the whole section.
    simRuntime.setPackageAckCapable(desired.ackCapable);
    simRuntime.activate({
      script: simScriptFor(desired.section, simRuntime.getState().dynamic),
      params: desired.params,
    });
    // NOTE: no 50ms settle timer before revealing an already-painted document. The runtime reveals
    // on SIM_PAINTED (or on the ack for a gated switch), which is the only honest "safe to show"
    // signal — a blind timer can only fire too early or too late.
    if (!simRuntime.getState().painted) {
      simRuntime.startPaintRecovery({ legacyCeilingMs: EDITOR_SIM_REVEAL_CEILING_MS });
    }
  }, [simRuntime]);

  // Timer cleanup on unmount. The runtime disposes itself: listener, poll, deferred stop.
  useEffect(() => () => {
    if (simDestroyTimerRef.current) { clearTimeout(simDestroyTimerRef.current); simDestroyTimerRef.current = null; }
    if (simWarmTimerRef.current) { clearTimeout(simWarmTimerRef.current); simWarmTimerRef.current = null; }
  }, []);

  // A document that has not handshaken yet DROPS a startScript, so the desired activation is
  // (re)applied here — `ready` flips false→true on every freshly loaded document, which is exactly
  // where the old SIM_READY handler consumed pendingSimRef. Re-arming from desiredSimRef is what
  // makes navigation races harmless: the freshly loaded page always gets its startScript.
  // (P1.1c) …unless the section editor's preview holds the page lease. This effect used to bypass
  // the preview pact entirely: a document going ready mid-preview started its script under the
  // editor's own sim. Now the desire is recorded and the lease-release sync performs it.
  //
  // A WARM document also goes ready here, and must NOT be activated: `activeSimUrlRef` is null
  // outside a sim section, so the desire it would apply belongs to no section at all. Warming is
  // deliberately script-less; the section body is installed on entry, and the apply gate then does
  // the right thing with a document that has painted its boot scene — it holds the swap until the
  // acknowledgement rather than revealing pixels that belong to no section.
  useEffect(() => {
    if (!simState.ready) return;
    if (!activeSimUrlRef.current) return;
    const desired = desiredSimRef.current;
    if (!desired) return;
    if (!simulationLeaseAllows('timeline-visible')) { setPendingLeaseActivation(true); return; }
    activateDesired();
  }, [simState.ready, activateDesired, setPendingLeaseActivation]);

  // (P1.1c) SectionEditor coordination, lease-mediated: while the editor's preview RUNS it holds
  // the page's 'preview-visible' lease; this surface suspends its sim (and pauses the editor
  // video) for exactly that window, then re-derives the DESIRED state when the lease frees.
  // This replaces the old one-shot simPreviewHidRef latch, which could only undo exactly what it
  // saw at suspend time — a boundary crossed mid-preview either resurrected the sim under the
  // preview (via the effects that bypassed the pact) or stayed dead after it (latch saw
  // visible=false). Two concurrently-running WebGL sims is exactly what this kills.
  const syncTimelineWithLease = useCallback(() => {
    const blocked = !simulationLeaseAllows('timeline-visible');
    if (blocked === timelineLeaseBlockedRef.current) return;   // transition-dedupe
    timelineLeaseBlockedRef.current = blocked;
    if (blocked) {
      // The audit's defect note: opening the preview never paused the editor video. Same control
      // path as the sim's own onUserInteraction — the shared playback engine's pause().
      if (hookRef.current.isPlaying) hookRef.current.pause();
      simRuntime.suspend();
      return;
    }
    // A MOUNT the lease refused comes first: there is no point asking what to do with the resident
    // document when the answer is that a different one should be resident. Mounting it here is the
    // whole of the replay — its native `load` arms the poll and the ceiling, its SIM_READY drives
    // the ready effect, and the lease is free by definition on this path, so that effect activates
    // rather than recording the desire again.
    const deferredMount = pendingLeaseMountRef.current;
    if (deferredMount) {
      pendingLeaseMountRef.current = null;
      setPendingLeaseActivation(false);
      mountResident(deferredMount);
      return;
    }
    const action = timelineActionOnLeaseFree({
      wantsSim: activeSimUrlRef.current !== null,
      pendingActivation: pendingLeaseActivationRef.current,
      ready: simRuntime.getState().ready,
    });
    setPendingLeaseActivation(false);
    if (action === 'activate') {
      // A boundary crossing (or SIM_READY) happened while blocked: the recorded desire becomes
      // the real activation now. activate() itself resumes, unmutes and drives the reveal.
      activateDesired();
    } else if (action === 'resume-presented') {
      simRuntime.resume();
      simRuntime.unmute();    // suspend() silences the frame; it was audible before the preview
      simRuntime.present();   // give back the presentation the lease took away
    } else if (action === 'resume-boot') {
      // Suspended mid-boot: unfreeze and drive the handshake — the ready effect above posts the
      // startScript when SIM_READY lands (the lease is free by definition on this path).
      simRuntime.resume();
      simRuntime.startPaintRecovery({ legacyCeilingMs: EDITOR_SIM_REVEAL_CEILING_MS });
    }
  }, [simRuntime, activateDesired, mountResident, setPendingLeaseActivation]);

  useEffect(() => {
    // Late join: a preview may ALREADY hold the lease when this player mounts.
    syncTimelineWithLease();
    // The residency effect's OTHER input is the lease: a warm boot that was refused while the
    // preview held the page must be reconsidered when it lets go. `syncTimelineWithLease` cannot
    // carry that — it is transition-deduped on the timeline's own blocked-ness, and 'warm' has a
    // different answer. One subscription, two readers; not a second arbitration channel.
    const onLeaseChange = () => { syncTimelineWithLease(); setLeaseEpoch((n) => n + 1); };
    const unsubscribe = subscribeSimulationLease(onLeaseChange);
    // Compatibility pact: the section editor still announces its preview over this CustomEvent.
    // The LEASE is the authority — the event is only a re-evaluation nudge (a duplicate delivery
    // is harmless: the sync is transition-deduped), kept so the two halves of the pact keep
    // naming each other and cannot be removed independently.
    window.addEventListener('sim-preview-active', onLeaseChange);
    return () => {
      unsubscribe();
      window.removeEventListener('sim-preview-active', onLeaseChange);
    };
  }, [syncTimelineWithLease]);

  // ── broll video: load / unload HLS ───────────────────────────────────────
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v) return;
    brollHlsRef.current?.destroy();
    brollHlsRef.current = null;
    if (!brollHlsUrl) { v.src = ''; return; }
    let destroyed = false;
    const setup = async () => {
      const HlsLib = (await import('hls.js')).default;
      if (destroyed) return;
      if (HlsLib.isSupported()) {
        const hls = new HlsLib(HLS_OPTS);
        hls.loadSource(brollHlsUrl);
        hls.attachMedia(v);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hls.on(HlsLib.Events.ERROR, (_: string, d: any) => {
          if (!d.fatal) return;
          if (d.type === 'networkError') setTimeout(() => hls.startLoad(), 1000);
          else if (d.type === 'mediaError') hls.recoverMediaError();
        });
        brollHlsRef.current = hls;
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = brollHlsUrl;
      }
    };
    setup();
    return () => { destroyed = true; brollHlsRef.current?.destroy(); brollHlsRef.current = null; };
  }, [brollHlsUrl]);

  // broll cleanup on unmount
  useEffect(() => () => { brollHlsRef.current?.destroy(); brollHlsRef.current = null; }, []);

  // ── broll/clip video: seek to correct position when section starts/ends ─────
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v) return;
    if (!activeBrollSection) { v.pause(); return; }
    // For clip sections, clip_in_sec is the source video in-point;
    // for broll sections, start_sec is the in-point (usually 0).
    const inPoint = (activeBrollSection as unknown as { clip_in_sec?: number }).clip_in_sec
      ?? activeBrollSection.start_sec
      ?? 0;
    const brollTime = inPoint + (hook.globalTime - (activeBrollSection.global_offset_sec ?? 0));
    v.currentTime = Math.max(0, brollTime);
    if (hook.isPlaying) v.play().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBrollSection?.id]);

  // ── broll video: sync volume from section's broll_volume field ────────────
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v) return;
    const vol = (activeBrollSection as unknown as { broll_volume?: number })?.broll_volume;
    v.volume = typeof vol === 'number' ? Math.max(0, Math.min(1, vol)) : 1.0;
  }, [activeBrollSection?.id, (activeBrollSection as unknown as { broll_volume?: number })?.broll_volume]);

  // ── broll/clip video: resync drift on every global-time tick ────────────────
  // Runs at timeupdate rate (~8–10 Hz), not 60 Hz — drift check is cheap.
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v || !activeBrollSection) return;
    const inPoint = (activeBrollSection as unknown as { clip_in_sec?: number }).clip_in_sec
      ?? activeBrollSection.start_sec
      ?? 0;
    const expected = inPoint + (hook.globalTime - (activeBrollSection.global_offset_sec ?? 0));
    if (Math.abs(v.currentTime - expected) > 1.0) v.currentTime = Math.max(0, expected);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hook.globalTime]);

  // ── broll video: play / pause in sync with main ──────────────────────────
  useEffect(() => {
    const v = brollVideoRef.current;
    if (!v || !activeBrollSection) return;
    if (hook.isPlaying && v.paused)    v.play().catch(() => {});
    else if (!hook.isPlaying && !v.paused) v.pause();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hook.isPlaying, activeBrollSection?.id]);

  // ── sim section boundary crossings ───────────────────────────────────────
  //
  // (§9.3 Stage 2) Script identity for this surface is now the pool's `?section=`-derived
  // `dynamicScriptFor`, resolved per document by `simScriptFor`. It used to be the stored
  // `sim_script`, on the reasoning that dynamic dispatch was "the viewer's concern" — but the
  // stored value is the literal 'main' on every generated row, and a bridge resolves 'main' to the
  // LOADED document's `?section=` default. That is correct only while the frame navigates to each
  // section's own URL, which is precisely the reload this stage removes. Reusing a document without
  // switching what it dispatches would run the previous section's body under the new section.
  useEffect(() => {
    const section = activeSimSection ?? null;
    const newUrl = section?.simulation_url ?? null;
    // Minimal-UI control picker: selectors hidden mechanically while simpleUi is on.
    // Editor sections carry the full sim_meta, so read the persisted uiControls.hide
    // (the viewer gets the same list pre-flattened as ui_hide in its player config).
    const uiHide = getStoredSelection(section?.sim_meta)?.hide;
    // Pass the section's toggle values so the bridge can apply simpleUi / autoScript
    const params: SimStartScriptParams = {
      simpleUi:   section?.simple_ui   ?? false,
      autoScript: section?.auto_script  ?? true,
      ...(uiHide?.length ? { hideSelectors: uiHide } : {}),
    };
    if (!newUrl || !section) {
      if (activeSimUrlRef.current) {
        // ATOMIC EXIT (same ordering as the final viewer): freeze + mute + fade FIRST, tear down
        // after. Posting stopScript at the boundary restored the sim's hidden control panels
        // synchronously and rendered them for the whole 200ms fade — a deterministic Minimal-UI
        // flash on every exit. The runtime owns that deferral (SIM_EXIT_STOP_MS) and cancels it
        // if the section is re-entered inside the fade.
        simRuntime.deactivate();
        // (D2b) …then arm the destroy grace so the frozen iframe is eventually unmounted.
        scheduleSimDestroy();
      }
      desiredSimRef.current = null;
      activeSimUrlRef.current = null;
      // (P1.2) `deactivate()` above stops the section, so nothing is running for this document any
      // more, and a re-entry inside the destroy grace must be an ACTIVATION even though the section,
      // the URL and the toggles are all unchanged. The runtime already refuses to police a stopped
      // section (`deactivate` nulls its `livePolicy`, so `setPolicy` answers 'no-activation' and the
      // branch below falls through to activate). This clears the caller's own record of the same
      // fact, so the two cannot disagree — the alternative is a policy branch whose correctness
      // depends on a private field of another module.
      activatedForRef.current = null;
      // (P1.1c) Withdraw any desire recorded while the lease was held: leaving the sim section
      // during a preview must not activate — or MOUNT — anything when the lease frees.
      setPendingLeaseActivation(false);
      pendingLeaseMountRef.current = null;
      return;
    }
    // (D2b) Re-entered a sim section before the destroy grace fired — keep the live iframe.
    // (A new activation also supersedes the runtime's pending deferred stopScript, so a late stop
    // can never tear down the document that is about to be re-applied.)
    cancelSimDestroy();
    // …and a warm mount scheduled for a LATER package must never navigate the frame the playhead
    // has just entered. The section owns the slot from here.
    cancelWarmMount();
    const live = simRuntime.getState();
    const switchTo = simDocumentSwitch({
      mounted: live.documentKey,
      mountedDynamic: live.dynamic,
      next: newUrl,
    });
    if (switchTo === 'navigate' && live.documentKey) {
      // A different document incoming: never leave the outgoing section on screen while the frame
      // navigates and the new configuration is applied. Explicitly BEFORE the src changes; the
      // paint-gated reveal brings the new one back.
      simRuntime.hide();
    }
    activeSimUrlRef.current = newUrl;
    // What the sim SHOULD run now — and what publication recorded about its bridge (audit P0.5).
    desiredSimRef.current = { section, params, ackCapable: section.bridge_ack_capable ?? null };
    if (switchTo === 'navigate') {
      const spec = { src: newUrl, bootHide: section.simple_ui && uiHide?.length ? uiHide : null };
      // (P1.1c) THE NAVIGATE PATH CONSULTS THE LEASE TOO. It used to be the one branch that did
      // not, and mounting is the most expensive thing this surface can do without permission:
      // `attach()` clears the runtime's per-document state — the `phase: 'suspended'` the
      // lease-driven suspend() just set with it — so a regeneration, rollback or save landing while
      // the section editor's preview runs booted a SECOND WebGL document, un-suspended the timeline
      // under the preview, and (with no activation ever posted, because the ready effect correctly
      // defers) composited the package's boot scene as the section's content until the preview
      // closed. Deferred instead, and replayed by `syncTimelineWithLease`.
      if (!simulationLeaseAllows('timeline-visible')) {
        pendingLeaseMountRef.current = spec;
        setPendingLeaseActivation(true);
        return;
      }
      pendingLeaseMountRef.current = null;
      mountResident(spec);
      // A different document has to load first: its `load` arms the poll/ceiling and its SIM_READY
      // drives the ready effect above. Anything armed here would be discarded by the re-attach.
      return;
    }
    // REUSE: the src is deliberately left alone. Re-assigning it — even to this section's own URL —
    // is a navigation, and a navigation is the reload this stage exists to remove.
    // (P1.1c) Boundary crossings consult the page lease before driving the document — this
    // effect and the ready effect were the two paths that bypassed the preview pact, which is
    // how a late crossing resurrected the timeline sim under the editor's running preview. While
    // blocked, only the DESIRE is recorded (desiredSimRef above, plus this flag); the
    // lease-release sync replays it.
    if (!simulationLeaseAllows('timeline-visible')) {
      setPendingLeaseActivation(true);
    } else if (live.ready) {
      // (P1.2) POLICY FIRST, WHEN NOTHING BUT POLICY CHANGED.
      //
      // This effect re-runs for two different kinds of change and treated them identically. A
      // different section, or a different document, is a real move and must be an activation. But
      // `simple_ui`, `auto_script` and `sim_meta.uiControls` are in the dep list too (deliberately —
      // a canReuse regeneration keeps the URL and must still show up live), and for those the
      // section already running is the section that should still be running. Re-activating it
      // resets the demonstration: on v2 the bridge falls through `stopScript` — cleanup runs, every
      // tracked timer dies, the body re-runs — and on v3 a new `configHash` IS a new activation by
      // construction. So saving a Minimal-UI toggle in the section editor threw away wherever the
      // timeline's simulation had got to, which is exactly the finding P1.2 closed on the preview.
      //
      // The claim that this could not be reached because the timeline is suspended behind the
      // preview's lease does not hold: the lease is held only while the preview is RUNNING, and the
      // toggles reach the row on Save (preview stopped, or never started) and on an undo/redo
      // restore with no modal open at all.
      //
      // `setPolicy` owns the fallback for a package whose bridge predates the handlers — it
      // re-activates and says so ('reactivated'). 'no-activation' is the one answer this surface
      // must handle itself: the runtime has no live section, so a real activation is what is wanted.
      const activatedFor = activatedForRef.current;
      const policyOnly = activatedFor?.sectionId === section.id && activatedFor.url === newUrl;
      if (policyOnly) {
        const outcome = simRuntime.setPolicy({
          simpleUi: params.simpleUi,
          autoScript: params.autoScript,
          // `[]` and `null` differ on the RESTART path only (simPolicy.ts): `null` leaves the body's
          // own generated hide logic to decide, `[]` is "hide nothing". The section's stored
          // selection is authoritative here, so an empty stored list means exactly `[]`.
          hideSelectors: uiHide ?? null,
        });
        if (outcome !== 'no-activation') return;
      }
      // Live document — activate now. This is also the SAME-PACKAGE HOP: one postMessage onto a
      // document that is already painted. The runtime resumes, sends startScript + clearBootHide,
      // unmutes, and decides whether the reveal may happen immediately or must wait for this
      // section's SCRIPT_APPLIED.
      activateDesired();
    } else {
      // (D2b) Same document, bridge not up yet (e.g. a warm mount still booting, or suspended
      // mid-boot on a fast leave): unfreeze so it can finish booting, then drive the handshake. No
      // native `load` fires for an already-loaded document, so nothing else would arm the poll or
      // the bounded ceiling.
      simRuntime.resume();
      simRuntime.startPaintRecovery({ legacyCeilingMs: EDITOR_SIM_REVEAL_CEILING_MS });
    }
  // Params/script deps: a regeneration that keeps the URL (canReuse) must still re-apply
  // the new simple_ui / auto_script / sim_script — and a changed sim_meta.uiControls
  // selection (hideSelectors) — to the live iframe. (sim-race fix)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSimSection?.id, activeSimSection?.simulation_url, activeSimSection?.simple_ui, activeSimSection?.auto_script, activeSimSection?.sim_script, activeSimSection?.sim_meta]);

  // ── residency: bounded prewarm (Stage 4) and retention (Stage 3) ─────────
  //
  // WHY THIS IS THE FIX AND THE COVER IS NOT. Everything above still begins the HTML fetch, the
  // module evaluation, the WebGL context creation and the shader compile at the instant the
  // playhead crosses into a section. Stage 2 removed that for a same-package hop; this removes it
  // for a first entry and for a genuinely different package, by paying it during the video that
  // precedes the section. A cover over a wait of the same length is not a fix.
  //
  // THREE THINGS KEEP IT CONSERVATIVE (audit §9.4, and the editor must be capped harder than the
  // viewer, never softer):
  //   • ONE document. `planEditorResidency` never asks for the active package AND the next one;
  //     the slot holds whichever is due. The section editor's preview is the second WebGL context
  //     this machine is expected to host, and there is no third.
  //   • THE NEXT SECTION, on a short lead. Editor users seek constantly, so the viewer's 45 s
  //     linear-playback lead would spend most of its warms on sections nobody reaches.
  //   • CHEAP TO CANCEL. The mount is one timer and this effect's cleanup clears it, so a scrub, a
  //     seek, or the section simply arriving costs exactly one clearTimeout — no request is in
  //     flight yet, because nothing is mounted until the timer fires.
  const warmTarget = useMemo(() => {
    // A section is live: the slot is spoken for, and warming would be the second document.
    if (activeSimSpec || !simOccurrences?.length) return null;
    // The VIEWER's planner, unchanged — "the first DISTINCT upcoming package whose section starts
    // within the lead" is not a second definition here. Only the cap applied to its answer differs.
    return planWindowResidency(simOccurrences, hook.globalTime, EDITOR_WARM_LEAD_SEC).next;
  }, [activeSimSpec, simOccurrences, hook.globalTime]);

  useEffect(() => {
    const plan = planEditorResidency({
      active: activeSimSpec,
      next: warmTarget
        ? { key: warmTarget.packageKey, src: warmTarget.src, bootHide: warmTarget.bootHide }
        : null,
      resident: residentKey,
    });
    // The boundary effect owns the slot whenever a section is live.
    if (plan.role === 'active') return;
    if (plan.role === 'release' || !plan.src) {
      // Nothing is due. Let the destroy grace free the WebGL context; its fire-time guard keeps a
      // re-entry safe, and a warm mount cancels it.
      if (residentKey) scheduleSimDestroy();
      return;
    }
    // (Stage 3) The package coming back is the one already mounted, so retention is simply not
    // destroying it. This is what a sim → video → sim excursion costs now: nothing. Before, the
    // grace could only save a re-entry to the identical URL, which two sections of one package
    // never are.
    if (plan.key === residentKey) { cancelSimDestroy(); return; }
    // Warming YIELDS. 'warm' is outranked by both visible priorities, so no background boot starts
    // while the section editor's preview holds the page — P1.1's broker, at the rank it already has
    // for exactly this. The lease subscription below re-runs this effect when that changes.
    if (!simulationLeaseAllows('warm')) return;
    const { src, bootHide } = plan;
    simWarmTimerRef.current = setTimeout(() => {
      simWarmTimerRef.current = null;
      cancelSimDestroy();
      mountResident({ src, bootHide });
    }, residentKey ? EDITOR_WARM_SETTLE_MS : 0);
    return () => cancelWarmMount();
  // The destroy/warm timer helpers are re-created every render, so listing them would re-run this
  // effect on every frame tick — and its cleanup clears the warm timer, so a per-render effect
  // would restart the settle forever and the warm mount would never happen at all. The deps are
  // the DECISION's inputs, which is what the effect actually depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSimSpec, warmTarget, residentKey, leaseEpoch, mountResident]);

  // A warm document has done its job the moment it has painted: freeze it, so a background WebGL
  // scene does not compete with the editor's own video decode until its section arrives.
  // `activate()` posts SIM_RESUME, so the boundary thaws it with no bookkeeping here. Muted
  // unconditionally — a hidden frame that keeps audio is the defect the exit mute exists for.
  useEffect(() => {
    if (simIsActive || !simUrl) return;
    simRuntime.mute();
    if (simState.painted) simRuntime.freeze();
  }, [simIsActive, simUrl, simState.painted, simRuntime]);

  // ── playback speed ────────────────────────────────────────────────────────
  useEffect(() => {
    const vA = hook.videoARef.current;
    const vB = hook.videoBRef.current;
    if (vA) vA.playbackRate = speed;
    if (vB) vB.playbackRate = speed;
  }, [speed, hook.videoARef, hook.videoBRef]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  const displayTime   = scrubDisplay ?? hook.globalTime;
  const totalDuration = Math.max(hook.totalDuration, timelineDuration ?? 0);
  // The resident document, as the slot needs to see it. `src` is the URL the frame is MOUNTED with
  // — deliberately not "this section's URL", because on a same-package hop they differ and the
  // mounted one is the one that must not change. `bootHide` likewise: it rides in the fragment and
  // is only ever read at boot, so it is the list this document was mounted with, not the list the
  // current section would ask for.
  // Memoized so SimSurface's memo() is not defeated by a fresh object identity every render.
  const residentSpec = useMemo<SimPoolFrameSpec | null>(() => (
    simUrl ? { key: packageKeyOf(simUrl), src: simUrl, bootHide: residentBootHideRef.current } : null
  ), [simUrl]);
  const simulationBadgeText = activeSimSection
    ? (activeSimSection.label?.trim() || 'Simulation')
    : null;

  // ── seek bar handlers — scrub fires exactly once on release ──────────────
  const handleScrubStart = useCallback(() => {
    hook.startScrub();
  }, [hook]);

  const handleScrubMove = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setScrubDisplay(parseFloat(e.target.value));
  }, []);

  const handleScrubEnd = useCallback((e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
    const val = parseFloat((e.target as HTMLInputElement).value);
    setScrubDisplay(null);
    hook.endScrub(val);
  }, [hook]);

  const rootClass = `flex-1 relative bg-black overflow-hidden${flush ? '' : ' rounded-lg shadow-card'}`;

  return (
    <div className={rootClass}>
      {/* Video A — initial z=2 (main), swapped by hook on clip transitions */}
      <video
        ref={hook.videoARef}
        className="absolute inset-0 w-full h-full object-contain"
        style={{ zIndex: 2 }}
        playsInline
        preload="auto"
      />
      {/* Video B — initial z=1 (standby), pre-warms the next clip */}
      <video
        ref={hook.videoBRef}
        className="absolute inset-0 w-full h-full object-contain"
        style={{ zIndex: 1 }}
        playsInline
        preload="auto"
      />

      {/* B-roll overlay */}
      <video
        ref={brollVideoRef}
        className="absolute inset-0 w-full h-full object-contain bg-transparent"
        style={{
          zIndex: 3,
          opacity: activeBrollSection && !showSimOverlay ? 1 : 0,
          transition: 'opacity 150ms ease',
          pointerEvents: 'none',
        }}
        playsInline
        preload="auto"
      />

      {/* Avatar circles — preview the speaker circles during b-roll in the editor */}
      <AvatarCirclesOverlay
        config={avatarCircles}
        visible={(!!activeBrollSection || !!activeImageSection) && !showSimOverlay}
        videoARef={hook.videoARef}
        videoBRef={hook.videoBRef}
        globalTime={hook.globalTime}
      />

      {/* Image overlay — animated still with camera movement */}
      {activeImageSection && (
        <ImageOverlay
          zIndex={4}
          data={{
            image: activeImageSection.image,
            durationSec: activeImageSection.duration,
            cameraMovement: activeImageSection.section.camera_movement ?? 'zoom_in',
            visible: true,
          }}
        />
      )}

      {/* No source yet */}
      {clips.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" style={{ zIndex: 5 }}>
          <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mb-3" />
          <p className="text-xs text-white/40">Preparing video…</p>
        </div>
      )}

      {/* The ONE resident simulation document. The slot owns the video↔sim crossfade, the
          composited gate (a warm document is never shown, whatever the runtime's own presentation
          flag says), the boot cover, and the background-warm lease. startScript is sent before it
          reveals, so the sim is already in minimal-UI mode; the frame itself — sandbox, boot cloak,
          and the inert/aria-hidden/untabbable rules for a hidden sim — is SimSurface's. */}
      <EditorSimPool
        spec={residentSpec}
        active={simIsActive}
        visible={simPresentable}
        interactive={simState.interactive}
        floorMissing={simFloorMissing}
        frameRef={simFrameRef}
        onLoad={handleSimFrameLoad}
      />

      {sectionLabel && !showSimOverlay && !simulationBadgeText && (
        <div className="absolute top-3 left-3 bg-black/70 text-white text-xs font-medium px-2 py-1 rounded-md backdrop-blur-sm" style={{ zIndex: 10 }}>
          {sectionLabel}
        </div>
      )}

      {simulationBadgeText && (
        <div className="absolute bottom-20 right-3 rounded-md bg-amber-500/90 px-2.5 py-1 text-xs font-semibold text-black shadow-sm backdrop-blur-sm" style={{ zIndex: 10 }}>
          {simulationBadgeText}
        </div>
      )}

      {clips.length > 1 && (
        <div className="absolute top-3 right-3 bg-black/60 text-white/70 text-[10px] font-semibold px-2 py-0.5 rounded-md" style={{ zIndex: 10 }}>
          {hook.currentClipIdx + 1}/{clips.length}
        </div>
      )}

      {/* Controls */}
      <div className="absolute bottom-0 left-0 right-0 space-y-2 px-3 py-2 sm:px-4 sm:py-2.5" style={{ zIndex: 10, background: 'linear-gradient(180deg,rgba(2,6,23,0),rgba(2,6,23,0.9) 22%,rgba(2,6,23,0.96))', backdropFilter: 'blur(10px)' }}>
        <input
          type="range"
          min={0}
          max={totalDuration || 1}
          step={0.1}
          value={displayTime}
          onChange={handleScrubMove}
          onMouseDown={handleScrubStart}
          onMouseUp={handleScrubEnd}
          onTouchStart={handleScrubStart}
          onTouchEnd={handleScrubEnd}
          className="w-full h-1 accent-primary cursor-pointer"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              onClick={() => hook.isPlaying ? hook.pause() : hook.play()}
              className="text-white hover:text-violet-300 transition-colors focus-ring rounded"
            >
              {hook.isPlaying ? (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <rect x="4" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                  <rect x="10.5" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path d="M5 3l11 6-11 6V3z" fill="currentColor" />
                </svg>
              )}
            </button>
            <span className="truncate font-mono text-[11px] text-white/70 sm:text-xs">
              {fmt(displayTime)} / {fmt(totalDuration)}
            </span>
          </div>
          <div className="flex shrink-0 gap-1">
            {([0.5, 1, 1.5, 2] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors focus-ring ${speed === s ? 'bg-violet-500 text-white' : 'text-white/50 hover:text-white'}`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Single-clip player (existing code path, unchanged) ───────────────────────

interface SingleClipPlayerProps {
  src?: string | null;
  hlsUrl?: string | null;
  hlsStatus?: string;
  currentTime: number;
  onTimeUpdate: (t: number) => void;
  sectionLabel?: string | null;
  flush?: boolean;
  imperativeRef: React.RefObject<VideoPlayerHandle | null>;
}

function SingleClipPlayer({ src, hlsUrl, hlsStatus, currentTime, onTimeUpdate, sectionLabel, flush = false, imperativeRef }: SingleClipPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const seekingRef = useRef(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hlsRef = useRef<any>(null);

  const prevSrcRef = useRef<string | null>(null);
  const prevHlsRef = useRef<string | null>(null);

  const transcoding = hlsStatus === 'pending' || hlsStatus === 'processing';
  const effectiveSrc = hlsUrl ?? src;

  // Expose seek imperatively
  useImperativeHandle(imperativeRef, () => ({
    seek(globalSec: number) {
      const v = videoRef.current;
      if (!v) return;
      seekingRef.current = true;
      v.currentTime = globalSec;
    },
  }));

  const logMedia = useCallback((evt: string) => {
    if (!IS_DEV) return;
    const v = videoRef.current;
    if (!v) return;
    const safeSrc = v.currentSrc ? v.currentSrc.split('?')[0] : null;
    console.log(`[VideoPlayer:media] ${evt}`, {
      readyState: v.readyState,
      networkState: v.networkState,
      currentTime: v.currentTime,
      duration: v.duration,
      currentSrc: safeSrc,
      errorCode: v.error?.code,
    });
  }, []);

  useEffect(() => {
    setLoadError(null);
    setIsLoading(!!effectiveSrc);
    setDuration(0);
    if (IS_DEV) {
      console.log('[VideoPlayer] source transition', {
        rawSrc: src,
        hlsUrl,
        effectiveSrc,
        srcChanged: src !== prevSrcRef.current,
        hlsChanged: hlsUrl !== prevHlsRef.current,
      });
      prevSrcRef.current = src ?? null;
      prevHlsRef.current = hlsUrl ?? null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSrc]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    if (!hlsUrl) {
      if (src) { v.src = src; v.load(); }
      else v.removeAttribute('src');
      return;
    }
    let destroyed = false;
    const setup = async () => {
      const HlsLib = (await import('hls.js')).default;
      if (destroyed) return;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      if (HlsLib.isSupported()) {
        const hls = new HlsLib(HLS_OPTS);
        hls.loadSource(hlsUrl);
        hls.attachMedia(v);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        hls.on(HlsLib.Events.ERROR, (_: string, d: any) => {
          if (!d.fatal) return;
          if (d.type === 'networkError') setTimeout(() => hls.startLoad(), 1000);
          else if (d.type === 'mediaError') hls.recoverMediaError();
          else { if (src) v.src = src; else setLoadError('HLS playback failed.'); }
        });
        hlsRef.current = hls;
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = hlsUrl;
      } else if (src) {
        v.src = src;
      } else {
        setLoadError('HLS is not supported in this browser.');
      }
    };
    setup();
    return () => { destroyed = true; hlsRef.current?.destroy(); hlsRef.current = null; };
  }, [hlsUrl, src]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (Math.abs(v.currentTime - currentTime) > 0.3) {
      seekingRef.current = true;
      v.currentTime = currentTime;
    }
  }, [currentTime]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed]);

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };

  const rootClass = `flex-1 relative bg-black overflow-hidden${flush ? '' : ' rounded-lg shadow-card'}`;

  return (
    <div className={rootClass}>
      {effectiveSrc ? (
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-contain"
          onTimeUpdate={() => {
            if (!videoRef.current || seekingRef.current) return;
            onTimeUpdate(videoRef.current.currentTime);
          }}
          onSeeked={() => { seekingRef.current = false; if (videoRef.current) onTimeUpdate(videoRef.current.currentTime); }}
          onLoadedMetadata={() => { logMedia('loadedmetadata'); setDuration(videoRef.current?.duration ?? 0); }}
          onLoadedData={() => { logMedia('loadeddata'); setIsLoading(false); setLoadError(null); }}
          onCanPlay={() => { logMedia('canplay'); setIsLoading(false); }}
          onCanPlayThrough={() => logMedia('canplaythrough')}
          onPlay={() => { logMedia('play'); setPlaying(true); }}
          onPause={() => { logMedia('pause'); setPlaying(false); }}
          onEnded={() => { logMedia('ended'); setPlaying(false); }}
          onError={() => {
            logMedia('error');
            setPlaying(false); setIsLoading(false);
            const code = videoRef.current?.error?.code;
            if (code === 4) setLoadError('This video format is not supported.');
            else if (code === 2) setLoadError('Network error — could not load video.');
            else setLoadError('Video could not be loaded.');
          }}
          onWaiting={() => { logMedia('waiting'); setIsLoading(true); }}
          onPlaying={() => { logMedia('playing'); setIsLoading(false); }}
          onStalled={() => logMedia('stalled')}
          playsInline
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin mb-3" />
          <p className="text-xs text-white/40">Preparing video…</p>
        </div>
      )}

      {isLoading && !loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 pointer-events-none">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mb-3" />
          <p className="text-white/60 text-xs">{transcoding ? 'Preparing preview…' : 'Loading…'}</p>
        </div>
      )}

      {loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 px-6 text-center pb-16">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className="text-red-400 mb-3" aria-hidden>
            <circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1.5" />
            <path d="M16 9v8M16 21v1.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <p className="text-white/90 text-sm font-medium mb-1">Playback error</p>
          <p className="text-white/50 text-xs mb-4">{loadError}</p>
          {src && (
            <button
              onClick={() => { const v = videoRef.current; if (!v) return; setLoadError(null); setIsLoading(true); v.src = src; v.load(); }}
              className="h-7 px-4 rounded-lg bg-card/10 hover:bg-card/20 text-white text-xs font-medium transition-colors"
            >
              Retry
            </button>
          )}
          {transcoding && (
            <p className="text-amber-400/80 text-xs mt-3">
              HD version is still processing — raw preview will be available shortly.
            </p>
          )}
        </div>
      )}

      {sectionLabel && !loadError && (
        <div className="absolute top-3 left-3 bg-black/70 text-white text-xs font-medium px-2 py-1 rounded-md backdrop-blur-sm">
          {sectionLabel}
        </div>
      )}

      {transcoding && !loadError && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-amber-500/90 text-black text-xs font-semibold px-2 py-1 rounded-md">
          <span className="w-1.5 h-1.5 bg-black rounded-full animate-pulse" />
          {hlsStatus === 'processing' ? 'Transcoding…' : 'Queued'}
        </div>
      )}

      <div className="absolute bottom-0 left-0 right-0 space-y-2 px-3 py-2 sm:px-4 sm:py-2.5" style={{ background: 'linear-gradient(180deg,rgba(2,6,23,0),rgba(2,6,23,0.9) 22%,rgba(2,6,23,0.96))', backdropFilter: 'blur(10px)' }}>
        <input
          type="range" min={0} max={duration || 1} step={0.1} value={currentTime}
          onChange={(e) => {
            const t = parseFloat(e.target.value);
            if (videoRef.current) videoRef.current.currentTime = t;
            onTimeUpdate(t);
          }}
          className="w-full h-1 accent-primary cursor-pointer"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              onClick={() => {
                const v = videoRef.current;
                if (!v) return;
                if (v.paused) { v.play().catch(() => setPlaying(false)); setPlaying(true); }
                else { v.pause(); setPlaying(false); }
              }}
              className="text-white hover:text-violet-300 transition-colors focus-ring rounded"
            >
              {playing ? (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <rect x="4" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                  <rect x="10.5" y="3" width="3.5" height="12" rx="1" fill="currentColor" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
                  <path d="M5 3l11 6-11 6V3z" fill="currentColor" />
                </svg>
              )}
            </button>
            <span className="truncate font-mono text-[11px] text-white/70 sm:text-xs">{fmt(currentTime)} / {fmt(duration)}</span>
          </div>
          <div className="flex shrink-0 gap-1">
            {([0.5, 1, 1.5, 2] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors focus-ring ${speed === s ? 'bg-violet-500 text-white' : 'text-white/50 hover:text-white'}`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Public component ─────────────────────────────────────────────────────────

export const VideoPlayer = forwardRef<VideoPlayerHandle, Props>(function VideoPlayer(props, ref) {
  // Internal ref that both sub-components share for imperative handle
  const imperativeRef = useRef<VideoPlayerHandle>(null);

  // Forward the internal ref out to the parent via forwardRef
  useImperativeHandle(ref, () => ({
    seek(globalSec: number) {
      imperativeRef.current?.seek(globalSec);
    },
  }));

  if (props.clips !== undefined) {
    return (
      <MultiClipPlayer
        clips={props.clips}
        timelineDuration={props.timelineDuration}
        onTimeUpdate={props.onTimeUpdate}
        sectionLabel={props.sectionLabel}
        activeSimSection={props.activeSimSection}
        simOccurrences={props.simOccurrences}
        activeBrollSection={props.activeBrollSection}
        brollHlsUrl={props.brollHlsUrl}
        activeImageSection={props.activeImageSection}
        avatarCircles={props.avatarCircles}
        flush={props.flush}
        imperativeRef={imperativeRef}
      />
    );
  }

  return (
    <SingleClipPlayer
      src={props.src}
      hlsUrl={props.hlsUrl}
      hlsStatus={props.hlsStatus}
      currentTime={props.currentTime}
      onTimeUpdate={props.onTimeUpdate}
      sectionLabel={props.sectionLabel}
      flush={props.flush}
      imperativeRef={imperativeRef}
    />
  );
});
