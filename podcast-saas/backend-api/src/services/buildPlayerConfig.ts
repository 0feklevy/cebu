import { packageRevisionFor as revisionIdentityFor } from 'shared/sim/simRevision';
import { db } from '../db/index.js';
import {
  projects, video_files, timeline_sections, image_files, audio_files, scenes,
  branch_sequences, branch_choice_points, branch_edges, playlists, simulations, sim_posters,
} from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';

export type SimPoolMode = 'adaptive' | 'single';

/** Kill switch for the adaptive simulation pool. Env SIM_POOL_MODE overrides the admin
 *  setting per-process (staging); otherwise admin_settings.sim_pool_mode (default 'adaptive').
 *  'single' makes the viewer mount one sim frame on activation with per-URL navigation — the
 *  conservative pre-pool behavior — without reverting the deployment. */
export async function resolveSimPoolMode(): Promise<SimPoolMode> {
  const env = (process.env.SIM_POOL_MODE ?? '').trim().toLowerCase();
  if (env === 'single' || env === 'adaptive') return env;
  try {
    const s = await db.query.admin_settings.findFirst({ columns: { sim_pool_mode: true } });
    return s?.sim_pool_mode === 'single' ? 'single' : 'adaptive';
  } catch {
    return 'adaptive';   // column not migrated yet, or DB hiccup → safe default
  }
}
import {
  DEFAULT_PRESENTATION_CONFIG, computeConfigHash, derivePackageRevision, variantKeyFor,
} from 'shared/sim/simIdentity';
import {
  parsePosterVariants, posterIdentityString, selectPosterVariant,
  type PosterFormat, type PosterKey,
} from 'shared/sim/posterIdentity';
import type { SimPackageClass } from 'shared/sim/simFailurePolicy';
import { requireProjectAccess } from './projectAccess.js';
import { collaboratorContentIds } from './collabAccess.js';

// Player-facing branching shapes (mirrored loosely in client-web viewer/types.ts).
// Cross-project/playlist/sim destinations are resolved to share tokens / URLs in a
// later phase; Phase 1 emits the structure with those fields null.
type PlayerBranchEdge = {
  id: string;
  label: string | null;
  description: string | null;
  thumbnail_url: string | null;
  destination_type: string;
  dest_sequence_id: string | null;
  dest_url: string | null;
  dest_project_token: string | null;
  dest_playlist_token: string | null;
  dest_simulation_url: string | null;
  trigger_event: string | null;
  trigger_match: Record<string, unknown> | null;
  disabled: boolean;
  disabled_reason: string | null;
};
type PlayerChoicePoint = {
  id: string;
  sequence_id: string;
  lead_in_sec: number;
  timeout_sec: number | null;
  behavior: string;
  prompt: string | null;
  layout: string;
  default_edge_id: string | null;
  edges: PlayerBranchEdge[];
};
import { getStorageAdapter } from './storage/getStorageAdapter.js';
import { captionUrlForVideo } from './captions/CaptionService.js';
import { normalizeAvatarCircles, normalizeSpeakerTimeline, type AvatarCirclesLike } from './avatarCircles/normalizeAvatarCircles.js';
import { logger } from '../lib/logger.js';
import { resolveRumSampleRate, resolveSimRuntimeFlags, fieldAggregates } from './simulation/RumService.js';
import { decideBudget } from 'shared/sim/closedLoop';

/** The simulation columns this file reads. Named so the degraded-read catch cannot drift from it. */
interface SimRowShape {
  id: string;
  package_class: string | null;
  bridge_hash: string | null;
  active_revision_id: string | null;
  active_revision_entry_key: string | null;
  prepare_budget_ms: number | null;
}

/**
 * Build the PlayerConfig for a single project — the dynamic equivalent of
 * interactive-podcast-react's constants/index.ts. Shared by the player-config
 * endpoint, the single-video share endpoint, and the playlist play-config.
 *
 * Returns null if the project does not exist.
 *
 * `preloadedProject` lets a caller that already loaded the project row (e.g. the
 * player-config controller does a visibility check first) hand it in so we don't
 * re-SELECT the same row on the hot path (loadperf-002/backend-110).
 */
