/**
 * The managed section lifecycle contract (Priority 6.1) — the shape a simulation section may
 * implement instead of returning a cleanup function.
 *
 * WHAT THE CLEANUP FUNCTION COULD NOT EXPRESS
 * A generated section body used to return one `cancel()` closure. That single hook has to stand in
 * for every question the player needs answered, and it can answer none of them:
 *
 *   "has your first frame been submitted?"     — a cleanup function cannot say
 *   "stop automating but keep the scene"       — cleanup tears the scene down
 *   "go quiescent, you are off screen"         — cleanup is the only lever, so the choice is
 *                                                 between burning a GPU in the background and
 *                                                 destroying state the user will come back to
 *   "release your GPU memory"                  — removing a mesh does not, and cleanup rarely did
 *   "you are muted now"                        — nothing to call
 *
 * Every one of those questions had, at some point, been answered by the player GUESSING — a timer,
 * a paint heuristic, a blanket `simPause`. This interface replaces the guesses with a contract.
 *
 * COMPATIBILITY IS EXPLICIT, NOT IMPLIED
 * A body that still returns a cleanup function is WRAPPED (see `wrapLegacyCleanup` in the child
 * runtime) and classified `legacy-*`. It is never described as managed. The wrapper implements
 * `dispose` from the cleanup function and declines every other capability, which is the honest
 * report: that body genuinely cannot suspend, cannot render on demand, and cannot prove a
 * presentation.
 */

import type { SimPresentationConfig, SimQualityProfile, VariantKey } from './simIdentity.js';
import type { SimResourceCounts } from './runtimeProtocol.js';

export interface PrepareContext {
  variantKey: VariantKey;
  config: SimPresentationConfig;
  /** The managed scope this section must allocate through. Anything else leaks. */
  scope: ManagedScopeHandle;
  /** Aborted when the activation is superseded or released — pass to fetch, await, etc. */
  signal: AbortSignal;
}

export interface PresentContext {
  variantKey: VariantKey;
  config: SimPresentationConfig;
  scope: ManagedScopeHandle;
  signal: AbortSignal;
  /**
   * The section MUST call this exactly once, after it has submitted a real render of the prepared
   * state. It is what becomes `SECTION_PRESENTED`, so calling it early is not a shortcut — it is
   * the reintroduction of the unverified reveal.
   */
  markPresented(info?: { canvas?: { width: number; height: number } | null }): void;
}

export interface ActivationContext {
  variantKey: VariantKey;
  config: SimPresentationConfig;
  scope: ManagedScopeHandle;
  signal: AbortSignal;
  /** Whether the section's own automation should run. Mirrors config.autoScript. */
  autoScript: boolean;
}

export interface AudibleState {
  muted: boolean;
  /** 0..1 */
  volume: number;
}

/**
 * Every hook except `present` and `dispose` is optional, and the child runtime reports exactly
 * which ones exist as capabilities. A section implementing only `present`/`dispose` is
 * `managed-partial`, honestly.
 */
export interface ManagedSectionLifecycle {
  /** Resolved when the section's assets/shaders are loaded. Awaited before `prepare`. */
  ready?: Promise<void>;
  /** Install state and UI WHILE COVERED. Must not start public animation or audio. */
  prepare?(ctx: PrepareContext): void | Promise<void>;
  /** Submit the first target render and call `markPresented`. Required. */
  present(ctx: PresentContext): void | Promise<void>;
  /** Start public animation, automation, audio, interaction. */
  activate?(ctx: ActivationContext): void | Promise<void>;
  /** Stop automation WITHOUT tearing the scene down. */
  pauseAuto?(): void | Promise<void>;
  resumeAuto?(): void | Promise<void>;
  setAudible?(state: AudibleState): void | Promise<void>;
  setQuality?(profile: SimQualityProfile): void | Promise<void>;
  /** Go quiescent: no rAF, no timers, no audio, no worker traffic. Scene state preserved. */
  suspend?(): void | Promise<void>;
  /** Release SECTION-owned resources; keep document-owned ones (renderer, loaded assets). */
  release?(): void | Promise<void>;
  /** Release everything. Required. */
  dispose(): void | Promise<void>;
}

/**
 * The subset of the managed scope a SECTION sees. The full scope (with pause/resume/dispose) is
 * owned by the runtime — a section that could dispose its own scope could strand the runtime's
 * bookkeeping, so the capability is simply not handed out.
 */
