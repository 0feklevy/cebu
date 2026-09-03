'use client';

/**
 * A banner for every simulation the project owns — captured in the creator's browser, one at a
 * time, without the creator opening anything.
 *
 * WHY. The section editor captures a poster when a section's preview has loaded
 * (usePosterCapture.ts) — which means a simulation the creator never re-opens, or one the library
 * lists but no section places, never gets a picture: the share library showed a gradient for every
 * one of them on production v0.3.0. So when the editor opens, this sweep looks at the listing (the
 * server says which simulations have no banner), mounts ONE offscreen frame at a time, waits for
 * the document to draw, asks it for its picture over the authoring channel, and files it under the
 * simulation's own identity. Then the next one.
 *
 * One at a time, so the creator's machine is never asked to run a dozen simulations at once.
 * Bounded per session. A document that cannot draw itself is counted, shown, and skipped — never
 * retried in a loop. "Capture banners" forces a pass over every simulation, banner or not.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { connectSimAuthoring } from '@/lib/sim/SimAuthoringClient';
import { renderPosterRenditions } from '@/lib/posterCapture';
import type { Simulation } from 'shared/src/generated/client-v1';
import type { SimAspectProfile } from 'shared/src/sim/simIdentity';

export const BANNER_SWEEP_MAX_PER_SESSION = 12;
export const BANNER_SWEEP_SETTLE_MS = 1500;

/** simulation id + document already attempted this session — a re-render must not re-run it. */
const attempted = new Set<string>();

export interface BannerSweepState {
  running: boolean;
  /** The simulation whose frame is mounted right now. */
  active: Simulation | null;
  queued: number;
  stored: number;
  existed: number;
  failed: number;
}

const IDLE: BannerSweepState = { running: false, active: null, queued: 0, stored: 0, existed: 0, failed: 0 };

/** Which simulations still need a banner — ready, served, and (unless forced) without one. */
export function bannersNeeded(sims: readonly Simulation[], force: boolean): Simulation[] {
  return sims.filter((s) => {
    if (s.status !== 'ready' || !s.entry_file) return false;
    if (attempted.has(`${s.id}|${s.entry_file}`) && !force) return false;
    return force || (s as Simulation & { poster_url?: string | null }).poster_url == null;
  });
}

export function __resetBannerSweepForTests(): void { attempted.clear(); }

export interface BannerSweepOptions {
  projectId: string;
  simulations: readonly Simulation[];
  aspect: SimAspectProfile;
  enabled?: boolean;
  settleMs?: number;
  maxPerSession?: number;
}

export interface BannerSweepHandle {
  state: BannerSweepState;
  /** The document to mount in the offscreen frame, or null while idle. */
  frameSrc: string | null;
  /**
   * Key the frame element by this: every simulation gets a FRESH iframe, so each one fires its own
   * `load` — an element reused across documents fires it once and the sweep would wait forever.
   */
  frameKey: string | null;
  frameRef: (el: HTMLIFrameElement | null) => void;
  onFrameLoad: () => void;
  /** Force a pass over every simulation, banner or not. */
  run: (force?: boolean) => void;
}

export function useBannerSweep(opts: BannerSweepOptions): BannerSweepHandle {
  const { projectId, simulations, aspect, enabled = true } = opts;
  const settleMs = opts.settleMs ?? BANNER_SWEEP_SETTLE_MS;
  const maxPerSession = opts.maxPerSession ?? BANNER_SWEEP_MAX_PER_SESSION;

  const [state, setState] = useState<BannerSweepState>(IDLE);
  const queue = useRef<Simulation[]>([]);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const loadedFor = useRef<string | null>(null);
  const busy = useRef(false);
  const doneThisSession = useRef(0);
  const simsRef = useRef(simulations);
  simsRef.current = simulations;

  const frameRef = useCallback((el: HTMLIFrameElement | null) => { frame.current = el; }, []);

  const next = useCallback(() => {
    const sim = queue.current.shift() ?? null;
    loadedFor.current = null;
    setState((s) => ({ ...s, running: sim !== null, active: sim, queued: queue.current.length }));
  }, []);

  /** Capture the active simulation once its frame has loaded and settled. */
  const captureActive = useCallback(async (sim: Simulation) => {
    const iframe = frame.current;
    attempted.add(`${sim.id}|${sim.entry_file}`);
    let session: Awaited<ReturnType<typeof connectSimAuthoring>> | null = null;
    try {
      if (!iframe) throw new Error('no frame');
      session = await connectSimAuthoring(iframe, { timeoutMs: 2500 });
      const raw = await session.snapshot(4000);
      const renditions = await renderPosterRenditions(raw, aspect);
      const result = await api.uploadSimulationPoster(projectId, sim.id, {
        renditions: renditions.map((r) => ({ size: r.size, format: 'png' as const, dataUrl: r.dataUrl })),
        force: true,
      });
      setState((s) => (result.outcome === 'existed' ? { ...s, existed: s.existed + 1 } : { ...s, stored: s.stored + 1 }));
    } catch (err) {
      // A document that cannot draw itself, a package without the authoring hook, a refused
      // upload: counted and shown, never retried here, never allowed to interrupt editing.
      if (process.env.NODE_ENV !== 'production') console.warn('[banner sweep] capture failed', sim.id, err);
      setState((s) => ({ ...s, failed: s.failed + 1 }));
    } finally {
      try { session?.dispose(); } catch { /* already gone */ }
      doneThisSession.current += 1;
      busy.current = false;
      next();
    }
  }, [aspect, next, projectId]);

  const onFrameLoad = useCallback(() => {
    const sim = state.active;
    if (!sim || busy.current || loadedFor.current === sim.id) return;
    loadedFor.current = sim.id;
    busy.current = true;
    window.setTimeout(() => { void captureActive(sim); }, settleMs);
  }, [captureActive, settleMs, state.active]);

  const run = useCallback((force = false) => {
    if (!enabled) return;
    const room = force ? Number.POSITIVE_INFINITY : Math.max(0, maxPerSession - doneThisSession.current);
    const wanted = bannersNeeded(simsRef.current, force).slice(0, room);
    if (wanted.length === 0) return;
    const activeId = state.active?.id;
    for (const sim of wanted) {
      if (sim.id === activeId || queue.current.some((q) => q.id === sim.id)) continue;
      queue.current.push(sim);
    }
    if (!state.running && queue.current.length > 0) next();
    else setState((s) => ({ ...s, queued: queue.current.length }));
  }, [enabled, maxPerSession, next, state.active?.id, state.running]);

  // Automatic: whenever the listing changes, whatever has no banner joins the queue.
  useEffect(() => {
    if (!enabled) return;
    run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, simulations]);

  const active = state.active;
  return {
    state,
    frameSrc: active ? active.entry_file : null,
    frameKey: active ? active.id : null,
    frameRef,
    onFrameLoad,
    run,
  };
}