export async function buildPlayerConfig(
  projectId: string,
  requesterUserId: string | null = null,
  preloadedProject?: typeof projects.$inferSelect,
) {
  const storage = getStorageAdapter();

  const project = preloadedProject && preloadedProject.id === projectId
    ? preloadedProject
    : await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) return null;

  // These queries only depend on project.id and are independent of each other — run them in
  // ONE round-trip instead of four sequential ones plus the two once-serial follow-ups
  // (scenes, branch_sequences). buildPlayerConfig is the hottest read path (every
  // player-config / share / playlist-item / course render), so the serial waits added up
  // (perf-003; scenes+branch_sequences folded in per loadperf-002/backend-110). Scenes and
  // sequences are filtered/used in memory below exactly as before.
  const [allVideos, sections, imageRows, audioRows, allScenes, sequenceRows, simPoolMode, rumSampleRate, simRuntimeFlags, projectSimulations] = await Promise.all([
    db.query.video_files.findMany({
      where: eq(video_files.project_id, project.id),
      orderBy: [asc(video_files.created_at)],
    }),
    db.query.timeline_sections.findMany({
      where: eq(timeline_sections.project_id, project.id),
      orderBy: [asc(timeline_sections.start_sec)],
    }),
    db.query.image_files.findMany({ where: eq(image_files.project_id, project.id) }),
    db.query.audio_files.findMany({ where: eq(audio_files.project_id, project.id) }),
    db.query.scenes.findMany({ where: eq(scenes.project_id, project.id) }),
    db.query.branch_sequences.findMany({
      where: eq(branch_sequences.project_id, project.id),
      orderBy: [asc(branch_sequences.sort_order), asc(branch_sequences.created_at)],
    }),
    resolveSimPoolMode(),
    resolveRumSampleRate(),
    resolveSimRuntimeFlags(),
    // The package identity + canary verdict for every simulation this project references.
    //
    // `columns` is not an optimisation detail: without it Drizzle selects the WHOLE row for every
    // simulation — `guidance` (a full GuidanceEntry[]), `guidance_meta`, `bridge_functions` and the
    // new `canary_report` JSONB — on the hottest read path in the product, to read one text field.
    //
    // The try/catch matches the precedent set by `resolveSimPoolMode` above: these columns arrive in
    // migration 049, and an app image that boots before the migration is applied must not 500 EVERY
    // viewer surface over a feature no stored package can use yet. An empty list reads as
    // "unclassified", which is exactly the safe default.
    db.query.simulations
      .findMany({
        where: eq(simulations.project_id, project.id),
        columns: {
          id: true, package_class: true, bridge_hash: true,
          // The pointer (migration 050). Two cheap scalars, deliberately denormalised onto this row
          // so resolving which bytes are live costs no join on the hottest read path.
          active_revision_id: true, active_revision_entry_key: true,
          // The package's own publish-time preparation cost, derived once when the canary verdict
          // was recorded. A scalar, deliberately: canary_report is large (per-case steps, errors,
          // capabilities, resource counts) and this is the read path the `columns` list exists to
          // keep narrow. It is the only real number available on a FIRST view, when nothing has
          // been measured yet and a compiled-in constant is least defensible.
          prepare_budget_ms: true,
        },
      })
      // A degraded read here is NOT harmless. An empty list makes every simulation look
      // revision-less, so `simulationUrlOf` falls back to the stored legacy URL and the identity
      // axis falls back to the pre-revision derivation — correct-looking output, entirely wrong
      // bytes, with nothing surfaced. It still must not 500 the viewer, so the catch stays; but a
      // project with sim sections and no simulation rows is an incident, not a degradation.
      .catch((err: unknown) => {
        logger.error({ err, projectId: project.id }, 'buildPlayerConfig: simulation rows unavailable — every sim degrades to the legacy package');
        return [] as SimRowShape[];
      }),
  ]);

  // Main video segments (uploaded by user, not AI-generated broll sources)
  const mainVideos = allVideos.filter((v) => !v.is_broll);
  const brollVideos = allVideos.filter((v) => v.is_broll);

  const simRows = new Map(projectSimulations.map((r) => [r.id, r]));

  // ── Posters ─────────────────────────────────────────────────────────────────
  // Not in the Promise.all above because the simulation ids it filters on come out of `sections`.
  // Skipped entirely for a project with no simulation sections, which is most of them — so the
  // hottest read path pays for this only when it has something to look up.
  const posterSimIds = [...new Set(sections.map((s) => s.simulation_id).filter((id): id is string => !!id))];
  // Same guard, same reason: `sim_posters` does not exist until migration 049 is applied, and a
  // missing poster table must degrade to "no poster" rather than take down every player surface.
  const posterRows = posterSimIds.length > 0
    ? await db.query.sim_posters
        .findMany({ where: inArray(sim_posters.simulation_id, posterSimIds) })
        .catch(() => [])
    : [];
  // Keyed by simulation AND identity: `identity` is unique only within one simulation
  // (uniq_sim_posters_sim_identity), and two simulations can legitimately produce the same
  // identity string when they share a revision, a variant and a configuration. `|` is a safe
  // joiner — a UUID is hex and dashes, and every component of an identity string is hex, an enum,
  // or a variant already sanitised to [A-Za-z0-9_-] (posterIdentity.sanitizeVariant).
  const postersByIdentity = new Map<string, (typeof posterRows)[number]>(
    posterRows.map((row) => [`${row.simulation_id}|${row.identity}`, row]),
  );

  /**
   * Format preference for the emitted URL.
   *
   * Every browser this player runs in decodes WebP, and `selectPosterVariant` applies the shared
   * preference order within this set — so the emitted URL is the cheapest rendition that shows the
   * right picture. AVIF and PNG stay listed as the fallbacks for identities captured before/without
   * a WebP rendition (a transparent capture is PNG-only by construction).
   */
  const POSTER_FORMATS: readonly PosterFormat[] = ['webp', 'avif', 'png'];

  /**
   * The poster for ONE section's own presentation identity, or null.
   *
   * There is deliberately NO fallback to another identity's poster. A poster is a promise that the
   * still picture is what the live frame would have shown; the moment it is allowed to come from a
   * different variant, configuration, aspect or quality it becomes a generic package screenshot,
   * and the user reads the difference between it and the frame that replaces it as a glitch
   * (shared/src/sim/posterIdentity.ts). Absent is honest; approximate is not.
   */
  const posterFor = (
    s: (typeof sections)[number],
    packageRevision: string | null,
  ): { url: string | null; transparent: boolean } => {
    const none = { url: null, transparent: false };
    if (!s.simulation_id || !packageRevision) return none;

    const key: PosterKey = {
      packageRevision,
      // The SECTION's dispatch key — the same value the runtime puts on the wire as `variantKey`.
      variantKey: variantKeyFor(s),
      configHash: computeConfigHash({
        ...DEFAULT_PRESENTATION_CONFIG,
        simpleUi:      s.simple_ui  ?? false,
        hideSelectors: uiHideFromMeta(s.sim_meta) ?? [],
        autoScript:    s.auto_script ?? true,
        // Quality and aspect are hashed here AND named again as key axes below — the same
        // configuration is legitimately captured more than once at different sizes and quality
        // profiles, so the key has to distinguish those captures (posterIdentity.ts). Both are
        // pinned to what the player asks for today: it builds its own config from
        // DEFAULT_PRESENTATION_CONFIG at quality 'high', and 'wide' is the aspect a full-width
        // player lays out for.
        quality: 'high',
        aspect:  'wide',
      }),
      aspectProfile:  'wide',
      qualityProfile: 'high',
    };

    const row = postersByIdentity.get(`${s.simulation_id}|${posterIdentityString(key)}`);
    if (!row) return none;
    const variant = selectPosterVariant({ variants: parsePosterVariants(row.variants) }, 'standard', POSTER_FORMATS);
    if (!variant) return none;
    return { url: storage.getSimPublicUrl(variant.path), transparent: row.transparent };
  };

  /**
   * Derive the logical package revision WITHOUT a second round trip.
   *
   * The stored section URL already carries `?v=<bridgeHash>` — the hash of the exact bridge.js the
   * entry document loads — so it is the strongest identity available before immutable publication
   * exists (Priority 7). Falling back to the raw URL keeps the value defined for a legacy row whose
   * URL predates the hash, at the cost of a revision that only changes when the URL does; that is
   * strictly better than emitting null, which would disable identity checking for that section.
   */
  /**
   * Lab preparation cost per simulation, from that package's own canary report.
   *
   * Absent for a package that has never been canaried, and the client treats absence as "no lab
   * data" rather than as zero — a package with no measurement must not be budgeted as instantaneous.
   */
  /** The identity axis for one simulation ROW — the key field measurements are grouped by. */
  const packageRevisionForRow = (row: SimRowShape): string | null => {
    try {
      return revisionIdentityFor(
        { id: row.id, bridge_hash: row.bridge_hash, active_revision_id: row.active_revision_id },
        derivePackageRevision,
      );
    } catch { return null; }
  };

  //
  // CLOSED LOOP. The lab number is the anchor; a FIELD aggregate may refine it, and only if it
  // survives every credibility check in `decideBudget`. That input derives from an unauthenticated
  // endpoint, so a refused aggregate must leave exactly the value the lab alone would produce —
  // which is what makes a hostile feed achieve nothing rather than something small.
  //
  // Field data is looked up in ONE grouped query for the whole project, and a failure returns an
  // empty map rather than throwing: no field data is the state every deployment is in today.
  const simPrepareBudgets: Record<string, number> = {};
  const revisionsForField = [...simRows.values()]
    .map((r) => packageRevisionForRow(r))
    .filter((r): r is string => typeof r === 'string' && r.length > 0);
  const field = await fieldAggregates(revisionsForField).catch(() => new Map());
  for (const [simId, row] of simRows) {
    const lab = typeof row.prepare_budget_ms === 'number' && Number.isFinite(row.prepare_budget_ms)
      && row.prepare_budget_ms > 0 ? row.prepare_budget_ms : null;
    const rev = packageRevisionForRow(row);
    const agg = rev ? field.get(rev) ?? null : null;
    if (lab === null && agg === null) continue;   // absent means "no data", never "instantaneous"
    const decision = decideBudget({ canaryMs: lab, field: agg });
    // The floor is emitted only when something real produced it; a package with neither a lab
    // number nor field data stays absent so the client treats it as unmeasured.
    if (lab !== null || decision.source === 'measured') simPrepareBudgets[simId] = decision.ms;
  }

  const packageRevisionFor = (simId: string | null, url: string | null): string | null => {
    if (!simId && !url) return null;
    const row = simId ? simRows.get(simId) : undefined;

    // THE PACKAGE's bridge hash, not the section URL's.
    //
    // Regenerating one section rewrites the shared bridge but stamps the new `?v=` onto only that
    // section's URL. Deriving from the URL gave two sections of ONE package — which share a single
    // pooled document and a single runtime client — different revisions, which re-opened the
    // transport mid-session and made every poster lookup miss.
    let bridgeHash: string | null = row?.bridge_hash ?? null;
    if (!bridgeHash && url) {
      // A package whose bridge predates the column. Falls back to the previous behaviour rather
      // than emitting null, which would disable identity checking for that section entirely.
      const m = /[?&]v=([^&#]+)/.exec(url);
      bridgeHash = m ? m[1] : url;
    }

    // ONE resolver. `simRevision.packageRevisionFor` decides whether identity comes from the active
    // revision (immutable bytes) or from the pre-revision derivation, and this file must not make
    // that decision a second time — a forked identity axis costs every poster (the lookup has no
    // fallback) and leaves the canary verdict describing bytes that are no longer served.
    return revisionIdentityFor(
      { id: simId ?? url ?? '', bridge_hash: bridgeHash, active_revision_id: row?.active_revision_id ?? null },
      derivePackageRevision,
    );
  };

  /**
   * The URL a section's simulation is actually served from — the pointer flip made visible.
   *
   * The STORED `simulation_url` is never rewritten. Putting the revision id into stored URLs would
   * make activation an N-row un-transacted rewrite and break the "single pointer update" promise
   * outright; it would also break sim-script reuse, which compares against the raw stored value.
   * So the pointer is resolved HERE, on the way out, and nowhere else.
   */
  const simulationUrlOf = (simId: string | null, url: string | null): string | null => {
    const row = simId ? simRows.get(simId) : undefined;
    if (!row?.active_revision_entry_key || !url) return url ?? null;
    // `?section=` and `?v=` are preserved exactly: the pool dispatches on `?section=`, and the
    // poster/variant identity axis reads it. Dropping the query here would collapse every section
    // of a package onto one variant key.
    const q = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    return storage.getSimPublicUrl(row.active_revision_entry_key) + q;
  };

  const packageClassFor = (simId: string | null): SimPackageClass | null => {
    if (!simId) return null;
    const row = simRows.get(simId) as { package_class?: string | null } | undefined;
    const cls = row?.package_class ?? null;
    return cls ? (cls as SimPackageClass) : null;
  };

  const buildSegment = (v: (typeof allVideos)[number]) => {
    const hls_url = v.hls_master_key
      ? storage.getPublicUrl(v.hls_master_key)
      : v.hls_360p_key
        ? storage.getPublicUrl(v.hls_360p_key)
        : null;
    const fallback_url = hls_url;

    // Only non-broll sections for this main video
    const simulations = sections
      .filter((s) => s.video_file_id === v.id && s.track === 'main')
      .map((s) => {
        const package_revision = packageRevisionFor(s.simulation_id, s.simulation_url);
        const poster = posterFor(s, package_revision);
        return {
          id:             s.id,
          start_sec:      s.start_sec,
          end_sec:        s.end_sec,
          simulation_url: simulationUrlOf(s.simulation_id, s.simulation_url),
          simulation_id:  s.simulation_id  ?? null,
          package_revision,
          // The LAST CANARY VERDICT, or null when the package has never been canaried. Null is not a
          // failure and is not 'legacy' — it means unproven, and the player treats unproven exactly
          // as it treats legacy: v2 path, no aggressive preparation.
          package_class:  packageClassFor(s.simulation_id),
          sim_script:     s.sim_script     ?? null,
          simple_ui:      s.simple_ui      ?? false,
          auto_script:    s.auto_script    ?? true,
          // Minimal-UI mechanical hide list (sim_meta.uiControls.hide) — the player passes
          // these as startScript params.hideSelectors while simple_ui is on. Omitted when
          // absent/empty so the no-selection payload is byte-identical to before.
          ui_hide:        uiHideFromMeta(s.sim_meta),
          // The still picture for THIS section's exact identity, or null when none was captured.
          poster_url:         poster.url,
          poster_transparent: poster.transparent,
          label:          s.label,
          type:           s.type,
        };
      });

    const crop_url = v.crop_status === 'ready' && v.crop_key ? storage.getPublicUrl(v.crop_key) : null;

    return {
      id: v.id,
      label: v.filename,
      duration_sec: v.duration_sec ?? 0,
      hls_url,
      fallback_url,
      hls_status: v.hls_status,
      crop_url,                 // smart portrait-crop metadata (null until ready)
      captions: {
        status: videoCaptionStatus(v.captions_status),
        vtt_url: captionUrlForVideo(v),
        error: v.captions_status === 'failed' ? v.captions_error : null,
      },
      simulations,
    };
  };

  const segments = mainVideos.map(buildSegment);

  // NB: crop + captions are NOT enqueued here. They run once on the write path when a
  // video is uploaded (video.controller enqueueVideoProcessing) instead of on every
  // preview/share/course render, which was a per-render side-effect (review perf-002).

  // Build broll_clips from broll sections — each broll section points to a broll video
  const brollVideoMap = new Map(brollVideos.map((v) => [v.id, v]));
  const brollClips = sections
    .filter((s) => s.track === 'broll' && !s.clip_source_audio_id)
    .map((s) => {
      const brollVid = brollVideoMap.get(s.video_file_id);
      if (!brollVid) return null;
      const hls_url = brollVid.hls_master_key
        ? storage.getPublicUrl(brollVid.hls_master_key)
        : brollVid.hls_360p_key
          ? storage.getPublicUrl(brollVid.hls_360p_key)
          : null;
      if (!hls_url) return null;
      return {
        id:                s.id,
        hls_url,
        global_offset_sec: s.global_offset_sec ?? 0,
        start_sec:         s.start_sec,
        end_sec:           s.end_sec,
        label:             s.label,
        broll_volume:      s.broll_volume ?? 1.0,
      };
    })
    .filter(Boolean);

  // Build clip_overlays from clip sections — user-trimmed library videos shown as overlay.
  // Compute each main video's global offset (cumulative sum of durations).
  const allVideoMap = new Map(allVideos.map((v) => [v.id, v]));
  let globalOff = 0;
  const videoGlobalOffsets = new Map<string, number>();
  for (const v of mainVideos) {
    videoGlobalOffsets.set(v.id, globalOff);
    globalOff += v.duration_sec ?? 0;
  }

  const clipOverlays = sections
    .filter((s) => s.type === 'clip' && s.clip_source_video_id)
    .map((s) => {
      const srcVideo = allVideoMap.get(s.clip_source_video_id!);
      if (!srcVideo) return null;
      const hls_url = srcVideo.hls_master_key
        ? storage.getPublicUrl(srcVideo.hls_master_key)
        : srcVideo.hls_360p_key
          ? storage.getPublicUrl(srcVideo.hls_360p_key)
          : null;
      if (!hls_url) return null;

      const vidOffset = videoGlobalOffsets.get(s.video_file_id) ?? 0;
      const sectionDuration = s.end_sec - s.start_sec;
      const clipIn = s.clip_in_sec ?? 0;

      return {
        id:                s.id,
        hls_url,
        global_offset_sec: vidOffset + s.start_sec,
        start_sec:         clipIn,
        end_sec:           clipIn + sectionDuration,
        label:             s.label,
        broll_volume:      1.0,
      };
    })
    .filter(Boolean);

  // Build image_overlays from clip sections that reference an image file
  const imageFileMap = new Map(imageRows.map((img) => [img.id, img]));

  const imageOverlays = sections
    .filter((s) => s.type === 'clip' && s.clip_source_image_id)
    .map((s) => {
      const img = imageFileMap.get(s.clip_source_image_id!);
      if (!img) return null;
      const vidOffset = videoGlobalOffsets.get(s.video_file_id) ?? 0;
      return {
        id:                s.id,
        image_url:         img.original_url,
        global_offset_sec: vidOffset + s.start_sec,
        duration_sec:      s.end_sec - s.start_sec,
        camera_movement:   s.camera_movement ?? 'zoom_in',
        crop_x:            img.crop_x,
        crop_y:            img.crop_y,
        crop_w:            img.crop_w,
        crop_h:            img.crop_h,
        label:             s.label,
      };
    })
    .filter(Boolean);

  // Build audio_cutaways from broll/audio sections backed by an audio file (audio-only cutaways)
  const audioFileMap = new Map(audioRows.map((a) => [a.id, a]));

  const audioCutaways = sections
    .filter((s) => (s.track === 'audio' || !!s.clip_source_audio_id) && s.clip_source_audio_id)
    .map((s) => {
      const af = audioFileMap.get(s.clip_source_audio_id!);
      if (!af) return null;
      return {
        id:                s.id,
        audio_url:         af.url,
        global_offset_sec: s.global_offset_sec ?? 0,
        start_sec:         s.start_sec,
        end_sec:           s.end_sec,
        label:             s.label,
        broll_volume:      s.broll_volume ?? 1.0,
      };
    })
    .filter(Boolean);

  // Avatar circles config (audio-reactive overlays shown during b-roll). Tolerate
  // a legacy double-encoded JSON string for avatar_config.
  const avatarConfigObj: { avatarCircles?: unknown } | null = (() => {
    const v = project.avatar_config as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as { avatarCircles?: unknown };
    if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; } }
    return null;
  })();
  // Self-heal a stored circles config on read: canonical faces (distinct speaker→circle so
  // "his wave / her wave" always maps correctly) + clean manual sections. A degenerate faces
  // mapping was the likely cause of the reported broken circles-waves data. (avatar-circles-fix)
  const avatarCircles = avatarConfigObj?.avatarCircles
    ? normalizeAvatarCircles(avatarConfigObj.avatarCircles as AvatarCirclesLike)
    : null;

  // Speaker timeline (from the latest script version) so the viewer can animate whichever
  // avatar is speaking. GAP-FILLED so a manual circle-section placed in a between-turn pause
  // still resolves to the speaker who just spoke, instead of activeSpeakerAt → null → BOTH
  // circles waving equally (the manual-mode "doesn't know who says what" bug). Empty for
  // uploaded videos with no script — the viewer then animates all circles to the audio.
  const speakerTimeline: Array<{ speaker: string; start_sec: number; end_sec: number }> =
    avatarCircles ? normalizeSpeakerTimeline(allScenes) : [];

  // ── Branching (migration 037) ────────────────────────────────────────────────
  // Emit a graph block only when the project has been split into sequences. Projects
  // with no branch_sequences rows return branching:null and play linearly as before —
  // zero behavior change. Phase 1 is read-only (no authoring UI yet); the block exists
  // so the viewer/editor can render a preview and Phase 2 can walk it.
  type Segment = ReturnType<typeof buildSegment>;
  type BranchingBlock = {
    entry_sequence_id: string;
    sequences: Array<{
      id: string;
      label: string;
      is_entry: boolean;
      segments: Segment[];
      choice_point: PlayerChoicePoint | null;
    }>;
  };

  let branching: BranchingBlock | null = null;

  // sequenceRows was fetched in the opening Promise.all (loadperf-002/backend-110).
  if (sequenceRows.length > 0) {
    const [choicePointRows, edgeRows] = await Promise.all([
      db.query.branch_choice_points.findMany({
        where: eq(branch_choice_points.project_id, project.id),
        orderBy: [asc(branch_choice_points.created_at)],
      }),
      db.query.branch_edges.findMany({
        where: eq(branch_edges.project_id, project.id),
        orderBy: [asc(branch_edges.sort_order), asc(branch_edges.created_at)],
      }),
    ]);

    // First choice point per sequence (Phase 1 supports one decision per sequence).
    const cpBySequence = new Map<string, (typeof choicePointRows)[number]>();
    for (const cp of choicePointRows) {
      if (!cpBySequence.has(cp.sequence_id)) cpBySequence.set(cp.sequence_id, cp);
    }
    const edgesByChoicePoint = new Map<string, typeof edgeRows>();
    for (const e of edgeRows) {
      if (!e.choice_point_id) continue;
      const list = edgesByChoicePoint.get(e.choice_point_id) ?? [];
      list.push(e);
      edgesByChoicePoint.set(e.choice_point_id, list);
    }

    const entrySeq = sequenceRows.find((s) => s.is_entry) ?? sequenceRows[0];

    // Group main videos by sequence; unassigned main videos fall into the entry
    // sequence so no segment is dropped from the preview.
    const videosBySequence = new Map<string, typeof mainVideos>();
    for (const seq of sequenceRows) videosBySequence.set(seq.id, []);
    for (const v of mainVideos) {
      const seqId = v.sequence_id && videosBySequence.has(v.sequence_id) ? v.sequence_id : entrySeq.id;
      videosBySequence.get(seqId)!.push(v);
    }
    const orderInSequence = (a: (typeof mainVideos)[number], b: (typeof mainVideos)[number]) => {
      const ao = a.sequence_order ?? Number.MAX_SAFE_INTEGER;
      const bo = b.sequence_order ?? Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return a.created_at.getTime() - b.created_at.getTime();
    };

    // Resolve cross-destination edges (Phase 4): tokens for project/playlist, sim URLs, and
    // access checks. Private/unpublished/missing destinations are disabled (greyed out at the
    // viewer), never exposed as raw ids — only share tokens for reachable destinations.
    const destProjectIds  = [...new Set(edgeRows.filter((e) => e.destination_type === 'project'         && e.dest_project_id).map((e) => e.dest_project_id!))];
    const destPlaylistIds = [...new Set(edgeRows.filter((e) => e.destination_type === 'playlist'        && e.dest_playlist_id).map((e) => e.dest_playlist_id!))];
    const destSimIds      = [...new Set(edgeRows.filter((e) => e.destination_type === 'simulation_full' && e.dest_simulation_id).map((e) => e.dest_simulation_id!))];

    const [destProjects, destPlaylists, destSims] = await Promise.all([
      destProjectIds.length  ? db.query.projects.findMany({ where: inArray(projects.id, destProjectIds) })       : Promise.resolve([]),
      destPlaylistIds.length ? db.query.playlists.findMany({ where: inArray(playlists.id, destPlaylistIds) })    : Promise.resolve([]),
      destSimIds.length      ? db.query.simulations.findMany({ where: inArray(simulations.id, destSimIds) })     : Promise.resolve([]),
    ]);
    const destProjectMap  = new Map(destProjects.map((p) => [p.id, p]));
    // Cross-project edge access also passes for invited collaborators (042); batch-resolved
    // here because mapEdge is sync.
    const collabDestIds = requesterUserId
      ? await collaboratorContentIds('project', destProjectIds, requesterUserId)
      : new Set<string>();
    const destPlaylistMap = new Map(destPlaylists.map((p) => [p.id, p]));
    const destSimMap      = new Map(destSims.map((s) => [s.id, s]));
    const resolveSimUrl = (entryFile: string | null) => !entryFile ? null : (entryFile.startsWith('http') ? entryFile : storage.getSimPublicUrl(entryFile));

    const mapEdge = (e: (typeof edgeRows)[number]): PlayerBranchEdge => {
      let dest_project_token: string | null = null;
      let dest_playlist_token: string | null = null;
      let dest_simulation_url: string | null = null;
      let disabled = false;
      let disabled_reason: string | null = null;

      switch (e.destination_type) {
        case 'project': {
          const p = e.dest_project_id ? destProjectMap.get(e.dest_project_id) : undefined;
          if (!p || !(requireProjectAccess(p, requesterUserId, null) || collabDestIds.has(p.id))) { disabled = true; disabled_reason = 'unavailable'; }
          else if (!p.share_token) { disabled = true; disabled_reason = 'no_share_link'; }
          else dest_project_token = p.share_token;
          break;
        }
        case 'playlist': {
          const pl = e.dest_playlist_id ? destPlaylistMap.get(e.dest_playlist_id) : undefined;
          if (!pl) { disabled = true; disabled_reason = 'unavailable'; }
          else if (!pl.share_token) { disabled = true; disabled_reason = 'no_share_link'; }
          else dest_playlist_token = pl.share_token;
          break;
        }
        case 'simulation_full': {
          const sim = e.dest_simulation_id ? destSimMap.get(e.dest_simulation_id) : undefined;
          if (!sim || sim.status !== 'ready') { disabled = true; disabled_reason = 'unavailable'; }
          else dest_simulation_url = resolveSimUrl(sim.entry_file);
          break;
        }
        case 'external_url':
          if (!e.dest_url) { disabled = true; disabled_reason = 'no_url'; }
          break;
        case 'sequence':
          if (!e.dest_sequence_id || !sequenceRows.some((s) => s.id === e.dest_sequence_id)) { disabled = true; disabled_reason = 'unavailable'; }
          break;
        // back | restart | end | quiz: always enabled
      }

      return {
        id:                  e.id,
        label:               e.label ?? null,
        description:         e.description ?? null,
        thumbnail_url:       e.thumbnail_url ?? null,
        destination_type:    e.destination_type,
        dest_sequence_id:    e.dest_sequence_id ?? null,
        dest_url:            e.dest_url ?? null,
        dest_project_token,
        dest_playlist_token,
        dest_simulation_url,
        trigger_event:       e.trigger_event ?? null,
        trigger_match:       (e.trigger_match as Record<string, unknown> | null) ?? null,
        disabled,
        disabled_reason,
      };
    };

    branching = {
      entry_sequence_id: entrySeq.id,
      sequences: sequenceRows.map((seq) => {
        const cp = cpBySequence.get(seq.id) ?? null;
        return {
          id:       seq.id,
          label:    seq.label,
          is_entry: seq.is_entry,
          segments: (videosBySequence.get(seq.id) ?? []).slice().sort(orderInSequence).map(buildSegment),
          choice_point: cp
            ? {
                id:              cp.id,
                sequence_id:     cp.sequence_id,
                lead_in_sec:     cp.lead_in_sec,
                timeout_sec:     cp.timeout_sec ?? null,
                behavior:        cp.behavior,
                prompt:          cp.prompt ?? null,
                layout:          cp.layout,
                default_edge_id: cp.default_edge_id ?? null,
                edges:           (edgesByChoicePoint.get(cp.id) ?? []).map(mapEdge),
              }
            : null,
        };
      }),
    };
  }

  return {
    project_id:     project.id,
    title:          project.title,
    description:    project.topic ?? null,
    thumbnail_url:  project.thumbnail_url ?? null,
    segments,
    broll_clips:    brollClips,
    clip_overlays:  clipOverlays,
    image_overlays: imageOverlays,
    audio_cutaways: audioCutaways,
    avatar_circles: avatarCircles,
    speaker_timeline: speakerTimeline,
    branching,
    sim_pool_mode: simPoolMode,   // kill switch: 'adaptive' (pool) | 'single' (conservative)
    // Sampled field measurement (migration 051). 0 means the viewer sends nothing, which is the
    // default and the state every existing deployment is in until an operator changes it.
    sim_rum_sample_rate: rumSampleRate,
    // Priority 8 runtime switches (migration 052). All default OFF, so a player that receives them
    // behaves exactly as it does today until an operator changes one.
    sim_scheduler_mode: simRuntimeFlags.schedulerMode,
    sim_adaptive_quality: simRuntimeFlags.adaptiveQuality,
    sim_boundary_sentinel: simRuntimeFlags.boundarySentinel,
    // Per-package preparation budgets from each package's own publish-time canary. Emitted as a map
    // rather than per section because a package's cost is a property of its BYTES, not of where it
    // happens to appear on a timeline — and one package commonly appears in many sections.
    sim_prepare_budget_ms: simPrepareBudgets,
  };
}

function videoCaptionStatus(status: string | null | undefined): 'none' | 'processing' | 'ready' | 'failed' {
  return status === 'processing' || status === 'ready' || status === 'failed' ? status : 'none';
}

/** sim_meta.uiControls.hide as a clean string[] — undefined (key omitted in JSON) when the
 *  section has no Minimal-UI selection, an empty hide list, or malformed jsonb. */
function uiHideFromMeta(simMeta: unknown): string[] | undefined {
  const hide = (simMeta as { uiControls?: { hide?: unknown } } | null | undefined)?.uiControls?.hide;
  if (!Array.isArray(hide)) return undefined;
  const clean = hide.filter((s): s is string => typeof s === 'string' && s.length > 0);
  return clean.length > 0 ? clean : undefined;
}