export interface ManagedScopeHandle {
  requestAnimationFrame(cb: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  setTimeout(fn: () => void, ms?: number, ...args: unknown[]): number;
  clearTimeout(handle: number): void;
  setInterval(fn: () => void, ms?: number, ...args: unknown[]): number;
  clearInterval(handle: number): void;
  addEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  /** A controller aborted with the activation. */
  abortController(): AbortController;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  createObjectURL(obj: Blob): string;
  revokeObjectURL(url: string): void;
  /**
   * Register a resource the scope cannot see itself — a Three.js renderer, an AudioContext, a
   * Worker created by a library, an observer. `kind` must be a key of SimResourceCounts so the
   * counters and the leak report stay in agreement.
   */
  track<T>(kind: ManagedResourceKind, resource: T, dispose: (r: T) => void): T;
  /** Mark a resource released early. Idempotent. */
  untrack(resource: unknown): void;
  /**
   * Declare that this section's automation is THIS handle — the only thing `pauseAuto` stops.
   * Attribution must be explicit: guessing which timers are "automation" and which are the
   * engine's own loop froze simulations (audited), so an unregistered timer is deliberately left
   * running rather than stopped on a hunch.
   */
  registerAutomation(handle: number, kind: 'timeout' | 'interval' | 'raf'): number;
}

export type ManagedResourceKind = keyof SimResourceCounts;

/** Everything a scope reports about itself. */
export interface ManagedScopeReport {
  counts: SimResourceCounts;
  /** Human-readable descriptions of resources still alive after a dispose. */
  leaked: string[];
  /** Things the scope was asked to stop and could not. */
  unstoppable: string[];
}

/**
 * Resource plateaus for the leak tests (Priority 6.7).
 *
 * A plateau is NOT zero. Repeating an A → B → A cycle a hundred times legitimately leaves the
 * document with its renderer, its loaded textures and its resident listeners — those are
 * DOCUMENT-owned and releasing them per activation would defeat the entire point of the resident
 * pool. What must not grow is the per-ACTIVATION set. So the test asserts a ceiling that is a
 * small constant above the steady state, and fails on any upward trend across the run.
 */
export interface ResourcePlateau {
  /** Maximum live count after any cycle, once warm. */
  max: number;
  /** Maximum growth between cycle 10 and cycle N. Zero means strictly flat. */
  maxDrift: number;
}

export const DEFAULT_PLATEAUS: Readonly<Partial<Record<ManagedResourceKind, ResourcePlateau>>> = {
  // Per-activation resources must return exactly to their steady state.
  rafCallbacks: { max: 4, maxDrift: 0 },
  timeouts: { max: 8, maxDrift: 0 },
  intervals: { max: 4, maxDrift: 0 },
  abortControllers: { max: 4, maxDrift: 0 },
  animations: { max: 8, maxDrift: 0 },
  objectUrls: { max: 2, maxDrift: 0 },
  imageBitmaps: { max: 2, maxDrift: 0 },
  workers: { max: 2, maxDrift: 0 },
  ports: { max: 4, maxDrift: 0 },
  audioContexts: { max: 1, maxDrift: 0 },
  // Listeners and observers have a document-owned baseline; the drift bound is what matters.
  listeners: { max: 64, maxDrift: 0 },
  observers: { max: 8, maxDrift: 0 },
  // GPU resources are document-owned and shared across sections of one package. A small ceiling
  // would be wrong; a flat drift is the real requirement.
  glRenderers: { max: 2, maxDrift: 0 },
  glGeometries: { max: 512, maxDrift: 0 },
  glMaterials: { max: 512, maxDrift: 0 },
  glTextures: { max: 256, maxDrift: 0 },
  glRenderTargets: { max: 32, maxDrift: 0 },
  glPrograms: { max: 128, maxDrift: 0 },
  mediaElements: { max: 8, maxDrift: 0 },
  audioNodes: { max: 64, maxDrift: 0 },
};

export interface LeakVerdict {
  kind: ManagedResourceKind;
  ok: boolean;
  observedMax: number;
  observedDrift: number;
  plateau: ResourcePlateau;
}

/**
 * Judge a series of per-cycle counts.
 *
 * `warmupCycles` samples are ignored on purpose: the first activations legitimately allocate the
 * document-owned baseline (renderer, shared geometry, the audio graph), and counting those as
 * growth would make every healthy package fail.
 */
export function judgeLeak(
  kind: ManagedResourceKind,
  perCycleCounts: readonly number[],
  plateau: ResourcePlateau,
  warmupCycles = 10,
): LeakVerdict {
  const warm = perCycleCounts.slice(warmupCycles);
  if (warm.length === 0) {
    return { kind, ok: true, observedMax: 0, observedDrift: 0, plateau };
  }
  const observedMax = Math.max(...warm);
  const observedDrift = warm[warm.length - 1] - warm[0];
  return {
    kind,
    ok: observedMax <= plateau.max && observedDrift <= plateau.maxDrift,
    observedMax,
    observedDrift,
    plateau,
  };
}
