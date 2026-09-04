import { packageRevisionFor as revisionIdentityFor } from 'shared/sim/simRevision';
import { db } from '../db/index.js';
import {
  projects, video_files, timeline_sections, image_files, audio_files, scenes,
  branch_sequences, branch_choice_points, branch_edges, playlists, simulations, sim_posters,
  video_dubs, sim_revisions,
} from '../db/schema.js';
import { eq, asc, inArray } from 'drizzle-orm';

export type SimPoolMode = 'adaptive' | 'single';

/** Kill switch for the adaptive simulation pool. Env SIM_POOL_MODE overrides the admin
 *  setting per-process (staging); otherwise admin_settings.sim_pool_mode (default 'adaptive').
 *  'single' makes the viewer mount one sim frame on activation with per-URL navigation — the
 *  conservative pre-pool behavior — without reverting the deployment. */
export const SIM_POOL_MODE_CACHE_MS = 10_000;
let poolModeCache: { at: number; value: SimPoolMode } | null = null;
/** Test seam; also called when the admin setting is written so an operator sees the change at once. */
export function invalidateSimPoolModeCache(): void { poolModeCache = null; }

export async function resolveSimPoolMode(): Promise<SimPoolMode> {
  const env = (process.env.SIM_POOL_MODE ?? '').trim().toLowerCase();
  if (env === 'single' || env === 'adaptive') return env;
  // CACHED for the same reason resolveRumSampleRate is: this runs on the hottest endpoint
  // (player-config) as one of two uncached admin_settings reads beside a third that was cached —
  // two round trips per public view against a pool of ten (night run 2026-09-03 §7).
  const now = Date.now();
  if (poolModeCache && now - poolModeCache.at < SIM_POOL_MODE_CACHE_MS) return poolModeCache.value;
  try {
    const s = await db.query.admin_settings.findFirst({ columns: { sim_pool_mode: true } });
    const value: SimPoolMode = s?.sim_pool_mode === 'single' ? 'single' : 'adaptive';
    poolModeCache = { at: now, value };
    return value;
  } catch {
    poolModeCache = { at: now, value: 'adaptive' };
    return 'adaptive';   // column not migrated yet, or DB hiccup → safe default
  }
}
import { derivePackageRevision } from 'shared/sim/simIdentity';
import {
  parsePosterVariants, posterIdentityString, selectPosterVariant,
  type PosterFormat, type PosterKey,
} from 'shared/sim/posterIdentity';
import type { SimPackageClass } from 'shared/sim/simFailurePolicy';
import { projectOrientation } from 'shared/video/orientation';
import { posterKeyForSection, uiHideFromMeta } from './simulation/sectionPosterKey.js';
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
import { dubCaptionUrl, isDubServable } from './dubbing/dubRegistry.js';
import { findDubbingLanguage } from './dubbing/languages.js';
import { normalizeAvatarCircles, normalizeSpeakerTimeline, type AvatarCirclesLike } from './avatarCircles/normalizeAvatarCircles.js';
import { logger } from '../lib/logger.js';
import { resolveRumSampleRate, resolveSimRuntimeFlags, fieldAggregates } from './simulation/RumService.js';
import { simulationUrlResolver } from './simulation/simulationUrlResolver.js';
import { decideBudget } from 'shared/sim/closedLoop';
// The ONE place that knows what a `timeline_sections` row is. This file used to answer that
// question separately at each emit site with a hand-written filter, and the filters were not
// disjoint — see the note above `overlayLanes` below.
import {
  classifyTimelineSection, groupTimelineSectionsByLane, sortTimelineSections,
  buildMainSegmentTimeline, resolveSectionPlacement,
} from 'shared';

/** The simulation columns this file reads. Named so the degraded-read catch cannot drift from it. */
interface SimRowShape {
  id: string;
  package_class: string | null;
  bridge_hash: string | null;
  active_revision_id: string | null;
  active_revision_entry_key: string | null;
  prepare_budget_ms: number | null;
  bridge_ack_capable: boolean | null;
  requires_import_maps: boolean | null;
}

/**
 * The columns that predate migrations 055/057, i.e. everything this file needs that a rollback of
 * either cannot take away. Split out so the retry below can only ever ask for a strict subset of
 * the full list — the two cannot drift.
 */
const SIM_COLUMNS_PRE_CAPABILITIES = {
  id: true, package_class: true, bridge_hash: true,
  active_revision_id: true, active_revision_entry_key: true,
  prepare_budget_ms: true,
} as const;

