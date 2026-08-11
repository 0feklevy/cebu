'use client';

import { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import { useEditorPlayback } from '../hooks/useEditorPlayback';
import { HLS_OPTS } from '../hooks/useSegmentedPlaybackCore';
import { simDestroyGraceMs } from '../lib/simLifecycle';
import { SIM_FADE_MS } from '../lib/sim/protocol';
import { SimSurface } from '../lib/sim/SimSurface';
import { useSimRuntime } from '../lib/sim/useSimRuntime';
import { simulationLeaseAllows, subscribeSimulationLease, timelineActionOnLeaseFree } from '../lib/sim/simulationLease';
import { getStoredSelection, type SimStartScriptParams } from '../lib/simUiControls';
import type { Clip } from '../hooks/useClipSequence';
import type { TimelineSection, ImageFile } from 'shared/src/generated/client-v1';
import { ImageOverlay } from './ImageOverlay';
import { AvatarCirclesOverlay } from './viewer/AvatarCirclesOverlay';
import type { AvatarCirclesConfig } from './viewer/types';

export type { Clip };

const IS_DEV = process.env.NODE_ENV === 'development';

/**
 * The sim <iframe> is pinned opaque: the crossfade lives on the WRAPPER, whose black backdrop has
 * to fade together with the frame (a non-fading backdrop would sit as a black rectangle over the
 * video for the whole destroy grace). Fading both would fade twice. Module-level so SimSurface's
 * memo() is not defeated by a fresh style object on every render.
 */
const SIM_FRAME_STYLE: React.CSSProperties = { opacity: 1 };

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
  activeBrollSection?: TimelineSection | null;
  brollHlsUrl?: string | null;
  activeImageSection?: ActiveImageSectionData | null;
  avatarCircles?: AvatarCirclesConfig | null;
  flush?: boolean;
  imperativeRef: React.RefObject<VideoPlayerHandle | null>;
}

