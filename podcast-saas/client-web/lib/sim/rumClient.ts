/**
 * RUM client transport (Priority 8.9).
 *
 * FAILURE ISOLATION IS THE WHOLE DESIGN
 * This runs inside the viewer, on the same main thread as playback. It must be impossible for it to
 * degrade what a viewer sees, so every operation is wrapped and every failure is terminal-but-quiet:
 * a transport that starts failing stops trying rather than retrying into a slow network, and any
 * throw anywhere disables collection for the rest of the session. Losing measurements is free.
 * Costing a viewer a frame is not.
 *
 * OFF UNLESS TOLD OTHERWISE
 * `create` returns a no-op recorder when the sample rate is 0, when the session loses its sampling
 * roll, or when anything about the environment is missing. The caller cannot tell the difference,
 * which is deliberate: there must be no branch in the player that behaves differently because
 * measurement is on.
 *
 * WHY sendBeacon FIRST
 * The most valuable batch is the last one, and the last one is flushed while the page is going
 * away — exactly when `fetch` is least likely to complete. `sendBeacon` is queued by the browser
 * and survives the unload; `fetch(keepalive)` is the fallback where it is unavailable.
 */

import {
  SIM_RUM_VERSION, RUM_RING_CAP, RumRing, shouldSample, normalizeSampleRate,
  bucketDevice, type RumBatch, type RumEvent, type RumDeviceProfile,
} from 'shared/src/sim/rumEvents';

export interface RumRecorder {
  /** True when this session is actually collecting. Exposed for tests, not for player branching. */
  readonly active: boolean;
  record(e: Omit<RumEvent, 't'>): void;
  /** Send whatever is buffered. Safe to call at any time, including during unload. */
  flush(reason: 'interval' | 'pagehide' | 'manual'): void;
  dispose(): void;
}

const NOOP: RumRecorder = {
  active: false,
  record: () => {},
  flush: () => {},
  dispose: () => {},
};

export interface RumOptions {
  endpoint: string;
  sampleRate: unknown;
  poolTier?: RumDeviceProfile['poolTier'];
  /** Injected for tests. Defaults to Math.random. */
  roll?: () => number;
  /** Injected for tests. Defaults to performance.now-based elapsed time. */
  now?: () => number;
  /** How often to flush while the page is alive. */
  flushIntervalMs?: number;
}

export const RUM_FLUSH_INTERVAL_MS = 30_000;
/**
 * Flush early once the ring is this full, so a long session does not lose its oldest events.
 *
 * Derived from the RING capacity, not from the batch maximum. Half the batch maximum is 250 while
 * the ring holds 200, so that threshold is UNREACHABLE: the ring would silently discard its oldest
 * events forever and the early flush would never fire — the exact failure the early flush exists to
 * prevent, hidden behind a constant that looks related but is not.
 */
export const RUM_FLUSH_AT = Math.floor(RUM_RING_CAP / 2);

