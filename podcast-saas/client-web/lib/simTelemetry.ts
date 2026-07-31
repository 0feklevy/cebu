// Dev-only sim-lifecycle telemetry, explicitly gated behind ?simdebug=1 — never active for
// ordinary viewers. Records timestamped pool/reveal events so transition performance can be
// measured and exported as JSON (window.__SIM_TELEMETRY__.export()) instead of eyeballed.
//
// Events used by the player: pool-spec-add / pool-spec-evict, frame-register, frame-load,
// sim-ready (with dispatch capability), sim-painted, activate (path taken), reveal,
// hold-expired, stall, navigate (legacy src change), reset (back-to-video), warm-begin/end.

interface SimTelemetryEvent { t: number; event: string; [key: string]: unknown }

interface SimTelemetryApi {
  events: SimTelemetryEvent[];
  export: () => string;
  clear: () => void;
}

declare global {
  interface Window { __SIM_TELEMETRY__?: SimTelemetryApi }
}

let enabled: boolean | null = null;

function isEnabled(): boolean {
  if (enabled !== null) return enabled;
  if (typeof window === 'undefined') return false;
  enabled = /[?&]simdebug=1/.test(window.location.search);
  if (enabled && !window.__SIM_TELEMETRY__) {
    const events: SimTelemetryEvent[] = [];
    window.__SIM_TELEMETRY__ = {
      events,
      export: () => JSON.stringify({ exportedAt: new Date().toISOString(), origin: window.location.href, events }, null, 2),
      clear: () => { events.length = 0; },
    };
  }
  return enabled;
}

/** Record one telemetry event (no-op unless ?simdebug=1). Keep payloads small + serializable. */
export function simTelemetry(event: string, data?: Record<string, unknown>): void {
  if (!isEnabled()) return;
  const list = window.__SIM_TELEMETRY__!.events;
  if (list.length >= 5000) return;   // hard cap — never grow unbounded
  list.push({ t: Math.round(performance.now()), event, ...data });
}