/**
 * The project's simulation rows, with the SAME degraded-column retry both editor reads already have
 * (`editor-state.controller.loadSimulations`, `sections.controller.withServedSimUrls`).
 *
 * WHY THE RETRY MATTERS MORE HERE THAN ANYWHERE ELSE. `bridge_ack_capable` (055) and
 * `requires_import_maps` (057) are named in the explicit `columns` list below, so a Postgres 42703
 * from either — the 055/057 rollback run under an image that still declares them, or an image
 * deployed ahead of its migrations — lands in the catch at the bottom of this function. That catch
 * returns `[]`, and `[]` on THIS path is not a degradation: every simulation in the project then
 * looks revision-less, so `simulationUrlOf` falls back to the stored legacy URL and the identity
 * axis to the pre-revision derivation. Correct-looking output, entirely wrong bytes. Both rollback
 * notes (055 and 057) call that out by name as "an incident rather than a degradation" — and the
 * viewer, the one surface they single out, was the one surface with no retry.
 *
 * Dropping exactly the two post-migration columns returns every row otherwise whole: both facts
 * read UNKNOWN, which is the state every consumer of them already handles, and the revision pointer
 * — the thing whose loss is the incident — survives. A failure of the RETRY is a real database
 * failure rather than migration lag, and falls through to the empty-list catch as before.
 */