export function createRumRecorder(opts: RumOptions): RumRecorder {
  const rate = normalizeSampleRate(opts.sampleRate);
  if (rate <= 0) return NOOP;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return NOOP;
  if (!opts.endpoint) return NOOP;

  const roll = opts.roll ?? Math.random;
  // ONE coin flip for the whole session. Deciding per event would produce a sample where some
  // sessions contributed their fast transitions and not their slow ones, and no percentile computed
  // from that means anything.
  if (!shouldSample(rate, roll())) return NOOP;

  let sessionId: string;
  try {
    sessionId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `s-${Math.floor(roll() * 1e16).toString(36)}${Date.now().toString(36)}`;
  } catch {
    return NOOP;
  }
  // Never persisted — no localStorage, no cookie — so it cannot link two visits by one person.

  const t0 = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now() : Date.now();
  const now = opts.now ?? (() => (typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now()) - t0);

  const device = collectDevice(opts.poolTier ?? null);
  const ring = new RumRing();
  let disabled = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Any failure disables collection for the session.
   *
   * Not a retry, deliberately. A transport that retries into a failing network competes with video
   * segment fetches for connections at exactly the moment the viewer can least afford it — and the
   * thing being retried is a measurement nobody is waiting for.
   */
  const disable = (): void => {
    disabled = true;
    if (timer !== null) { clearInterval(timer); timer = null; }
    ring.drain();
  };

  const send = (batch: RumBatch): void => {
    const body = JSON.stringify(batch);
    try {
      if (typeof navigator.sendBeacon === 'function') {
        // NOTE ON CREDENTIALS: sendBeacon's credentials mode is `include` and cannot be changed, so
        // a beacon to a same-site endpoint carries the viewer's cookies. That is a property of the
        // API, not a choice made here, and it is why the server stores nothing derived from the
        // request identity — no user id, no IP, no session linkage. The `credentials: 'omit'` on the
        // fetch fallback below is therefore a floor, not a guarantee that covers both paths.
        //
        // A `false` return means the browser refused to queue it — usually the payload exceeded its
        // beacon budget. Falling through to fetch would send it twice on some browsers, so the
        // batch is dropped instead: a duplicated measurement is worse than a missing one, because
        // it silently biases a percentile.
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(opts.endpoint, blob)) return;
        return;
      }
      void fetch(opts.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
        // Measurement must never carry ambient authority.
        credentials: 'omit',
        mode: 'cors',
      }).catch(() => disable());
    } catch {
      // Layered with the catch in `flush`, which is this function's only caller. A mutation removing
      // THIS catch survives the suite for that reason — recorded as an equivalent mutant rather than
      // pretended otherwise, and kept because the disable point is more precise here and because
      // deleting error handling to raise a mutation score optimises the wrong thing.
      disable();
    }
  };

  const flush = (_reason: 'interval' | 'pagehide' | 'manual'): void => {
    if (disabled) return;
    try {
      const { events, dropped } = ring.drain();
      if (events.length === 0) return;
      send({ v: SIM_RUM_VERSION, sessionId, device, events, dropped });
    } catch {
      disable();
    }
  };

  const record = (e: Omit<RumEvent, 't'>): void => {
    if (disabled) return;
    try {
      ring.push({ ...e, t: Math.max(0, Math.round(now())) } as RumEvent);
      if (ring.size >= RUM_FLUSH_AT) flush('interval');
    } catch {
      disable();
    }
  };

  const onHide = (): void => flush('pagehide');
  // NAMED, so it can actually be removed. An anonymous listener here leaked on every mount: this
  // viewer mounts and unmounts per navigation, so each disposed recorder kept a closure over its
  // ring alive for the lifetime of the document.
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flush('pagehide');
  };
  try {
    // `pagehide` and not `unload`: `unload` is not fired on mobile Safari and blocks the bfcache
    // everywhere else, which would make measurement cost the viewer a fast back-navigation.
    window.addEventListener('pagehide', onHide);
    window.addEventListener('visibilitychange', onVisibility);
    timer = setInterval(() => flush('interval'), opts.flushIntervalMs ?? RUM_FLUSH_INTERVAL_MS);
  } catch {
    return NOOP;
  }

  return {
    get active() { return !disabled; },
    record,
    flush,
    dispose() {
      try {
        flush('manual');
        window.removeEventListener('pagehide', onHide);
        window.removeEventListener('visibilitychange', onVisibility);
      } catch { /* disposal must never throw into the caller's unmount path */ }
      if (timer !== null) { clearInterval(timer); timer = null; }
      // A disposed recorder is DONE. Without this a later record() still buffered into a ring
      // nothing would ever flush, and a stray flush could still send after the timer was gone.
      disabled = true;
    },
  };
}

/** Coarse, non-identifying device signals. Every one already exists elsewhere in the client. */
function collectDevice(poolTier: RumDeviceProfile['poolTier']): RumDeviceProfile {
  const nav = navigator as Navigator & {
    deviceMemory?: number; connection?: { saveData?: boolean };
  };
  let coarsePointer: boolean | null;
  try {
    coarsePointer = typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches : null;
  } catch {
    // An unknown signal is null, never a guess: `false` here would claim a desktop pointer on a
    // device we could not probe, and every duration is read against these buckets.
    coarsePointer = null;
  }

  return bucketDevice({
    deviceMemory: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
    coarsePointer,
    saveData: typeof nav.connection?.saveData === 'boolean' ? nav.connection.saveData : null,
    dpr: typeof window.devicePixelRatio === 'number' ? window.devicePixelRatio : null,
    poolTier,
  });
}