function MultiClipPlayer({ clips, timelineDuration, onTimeUpdate, sectionLabel, activeSimSection, activeBrollSection, brollHlsUrl, activeImageSection, avatarCircles, flush = false, imperativeRef }: MultiClipPlayerProps) {
  const [speed, setSpeed] = useState(1);
  // scrubDisplay: non-null while the user is dragging the seek bar — used for
  // visual feedback only; the actual seek fires once on mouseup/touchend.
  const [scrubDisplay, setScrubDisplay] = useState<number | null>(null);

  // ── broll overlay state ───────────────────────────────────────────────────
  const brollVideoRef = useRef<HTMLVideoElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brollHlsRef   = useRef<any>(null);

  // ── sim overlay state ─────────────────────────────────────────────────────
  // The DOCUMENT lifecycle — handshake, paint, reveal policy, the ack gate, the deferred
  // teardown, the message listener — belongs to the shared runtime (lib/sim/SimRuntimeClient).
  // What stays here is the two things the runtime deliberately has no notion of: which URL this
  // surface has mounted, and the destroy grace that finally UNMOUNTS the iframe.
  const [simUrl, setSimUrl] = useState<string | null>(null);
  // The sim URL the timeline currently WANTS (null outside a sim section). Distinct from simUrl,
  // which stays set through the destroy grace so a fast re-entry re-uses the live document.
  const activeSimUrlRef = useRef<string | null>(null);
  // What the mounted document SHOULD be running. The runtime posts startScript immediately, and a
  // document whose bridge has not booted yet simply drops it — so the desired activation is
  // re-applied the moment SIM_READY lands (see the ready effect below). This is the old
  // pendingSimRef/SIM_READY dance without the hand-rolled listener. (sim-race fix)
  const desiredSimRef = useRef<{ script: string; params: SimStartScriptParams } | null>(null);
  // (P1.1c) True when a lease-blocked window skipped an activation this document still owes:
  // entering a sim section (or a fresh SIM_READY) while the section editor's preview holds the
  // page lease records the desire here, and the lease-release re-evaluation turns it into the
  // real activate. Without it, a boundary crossed DURING a preview never started its script.
  const pendingLeaseActivationRef = useRef(false);
  // Last observed blocked-state, so the broker subscription and the compatibility CustomEvent
  // delivering the same transition twice cannot double-suspend or double-restore.
  const timelineLeaseBlockedRef = useRef(false);
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
  const showSimOverlay = simState.visible;

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
      setSimUrl(null);
    }, simDestroyGraceMs());
  };

  // Native `load` of a fresh document: the runtime clears its readiness/paint flags, and this
  // surface arms the handshake poll plus the bounded reveal ceiling. Module-heavy sims (three.js
  // over a CDN) only emit SIM_READY through the bridge's own 3s timeout, and without the ceiling
  // the overlay stayed hidden while the iframe was visibly rendering. (sim-reliability fix)
  const handleSimFrameLoad = useCallback(() => {
    onSimFrameLoad();
    simRuntime.startPaintRecovery();
  }, [onSimFrameLoad, simRuntime]);

  // Destroy-timer cleanup on unmount. The runtime disposes itself: listener, poll, deferred stop.
  useEffect(() => () => {
    if (simDestroyTimerRef.current) { clearTimeout(simDestroyTimerRef.current); simDestroyTimerRef.current = null; }
  }, []);

  // A document that has not handshaken yet DROPS a startScript, so the desired activation is
  // (re)applied here — `ready` flips false→true on every freshly loaded document, which is exactly
  // where the old SIM_READY handler consumed pendingSimRef. Re-arming from desiredSimRef is what
  // makes navigation races harmless: the freshly loaded page always gets its startScript.
  // (P1.1c) …unless the section editor's preview holds the page lease. This effect used to bypass
  // the preview pact entirely: a document going ready mid-preview started its script under the
  // editor's own sim. Now the desire is recorded and the lease-release sync performs it.
  useEffect(() => {
    if (!simState.ready) return;
    const desired = desiredSimRef.current;
    if (!desired) return;
    if (!simulationLeaseAllows('timeline-visible')) { pendingLeaseActivationRef.current = true; return; }
    simRuntime.activate(desired);
    if (!simRuntime.getState().painted) simRuntime.startPaintRecovery();
  }, [simState.ready, simRuntime]);

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
    const action = timelineActionOnLeaseFree({
      wantsSim: activeSimUrlRef.current !== null,
      pendingActivation: pendingLeaseActivationRef.current,
      ready: simRuntime.getState().ready,
    });
    pendingLeaseActivationRef.current = false;
    if (action === 'activate') {
      // A boundary crossing (or SIM_READY) happened while blocked: the recorded desire becomes
      // the real activation now. activate() itself resumes, unmutes and drives the reveal.
      const desired = desiredSimRef.current;
      if (desired) {
        simRuntime.activate(desired);
        if (!simRuntime.getState().painted) simRuntime.startPaintRecovery();
      }
    } else if (action === 'resume-presented') {
      simRuntime.resume();
      simRuntime.unmute();    // suspend() silences the frame; it was audible before the preview
      simRuntime.present();   // give back the presentation the lease took away
    } else if (action === 'resume-boot') {
      // Suspended mid-boot: unfreeze and drive the handshake — the ready effect above posts the
      // startScript when SIM_READY lands (the lease is free by definition on this path).
      simRuntime.resume();
      simRuntime.startPaintRecovery();
    }
  }, [simRuntime]);

  useEffect(() => {
    // Late join: a preview may ALREADY hold the lease when this player mounts.
    syncTimelineWithLease();
    const unsubscribe = subscribeSimulationLease(syncTimelineWithLease);
    // Compatibility pact: the section editor still announces its preview over this CustomEvent.
    // The LEASE is the authority — the event is only a re-evaluation nudge (a duplicate delivery
    // is harmless: the sync is transition-deduped), kept so the two halves of the pact keep
    // naming each other and cannot be removed independently.
    const onPreviewActive = () => syncTimelineWithLease();
    window.addEventListener('sim-preview-active', onPreviewActive);
    return () => {
      unsubscribe();
      window.removeEventListener('sim-preview-active', onPreviewActive);
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
  useEffect(() => {
    const newUrl = activeSimSection?.simulation_url ?? null;
    // Script identity for THIS surface stays the stored sim_script — the pool's ?section=-derived
    // dynamicScriptFor dispatch is the viewer's concern and is deliberately not adopted here.
    const script  = activeSimSection?.sim_script ?? 'main';
    // Minimal-UI control picker: selectors hidden mechanically while simpleUi is on.
    // Editor sections carry the full sim_meta, so read the persisted uiControls.hide
    // (the viewer gets the same list pre-flattened as ui_hide in its player config).
    const uiHide = getStoredSelection(activeSimSection?.sim_meta)?.hide;
    // Pass the section's toggle values so the bridge can apply simpleUi / autoScript
    const params: SimStartScriptParams = {
      simpleUi:   activeSimSection?.simple_ui   ?? false,
      autoScript: activeSimSection?.auto_script  ?? true,
      ...(uiHide?.length ? { hideSelectors: uiHide } : {}),
    };
    if (!newUrl) {
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
      // (P1.1c) Withdraw any desire recorded while the lease was held: leaving the sim section
      // during a preview must not activate anything when the lease frees.
      pendingLeaseActivationRef.current = false;
      return;
    }
    // (D2b) Re-entered a sim section before the destroy grace fired — keep the live iframe.
    // (A new activation also supersedes the runtime's pending deferred stopScript, so a late stop
    // can never tear down the document that is about to be re-applied.)
    cancelSimDestroy();
    const live = simRuntime.getState();
    const sameDoc = live.documentKey === newUrl;
    if (!sameDoc && live.documentKey) {
      // Different section incoming: never leave the outgoing section on screen while the frame
      // navigates and the new configuration is applied. Explicitly BEFORE the src changes; the
      // paint-gated reveal brings the new one back.
      simRuntime.hide();
    }
    activeSimUrlRef.current = newUrl;
    desiredSimRef.current = { script, params };   // what the loaded sim SHOULD be running now
    setSimUrl(newUrl);
    // A different document has to load first: its `load` arms the poll/ceiling and its SIM_READY
    // drives the ready effect above. Anything armed here would be discarded by the re-attach.
    if (!sameDoc) return;
    // (P1.1c) Boundary crossings consult the page lease before driving the document — this
    // effect and the ready effect were the two paths that bypassed the preview pact, which is
    // how a late crossing resurrected the timeline sim under the editor's running preview. While
    // blocked, only the DESIRE is recorded (desiredSimRef above, plus this flag); the
    // lease-release sync replays it.
    if (!simulationLeaseAllows('timeline-visible')) {
      pendingLeaseActivationRef.current = true;
    } else if (live.ready) {
      // Live document — activate now. Re-running on params/script changes (deps below) is what
      // makes a canReuse regeneration — same URL, new toggles — show up live in the editor.
      // The runtime resumes, sends startScript + clearBootHide, unmutes, and decides whether the
      // reveal may happen immediately or must wait for this section's SCRIPT_APPLIED.
      simRuntime.activate({ script, params });
      // NOTE: no 50ms settle timer before revealing an already-painted document. The runtime
      // reveals on SIM_PAINTED (or on the ack for a gated switch), which is the only honest
      // "safe to show" signal — a blind timer can only fire too early or too late.
      if (!simRuntime.getState().painted) simRuntime.startPaintRecovery();
    } else {
      // (D2b) Same document, bridge not up yet (e.g. suspended mid-boot on a fast leave): unfreeze
      // so it can finish booting, then drive the handshake. No native `load` fires for an
      // already-loaded document, so nothing else would arm the poll or the bounded ceiling.
      simRuntime.resume();
      simRuntime.startPaintRecovery();
    }
  // Params/script deps: a regeneration that keeps the URL (canReuse) must still re-apply
  // the new simple_ui / auto_script / sim_script — and a changed sim_meta.uiControls
  // selection (hideSelectors) — to the live iframe. (sim-race fix)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSimSection?.id, activeSimSection?.simulation_url, activeSimSection?.simple_ui, activeSimSection?.auto_script, activeSimSection?.sim_script, activeSimSection?.sim_meta]);

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
  // The minimal-UI boot hint rides in the FRAGMENT (#simboot=…) so the sim paints already-minimal.
  // SimSurface resolves it (device hints + origin rebase + boot cloak) and is always boot-aware, so
  // a hash-only src change never reloads the document — bootHide flipping between sections is safe.
  // Memoized so SimSurface's memo() is not defeated by a fresh array identity every render.
  const simBootHide = useMemo(() => {
    if (!activeSimSection?.simple_ui) return null;
    const hide = getStoredSelection(activeSimSection?.sim_meta)?.hide;
    return hide?.length ? hide : null;
  }, [activeSimSection]);
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

      {/* Simulation overlay — the black background lives ON the fading layer so
          that when the sim is hidden (opacity 0) the video shows through. This
          is a true video↔sim crossfade. (A separate always-on backdrop would
          stay opaque while simUrl is set → black screen; simUrl is only cleared
          by the destroy grace timer, never during the 200ms fade, so the iframe
          stays mounted across brief hides.) startScript is sent before this
          reveals so the sim is already in minimal-UI mode. The frame itself — sandbox, boot
          cloak, and the inert/aria-hidden/untabbable rules for a hidden sim — is SimSurface's. */}
      {simUrl && (
        <div
          className="absolute inset-0"
          style={{
            zIndex: 5,
            background: '#0e0e0e',
            opacity: showSimOverlay ? 1 : 0,
            pointerEvents: showSimOverlay ? 'auto' : 'none',
            transition: `opacity ${SIM_FADE_MS}ms ease`,
          }}
        >
          <SimSurface
            src={simUrl}
            bootHide={simBootHide}
            visible={simState.visible}
            interactive={simState.interactive}
            frameRef={simFrameRef}
            onLoad={handleSimFrameLoad}
            className="w-full h-full border-0"
            style={SIM_FRAME_STYLE}
          />
        </div>
      )}

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
