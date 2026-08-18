'use client';

import { simTelemetry } from '../../lib/simTelemetry';

/**
 * THE CLIENT HALF OF THE AVATAR START TRACE (anam-latency-001).
 *
 * The backend already emits phase timings for POST /api/v1/avatar/start and returns a
 * `correlationId` (services/avatar/startTelemetry.ts). Nothing in client-web read it:
 * `performance.mark`, `performance.now` and `sendBeacon` all returned zero hits under
 * components/avatar. So the entire span a viewer actually experiences — click, token,
 * SDK chunk, vendor session, first visible frame — was dark, and every millisecond
 * figure attached to it, in this audit included, was a reasoned estimate.
 *
 * WHAT THIS IS AND IS NOT. It makes the span MEASURABLE; it does not make it
 * COLLECTED. Two sinks, both already present, neither of them new:
 *
 *   - performance.mark / performance.measure, always on. Sub-microsecond, synchronous,
 *     no network, no vendor. It puts the phases in DevTools' timeline for anyone
 *     debugging a slow open, and it is the one primitive a future RUM collector can
 *     read with a PerformanceObserver without this file changing at all.
 *   - lib/simTelemetry, the sim subsystem's existing RUM channel, gated on ?simdebug=1.
 *     Structured, in-memory, exportable via window.__SIM_TELEMETRY__.export().
 *
 * Field aggregation would need a network call, which the brief forbids on this path and
 * which would need a collector decision this file should not be making. So: shipping
 * this does NOT turn the estimates into field data. It turns them into something one
 * `?simdebug=1` reload can settle.
 *
 * EVERY CALL IS BEST-EFFORT. Reporting is synchronous, awaits nothing, and each sink is
 * wrapped so a throw — a locked-down User Timing API, a sink that was monkey-patched by
 * an extension — cannot reach the connect. Instrumentation that can break playback is
 * worse than no instrumentation.
 */

export type ConnectPhase =
  /** The popup opened: t0, the first instant the viewer is waiting. */
  | 'popup-open'
  /** POST /api/v1/avatar/start came back; from here on every event carries its cid. */
  | 'token'
  /** The lazy @anam-ai/js-sdk chunk resolved. */
  | 'sdk-loaded'
  /** The best-effort element prime finished (or hit its bound). */
  | 'primed'
  /** streamToVideoElement was called — everything after this is vendor time. */
  | 'connect-started'
  /** The SDK's promise settled: a session exists and streaming was started. */
  | 'connect-settled'
  /** A frame was demonstrably presented. This is the number that matters. */
  | 'first-frame'
  | 'connect-failed'
  | 'watchdog';

export interface ConnectTrace {
  /** Record a phase. First occurrence wins; later duplicates are ignored. */
  mark(phase: ConnectPhase, data?: Record<string, unknown>): void;
  /** Attach the backend's correlationId so the two halves of the trace join. */
  join(correlationId: string | undefined): void;
  /** Phase offsets in ms from popup-open. For tests and for the debug export. */
  phases(): Record<string, number>;
}

function now(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
  } catch { /* fall through */ }
  return Date.now();
}

function safe(fn: () => void): void {
  try { fn(); } catch { /* a report must never be able to break the thing it reports on */ }
}

const MARK = (phase: ConnectPhase) => `anam:${phase}`;

export function beginConnectTrace(): ConnectTrace {
  const t0 = now();
  const offsets: Record<string, number> = {};
  const seen = new Set<ConnectPhase>();
  let cid: string | undefined;

  return {
    join(correlationId) {
      if (typeof correlationId === 'string' && correlationId.length > 0 && correlationId.length <= 64) cid = correlationId;
    },
    mark(phase, data) {
      if (seen.has(phase)) return;
      seen.add(phase);
      const sinceOpenMs = Math.max(0, Math.round(now() - t0));
      offsets[phase] = sinceOpenMs;
      const payload = { cid, sinceOpenMs, ...data };
      safe(() => { performance.mark(MARK(phase), { detail: payload }); });
      // The single number the whole audit is about, as a first-class measure.
      if (phase === 'first-frame' && seen.has('popup-open')) {
        safe(() => { performance.measure('anam:click-to-first-frame', MARK('popup-open'), MARK('first-frame')); });
      }
      safe(() => { simTelemetry(`avatar-${phase}`, payload); });
    },
    phases() {
      return { ...offsets };
    },
  };
}
