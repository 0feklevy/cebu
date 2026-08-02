'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { injectViewportFill } from './injectViewportFill';
import { SimSurface } from '../../lib/sim/SimSurface';
import { useSimRuntime } from '../../lib/sim/useSimRuntime';

interface Props {
  html?: string;
  src?: string;
  caption: string;
  visible: boolean;
  onDismiss: () => void;
}

// Ported from darwin-avatar/client/src/components/SimulationOverlay.tsx
export function SimulationOverlay({ html, src, caption, visible, onDismiss }: Props) {
  const processedHtml = useMemo(() => (html ? injectViewportFill(html) : ''), [html]);
  // Identity of the hosted document — a change means a genuinely new document, which is exactly
  // what the runtime keys its per-document state on.
  const simKey = src ?? processedHtml;

  // The shared runtime owns readiness, the reveal decision, disposal and listener cleanup. This
  // surface previously kept its own SIM_READY listener plus an 8s reveal fallback, and posted its
  // own teardown on unmount — four separate re-implementations of rules that now live in one place.
  const { state, runtime, frameRef, onFrameLoad } = useSimRuntime(simKey || null);

  // Drive the document to readiness and arm the bounded ceiling. This overlay has no section to
  // apply — the generated document IS the content — so it reveals on paint (or at the ceiling for
  // a package that can never ack one), never on a blind timer.
  useEffect(() => {
    if (!simKey) return;
    runtime.startPaintRecovery({ legacyCeilingMs: 8_000 });
  }, [runtime, simKey]);

  // Re-arm after the document's own `load`. handleFrameLoad bumps the runtime generation, which
  // silently aborts a ceiling armed before it — and clears neither the ceiling nor the poll, so
  // the failure is invisible: a package that never emits SIM_PAINTED stays behind the spinner
  // forever. Every other surface re-arms on load; this one did not (audited).
  const armRecovery = useCallback(() => {
    onFrameLoad();
    runtime.startPaintRecovery({ legacyCeilingMs: 8_000 });
  }, [onFrameLoad, runtime]);

  // Tear the script down when the overlay closes. This surface never calls activate(), so
  // `state.currentScript` is permanently null — guarding on it made this dead code and left a
  // dismissed simulation running, animating and audible, because the modal's root element stays
  // mounted (visibility is a CSS class) so dispose() never runs either (audited).
  useEffect(() => {
    if (visible) return;
    runtime.stopNow();
    runtime.suspend();     // freeze + mute: stopScript alone does not silence a running scene
  }, [visible, runtime]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onDismiss]);

  // Until the document has painted, the spinner covers it (the runtime reports the paint).
  const loading = !state.visible;

  return (
    <div
      className={`avatar-simulation-overlay${visible ? ' avatar-simulation-overlay--visible' : ''}`}
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
    >
      <div className="avatar-simulation-overlay__panel">
        {caption && <div className="avatar-simulation-overlay__caption-pill">{caption}</div>}
        <button className="avatar-simulation-overlay__close" onClick={onDismiss} aria-label="Close">✕</button>
        {loading && (
          <div className="avatar-simulation-overlay__loading">
            <div className="avatar-sim-spinner" />
            <span>{src ? 'Loading simulation…' : 'Generating simulation…'}</span>
          </div>
        )}
        {/*
          SimSurface applies the origin rebase (a stored sim_entry_url minted under another origin
          is otherwise blocked outright by the frame-src CSP), the boot-hide fragment, and the
          hidden-frame accessibility state this surface never had.
          srcDoc covers the generated-on-the-fly case: that document has an opaque origin.
        */}
        <SimSurface
          src={src ?? null}
          srcDoc={src ? null : (processedHtml || null)}
          visible={state.visible}
          frameRef={frameRef}
          onLoad={armRecovery}
          sandbox={src ? 'allow-scripts allow-same-origin' : 'allow-scripts'}
          className="avatar-simulation-overlay__iframe"
        />
      </div>
    </div>
  );
}
