'use client';

import { useRef, useEffect, useState, useMemo } from 'react';
import { injectViewportFill } from './injectViewportFill';
import { resolveSimUrl } from '../../lib/simUrl';
import { SIM_READY, STOP_SCRIPT, asInbound } from '../../lib/sim/protocol';

interface Props {
  html?: string;
  src?: string;
  caption: string;
  visible: boolean;
  onDismiss: () => void;
}

// Ported from darwin-avatar/client/src/components/SimulationOverlay.tsx
export function SimulationOverlay({ html, src, caption, visible, onDismiss }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);

  const processedHtml = useMemo(() => (html ? injectViewportFill(html) : ''), [html]);
  const simKey = src ?? processedHtml;

  useEffect(() => {
    setLoading(true);
    const handler = (e: MessageEvent) => {
      // Only THIS overlay's frame may clear its spinner: the pooled viewer hosts simulations at
      // the same time, and an unscoped listener answers their handshakes as if they were ours.
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (asInbound(e.data)?.type === SIM_READY) setLoading(false);
    };
    window.addEventListener('message', handler);
    const fallback = setTimeout(() => setLoading(false), 8000);
    return () => { window.removeEventListener('message', handler); clearTimeout(fallback); };
  }, [simKey]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [visible, onDismiss]);

  useEffect(() => () => {
    try {
      const frame = iframeRef.current;
      if (!frame?.contentWindow) return;
      // Target the iframe's real origin for a cross-origin (src) sim; srcDoc iframes are opaque
      // ('null' origin) so they still need '*' (frontend-011).
      let targetOrigin = '*';
      try { if (frame.src) targetOrigin = new URL(frame.src).origin; } catch { /* opaque → '*' */ }
      frame.contentWindow.postMessage({ type: STOP_SCRIPT }, targetOrigin);
    } catch { /* noop */ }
  }, []);

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
        {src ? (
          // resolveSimUrl rebases /sim-public/ URLs onto THIS environment's API origin: a stored
          // sim_entry_url minted under another origin (a row promoted from staging, or any row
          // predating an API domain change) is otherwise blocked outright by the frame-src CSP
          // in the end user's browser — this is a shipping viewer surface (audited).
          <iframe ref={iframeRef} src={resolveSimUrl(src)} title="Interactive simulation" sandbox="allow-scripts allow-same-origin" className="avatar-simulation-overlay__iframe" style={{ opacity: loading ? 0 : 1 }} />
        ) : processedHtml ? (
          <iframe ref={iframeRef} srcDoc={processedHtml} title="Interactive simulation" sandbox="allow-scripts" className="avatar-simulation-overlay__iframe" style={{ opacity: loading ? 0 : 1 }} />
        ) : null}
      </div>
    </div>
  );
}
