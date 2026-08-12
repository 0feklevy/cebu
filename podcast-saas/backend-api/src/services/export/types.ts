/**
 * Linear video export — the shared contracts (plan doc "THE DECISION", Phase 1).
 *
 * Two components build against these shapes from opposite sides:
 *   • `buildExportPlan` + `ProjectExportService` (this phase) produce an `ExportPlan`, store it in
 *     `project_exports.plan` BEFORE any work, and drive the job through its phases;
 *   • `LinearAssembler` (a sibling change owns `services/export/LinearAssembler.ts`) consumes the
 *     plan and produces the master file. Phase 1 tests stub it; the interface is defined HERE so
 *     neither side can drift from the other.
 *
 * The plan is the frozen resolution of the timeline: after the export finishes (or fails), the
 * timeline keeps being edited and the work directory is deleted, so the plan jsonb is the only
 * artefact that can answer "why does the master look like that?". Everything deliberately left
 * out — RAW simulation sections, avatar circles, captions, Ken Burns motion, poster stand-ins —
 * is recorded in `warnings`, never silently absent.
 */

// ── Grid ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The canonical grid every branch of the filter graph is normalised onto.
 *
 * Fixed at 1920×1080@30 by the user ruling in the plan doc ("output is 1920×1080 landscape"),
 * NOT derived from the highest-resolution source — one 4K B-roll must not silently promote the
 * whole export past level 4.0. Recorded in the plan so the choice is auditable.
 */
export interface ExportGrid {
  w: number;
  h: number;
  fps: number;
}

export const EXPORT_GRID: ExportGrid = { w: 1920, h: 1080, fps: 30 };

// ── Timeline windows ──────────────────────────────────────────────────────────────────────────

/**
 * Every window is `[startSec, endSec)` in ABSOLUTE export-timeline seconds — half-open, because
 * the schema's windows are half-open and a closed interval draws two sections on the shared
 * boundary frame (the `between()` trap the plan doc measured).
 */
export interface ExportWindowBase {
  /** Absolute start on the export timeline, seconds. */
  startSec: number;
  /** Absolute end (exclusive) on the export timeline, seconds. */
  endSec: number;
  /** The timeline section this window came from; null for base main-video windows. */
  sectionId: string | null;
  label: string | null;
}

/** A stretch of a main video, played as the base layer. */
export interface VideoWindow extends ExportWindowBase {
  kind: 'video';
  videoFileId: string;
  /** The raw master's storage key — the splice reads sources, never the HLS ladder. */
  storageKey: string | null;
  /** In-point in the SOURCE file, seconds (main videos play 1:1, so this equals startSec − videoOffset). */
  sourceInSec: number;
  sourceOutSec: number;
}

/**
 * A scripted simulation section to be captured server-side (Phase 2). Carries everything the
 * capture host needs to reproduce what the viewer runs: the SERVED URL (revision pointer already
 * resolved, `?section=&v=` preserved verbatim) and the exact `startScript` params the player
 * sends. `posterKey` is the identity-matched still for the permanent fallback path — an export
 * always completes, degraded loudly in the warnings rather than failing silently.
 */
export interface SimCaptureWindow extends ExportWindowBase {
  kind: 'sim-capture';
  sectionId: string;
  simulationId: string | null;
  /** The URL the viewer would load — resolved through the revision pointer, query intact. */
  servedUrl: string | null;
  simpleUi: boolean;
  autoScript: boolean;
  /** sim_meta.uiControls.hide, exactly as the player passes hideSelectors. */
  uiHide: string[] | undefined;
  /** The presentation-config hash of exactly these params — the capture's identity axis. */
  configHash: string | null;
  /** Storage key of the identity-matched poster still, or null when none was ever captured. */
  posterKey: string | null;
}

/** A trimmed library video (clip section) or a video B-roll overlay, spliced from its source. */
export interface ClipWindow extends ExportWindowBase {
  kind: 'clip';
  sourceVideoFileId: string;
  storageKey: string | null;
  /** In-point in the source file, seconds. */
  sourceInSec: number;
  sourceOutSec: number;
  /**
   * Where the window came from: a `clip` section (segment-local timing) or a `broll` overlay
   * (global-offset timing). Same splice either way; kept so the plan stays auditable.
   */
  sourceRole: 'clip' | 'broll';
}

/** A still image section. v1 renders it static — Ken Burns motion is cut (user ruling). */
export interface ImageWindow extends ExportWindowBase {
  kind: 'image';
  imageFileId: string;
  storageKey: string;
  crop: { x: number; y: number; w: number; h: number };
}

/**
 * A simulation window resolved to its poster still + silence. The permanent fallback: before
 * Phase 2 lands this is what EVERY sim-capture window becomes, and after it lands it is what a
 * failed capture becomes. Each substitution is recorded as a warning.
 */
export interface PosterFallbackWindow extends ExportWindowBase {
  kind: 'poster-fallback';
  sectionId: string;
  /** Storage key of the still, or null — a null key renders the base video through instead. */
  posterKey: string | null;
}

export type ExportWindow =
  | VideoWindow
  | SimCaptureWindow
  | ClipWindow
  | ImageWindow
  | PosterFallbackWindow;

