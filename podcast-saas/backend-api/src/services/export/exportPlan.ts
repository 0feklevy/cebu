/**
 * buildExportPlan — pure planning for the linear video export (plan doc "THE DECISION", Phase 1).
 *
 * Reads the project once and resolves the timeline EXACTLY as `buildPlayerConfig` does, because
 * the export's one promise is "what a viewer sees is what is exported":
 *
 *   • main segments ordered by `created_at ASC`, global offsets by cumulative `duration_sec`;
 *   • the two time conventions, verbatim: a `main`-track section's `start_sec` is SEGMENT-LOCAL
 *     (absolute = the segment's offset + start_sec); `broll`/`audio` sections carry their own
 *     `global_offset_sec` and use `start_sec`/`end_sec` as the SOURCE in/out points;
 *   • the exclusion predicate is THE predicate from the plan doc — the same expression the player
 *     computes at `useProjectPlayer.ts:1936` and calls RAW activation. Both of its halves import
 *     from shared (`variantParamOf`) so the two surfaces cannot drift.
 *
 * NO SIDE EFFECTS: this module reads the database and mints nothing. The service stores the
 * result in `project_exports.plan` before any work starts; every deliberate omission is a
 * `warnings` entry, never a silent absence.
 */

import { asc, eq, inArray } from 'drizzle-orm';

import { db } from '../../db/index.js';
import {
  audio_files, branch_sequences, image_files, projects, sim_posters, sim_revisions, simulations,
  timeline_sections, video_files,
} from '../../db/schema.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { logger } from '../../lib/logger.js';
import { resolveSimulationUrl } from '../simulation/simulationUrlResolver.js';
import { packageRevisionFor } from 'shared/sim/simRevision';
import {
  DEFAULT_PRESENTATION_CONFIG, computeConfigHash, derivePackageRevision, variantKeyFor,
  variantParamOf,
} from 'shared/sim/simIdentity';
import {
  parsePosterVariants, posterIdentityString, selectPosterVariant,
  type PosterFormat, type PosterKey,
} from 'shared/sim/posterIdentity';

import {
  EXPORT_GRID,
  type ClipWindow, type ExportAudioWindow, type ExportPlan, type ExportSourceIdentity,
  type ExportWindow, type ImageWindow, type PosterFallbackWindow, type SimCaptureWindow,
  type VideoWindow,
} from './types.js';

// ── Refusal ───────────────────────────────────────────────────────────────────────────────────

/**
 * An export that cannot proceed for a reason the caller should see, not a 500.
 *
 * The `DuplicationRefused` shape, deliberately (see `classifyExportFailure`, which mirrors
 * `classifyDuplicationFailure` — one convention, not two). `retryable` means ONE thing: the
 * identical attempt, with nothing changed, could succeed. A branching project is `false` —
 * pressing the same button again cannot help; the project has to change first.
 */
/**
 * Admission control for the capture phase — the arithmetic that says whether a job CAN finish.
 *
 * Capture cost is measured, not guessed: on the reference 2-vCPU worker one frame of a real
 * simulation costs about 5.4 s at 640×360 and about 16 s at 1920×1080, of which ~97 % is SwiftShader
 * software rasterisation. Against a per-section budget of `min(600, 90 + 6·durationSec)` that means
 * a ten-second 1080p window needs roughly 83 minutes and gets 150 seconds.
 *
 * Enqueueing such a job is not optimism, it is a promise the system cannot keep: it occupies the
 * worker for the full budget, is killed, and — under the strict policy — fails. Rejecting it at the
 * door with a truthful reason is strictly kinder than failing it an hour later, and it is the only
 * thing that keeps one impossible project from starving every other tenant's queue.
 *
 * These are deliberately generous ceilings, not the measured cost: the point is to refuse the
 * absurd, not to predict the achievable. The real per-section wall clock still governs each capture.
 */
export const MAX_SIM_WINDOWS_PER_EXPORT = Number(process.env.EXPORT_MAX_SIM_WINDOWS ?? '12');
/** Longest single simulation window the server will admit, whatever the UI allows. */
export const MAX_SIM_WINDOW_SEC = Number(process.env.EXPORT_MAX_SIM_WINDOW_SEC ?? '15');
/** Total captured frames across the whole export. */
export const MAX_TOTAL_CAPTURE_FRAMES = Number(process.env.EXPORT_MAX_TOTAL_FRAMES ?? '2700');

