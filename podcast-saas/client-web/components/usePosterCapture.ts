'use client';

/**
 * Posters captured in the creator's own browser (night run 2026-09-03 §6).
 *
 * WHY HERE. Production has never generated a simulation poster: the only capture path was an
 * operator script, the worker image has no browser, and the export design deliberately runs
 * untrusted simulation code only inside an isolated container on another host. But the editor
 * already renders the simulation, live, on a machine that can draw — the creator's. So when the
 * preview has painted, the editor asks the document (over the authoring channel) for its picture,
 * letterboxes it into the poster sizes, and files it under the identity the player will look up.
 * The server derives that identity from the section row; the client never names a key.
 *
 * Once per section+document per editor session, a second after the frame loads, and never for a
 * document that cannot answer (a pre-authoring package, a tainted canvas): the banner stays what
 * it was. "Refresh banner" forces a new capture.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { connectSimAuthoring } from '@/lib/sim/SimAuthoringClient';
import { renderPosterRenditions } from '@/lib/posterCapture';
import type { SimAspectProfile } from 'shared/src/sim/simIdentity';

/** Section+document pairs already captured this session — a re-open must not re-upload. */
const captured = new Set<string>();

export interface PosterCaptureOptions {
  projectId: string;
  sectionId: string | null | undefined;
  /** The document being previewed; a change is a new picture. */
  simulationUrl: string | null | undefined;
  /** The frame element, once the preview has loaded. */
  frame: () => HTMLIFrameElement | null;
  /** True once the preview reports it loaded. */
  loaded: boolean;
  aspect: SimAspectProfile;
  enabled?: boolean;
}

export type PosterCaptureState = 'idle' | 'capturing' | 'stored' | 'existed' | 'failed';

export function usePosterCapture(opts: PosterCaptureOptions): { state: PosterCaptureState; refresh: () => void } {
  const [state, setState] = useState<PosterCaptureState>('idle');
  const inFlight = useRef(false);

  const capture = useCallback(async (force: boolean) => {
    const iframe = opts.frame();
    if (!opts.sectionId || !opts.simulationUrl || !iframe || inFlight.current) return;
    const key = `${opts.sectionId}|${opts.simulationUrl}`;
    if (!force && captured.has(key)) return;
    inFlight.current = true;
    setState('capturing');
    let session: Awaited<ReturnType<typeof connectSimAuthoring>> | null = null;
    try {
      session = await connectSimAuthoring(iframe, { timeoutMs: 2500 });
      const raw = await session.snapshot(4000);
      const renditions = await renderPosterRenditions(raw, opts.aspect);
      const result = await api.uploadSectionPoster(opts.projectId, opts.sectionId, {
        renditions: renditions.map((r) => ({ size: r.size, format: 'png' as const, dataUrl: r.dataUrl })),
        force,
      });
      captured.add(key);
      setState(result.outcome);
    } catch {
      // A document that cannot draw itself, a tainted canvas, or a refused upload: the banner the
      // tile had stays. Nothing here may interrupt editing.
      setState('failed');
    } finally {
      try { session?.dispose(); } catch { /* already gone */ }
      inFlight.current = false;
    }
  }, [opts]);

  // Automatic, once, a moment after the preview loads — the sim needs a frame or two to draw.
  useEffect(() => {
    if (opts.enabled === false || !opts.loaded || !opts.sectionId || !opts.simulationUrl) return;
    if (captured.has(`${opts.sectionId}|${opts.simulationUrl}`)) return;
    const t = window.setTimeout(() => void capture(false), 1500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, opts.loaded, opts.sectionId, opts.simulationUrl]);

  const refresh = useCallback(() => { void capture(true); }, [capture]);
  return { state, refresh };
}