export type ExportWindowKind = ExportWindow['kind'];

// ── Audio windows ─────────────────────────────────────────────────────────────────────────────

/**
 * An asset with known timing on the absolute timeline — main video audio or an audio cutaway /
 * music bed. All export audio mixes from these (the `mixTimeline` discipline); nothing is
 * captured. B-roll video audio is NOT here: the viewer mutes b-roll today, and the export
 * matches the viewer rather than silently producing more audio than the product plays — recorded
 * as a warning when a b-roll section carries a non-default `broll_volume`.
 */
export interface ExportAudioWindow {
  source: 'main' | 'audio';
  sectionId: string | null;
  /** Absolute start on the export timeline, seconds. */
  globalOffsetSec: number;
  /** Source in/out, seconds. */
  sourceInSec: number;
  sourceOutSec: number;
  storageKey: string | null;
  /** Stored gain (broll_volume for cutaways, 1.0 for main audio). */
  gain: number;
}

// ── Source identity (snapshot discipline) ─────────────────────────────────────────────────────

export type ExportSourceKind = 'video' | 'audio' | 'image' | 'poster' | 'sim-revision';

/**
 * The identity of one input, FROZEN AT PLAN TIME. The plan locks what the master is made OF, not
 * just where its windows sit: the ingest step re-HEADs every mutable source and refuses
 * (`source_changed`, retryable — the user edited mid-export, a fresh attempt re-plans) on any
 * size/etag mismatch, so a master spliced from two generations of one file — a chimera nobody
 * authored — is impossible by construction.
 *
 * Sim REVISION urls are already immutable by the revision model (bytes under a revision id are
 * never rewritten), so the real exposure is raw video masters, audio assets and posters — the
 * keys "Replace"/re-upload flows overwrite in place. Those are the ones carried with size/etag.
 */
export interface ExportSourceIdentity {
  kind: ExportSourceKind;
  storageKey: string;
  /** From headObject at plan time; null when the store did not report it. */
  sizeBytes: number | null;
  etag: string | null;
  /** sim-revision sources only: the revision's manifest_hash — its own bytes-identity proof. */
  manifestHash?: string | null;
}

/**
 * Phase 2's capture-environment identity: which headless-shell image, viewport and DPR produced
 * the captured frames. Recorded so "why do these two exports differ?" stays answerable. Null in
 * Phase 1 — nothing captures yet.
 */
export interface RendererIdentity {
  imageDigest: string;
  headlessShellVersion: string;
  viewport: { w: number; h: number };
  dpr: number;
}

// ── The plan ──────────────────────────────────────────────────────────────────────────────────

/** Phase names, stored with a failure so the row can say WHERE it died. */
export type ExportPhase = 'planning' | 'capturing' | 'assembling' | 'uploading';

export interface ExportPlanFailure {
  code: string;
  retryable: boolean;
  phase: ExportPhase;
  detail: string;
}

/** The `project_exports.plan` jsonb — the contract from the plan doc, verbatim. */
export interface ExportPlan {
  projectId: string;
  grid: ExportGrid;
  /** Every resolved window, absolute times, ordered by startSec. */
  timeline: ExportWindow[];
  /** Every audio asset window. */
  audio: ExportAudioWindow[];
  /** Every input's frozen identity — see ExportSourceIdentity. */
  sources: ExportSourceIdentity[];
  /** Phase 2 fills this; Phase 1 records the honest null. */
  rendererIdentity: RendererIdentity | null;
  /** The honest record of everything deliberately not in the master. */
  warnings: string[];
  /** Sum of the referenced sources' stored byte sizes — a floor, for the disk pre-flight. */
  estimatedSourceBytes: number;
  /**
   * What the work directory needs free before starting: sources are downloaded, normalised and
   * concatenated, so the estimate is a multiple of the source floor plus fixed headroom.
   */
  requiredDiskBytes: number;
  /** Total export duration — the sum of main video durations, seconds. */
  totalDurationSec: number;
  failure?: ExportPlanFailure;
}

// ── The assembler seam ────────────────────────────────────────────────────────────────────────

/**
 * The ffmpeg half of the export — implemented by `services/export/LinearAssembler.ts` (sibling
 * change), called by `ProjectExportService.run()` in the `assembling` phase, stubbed in Phase 1
 * tests.
 *
 * Contract:
 *   • `assemble` resolves ONLY when the encode exited 0 AND the output passed the duration gate
 *     against `plan.totalDurationSec` — a SIGTERM'd encode leaves a valid, playable, truncated
 *     MP4, so "the file exists and parses" must never be the success test.
 *   • `onProgress` receives 0–100; the caller writes it to the row, so it must be cheap.
 *   • `signal` aborting means SIGTERM first, escalate after ~5s — never SIGKILL first (that
 *     leaves `moov atom not found` garbage instead of a diagnosable partial).
 *   • `masterPath` is inside `workDir`; the caller owns upload and cleanup.
 */
export interface LinearAssembler {
  assemble(
    plan: ExportPlan,
    workDir: string,
    onProgress: (pct: number) => void,
    signal: AbortSignal,
  ): Promise<{ masterPath: string }>;
}