export interface AdmissionVerdict {
  admitted: boolean;
  /** 413 for "too large to ever run", 429 for "too much at once". */
  statusCode: 413 | 429;
  code: string;
  message: string;
  detail: string;
}

/** Decide whether an export's capture workload is admissible. Pure — the caller does the refusing. */
export function admitCaptureWorkload(
  windows: readonly { kind: string; startSec: number; endSec: number; label?: string | null }[],
  fps: number,
): AdmissionVerdict | null {
  const sims = windows.filter((w) => w.kind === 'sim-capture');
  if (sims.length === 0) return null;

  if (sims.length > MAX_SIM_WINDOWS_PER_EXPORT) {
    return {
      admitted: false,
      statusCode: 413,
      code: 'too_many_simulations',
      message:
        `This project has ${sims.length} simulation sections, and an export can render at most `
        + `${MAX_SIM_WINDOWS_PER_EXPORT}. Split it into shorter projects and export them separately.`,
      detail: `sim windows ${sims.length} > ${MAX_SIM_WINDOWS_PER_EXPORT}`,
    };
  }

  const tooLong = sims.find((w) => w.endSec - w.startSec > MAX_SIM_WINDOW_SEC);
  if (tooLong) {
    const secs = Math.round(tooLong.endSec - tooLong.startSec);
    return {
      admitted: false,
      statusCode: 413,
      code: 'simulation_window_too_long',
      message:
        `The simulation "${tooLong.label ?? 'section'}" runs for ${secs} seconds, and a single `
        + `simulation can be rendered for at most ${MAX_SIM_WINDOW_SEC}. Shorten it and try again.`,
      detail: `window ${secs}s > ${MAX_SIM_WINDOW_SEC}s`,
    };
  }

  const frames = sims.reduce((n, w) => n + Math.round((w.endSec - w.startSec) * fps), 0);
  if (frames > MAX_TOTAL_CAPTURE_FRAMES) {
    return {
      admitted: false,
      statusCode: 429,
      code: 'capture_workload_too_large',
      message:
        'This export would render more simulation frames than one job is allowed to. '
        + 'Shorten the simulation sections, or export fewer of them at a time.',
      detail: `total frames ${frames} > ${MAX_TOTAL_CAPTURE_FRAMES}`,
    };
  }
  return null;
}

export class ExportRefused extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string = 'refused',
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'ExportRefused';
  }
}

// ── The predicate ─────────────────────────────────────────────────────────────────────────────

/** The section fields the predicate and the window builders read. */
interface SectionShape {
  id: string;
  type: string;
  simulation_url: string | null;
  sim_script: string | null;
}

/**
 * THE PREDICATE — final, from the plan doc, verbatim.
 *
 * A RAW ("show full simulation") section is a simulation section whose URL carries no
 * `?section=` variant AND whose script is absent or the meaningless literal 'main'. The player
 * computes exactly this at `useProjectPlayer.ts:1936` and treats it as RAW activation; the export
 * excludes exactly what the player would hand over to free interaction.
 *
 * BOTH halves matter. A scripted section's URL always carries `?section=<id>&v=<hash>` (minted at
 * bridge-upload time), so `variantParamOf` is the authoritative signal — and it comes from shared
 * so this file and the player read the SAME parser. The `sim_script` half keeps a legacy row
 * whose URL predates the `?section=` era but names a real script on the capture path.
 */
export const isFullSimulation = (s: SectionShape): boolean =>
  s.type === 'simulation' &&
  (!s.simulation_url || variantParamOf(s.simulation_url) === null) &&
  (!s.sim_script || s.sim_script === 'main');

// ── Disk pre-flight ───────────────────────────────────────────────────────────────────────────

/**
 * Work-directory headroom beyond the sources themselves: the normalised intermediates and the
 * master. Sources are re-encoded onto the canonical grid, so 2× the source floor + 1 GiB is a
 * deliberate over-ask — refusing to start is recoverable; ENOSPC mid-encode wastes the minutes
 * and fails with an error nobody maps back to disk.
 */