async function loadProjectSimulations(projectId: string): Promise<SimRowShape[]> {
  const where = eq(simulations.project_id, projectId);
  try {
    return await db.query.simulations.findMany({
      where,
      // `columns` is not an optimisation detail: without it Drizzle selects the WHOLE row for every
      // simulation — `guidance` (a full GuidanceEntry[]), `guidance_meta`, `bridge_functions` and
      // `canary_report` — on the hottest read path in the product, to read a handful of scalars.
      columns: {
        ...SIM_COLUMNS_PRE_CAPABILITIES,
        // Whether the ACTIVE revision's bridge acknowledges applied sections (migration 055).
        // A scalar for the same reason `prepare_budget_ms` is one: this list exists to keep the
        // hottest read path off the JSONB columns, and the fact itself lives in the revision's
        // metadata. The player's apply gate is the only consumer, and it needs the answer BEFORE
        // the first activation — which is precisely why it cannot be learned from the wire.
        bridge_ack_capable: true,
        // Does this package's entry document need import maps (migration 057, audit P0.8)? A
        // scalar here for the same reason as the one above, and read on EVERY sim section rather
        // than only on the modern path: a package that cannot resolve its bare specifiers never
        // paints at all, so the viewer needs the answer before it decides what to put on screen.
        requires_import_maps: true,
      },
    });
  } catch (err) {
    logger.error(
      { err, projectId },
      'buildPlayerConfig: simulation read failed — retrying without the post-migration capability columns',
    );
    const rows = await db.query.simulations.findMany({
      where,
      columns: SIM_COLUMNS_PRE_CAPABILITIES,
    });
    // UNKNOWN, explicitly. `?? false` here would tell the apply gate a bridge is proven silent and
    // the floor that a package is proven not to need import maps — two confident answers derived
    // from a missing column.
    return rows.map((r) => ({ ...r, bridge_ack_capable: null, requires_import_maps: null }));
  }
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
  /**
   * Which dubbed language to serve, or null for the source-language track (migration 067).
   *
   * Deliberately a SERVER-SIDE swap rather than something the player does. When this is set, each
   * segment's `hls_url` and `captions.vtt_url` are replaced with that language's rendition, so the
   * viewer plays a dubbed lesson through exactly the code path it plays any other lesson through —
   * no second player state, no audio-track switching, and no way for the audio and the captions to
   * come from different languages, because one decision here picks both.
   *
   * An unknown or unavailable language falls back to the source track rather than 404ing: a
   * shared /he link must not break when that dub is deleted or has not finished.
   */
  language: string | null = null,
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
  // Avatar circles config (audio-reactive overlays shown during b-roll). Tolerate a legacy
  // double-encoded JSON string for avatar_config.
  //
  // READ BEFORE THE FAN-OUT, not beside its consumer, because `wantsSpeakerTimeline` below decides
  // whether the `scenes` query runs at all — and a decision made after the queries can only narrow
  // one, never skip it. There is exactly ONE parse of this column in this file on purpose: two
  // readings of the same config that must agree is the drift class this codebase keeps paying for.
  const avatarConfigObj: { avatarCircles?: unknown } | null = (() => {
    const v = project.avatar_config as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as { avatarCircles?: unknown };
    if (typeof v === 'string') { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : null; } catch { return null; } }
    return null;
  })();

  /** Whether anything downstream reads the scene rows. Same truthiness test the consumer applies. */
  const wantsSpeakerTimeline = Boolean(avatarConfigObj?.avatarCircles);

  const [allVideos, sectionRows, imageRows, audioRows, allScenes, sequenceRows, simPoolMode, rumSampleRate, simRuntimeFlags, projectSimulations] = await Promise.all([
    db.query.video_files.findMany({
      where: eq(video_files.project_id, project.id),
      orderBy: [asc(video_files.created_at)],
    }),
    db.query.timeline_sections.findMany({
      where: eq(timeline_sections.project_id, project.id),
      // The SAME total order the editor reads in (`sections.controller` GET /sections), so the two
      // surfaces cannot disagree about one project. `start_sec` ALONE — what this was — ties for
      // every b-roll row of a project, because on that track `start_sec` is a source in-point and
      // is almost always 0; a tie lets Postgres return them in any order it likes, and the viewer's
      // `.find()` takes the first match. That is why "the wrong b-roll plays" was intermittent.
      // `id` is the primary key, so this order is total and nothing can tie.
      orderBy: [
        asc(timeline_sections.sort_order),
        asc(timeline_sections.start_sec),
        asc(timeline_sections.global_offset_sec),
        asc(timeline_sections.id),
      ],
    }),
    db.query.image_files.findMany({ where: eq(image_files.project_id, project.id) }),
    db.query.audio_files.findMany({ where: eq(audio_files.project_id, project.id) }),
    // FOUR SCALARS, AND ONLY WHEN SOMETHING READS THEM (database-005).
    //
    // This is the hottest read path in the product — every player config, share page, playlist
    // item and course render goes through it — and this row used to select `scenes.*`. That
    // means `transcript` (text) and `aligned_words` (jsonb, word-level alignment) came back for
    // every scene in the project, on every one of those reads.
    //
    // Its ONLY consumer is `normalizeSpeakerTimeline`, whose `SceneRow` is exactly the four
    // columns below — and it is called only when avatar circles are configured, which most
    // projects do not use. So the fetch was not merely wide, it was usually wasted entirely.
    // Every sibling query in this `Promise.all` already narrows; `scenes` was the outlier.
    wantsSpeakerTimeline
      ? db.query.scenes.findMany({
          where: eq(scenes.project_id, project.id),
          columns: { speaker: true, start_ms: true, end_ms: true, script_version: true },
        })
      : Promise.resolve([]),
    db.query.branch_sequences.findMany({
      where: eq(branch_sequences.project_id, project.id),
      orderBy: [asc(branch_sequences.sort_order), asc(branch_sequences.created_at)],
    }),
    resolveSimPoolMode(),
    resolveRumSampleRate(),
    resolveSimRuntimeFlags(),
    // The package identity + canary verdict for every simulation this project references. The
    // narrow `columns` list and its degraded-column RETRY both live in `loadProjectSimulations`.
    //
    // The try/catch matches the precedent set by `resolveSimPoolMode` above: `package_class` and
    // friends arrive in migration 049, and an app image that boots before the migration is applied
    // must not 500 EVERY viewer surface over a feature no stored package can use yet.
    //
    // A degraded read here is NOT harmless, which is why the retry inside `loadProjectSimulations`
    // exists and this catch is the LAST resort. An empty list makes every simulation look
    // revision-less, so `simulationUrlOf` falls back to the stored legacy URL and the identity
    // axis falls back to the pre-revision derivation — correct-looking output, entirely wrong
    // bytes, with nothing surfaced. It still must not 500 the viewer, so the catch stays; but a
    // project with sim sections and no simulation rows is an incident, not a degradation.
    loadProjectSimulations(project.id)
      .catch((err: unknown) => {
        logger.error({ err, projectId: project.id }, 'buildPlayerConfig: simulation rows unavailable — every sim degrades to the legacy package');
        return [] as SimRowShape[];
      }),
  ]);

  // ONE orientation for the whole config (night run 2026-09-03 §3): the primary video's probed
  // geometry decides, unknown is landscape. 'portrait' selects portrait poster identities and
  // suppresses the crop track below.
  const orientation = projectOrientation(allVideos);
  const posterAspect = orientation === 'portrait' ? 'portrait' as const : 'wide' as const;

  // Re-applied IN MEMORY, not because the `ORDER BY` above is wrong but because this order is a
  // contract and a contract needs one owner. `compareTimelineSections` is that owner; the SQL is an
  // optimisation that lets Postgres do the work. Belt and braces here is cheap (one sort of a small
  // per-project list) and it means the guarantee survives a driver, a cache or a caller that hands
  // this function rows from anywhere else.
  const sections = sortTimelineSections(sectionRows);

  // Main video segments (uploaded by user, not AI-generated broll sources)
  const mainVideos = allVideos.filter((v) => !v.is_broll);

  // ── Dubbed languages (migration 067) ────────────────────────────────────────
  //
  // One query for the whole project, keyed `{videoId}:{language}`, because the alternative is a
  // lookup per segment on the hottest read path in the product. Only SERVABLE dubs are indexed —
  // `isDubServable` rejects a watermarked or rendition-less row — so a half-finished or
  // unshippable dub is invisible here rather than being something every read site has to remember
  // to filter.
  const dubRows = mainVideos.length > 0
    ? await db.query.video_dubs.findMany({
        where: inArray(video_dubs.video_file_id, mainVideos.map((v) => v.id)),
      })
    : [];
  const servableDubs = new Map<string, (typeof dubRows)[number]>();
  for (const dub of dubRows) {
    if (isDubServable(dub)) servableDubs.set(`${dub.video_file_id}:${dub.target_language}`, dub);
  }

  /**
   * A language is offered to the viewer only when EVERY main video has a servable dub in it.
   *
   * The strict rule is the honest one. Offering a partly-dubbed language would give a viewer a
   * lesson that switches back to the source language partway through, with the captions following
   * it — which reads as a broken player rather than as a partial translation. A creator sees the
   * per-video truth on the settings page; a viewer sees only languages that work end to end.
   */
  const offeredLanguages = [...new Set(dubRows.map((d) => d.target_language))]
    .filter((lang) => mainVideos.every((v) => servableDubs.has(`${v.id}:${lang}`)))
    .sort();

  // A requested language that is not fully available falls back to the source track. A shared /he
  // link must keep working when that dub is deleted or is still processing.
  const activeLanguage = language && offeredLanguages.includes(language) ? language : null;

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

    // ONE identity function for the player, the export and the editor's capture (sectionPosterKey.ts).
    const key: PosterKey = posterKeyForSection(s, packageRevision, posterAspect);

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
  /**
   * A stored `simulation_url` per simulation id, for the legacy `?v=` fallback below.
   *
   * First one wins: every section of a package shares one pooled document and one runtime client,
   * so they must resolve to ONE revision — which is the same reason `packageRevisionFor` derives
   * from the bridge hash rather than from each section's own URL.
   */
  const urlForSim = new Map<string, string>();
  for (const sec of sections) {
    if (sec.simulation_id && sec.simulation_url && !urlForSim.has(sec.simulation_id)) {
      urlForSim.set(sec.simulation_id, sec.simulation_url);
    }
  }

  /**
   * The identity axis for one simulation ROW — the key field measurements are grouped by.
   *
   * MUST MATCH `packageRevisionFor` EXACTLY, including its `?v=` fallback for a package whose
   * bridge predates the column. Omitting the fallback here forked the identity axis: legacy
   * packages were looked up under a key the client never reports under, so their field data was
   * silently never found — the closed loop reported "no samples" forever for exactly the packages
   * most likely to be slow. This file's own comment warns that a forked axis is what costs every
   * poster; the same fork cost every field measurement.
   */
  const packageRevisionForRow = (row: SimRowShape): string | null => {
    try {
      let bridgeHash: string | null = row.bridge_hash;
      if (!bridgeHash) {
        const url = urlForSim.get(row.id);
        if (url) {
          const m = /[?&]v=([^&#]+)/.exec(url);
          bridgeHash = m ? m[1] : url;
        }
      }
      return revisionIdentityFor(
        { id: row.id, bridge_hash: bridgeHash, active_revision_id: row.active_revision_id },
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
  /** Canary-derived only — never refined by field data. See the note at the emit site below. */
  const simLabBudgets: Record<string, number> = {};
  const revisionsForField = [...simRows.values()]
    .map((r) => packageRevisionForRow(r))
    .filter((r): r is string => typeof r === 'string' && r.length > 0);
  // NOT GATED ON `rumSampleRate`. Gating it there was tried and reverted: the rate controls
  // COLLECTION, not USE, so an operator who samples for a week and then turns collection back off
  // would silently lose every budget the week produced — at the exact moment the data became
  // complete. The cost is one grouped, indexed query, skipped entirely when no package on the
  // project has a revision to look up.
  const field = revisionsForField.length > 0
    ? await fieldAggregates(revisionsForField).catch(() => new Map())
    : new Map();
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
    // THE LAB NUMBER, UNREFINED, emitted separately.
    //
    // `sim_prepare_budget_ms` above is the LEAD TIME, and refining it with field data is exactly
    // right for deciding how early to prepare. It is the wrong input for adaptive quality, which
    // judges a device's p90 against a standard: once >=30 credible rows exist the emitted budget IS
    // the fleet p90 x 1.25, so a device that dominates its own package's aggregate would be judged
    // against 1.25x its own p90 — the same tautology the client-side fix removed, arriving from the
    // server instead. The canary number is a property of the PACKAGE and of nobody's device, which
    // is what a standard has to be.
    if (lab !== null) simLabBudgets[simId] = lab;
  }

  // Per-package total weight from the ACTIVE revision's publish-time report. Until now
  // `metadata.weight` was written at publication and read by nothing player-facing — so a 35MB
  // package and a 500KB one were indistinguishable to pool residency and to the prepare failure
  // bound (sim-review 2026-09-04, P1). Absent (legacy revision, no weight report) means
  // "unmeasured", never 0 — the client only ever uses a weight it actually has.
  const simWeightBytes: Record<string, number> = {};
  {
    const revToSim = new Map<string, string>();
    for (const [simId, row] of simRows) {
      if (typeof row.active_revision_id === 'string' && row.active_revision_id) {
        revToSim.set(row.active_revision_id, simId);
      }
    }
    if (revToSim.size > 0) {
      // Failure here (or a test double without .select) yields an empty map, never a failed
      // config — same posture as the fieldAggregates lookup above.
      const revRows = await Promise.resolve()
        .then(() => db
          .select({ id: sim_revisions.id, metadata: sim_revisions.metadata })
          .from(sim_revisions)
          .where(inArray(sim_revisions.id, [...revToSim.keys()])))
        .catch(() => [] as { id: string; metadata: unknown }[]);
      for (const rev of revRows) {
        // Tolerate the db/jsonb.ts double-encoding: a metadata stored as a jsonb STRING scalar
        // comes back as the JSON text; parse it before reading the report.
        let meta: unknown = rev.metadata;
        if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
        const total = (meta as { weight?: { totalBytes?: unknown } } | null)?.weight?.totalBytes;
        const simId = revToSim.get(rev.id);
        if (simId && typeof total === 'number' && Number.isFinite(total) && total > 0) {
          simWeightBytes[simId] = total;
        }
      }
    }
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
   * So the pointer is resolved on the way out — by the SHARED resolver, which is the only place
   * that knows how. It used to be a closure here, which is precisely why the editor's own read of
   * `timeline_sections` served retired bytes (audit §9.6): a rule that lives in one caller is a
   * rule the other callers do not follow.
   */
  const simulationUrlOf = simulationUrlResolver(simRows, storage);

  /**
   * Three states, and the third one is the point (audit P0.5).
   *
   * `true`/`false` are the publication's own answer about the bytes being served. `null` — no row,
   * no column, or a package published before migration 055 — is UNKNOWN, and the player's apply
   * gate has a distinct branch for it. Coercing the absence to `false` here would tell the gate
   * "this package cannot acknowledge, so reveal immediately", which is the first-activation hole
   * this record exists to close, restored by a default.
   */
  const bridgeAckCapableFor = (simId: string | null): boolean | null => {
    if (!simId) return null;
    const row = simRows.get(simId) as { bridge_ack_capable?: boolean | null } | undefined;
    return typeof row?.bridge_ack_capable === 'boolean' ? row.bridge_ack_capable : null;
  };

  /**
   * The browser capability floor, as a package property (audit P0.8).
   *
   * `true`/`false` are the publication's own answer about the bytes being served. `null` — no row,
   * no column, or a package published before migration 057 — is UNKNOWN, and the viewer's floor
   * treats unknown as "no known requirement". Coercing the absence to `true` here would poster-only
   * every legacy package on an older browser for a need it may not have; coercing it to `false`
   * would be the same lie in the other direction, so both stay distinguishable from a real answer.
   */
  const requiresImportMapsFor = (simId: string | null): boolean | null => {
    if (!simId) return null;
    const row = simRows.get(simId) as { requires_import_maps?: boolean | null } | undefined;
    return typeof row?.requires_import_maps === 'boolean' ? row.requires_import_maps : null;
  };

  const packageClassFor = (simId: string | null): SimPackageClass | null => {
    if (!simId) return null;
    const row = simRows.get(simId) as { package_class?: string | null } | undefined;
    const cls = row?.package_class ?? null;
    return cls ? (cls as SimPackageClass) : null;
  };

  const buildSegment = (v: (typeof allVideos)[number]) => {
    // The dubbed rendition for the requested language, if this video has a servable one. A video
    // without one keeps its source track — a project whose lessons are only partly dubbed plays
    // through, in the languages it has, rather than failing whole.
    const dub = activeLanguage ? servableDubs.get(`${v.id}:${activeLanguage}`) ?? null : null;

    const hls_url = dub?.hls_master_key
      ? storage.getPublicUrl(dub.hls_master_key)
      : v.hls_master_key
        ? storage.getPublicUrl(v.hls_master_key)
        : v.hls_360p_key
          ? storage.getPublicUrl(v.hls_360p_key)
          : null;
    const fallback_url = hls_url;

    // Only non-broll sections for this main video.
    //
    // DELIBERATELY NOT routed through `classifyTimelineSection`. Despite the name, this array is
    // the segment's whole main-track section list — clips and plain video sections ride in it
    // alongside the simulations, and the player reads `type` off each one. `track === 'main'` here
    // is a SEGMENT-MEMBERSHIP test ("does this row belong to this video?"), not a shape dispatch,
    // so swapping in the lane router would silently drop every main-track clip from the segment.
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
          // Does this package's bridge acknowledge an applied section? Null means never recorded,
          // which the apply gate treats as UNKNOWN rather than as either answer.
          bridge_ack_capable: bridgeAckCapableFor(s.simulation_id),
          // Does this package need `<script type="importmap">` support to run at all? Null means
          // never recorded, which the viewer's capability floor treats as "nothing known to be
          // missing" — it never downgrades a package on a guess.
          requires_import_maps: requiresImportMapsFor(s.simulation_id),
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

    // A portrait project never gets a crop track: the source already IS the portrait frame, and
    // a crop applied to it would cut the top and bottom off (night run 2026-09-03 §3). This is the
    // cheapest kill switch — the viewer's overlay does nothing without a URL.
    const crop_url = orientation !== 'portrait' && v.crop_status === 'ready' && v.crop_key
      ? storage.getPublicUrl(v.crop_key) : null;

    return {
      id: v.id,
      label: v.filename,
      duration_sec: v.duration_sec ?? 0,
      hls_url,
      fallback_url,
      hls_status: v.hls_status,
      crop_url,                 // smart portrait-crop metadata (null until ready)
      // THE INTEGRITY RULE, enforced structurally: when a dub is being served, its captions come
      // from that same dub and nothing else. `dub` decided the audio two dozen lines above, so the
      // audio and the caption text are two halves of one decision and cannot be made to disagree.
      captions: dub
        ? {
            status: (dub.captions_vtt ? 'ready' : 'none') as 'none' | 'ready',
            vtt_url: dub.captions_vtt ? dubCaptionUrl(v.id, dub.target_language) : null,
            error: null,
          }
        : {
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

  // ── Overlay dispatch ────────────────────────────────────────────────────────
  //
  // ONE partition, not four filters. The four `.filter()`s that used to stand here each re-derived
  // "what is this row?" on their own, and two of them — `track==='broll' && !clip_source_audio_id`
  // and `type==='clip' && clip_source_video_id` — were NOT disjoint. A row that is
  // `track='broll' AND type='clip' AND clip_source_video_id IS NOT NULL` satisfied both and was
  // emitted TWICE, at two different offsets, into the one array the viewer concatenates and
  // `.find()`s over: the clip played twice, and the export and the editor each showed a third
  // answer. Routing every row through `classifyTimelineSection` makes double emission structurally
  // impossible rather than merely unlikely — a row is in exactly one bucket because the buckets are
  // a partition. Which bucket a hybrid lands in is decided explicitly in that module (`track` beats
  // `type`, because `type` is the column the section editor rewrites behind the user's back).
  //
  // AND, since D-01, how each lane computes its offset is no longer decided here either. Every lane
  // below places its rows through `resolveSectionPlacement`, the ONE resolver the export planner and
  // the editor also call. The b-roll lane used to read the stored `global_offset_sec` and the clip
  // lane used to re-derive a running sum of `duration_sec` inline; those two representations of the
  // same authored moment come apart the moment a main video is re-transcoded, and each surface
  // having written the derivation out by hand is what let them come apart DIFFERENTLY.
  const overlayLanes = groupTimelineSectionsByLane(sections);

  const hybrids = sections.filter((s) => classifyTimelineSection(s) === 'broll_clip_hybrid');
  if (hybrids.length > 0) {
    // One line for the whole build, not one per row. These used to double-emit; now they play once,
    // in the b-roll lane — but a row that is two shapes at once is still a data defect someone has
    // to repair, and it was previously invisible from the outside.
    logger.warn(
      { projectId: project.id, sectionIds: hybrids.map((s) => s.id) },
      'buildPlayerConfig: broll sections carry a clip source — played as broll, clip pointer ignored',
    );
  }

  // Rows no lane can place — a clip section with no source. DEBUG, not warn: the editor's
  // Add → "Existing clip" deliberately creates exactly this as a provisional row for the user to
  // fill in, so it is a normal transient state on a project being edited, not an incident. It was
  // previously indistinguishable from a row that had been silently swallowed.
  if (overlayLanes.none.length > 0) {
    logger.debug(
      { projectId: project.id, sectionIds: overlayLanes.none.map((s) => s.id) },
      'buildPlayerConfig: sections reference no placeable source — omitted from every overlay lane',
    );
  }

  // Every video in the project by id — the source lookup for BOTH the b-roll lane and the clip
  // lane. The b-roll lane used to have its own narrower map, built from `is_broll` videos only, and
  // that is exactly what silently dropped a "Use Existing" b-roll sourced from a normal uploaded
  // clip: the editor offers those videos, the API accepts them, the editor previews them, and the
  // export resolves them through its own all-videos map — the player was the one surface that
  // omitted them, with no log line, no warning field and no counter. One map for both lanes is what
  // makes those four surfaces agree; it invents nothing and needs no migration.
  const allVideoMap = new Map(allVideos.map((v) => [v.id, v]));

  // ── The main segment timeline (D-01) ────────────────────────────────────────
  //
  // The concatenation of this project's main videos: segment i owns `[start_i, start_i + dur_i)`,
  // half-open, so a placement exactly on a seam belongs to the LATER segment and has one answer
  // instead of two. Built ONCE here and handed to every lane, and built by the shared helper rather
  // than by the running sum that used to sit inline below — the export planner builds it from the
  // same function off the same `created_at ASC` query, which is what stops the viewer and the export
  // disagreeing about what second a clip is at.
  const mainTimeline = buildMainSegmentTimeline(allVideos);

  /**
   * WHERE ONE ROW SITS, and the only place this file answers that.
   *
   * Dual read, anchor first: a row carrying `placement_mode='segment'` is placed by its anchor pair
   * and therefore MOVES WITH ITS HOST when that host is re-transcoded; every legacy row falls back
   * to its stored `global_offset_sec` and behaves exactly as it did before this change. A row whose
   * anchor cannot be resolved — most plausibly because its host video was deleted, which sets the
   * FK to NULL — also falls back, and says why, because a b-roll that quietly vanished from the
   * viewer would be far worse than one playing at a stale second.
   */
  const placementOf = (s: (typeof sections)[number]) => {
    const at = resolveSectionPlacement(s, mainTimeline);
    if (at.degradation) {
      logger.warn(
        { projectId: project.id, sectionId: s.id, degradation: at.degradation, absoluteSec: at.absoluteSec },
        'buildPlayerConfig: section placement degraded — played at its fallback second',
      );
    }
    return at.absoluteSec;
  };

  // Build broll_clips from broll sections — each broll section points to a source video.
  const brollClips = overlayLanes.broll
    .map((s) => {
      const brollVid = allVideoMap.get(s.video_file_id);
      if (!brollVid) {
        // Reachable when the source belongs to another project (the FKs check existence, not
        // tenancy) — the row is inert, but silence here is what made the parity bug invisible.
        logger.warn(
          { projectId: project.id, sectionId: s.id, videoFileId: s.video_file_id },
          'buildPlayerConfig: broll section dropped — source video is not in this project',
        );
        return null;
      }
      const hls_url = brollVid.hls_master_key
        ? storage.getPublicUrl(brollVid.hls_master_key)
        : brollVid.hls_360p_key
          ? storage.getPublicUrl(brollVid.hls_360p_key)
          : null;
      if (!hls_url) {
        // The export renders this one anyway, from `storage_key`. The viewer needs HLS and has
        // none, so it still drops the row — but says so, exactly as the export already does.
        logger.warn(
          { projectId: project.id, sectionId: s.id, videoFileId: s.video_file_id, hlsStatus: brollVid.hls_status },
          'buildPlayerConfig: broll section dropped — source video has no playable HLS rendition',
        );
        return null;
      }
      return {
        id:                s.id,
        hls_url,
        global_offset_sec: placementOf(s),
        start_sec:         s.start_sec,
        end_sec:           s.end_sec,
        label:             s.label,
        broll_volume:      s.broll_volume ?? 1.0,
      };
    })
    .filter(Boolean);

  // Build clip_overlays from clip sections — user-trimmed library videos shown as overlay.
  const clipOverlays = overlayLanes.clip_video
    .map((s) => {
      const srcVideo = allVideoMap.get(s.clip_source_video_id!);
      if (!srcVideo) return null;
      const hls_url = srcVideo.hls_master_key
        ? storage.getPublicUrl(srcVideo.hls_master_key)
        : srcVideo.hls_360p_key
          ? storage.getPublicUrl(srcVideo.hls_360p_key)
          : null;
      if (!hls_url) return null;

      const sectionDuration = s.end_sec - s.start_sec;
      const clipIn = s.clip_in_sec ?? 0;

      return {
        id:                s.id,
        hls_url,
        // `segmentStart(host) + start_sec` — the same running sum as before, now stated once in the
        // resolver. The `?? 0` this replaced turned a host outside the main timeline into second
        // zero without a word; the resolver still places it there but says so.
        global_offset_sec: placementOf(s),
        start_sec:         clipIn,
        end_sec:           clipIn + sectionDuration,
        label:             s.label,
        broll_volume:      1.0,
      };
    })
    .filter(Boolean);

  // Build image_overlays from clip sections that reference an image file
  const imageFileMap = new Map(imageRows.map((img) => [img.id, img]));

  const imageOverlays = overlayLanes.clip_image
    .map((s) => {
      const img = imageFileMap.get(s.clip_source_image_id!);
      if (!img) return null;
      return {
        id:                s.id,
        image_url:         img.original_url,
        global_offset_sec: placementOf(s),
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

  const audioCutaways = overlayLanes.audio_cutaway
    .map((s) => {
      const af = audioFileMap.get(s.clip_source_audio_id!);
      if (!af) return null;
      return {
        id:                s.id,
        audio_url:         af.url,
        // The SAME abstraction as b-roll, per the ruling: an audio cutaway is placed by its own
        // offset on whichever track it sits on, so it drifts the same way and anchors the same way.
        global_offset_sec: placementOf(s),
        start_sec:         s.start_sec,
        end_sec:           s.end_sec,
        label:             s.label,
        broll_volume:      s.broll_volume ?? 1.0,
      };
    })
    .filter(Boolean);

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
    // The project's frame: 'portrait' when the primary video is taller than wide (082 geometry),
    // 'landscape' otherwise and for everything probed before 082. The editor preview, the lesson
    // page and the poster identity above all key off this one word.
    orientation,
    segments,
    // ── The viewer's language switcher (migration 067) ──────────────────────
    //
    // `language` is what is PLAYING — null means the source track. `available_languages` is what
    // the switcher may offer, and it never contains the source language, because "switch back to
    // the original" is a different action from "switch to a translation" and the player renders it
    // as such. Both are emitted unconditionally: a project with no dubs sends `null` and `[]`, and
    // a viewer that receives them draws no switcher at all.
    language: activeLanguage,
    available_languages: offeredLanguages.map((code) => {
      const meta = findDubbingLanguage(code);
      return {
        code,
        name: meta?.name ?? code,
        endonym: meta?.endonym ?? code,
        rtl: meta?.rtl ?? false,
      };
    }),
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
    // The frame-valid transition coordinator (migration 054, audit P0.1). OFF is byte-for-byte
    // today's simulation→video exit; the server value is authoritative and there is no URL override.
    sim_transition_coordinator: simRuntimeFlags.transitionCoordinator,
    // Per-package preparation budgets from each package's own publish-time canary. Emitted as a map
    // rather than per section because a package's cost is a property of its BYTES, not of where it
    // happens to appear on a timeline — and one package commonly appears in many sections.
    sim_prepare_budget_ms: simPrepareBudgets,
    // The canary number alone. Adaptive quality judges against this, never against the refined
    // lead time above — see the note at the emit site.
    sim_lab_budget_ms: simLabBudgets,
    // Total package weight of each simulation's active revision — pool residency demotes the
    // up-front-mount tier when the pooled set is byte-heavy, and the prepare failure bound
    // extends for packages whose bytes justify it. Absent key = unmeasured, never zero.
    sim_weight_bytes: simWeightBytes,
  };
}

function videoCaptionStatus(status: string | null | undefined): 'none' | 'processing' | 'ready' | 'failed' {
  return status === 'processing' || status === 'ready' || status === 'failed' ? status : 'none';
}

/** sim_meta.uiControls.hide as a clean string[] — undefined (key omitted in JSON) when the
 *  section has no Minimal-UI selection, an empty hide list, or malformed jsonb. */