export const EXPORT_DISK_MULTIPLIER = 2;
export const EXPORT_DISK_HEADROOM_BYTES = 1024 * 1024 * 1024;

// ── The builder ───────────────────────────────────────────────────────────────────────────────

/**
 * Storage surface the plan needs: sim URL resolution, plus HEADs for the source-identity
 * snapshot. Injectable for tests. `headObject` is a READ — the builder still writes nothing.
 */
interface PlanStorage {
  getSimPublicUrl(key: string): string;
  headObject(key: string): Promise<{ size: number | null; etag: string | null } | null>;
}

const POSTER_FORMATS: readonly PosterFormat[] = ['webp', 'avif', 'png'];

/**
 * Resolve one project into an `ExportPlan`, or null when the project does not exist.
 *
 * Throws `ExportRefused` (`export_branching_unsupported`, retryable false) for a branching
 * project: a linear video follows one path, and v1 does not choose one (plan doc, Phase 1 scope).
 */
export async function buildExportPlan(
  projectId: string,
  storage: PlanStorage = getStorageAdapter(),
): Promise<ExportPlan | null> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) return null;

  const [allVideos, sections, imageRows, audioRows, sequenceRows] = await Promise.all([
    db.query.video_files.findMany({
      where: eq(video_files.project_id, projectId),
      orderBy: [asc(video_files.created_at)],
    }),
    db.query.timeline_sections.findMany({
      where: eq(timeline_sections.project_id, projectId),
      orderBy: [asc(timeline_sections.start_sec)],
    }),
    db.query.image_files.findMany({ where: eq(image_files.project_id, projectId) }),
    db.query.audio_files.findMany({ where: eq(audio_files.project_id, projectId) }),
    db.query.branch_sequences.findMany({ where: eq(branch_sequences.project_id, projectId) }),
  ]);

  // Branching: REFUSED, v1 (plan doc). `retryable: false` — the identical attempt cannot succeed;
  // the refusal names the reason so the row (and the user) holds the real answer, not a generic.
  if (sequenceRows.length > 0) {
    throw new ExportRefused(
      'This project uses branching. A linear video export follows a single path, and path '
      + 'selection is not supported yet — export is available for linear projects.',
      409, 'export_branching_unsupported', false,
    );
  }

  // Simulation rows: the revision pointer (served URL) and the identity axis (poster lookup).
  // Degraded read tolerated the same way buildPlayerConfig tolerates it — with a warning, because
  // on this path degradation changes which BYTES a Phase 2 capture would load.
  const warnings: string[] = [];
  const simRowList = await db.query.simulations
    .findMany({
      where: eq(simulations.project_id, projectId),
      columns: {
        id: true, bridge_hash: true, active_revision_id: true, active_revision_entry_key: true,
      },
    })
    .catch((err: unknown) => {
      logger.error({ err, projectId }, 'exportPlan: simulation rows unavailable — sim sections degrade to stored URLs');
      warnings.push('simulation records could not be read — simulation sections resolve to their stored (possibly stale) URLs');
      return [] as { id: string; bridge_hash: string | null; active_revision_id: string | null; active_revision_entry_key: string | null }[];
    });
  const simRows = new Map(simRowList.map((r) => [r.id, r]));

  // Posters, for the fallback path. Missing table (pre-049) degrades to "no poster", loudly per
  // window below.
  const posterSimIds = [...new Set(sections.map((s) => s.simulation_id).filter((id): id is string => !!id))];
  const posterRows = posterSimIds.length > 0
    ? await db.query.sim_posters
        .findMany({ where: inArray(sim_posters.simulation_id, posterSimIds) })
        .catch(() => [])
    : [];
  const postersByIdentity = new Map(posterRows.map((row) => [`${row.simulation_id}|${row.identity}`, row]));

  // ── Main timeline: created_at ASC order, cumulative offsets ──────────────────────────────────
  const mainVideos = allVideos.filter((v) => !v.is_broll);
  const videoById = new Map(allVideos.map((v) => [v.id, v]));
  const imageById = new Map(imageRows.map((i) => [i.id, i]));
  const audioById = new Map(audioRows.map((a) => [a.id, a]));

  const videoGlobalOffsets = new Map<string, number>();
  let globalOff = 0;
  for (const v of mainVideos) {
    videoGlobalOffsets.set(v.id, globalOff);
    globalOff += v.duration_sec ?? 0;
  }
  const mainDurationSec = globalOff;
  /**
   * POST-ROLL (decided): a rendered sim window may extend past its host video's end — in the
   * viewer it would pause-wait there, which has no meaning in a linear file, so it plays its
   * authored `end_sec − start_sec` under autoScript instead. The export total therefore extends
   * exactly the way the player's `computeDisplayTotal` extends the display timeline:
   * `max(main total, offset + section.end_sec)` over the rendered simulation windows.
   */
  let simTailEndSec = 0;

  const timeline: ExportWindow[] = [];
  const audio: ExportAudioWindow[] = [];

  for (const v of mainVideos) {
    const off = videoGlobalOffsets.get(v.id) ?? 0;
    const dur = v.duration_sec ?? 0;
    if (dur <= 0) {
      warnings.push(`video "${v.filename}" has no known duration — it contributes nothing to the timeline`);
      continue;
    }
    if (!v.storage_key) {
      warnings.push(`video "${v.filename}" has no source master in storage — assembly will fail unless it is re-uploaded`);
    }
    const base: VideoWindow = {
      kind: 'video',
      sectionId: null,
      label: v.filename,
      startSec: off,
      endSec: off + dur,
      videoFileId: v.id,
      storageKey: v.storage_key,
      sourceInSec: 0,
      sourceOutSec: dur,
    };
    timeline.push(base);
    audio.push({
      source: 'main', sectionId: null, globalOffsetSec: off,
      sourceInSec: 0, sourceOutSec: dur, storageKey: v.storage_key, gain: 1.0,
    });
  }

  // ── Sections: classify every window; exclusions become warnings, never silence ───────────────

  /** The package identity axis, resolved the way buildPlayerConfig resolves it (one resolver). */
  const packageRevisionOf = (simId: string | null, url: string | null): string | null => {
    if (!simId && !url) return null;
    const row = simId ? simRows.get(simId) : undefined;
    let bridgeHash: string | null = row?.bridge_hash ?? null;
    if (!bridgeHash && url) {
      const m = /[?&]v=([^&#]+)/.exec(url);
      bridgeHash = m ? m[1] : url;
    }
    try {
      return packageRevisionFor(
        { id: simId ?? url ?? '', bridge_hash: bridgeHash, active_revision_id: row?.active_revision_id ?? null },
        derivePackageRevision,
      );
    } catch { return null; }
  };

  /**
   * The presentation identity of one section — the config hash the capture is keyed by, and the
   * identity-matched poster STORAGE KEY (or null). No cross-identity poster fallback, ever.
   */
  const presentationIdentity = (
    s: (typeof sections)[number], uiHide: string[] | undefined,
  ): { configHash: string | null; posterKey: string | null } => {
    const configHash = computeConfigHash({
      ...DEFAULT_PRESENTATION_CONFIG,
      simpleUi:      s.simple_ui  ?? false,
      hideSelectors: uiHide ?? [],
      autoScript:    s.auto_script ?? true,
      quality: 'high',
      aspect:  'wide',
    });
    const packageRevision = packageRevisionOf(s.simulation_id, s.simulation_url);
    if (!s.simulation_id || !packageRevision) return { configHash, posterKey: null };
    const key: PosterKey = {
      packageRevision,
      variantKey: variantKeyFor(s),
      configHash,
      aspectProfile:  'wide',
      qualityProfile: 'high',
    };
    const row = postersByIdentity.get(`${s.simulation_id}|${posterIdentityString(key)}`);
    if (!row) return { configHash, posterKey: null };
    const variant = selectPosterVariant({ variants: parsePosterVariants(row.variants) }, 'standard', POSTER_FORMATS);
    return { configHash, posterKey: variant?.path ?? null };
  };

  const sectionName = (s: (typeof sections)[number]): string => s.label ?? `section ${s.id}`;

  for (const s of sections) {
    // ── Main-track simulation sections: THE PREDICATE ──
    if (s.track === 'main' && s.type === 'simulation') {
      const host = videoById.get(s.video_file_id);
      const off = videoGlobalOffsets.get(s.video_file_id);
      if (!host || off === undefined) {
        warnings.push(`${sectionName(s)} references a missing or non-main video — skipped`);
        continue;
      }
      // POST-ROLL: deliberately NOT clamped to the host video's duration — the authored
      // `end_sec` places the window exactly as `computeDisplayTotal` places it, and the tail
      // extends the export (accumulated into `simTailEndSec` when the window is rendered).
      const startSec = off + s.start_sec;
      const endSec = off + s.end_sec;
      if (endSec <= startSec) {
        warnings.push(`${sectionName(s)} has a zero-length window — skipped`);
        continue;
      }
      const uiHide = uiHideFromMeta(s.sim_meta);
      if (isFullSimulation(s)) {
        // LEGACY-ROW BACKSTOP. A row generated before the `?section=` URL era has a bare URL —
        // so THE PREDICATE reads it as RAW — but it DOES have a generated bridge, and the trace
        // of that generation is its `sim_meta`. Excluding it outright would silently drop a
        // scripted section the viewer plays; instead it renders as its poster fallback with the
        // repair path named. Only a TRULY RAW section (bare URL, no sim_meta, no real script)
        // is excluded from the render.
        if (s.sim_meta !== null && s.sim_meta !== undefined) {
          const { posterKey } = presentationIdentity(s, uiHide);
          warnings.push(
            `${sectionName(s)}: suspected legacy scripted simulation — run the repair tool `
            + '(classify-orphan-sim-rows) and re-export',
          );
          const fallback: PosterFallbackWindow = {
            kind: 'poster-fallback',
            sectionId: s.id,
            label: s.label,
            startSec,
            endSec,
            posterKey,
          };
          timeline.push(fallback);
          simTailEndSec = Math.max(simTailEndSec, endSec);
          continue;
        }
        // RAW: excluded from the render BY DESIGN, and said so. Never silent.
        warnings.push(
          `${sectionName(s)}: "show full simulation" sections are interactive and are not part of `
          + 'the rendered video — the main video plays through this window instead',
        );
        continue;
      }
      const simRow = s.simulation_id ? simRows.get(s.simulation_id) ?? null : null;
      const { configHash, posterKey } = presentationIdentity(s, uiHide);
      if (!posterKey) {
        warnings.push(`${sectionName(s)}: no poster still exists for this exact configuration — if capture is unavailable this window falls back to the base video`);
      }
      const win: SimCaptureWindow = {
        kind: 'sim-capture',
        sectionId: s.id,
        label: s.label,
        startSec,
        endSec,
        simulationId: s.simulation_id,
        servedUrl: withBootCloak(
          resolveSimulationUrl(s.simulation_url, simRow, storage), s.simple_ui ?? false, uiHide,
        ),
        simpleUi: s.simple_ui ?? false,
        autoScript: s.auto_script ?? true,
        uiHide,
        configHash,
        posterKey,
      };
      timeline.push(win);
      simTailEndSec = Math.max(simTailEndSec, endSec);
      continue;
    }

    // ── Clip sections (segment-local timing): trimmed library video or still image ──
    if (s.type === 'clip' && s.clip_source_video_id) {
      const src = videoById.get(s.clip_source_video_id);
      const off = videoGlobalOffsets.get(s.video_file_id);
      if (!src || off === undefined) {
        warnings.push(`${sectionName(s)} references a missing clip source or host video — skipped`);
        continue;
      }
      const clipIn = s.clip_in_sec ?? 0;
      const winDur = s.end_sec - s.start_sec;
      const win: ClipWindow = {
        kind: 'clip',
        sectionId: s.id,
        label: s.label,
        startSec: off + s.start_sec,
        endSec: off + s.start_sec + winDur,
        sourceVideoFileId: src.id,
        storageKey: src.storage_key,
        sourceInSec: clipIn,
        sourceOutSec: clipIn + winDur,
        sourceRole: 'clip',
      };
      timeline.push(win);
      continue;
    }
    if (s.type === 'clip' && s.clip_source_image_id) {
      const img = imageById.get(s.clip_source_image_id);
      const off = videoGlobalOffsets.get(s.video_file_id);
      if (!img || off === undefined) {
        warnings.push(`${sectionName(s)} references a missing image or host video — skipped`);
        continue;
      }
      if ((s.camera_movement ?? 'zoom_in') !== 'none') {
        warnings.push(`${sectionName(s)}: camera movement ("${s.camera_movement ?? 'zoom_in'}") is not in the v1 export — the image renders as a static frame`);
      }
      const win: ImageWindow = {
        kind: 'image',
        sectionId: s.id,
        label: s.label,
        startSec: off + s.start_sec,
        endSec: off + s.end_sec,
        imageFileId: img.id,
        storageKey: img.storage_key,
        crop: { x: img.crop_x, y: img.crop_y, w: img.crop_w, h: img.crop_h },
      };
      timeline.push(win);
      continue;
    }

    // ── Audio cutaways (global-offset timing; start/end are SOURCE in/out) ──
    if (s.clip_source_audio_id) {
      const af = audioById.get(s.clip_source_audio_id);
      if (!af) {
        warnings.push(`${sectionName(s)} references a missing audio file — skipped`);
        continue;
      }
      audio.push({
        source: 'audio',
        sectionId: s.id,
        globalOffsetSec: s.global_offset_sec ?? 0,
        sourceInSec: s.start_sec,
        sourceOutSec: s.end_sec,
        storageKey: af.storage_key,
        gain: s.broll_volume ?? 1.0,
      });
      continue;
    }

    // ── B-roll overlays (global-offset timing; start/end are SOURCE in/out) ──
    if (s.track === 'broll') {
      const src = videoById.get(s.video_file_id);
      if (!src) {
        warnings.push(`${sectionName(s)} references a missing b-roll video — skipped`);
        continue;
      }
      const win: ClipWindow = {
        kind: 'clip',
        sectionId: s.id,
        label: s.label,
        startSec: s.global_offset_sec ?? 0,
        endSec: (s.global_offset_sec ?? 0) + (s.end_sec - s.start_sec),
        sourceVideoFileId: src.id,
        storageKey: src.storage_key,
        sourceInSec: s.start_sec,
        sourceOutSec: s.end_sec,
        sourceRole: 'broll',
      };
      timeline.push(win);
      // The viewer plays b-roll MUTED (both b-roll <video> elements carry the muted attribute), so
      // the export matches the viewer rather than producing more audio than the product plays.
      warnings.push(`${sectionName(s)}: b-roll audio is omitted — the viewer plays b-roll muted, and the export matches the viewer`);
      continue;
    }
  }

  // ── Out-of-scope layers: cut from v1 by ruling, recorded per project ──────────────────────────
  const avatarConfig = project.avatar_config as { avatarCircles?: { enabled?: boolean } } | null;
  if (avatarConfig && typeof avatarConfig === 'object' && avatarConfig.avatarCircles?.enabled) {
    warnings.push('avatar circles are not in the v1 export — they are drawn live from the playing audio and are cut by scope ruling');
  }
  if (mainVideos.some((v) => v.captions_status === 'ready')) {
    warnings.push('captions are not in the v1 export — cut by scope ruling');
  }

  timeline.sort((a, b) => a.startSec - b.startSec);
  audio.sort((a, b) => a.globalOffsetSec - b.globalOffsetSec);

  // ── Disk pre-flight: source sizes are a FLOOR (unknown sizes count zero) ─────────────────────
  const referencedVideoIds = new Set<string>();
  for (const w of timeline) {
    if (w.kind === 'video') referencedVideoIds.add(w.videoFileId);
    if (w.kind === 'clip') referencedVideoIds.add(w.sourceVideoFileId);
  }
  let estimatedSourceBytes = 0;
  for (const id of referencedVideoIds) estimatedSourceBytes += videoById.get(id)?.file_size ?? 0;

  // ── Source identity snapshot (types.ts, ExportSourceIdentity) ────────────────────────────────
  // The plan locks what the master is made OF: every MUTABLE input's key is HEADed now and its
  // size/etag frozen, so the ingest step can refuse a source that changed under the export.
  // Revision bytes are immutable by the revision model and carry manifest_hash instead.
  const mutableKeys = new Map<string, ExportSourceIdentity['kind']>();
  for (const id of referencedVideoIds) {
    const key = videoById.get(id)?.storage_key;
    if (key) mutableKeys.set(key, 'video');
  }
  for (const w of timeline) {
    if (w.kind === 'image') mutableKeys.set(w.storageKey, 'image');
    if ((w.kind === 'sim-capture' || w.kind === 'poster-fallback') && w.posterKey) {
      mutableKeys.set(w.posterKey, 'poster');
    }
  }
  for (const a of audio) {
    if (a.source === 'audio' && a.storageKey) mutableKeys.set(a.storageKey, 'audio');
  }
  const sources: ExportSourceIdentity[] = await Promise.all(
    [...mutableKeys].map(async ([storageKey, kind]): Promise<ExportSourceIdentity> => {
      const head = await storage.headObject(storageKey).catch(() => null);
      return { kind, storageKey, sizeBytes: head?.size ?? null, etag: head?.etag ?? null };
    }),
  );
  // Referenced sim revisions: identity is the manifest hash of their immutable bytes.
  const referencedSimIds = new Set<string>();
  for (const w of timeline) {
    if (w.kind === 'sim-capture' && w.simulationId) referencedSimIds.add(w.simulationId);
  }
  const activeRevisionIds = [...referencedSimIds]
    .map((id) => simRows.get(id)?.active_revision_id)
    .filter((id): id is string => !!id);
  if (activeRevisionIds.length > 0) {
    const revisionRows = await db.select({
      id: sim_revisions.id, simulation_id: sim_revisions.simulation_id,
      manifest_hash: sim_revisions.manifest_hash,
    }).from(sim_revisions).where(inArray(sim_revisions.id, activeRevisionIds)).catch(() => []);
    for (const rev of revisionRows) {
      const entryKey = simRows.get(rev.simulation_id)?.active_revision_entry_key;
      if (!entryKey) continue;
      sources.push({
        kind: 'sim-revision', storageKey: entryKey,
        sizeBytes: null, etag: null, manifestHash: rev.manifest_hash,
      });
    }
  }

  return {
    // Frozen with the plan: the profile this export was described and consented to under.
    rendererProfile: (process.env.EXPORT_CAPTURE_RENDERER?.trim() === 'hardware' ? 'hardware' : 'swiftshader') as 'swiftshader' | 'hardware',
    projectId,
    grid: EXPORT_GRID,
    timeline,
    audio,
    sources,
    // Phase 2's capture worker records its environment here; Phase 1 captures nothing.
    rendererIdentity: null,
    warnings,
    estimatedSourceBytes,
    requiredDiskBytes: estimatedSourceBytes * EXPORT_DISK_MULTIPLIER + EXPORT_DISK_HEADROOM_BYTES,
    // The post-roll rule: a rendered sim window past its host's end extends the export, exactly
    // as computeDisplayTotal extends the viewer's timeline.
    totalDurationSec: Math.max(mainDurationSec, simTailEndSec),
  };
}

/** sim_meta.uiControls.hide as a clean string[] — same semantics as buildPlayerConfig. */
function uiHideFromMeta(simMeta: unknown): string[] | undefined {
  const hide = (simMeta as { uiControls?: { hide?: unknown } } | null | undefined)?.uiControls?.hide;
  if (!Array.isArray(hide)) return undefined;
  const clean = hide.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return clean.length > 0 ? clean : undefined;
}

/**
 * Append the viewer's Minimal-UI boot cloak to a served sim URL (`bootHideFor` semantics: selectors
 * only when Minimal UI is on, `{"hide":[]}` otherwise). The `data-simboot` head snippet — injected
 * by the `/sim-public/` proxy at serve time and baked into container packages by `packageInput` —
 * turns the fragment into pre-paint `display:none` CSS, which is what actually hides a Minimal-UI
 * section's controls in a capture: the capture never sends `clearBootHide`, so the cloak holds for
 * bridges without runtime `applyHideUi` while a full bridge replaces it in `startScript` anyway.
 * Any fragment already on the stored URL is replaced — it belongs to the viewer's own resolution.
 */
export function withBootCloak(
  url: string | null, simpleUi: boolean, uiHide: readonly string[] | undefined,
): string | null {
  if (!url) return url;
  const hide = simpleUi && uiHide && uiHide.length > 0 ? [...uiHide] : [];
  return `${url.replace(/#.*$/, '')}#simboot=${encodeURIComponent(JSON.stringify({ hide }))}`;
}
