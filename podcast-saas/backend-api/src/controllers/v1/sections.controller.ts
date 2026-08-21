import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/index.js';
import {
  timeline_sections, simulations, video_files, branch_sequences, placement_impact_reviews,
} from '../../db/schema.js';
import { eq, and, asc, desc, inArray, isNull } from 'drizzle-orm';
import { firebaseAuthMiddleware } from '../../middleware/firebase-auth.js';
import { editableProject } from '../../services/collabAccess.js';
import {
  SimulationService,
  type ConversationMessage,
  type SectionPersistHook,
} from '../../services/simulation/SimulationService.js';
import {
  SIM_UI_CONTROLS_PARAM_MAX_CHARS,
  SimUiSelectionSchema,
  normalizeSimUiSelection,
  readStoredUiControls,
  simUiSelectionsEqual,
  type SimUiSelection,
} from '../../services/simulation/SimUiControls.js';
import {
  withServedSimulationUrls,
  type SimRevisionPointerRow, type WithServedSimFields,
} from '../../services/simulation/simulationUrlResolver.js';
import { getStorageAdapter } from '../../services/storage/getStorageAdapter.js';
import { logger } from '../../lib/logger.js';
import { resolveReviewsAfterReplacement } from '../../services/timeline/placementImpact.js';
import {
  newTimelineSectionViolations, sortTimelineSections, timelineSectionViolations,
  anchorPlacementViolations, buildMainSegmentTimeline, deriveAnchorForAbsoluteSec, isAnchorable,
  planAnchorBackfill, resolveSectionPlacement,
  type MainSegmentTimeline, type PlacementSectionLike, type TimelineSectionLike,
} from 'shared';
import { LLMService } from '../../services/llm/LLMService.js';
import { ApiKeyService } from '../../services/secrets/ApiKeyService.js';
import { UsageTrackingService } from '../../services/usage/UsageTrackingService.js';

const _llmService = new LLMService(new ApiKeyService(), new UsageTrackingService());

// Single shared SimulationService for this controller. The bridge.js read-modify-write
// lock (SimulationService.withBridgeLock) lives in a per-INSTANCE map, so a new instance
// per request only serialized retries within one call — two different sections of the SAME
// simulation generating concurrently each read the same bridge.js and the later write
// clobbered the earlier section's entry. Sharing one instance (hence one bridgeLocks map)
// across requests makes the lock effective process-wide. Lazily constructed so the storage
// adapter is resolved AFTER the startup R2→local probe (getStorageAdapter can be flipped to
// local at boot). (backend-101; still process-local — a cluster needs a durable advisory lock.)
let _simService: SimulationService | null = null;
function getSimService(): SimulationService {
  if (!_simService) _simService = new SimulationService(getStorageAdapter(), _llmService);
  return _simService;
}

// Per-section generation lock: two near-simultaneous generate requests for the SAME section
// (double-click, retry, two editor tabs) both read the same conversationHistory and race the
// final write, so the later one clobbers the earlier and the merged bridge can reference a URL
// that was never persisted. We let only one generation per section proceed at a time (backend-005).
const activeSimGenerations = new Set<string>();

// Hard BACKSTOP for a single sim-script generation so a hung LLM provider can't pin an open
// SSE socket forever (backend-007). This is the pathological ceiling, NOT the expected time:
// bridge_plan runs on claude-opus-4-8 with adaptive thinking (always on) + effort:'high' at
// max_tokens 32000, streamed — one call alone realistically takes 1.5-6 min, and a generation
// can make an initial call + one validation-retry call. The old 120s guard fired mid-thought on
// legitimate generations ("Generation timed out"); 15 min leaves room for the retry path while
// still killing a truly wedged provider. A stall-aware heartbeat (runSseGeneration) keeps the
// UI honest in the meantime so the long wait never looks frozen.
const SIM_GEN_TIMEOUT_MS = 900_000;

/** Resolve a simulation's entry_file (may be a storage key or a legacy full URL) to a public URL. */
function resolveSimEntryUrl(entryFile: string | null): string | null {
  if (!entryFile) return null;
  // New rows store the storage key; old rows stored the full URL (backward compat).
  return entryFile.startsWith('http') ? entryFile : getStorageAdapter().getSimPublicUrl(entryFile);
}

/**
 * Attach `ServedSimFields` — the bytes that are live right now, and what publication recorded about
 * them — to a section list.
 *
 * ONE query for the whole list, never one per section: the pointer read is project-scoped and
 * indexed, exactly as `buildPlayerConfig` does it, and is skipped entirely for a project with no
 * simulation sections (which is most of them). `columns` keeps it to four scalars — the row also
 * carries `guidance`, `bridge_functions` and `canary_report`, none of which this needs.
 *
 * EVERY section-shaped response in this file goes through here, reads and writes alike. It used to
 * be the read paths only, and the two write endpoints returned the raw row: every client update
 * path (`TimelinePanel`'s drag/trim/move, `VideoEditor`'s undo/redo) splices that response straight
 * into editor state, so one drag replaced a section carrying all three facts with one carrying
 * none. `simulation_served_url` had a client-side compensation (`servedSimUrls` in VideoEditor);
 * the other two had none, so a drag silently downgraded a proven bridge to UNKNOWN and — the one
 * that costs a user something they can see — erased a recorded `requires_import_maps`, replacing
 * P0.8's honest cue with exactly the blank frame it exists to end. The fix is at the SOURCE: the
 * write endpoints return the same enriched shape the bootstrap reads return, so there is nothing
 * for a client to have to remember.
 *
 * The extra query is paid only by a section that HAS a simulation — the early return below skips it
 * for every other row, which is what a drag on a video or b-roll section is.
 *
 * The degraded read mirrors buildPlayerConfig's: `active_revision_entry_key` arrives in migration
 * 050, and an app image that boots before it is applied must not 500 the editor. Degrading means
 * every section falls back to its stored URL — which is today's behaviour, and wrong bytes rather
 * than no editor — so it is logged as an incident rather than swallowed.
 */
async function withServedSimUrls<T extends { simulation_id: string | null; simulation_url: string | null }>(
  projectId: string,
  sections: readonly T[],
): Promise<Array<WithServedSimFields<T>>> {
  if (!sections.some((s) => s.simulation_id)) {
    return sections.map((s) => ({
      ...s, simulation_served_url: s.simulation_url, requires_import_maps: null, bridge_ack_capable: null,
    }));
  }
  // try/catch rather than `.catch()`: this now runs on the WRITE paths too, where the row is
  // already committed. A response that failed here would tell the client its edit did not happen —
  // after it did — and leave the editor's optimistic state diverged from the database. Degrading
  // (every section falls back to its stored URL, both capabilities UNKNOWN) is the pre-migration
  // behaviour and is loudly logged; failing is not an option a committed write leaves open. The
  // wider form also covers a SYNCHRONOUS throw, which `.catch()` on the returned promise does not.
  let pointerRows: SimRevisionPointerRow[];
  try {
    pointerRows = await db.query.simulations.findMany({
      where: eq(simulations.project_id, projectId),
      // `requires_import_maps` (migration 057, audit P0.8) and `bridge_ack_capable` (migration 055,
      // audit P0.5) are two more scalars off the row this query already loads — the alternative is
      // a second read, on both editor bootstrap paths, to learn whether the document the editor is
      // about to mount can paint on this browser at all and whether its bridge acknowledges the
      // sections the editor dispatches into it.
      columns: {
        id: true, active_revision_entry_key: true, requires_import_maps: true, bridge_ack_capable: true,
      },
    });
  } catch (err) {
    logger.error({ err, projectId }, 'sections: revision pointers unavailable — the editor falls back to stored URLs');
    pointerRows = [];
  }
  return withServedSimulationUrls(sections, pointerRows, getStorageAdapter());
}

/**
 * The same shaping for ONE row — every write endpoint's response.
 *
 * A separate name only because the singular call reads badly inline; it is the list helper with a
 * one-element list, deliberately, so a write response can never drift from a read response.
 */
async function servedSection<T extends { simulation_id: string | null; simulation_url: string | null }>(
  projectId: string,
  section: T,
): Promise<WithServedSimFields<T>> {
  return (await withServedSimUrls(projectId, [section]))[0];
}

// ── Simulation-generation error mapping ───────────────────────────────────────
// Module scope + exported so the SSE/HTTP error contract is unit-testable without a route.

export function classifySimulationError(err: unknown): string {
  if (err instanceof Error) {
    // A lost activation compare-and-set: a CONCURRENT publication for the same simulation was
    // activated first. Nothing was overwritten (the loser's bytes sit in an inactive revision
    // prefix), so the correct client response is a retry, not a bug report. Matched by name
    // rather than instanceof so the check cannot be defeated by a second copy of the class.
    if (err.name === 'RevisionConflict') return 'conflict';
    const msg = err.message.toLowerCase();
    if (err.name === 'AbortError' || msg.includes('generation cancelled')) return 'aborted';
    if (msg.includes('overloaded') || msg.includes('529'))                 return 'ai_overloaded';
    if (msg.includes('rate_limit') || msg.includes('429'))                 return 'limit_exceeded';
    if (msg.includes('no html entry') || msg.includes('not found'))        return 'not_found';
    if (msg.includes('non-json plan'))                                     return 'validation_error';
  }
  return 'generation_error';
}

export const ERROR_MESSAGES: Record<string, string> = {
  aborted:          'Generation was cancelled.',
  ai_overloaded:    'AI is busy right now. Please try again in a moment.',
  limit_exceeded:   'Rate limit reached. Please wait before trying again.',
  not_found:        'Simulation files not found. Please re-upload the simulation.',
  validation_error: 'AI returned an unexpected response. Please try a different prompt.',
  conflict:         'A concurrent generation for this simulation completed first — nothing was overwritten. Please retry.',
  generation_error: 'Generation failed. Please try again or simplify your prompt.',
};

// ── Section write schemas ─────────────────────────────────────────────────────
//
// These two endpoints were the only unvalidated writes into `timeline_sections`, and the table has
// no CHECK constraint to fall back on. Every OTHER writer — the b-roll panel, the generator, the
// audio-cutaway route — is a zod-validated endpoint that can produce exactly one shape, which is
// why the malformed shapes the census counts can only have come from here.
//
// The split of responsibility below is deliberate:
//   • the SCHEMAS check what a field IS — a number rather than a string, finite rather than NaN,
//     a non-empty id, one of the three legal tracks;
//   • `timelineSectionViolations` (shared) checks what a ROW is — ranges, the interval, and the
//     field COMBINATIONS that decide which of the three shapes a row is.
//
// Ranges live on the row side rather than in the schema on purpose. It lets POST be strict (a fresh
// row has no history, so every violation is one this request is introducing) while PATCH is held to
// the weaker and correct rule that it may not make a row WORSE — see the note on the PATCH handler.
//
// Ids are `z.string().min(1)`, not `.uuid()`: the foreign keys already enforce existence, and
// tightening the format here would be a second, redundant, and independently-driftable rule.

/** Readable first-issue message from a Zod error, prefixed with the field path. */
const firstZodMessage = (e: z.ZodError): string => {
  const i = e.issues[0];
  return i ? `${i.path.join('.') || 'request'}: ${i.message}` : 'Invalid request';
};

/** A second-valued field. Finiteness here; the legal RANGE is a row rule (see above). */
const zSeconds = z.number().finite();
const zId = z.string().min(1);
const zTrack = z.enum(['main', 'broll', 'audio']);

const SECTION_FIELDS = {
  start_sec: zSeconds,
  end_sec: zSeconds,
  type: z.string().min(1).max(64),
  label: z.string().max(1_000).nullish(),
  notes: z.string().max(100_000).nullish(),
  sort_order: z.number().int().nullish(),
  simulation_url: z.string().max(4_096).nullish(),
  // NOT `zId`: an EMPTY STRING is this field's documented "clear the simulation" signal, and both
  // handlers already fold it to null (`simulation_id || null`). The clip source ids below have no
  // such contract — they are cleared with an explicit null — so they stay non-empty.
  simulation_id: z.string().max(255).nullish(),
  sim_script: z.string().nullish(),
  sim_prompt: z.string().nullish(),
  sim_meta: z.unknown().optional(),
  global_offset_sec: zSeconds.nullish(),
  clip_source_video_id: zId.nullish(),
  clip_in_sec: zSeconds.nullish(),
  // NOT nullish: the column is NOT NULL with a default, so an explicit null here is a client bug
  // that used to reach Postgres and fail there. It fails with a readable message instead.
  broll_volume: z.number().finite().optional(),
  simple_ui: z.boolean().optional(),
  auto_script: z.boolean().optional(),
  clip_source_image_id: zId.nullish(),
  camera_movement: z.string().max(64).optional(),
  clip_source_audio_id: zId.nullish(),
  // ── Segment-relative placement (D-01) ──────────────────────────────────────────────────────
  //
  // A client MAY send the anchor explicitly; nothing in the product does yet, and it does not have
  // to. When a request moves an overlay — sets `global_offset_sec` to a value it did not already
  // have — the handler derives the anchor itself from the project's live timeline. That is the
  // ruling's "author drag (keep current visible location)": the author is asserting, right now,
  // where they can see the clip, so expressing that as a segment offset canonises nothing that was
  // not just chosen. It is also why no client change is needed to start anchoring.
  anchor_video_file_id: zId.nullish(),
  anchor_offset_sec: zSeconds.nullish(),
  placement_mode: z.enum(['segment', 'legacy_absolute']).optional(),
} as const;

/** `track` defaults here rather than at the insert so the row rules see the EFFECTIVE track. */
const CreateSectionSchema = z.object({
  ...SECTION_FIELDS,
  video_file_id: zId,
  track: zTrack.default('main'),
});

/**
 * PATCH stays PARTIAL — every field optional, and a key that is absent stays absent in the parsed
 * output, so the handler below can keep writing only what the request actually sent. `video_file_id`
 * is deliberately absent: this endpoint has never moved a section between host videos.
 */
const PatchSectionSchema = z.object({ ...SECTION_FIELDS, track: zTrack.optional() }).partial();

// ── Segment-relative placement (D-01) ─────────────────────────────────────────
//
// A b-roll's position used to be an ABSOLUTE second on the concatenated main timeline. That
// timeline is not stable — re-transcode a main video to a slightly different length and every frame
// after it slides while the overlay does not, so the clip still fires at second 47 and second 47 is
// now a different moment. An ANCHOR (a main segment + a time inside it) fixes that by being
// re-resolved against the live timeline on every read.
//
// This controller is one of the four surfaces that must agree about where a row sits, and it agrees
// by calling `resolveSectionPlacement` and nothing else. It is also where rows BECOME anchored:
// nothing is backfilled, so a row acquires its anchor the first time an author places or moves it.

/**
 * The project's main timeline — the concatenation the anchors are relative to.
 *
 * DEGRADES rather than fails, for the same reason `withServedSimUrls` does: a write that 500s after
 * validating tells the client its edit did not happen. Losing the timeline only costs the anchor —
 * the row still stores its absolute second and reads back exactly as it does today.
 */
async function mainTimelineFor(projectId: string): Promise<MainSegmentTimeline> {
  try {
    const videos = await db.query.video_files.findMany({
      where: eq(video_files.project_id, projectId),
      orderBy: [asc(video_files.created_at)],
      columns: { id: true, duration_sec: true, is_broll: true },
    });
    return buildMainSegmentTimeline(videos ?? []);
  } catch (err) {
    logger.error({ err, projectId }, 'sections: main timeline unavailable — placement falls back to absolute seconds');
    return buildMainSegmentTimeline([]);
  }
}

/**
 * The placement columns a write should store, or null to leave them untouched.
 *
 * `global_offset_sec` rides along because the two representations must AGREE at rest: the stored
 * absolute is the dual read's fallback, and a fallback that disagrees with the anchor is a row that
 * moves the day the anchor stops resolving. Every write that sets an anchor therefore also writes
 * the second that anchor resolves to.
 */
type AnchorWrite = {
  anchor_video_file_id: string | null;
  anchor_offset_sec: number | null;
  placement_mode: 'segment' | 'legacy_absolute';
  global_offset_sec?: number;
};

/**
 * What this write does to the row's placement.
 *
 * THREE CASES, and the middle one is the whole rollout:
 *
 *  1. THE CLIENT SAID SO. An explicit `anchor_video_file_id` / `anchor_offset_sec` / `placement_mode`
 *     is honoured verbatim. Nothing in the product sends these yet; the contract exists so an
 *     editor that learns about segments does not need a second endpoint.
 *  2. THE AUTHOR PLACED IT. An anchorable row (b-roll or audio cutaway) whose `global_offset_sec`
 *     this request is SETTING TO A NEW VALUE gets its anchor derived from the live timeline. This
 *     is the ruling's "author drag — keep current visible location", and it is deliberately not a
 *     backfill: the author is asserting, at this instant, where they can see the clip, so writing
 *     that down as a segment offset canonises nothing that was not just chosen. A drag on an
 *     ALREADY-anchored row re-derives too, and must: the dual read takes the anchor first, so an
 *     anchor left pointing at the old moment would make the drag appear to do nothing.
 *  3. NOTHING ELSE. A PATCH that does not move the row, or one that re-sends the same offset (the
 *     undo/redo restore posts a section's whole stored body back), leaves the placement columns
 *     alone. Untouched rows are never converted — that is the ruling, and the reason is that
 *     mapping an absolute second that has ALREADY drifted onto today's segments would make the
 *     drift permanent.
 */
function anchorWriteFor(opts: {
  next: PlacementSectionLike;
  timeline: MainSegmentTimeline;
  explicit: {
    anchor_video_file_id?: string | null;
    anchor_offset_sec?: number | null;
    placement_mode?: 'segment' | 'legacy_absolute';
  };
  /** True when this request gives `global_offset_sec` a value it did not already hold. */
  offsetMoved: boolean;
  /**
   * True on POST. It decides which of the two inputs wins when a request supplies both an offset
   * and an anchor, and the asymmetry is not arbitrary: on CREATE there is no prior state, so a
   * supplied anchor cannot be a replay of one — it is the caller's intent and is honoured. On
   * UPDATE it can be, and usually is (the undo/redo restore posts a whole earlier snapshot back),
   * so a moved offset wins there.
   */
  create?: boolean;
}): AnchorWrite | null {
  const { next, timeline, explicit, offsetMoved, create } = opts;

  // DERIVATION WINS ON AN UPDATE WHENEVER THE OFFSET MOVED, even if the request also named an
  // anchor. The hazard it closes is a client sending a NEW `global_offset_sec` next to a STALE
  // anchor — exactly what the undo/redo restore does when it replays a snapshot taken before the
  // last drag. Honouring the anchor there would silently discard the move; deriving honours it. A
  // client that sends a CONSISTENT pair loses nothing, because deriving from its own offset
  // reproduces its own anchor. To set an anchor directly on an existing row, send it alone.
  if (offsetMoved && isAnchorable(next) && !(create && explicit.anchor_video_file_id !== undefined)) {
    const absolute = next.global_offset_sec;
    if (typeof absolute !== 'number' || !Number.isFinite(absolute)) return null;
    const derived = deriveAnchorForAbsoluteSec(timeline, absolute);
    // No main video to anchor to. The row keeps its absolute second and stays legacy — the "no host
    // to anchor to" case, whose honest answer is to change nothing.
    if (!derived) return null;
    return {
      anchor_video_file_id: derived.anchor_video_file_id,
      anchor_offset_sec: derived.anchor_offset_sec,
      placement_mode: 'segment',
    };
  }

  const saidId = explicit.anchor_video_file_id !== undefined;
  const saidOffset = explicit.anchor_offset_sec !== undefined;
  const saidMode = explicit.placement_mode !== undefined;
  if (!saidId && !saidOffset && !saidMode) return null;

  const id = saidId ? (explicit.anchor_video_file_id ?? null) : (next.anchor_video_file_id ?? null);
  const off = saidOffset ? (explicit.anchor_offset_sec ?? null) : (next.anchor_offset_sec ?? null);
  const mode = explicit.placement_mode ?? (id !== null && off !== null ? 'segment' : 'legacy_absolute');
  const write: AnchorWrite = { anchor_video_file_id: id, anchor_offset_sec: off, placement_mode: mode };

  // Keep the fallback truthful: if this anchor resolves, the stored absolute becomes the second it
  // resolves to. Otherwise the row would carry two positions and quietly jump between them the day
  // the anchor stopped resolving.
  if (mode === 'segment' && id !== null && off !== null) {
    const seg = timeline.byId.get(id);
    if (seg) write.global_offset_sec = seg.startSec + off;
  }
  return write;
}

/** The row's placement, resolved — attached to every section this controller returns. */
type PlacedSection<T> = T & {
  placement: {
    absolute_sec: number;
    source: string;
    containing_segment_id: string | null;
    post_roll_sec: number;
    degradation: string | null;
  };
};

/**
 * Attach the RESOLVED placement, and — for the two lanes positioned by their own offset — serve the
 * resolved second AS `global_offset_sec`.
 *
 * That overwrite is the point. The editor lays its overlay track out from this field, and the
 * viewer lays the same overlays out from `resolveSectionPlacement`; if the editor kept reading the
 * raw column while the viewer read the anchor, the two would show an anchored clip at two different
 * seconds the moment its host was re-transcoded — the D-01 bug, reintroduced on the surface where
 * the author would be actively looking at it.
 *
 * It changes NOTHING for any row that exists today: a `legacy_absolute` row resolves to exactly its
 * stored `global_offset_sec`. And it keeps the write round-trip consistent — the editor PATCHes back
 * the second it was displaying, which `anchorWriteFor` reads as "keep it where I can see it".
 *
 * `placement.absolute_sec` carries the same number explicitly, with the rule that produced it, so a
 * client (or an operator reading the response) can tell an anchored row from a legacy one and see
 * when an anchor has stopped resolving.
 */
function placeSections<T extends PlacementSectionLike>(
  rows: readonly T[],
  timeline: MainSegmentTimeline,
): Array<PlacedSection<T>> {
  return rows.map((row) => {
    const at = resolveSectionPlacement(row, timeline);
    return {
      ...row,
      ...(isAnchorable(row) ? { global_offset_sec: at.absoluteSec } : {}),
      placement: {
        absolute_sec: at.absoluteSec,
        source: at.source,
        containing_segment_id: at.containingSegmentId,
        post_roll_sec: at.postRollSec,
        degradation: at.degradation,
      },
    } as PlacedSection<T>;
  });
}

export async function registerSectionsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/v1/projects/:id/sections
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/sections',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      // `(sort_order, start_sec)` alone TIES — for every b-roll row of a project, because on that
      // track `start_sec` is a source in-point and is almost always 0. A tie in ORDER BY lets
      // Postgres return the rows in any order, run to run. The two extra keys make the order total
      // (`id` is the primary key) and — the reason it matters — make it the SAME order the player
      // build uses, so the editor and the viewer can no longer disagree about one project. It is a
      // strict refinement of the previous key, so nothing that was already unambiguous moves.
      const rows = await db.query.timeline_sections.findMany({
        where: eq(timeline_sections.project_id, project.id),
        orderBy: [
          asc(timeline_sections.sort_order),
          asc(timeline_sections.start_sec),
          asc(timeline_sections.global_offset_sec),
          asc(timeline_sections.id),
        ],
      });
      // Re-applied in memory for the same reason `buildPlayerConfig` does it: the order is a
      // contract between two surfaces, and `compareTimelineSections` is the one place it is stated.
      const sections = sortTimelineSections(rows);

      // Placement is RESOLVED here rather than left to the client (D-01). An anchored overlay's
      // absolute second is a function of the project's live video durations, and the editor must
      // read it through the same resolver the viewer and the export use — otherwise a re-transcode
      // moves the clip in the player and not in the editor, which is the bug wearing a new hat.
      const placed = placeSections(sections, await mainTimelineFor(project.id));

      // The stored URL is what this section last published; the SERVED url is what is live now.
      // The editor renders the served one and writes back only the stored one (audit §9.6).
      return reply.send(await withServedSimUrls(project.id, placed));
    },
  );

  /**
   * GET /api/v1/projects/:id/sections/placement-report — THE DRY RUN. Reads; writes nothing.
   *
   * The ruling forbids a silent backfill, and the reason is worth restating at the endpoint that
   * exists because of it: converting a row means reading its absolute second, asking TODAY's
   * timeline which segment that lands in, and recording the answer as the author's intent. If the
   * row has already drifted — the entire premise of D-01 — that records the DRIFTED position,
   * permanently, and the original intent stops being recoverable. A migration that "fixed"
   * everything would freeze every row's current mistake.
   *
   * So this nominates and explains, and a human decides. Three populations are excluded outright,
   * because for them the mapping is not merely risky but meaningless: rows at or after a segment
   * whose duration has not landed, rows whose second is outside the timeline and its legal tail,
   * and every row of a BRANCHED project — where playback is a graph and "the cumulative sum of
   * durations" is not the timeline at all.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/sections/placement-report',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const [rows, timeline, sequences] = await Promise.all([
        db.query.timeline_sections.findMany({ where: eq(timeline_sections.project_id, project.id) }),
        mainTimelineFor(project.id),
        db.query.branch_sequences.findMany({
          where: eq(branch_sequences.project_id, project.id),
          columns: { id: true },
        }).catch(() => []),
      ]);

      const report = planAnchorBackfill(rows ?? [], timeline, { branched: (sequences ?? []).length > 0 });
      return reply.send({
        project_id: project.id,
        main_timeline: {
          total_sec: timeline.totalSec,
          segment_count: timeline.segments.length,
          has_unknown_duration: timeline.hasUnknownDuration,
          segments: timeline.segments.map((seg) => ({
            video_file_id: seg.id, start_sec: seg.startSec, end_sec: seg.endSec,
            duration_known: seg.durationKnown,
          })),
        },
        ...report,
      });
    },
  );

  /**
   * GET /api/v1/projects/:id/placement-impacts — the queue of decisions the author still owes.
   *
   * Opened by the transcode job when a media change leaves a placement outside its host, and by
   * the video delete when an author explicitly detaches an orphan. Every item is a row that was
   * KEPT EXACTLY AS AUTHORED: this endpoint is the whole reason it was safe not to clamp it.
   *
   * The stored numbers are the ones captured AT DETECTION; `placement` is where the row sits right
   * now, resolved through the one resolver. Both are returned because they answer different
   * questions — "what broke" and "where is it today" — and the second has usually moved again.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v1/projects/:id/placement-impacts',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const [reviews, timeline] = await Promise.all([
        db.query.placement_impact_reviews.findMany({
          where: and(
            eq(placement_impact_reviews.project_id, project.id),
            isNull(placement_impact_reviews.resolved_at),
          ),
          orderBy: [desc(placement_impact_reviews.detected_at)],
        }),
        mainTimelineFor(project.id),
      ]);

      const sectionIds = [...new Set((reviews ?? []).map((r) => r.section_id))];
      const rows = sectionIds.length > 0
        ? await db.query.timeline_sections.findMany({
            where: inArray(timeline_sections.id, sectionIds),
          })
        : [];
      const placed = new Map(
        placeSections(rows ?? [], timeline).map((r) => [r.id, r.placement]),
      );

      return reply.send({
        project_id: project.id,
        open: (reviews ?? []).map((r) => ({ ...r, placement: placed.get(r.section_id) ?? null })),
      });
    },
  );

  /**
   * POST /api/v1/projects/:id/placement-impacts/:reviewId/resolve — close one item, explicitly.
   *
   * The body names what the author decided; nothing is inferred and no placement is changed here.
   * `re_placed` is not accepted from this route: "the author moved it" is a claim only a write to
   * the section can make, and the PATCH handler makes it there. Offering the word here would let a
   * client mark the queue clean without anything having moved.
   */
  app.post<{ Params: { id: string; reviewId: string }; Body: { resolution?: string } }>(
    '/api/v1/projects/:id/placement-impacts/:reviewId/resolve',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const resolution = request.body?.resolution;
      if (resolution !== 'accepted' && resolution !== 'dismissed') {
        return reply.code(400).send({ message: 'resolution must be "accepted" or "dismissed"' });
      }

      const [updated] = await db
        .update(placement_impact_reviews)
        .set({ resolved_at: new Date(), resolution })
        .where(and(
          eq(placement_impact_reviews.id, request.params.reviewId),
          eq(placement_impact_reviews.project_id, project.id),
          isNull(placement_impact_reviews.resolved_at),
        ))
        .returning();
      if (!updated) return reply.code(404).send({ message: 'Open placement review not found' });

      return reply.send(updated);
    },
  );

  // POST /api/v1/projects/:id/sections
  app.post<{
    Params: { id: string };
    Body: {
      video_file_id: string;
      start_sec: number;
      end_sec: number;
      type: string;
      label?: string;
      notes?: string;
      sort_order?: number | null;
      simulation_url?: string;
      simulation_id?: string;
      sim_script?: string;
      sim_prompt?: string | null;
      sim_meta?: unknown;
      track?: 'main' | 'broll' | 'audio';
      global_offset_sec?: number | null;
      clip_source_video_id?: string | null;
      clip_in_sec?: number | null;
      broll_volume?: number;
      simple_ui?: boolean;
      auto_script?: boolean;
      clip_source_image_id?: string | null;
      camera_movement?: string;
      clip_source_audio_id?: string | null;
      anchor_video_file_id?: string | null;
      anchor_offset_sec?: number | null;
      placement_mode?: 'segment' | 'legacy_absolute';
    };
  }>(
    '/api/v1/projects/:id/sections',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const parsed = CreateSectionSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: firstZodMessage(parsed.error) });

      // A fresh row has no history, so EVERY structural violation is one this request is
      // introducing — which makes POST the strict end of the pair. This is the gate the census's
      // three malformed populations all walked through: b-roll rows with no position at all, the
      // `track='broll' + clip_source_video_id` hybrid the viewer emitted twice, and intervals that
      // do not move forward.
      const violations = timelineSectionViolations(parsed.data);
      if (violations.length > 0) return reply.code(400).send({ message: violations[0]!.message });

      const {
        video_file_id,
        start_sec,
        end_sec,
        type,
        label,
        notes,
        sort_order,
        simulation_url,
        simulation_id,
        sim_script,
        sim_prompt,
        sim_meta,
        track,
        global_offset_sec,
        clip_source_video_id,
        clip_in_sec,
        broll_volume,
        simple_ui,
        auto_script,
        clip_source_image_id,
        camera_movement,
        clip_source_audio_id,
        anchor_video_file_id,
        anchor_offset_sec,
        placement_mode,
      } = parsed.data;

      const videoFile = await db.query.video_files.findFirst({
        where: and(eq(video_files.id, video_file_id), eq(video_files.project_id, project.id)),
      });
      if (!videoFile) return reply.code(404).send({ message: 'Video not found' });

      // Resolve simulation_url from simulation_id if provided
      let resolvedSimUrl = simulation_url ?? null;
      if (simulation_id && !resolvedSimUrl) {
        const sim = await db.query.simulations.findFirst({
          where: and(eq(simulations.id, simulation_id), eq(simulations.project_id, project.id)),
        });
        resolvedSimUrl = resolveSimEntryUrl(sim?.entry_file ?? null);
      }

      // NEW WRITES ARE ANCHORED. A fresh row's `global_offset_sec` is the author placing it at this
      // instant, against the timeline they are looking at, so expressing that as a segment offset
      // records an intent rather than canonising a drift — the distinction the ruling draws between
      // this and a backfill.
      const timeline = await mainTimelineFor(project.id);
      const anchor = anchorWriteFor({
        next: parsed.data as PlacementSectionLike,
        timeline,
        explicit: { anchor_video_file_id, anchor_offset_sec, placement_mode },
        offsetMoved: typeof global_offset_sec === 'number',
        create: true,
      });

      if (anchor?.anchor_video_file_id && !timeline.byId.has(anchor.anchor_video_file_id)) {
        // Tenancy, and it has to be checked here: the FK proves the video EXISTS, not that it
        // belongs to this project — the same gap that let a b-roll source from another project be
        // accepted and then silently dropped by the player. An anchor pointing outside this
        // project's main timeline can never resolve, so it is refused rather than stored.
        return reply.code(400).send({ message: 'anchor_video_file_id is not a main video of this project' });
      }
      const anchorViolations = anchorPlacementViolations(
        { ...parsed.data, ...(anchor ?? {}) } as PlacementSectionLike, timeline,
      );
      if (anchorViolations.length > 0) {
        return reply.code(400).send({ message: anchorViolations[0]!.message });
      }

      const [section] = await db
        .insert(timeline_sections)
        .values({
          project_id: project.id,
          video_file_id,
          start_sec,
          end_sec,
          type,
          label: label ?? null,
          notes: notes ?? null,
          sort_order: sort_order ?? null,
          simulation_url: resolvedSimUrl,
          // `|| null`, matching PATCH: the empty string is the clear signal, and it is not a uuid.
          simulation_id: simulation_id || null,
          sim_script: sim_script ?? null,
          // sim_prompt/sim_meta carry the simulation's generation prompt + bridge plan so a
          // duplicated simulation section keeps its full config instead of losing it. (duplicate-section)
          sim_prompt: sim_prompt ?? null,
          sim_meta: sim_meta ?? null,
          track: track ?? 'main',
          global_offset_sec: global_offset_sec ?? null,
          clip_source_video_id: clip_source_video_id ?? null,
          clip_in_sec: clip_in_sec ?? 0,
          broll_volume: broll_volume == null ? 1.0 : Math.max(0, Math.min(1, broll_volume)),
          simple_ui: simple_ui ?? false,
          auto_script: auto_script ?? true,
          clip_source_image_id: clip_source_image_id ?? null,
          camera_movement: camera_movement ?? 'zoom_in',
          clip_source_audio_id: clip_source_audio_id ?? null,
          anchor_video_file_id: anchor?.anchor_video_file_id ?? null,
          anchor_offset_sec: anchor?.anchor_offset_sec ?? null,
          placement_mode: anchor?.placement_mode ?? 'legacy_absolute',
          ...(anchor?.global_offset_sec !== undefined ? { global_offset_sec: anchor.global_offset_sec } : {}),
        })
        .returning();

      // The SAME shape GET /sections returns — placement included, for the same reason the served
      // sim fields are: the caller splices this response straight into editor state, and a row that
      // came back carrying a raw offset while its neighbours carry resolved ones would put one clip
      // on the editor's timeline at a second the viewer does not agree with.
      return reply.code(201).send(await servedSection(project.id, placeSections([section], timeline)[0]!));
    },
  );

  // PATCH /api/v1/projects/:id/sections/:sid
  app.patch<{
    Params: { id: string; sid: string };
    Body: Partial<{
      start_sec: number;
      end_sec: number;
      type: string;
      label: string;
      notes: string;
      sort_order: number;
      simulation_url: string;
      simulation_id: string;
      sim_script: string;
      sim_prompt: string | null;
      sim_meta: unknown;
      global_offset_sec: number;
      clip_source_video_id: string | null;
      clip_in_sec: number;
      broll_volume: number;
      simple_ui: boolean;
      auto_script: boolean;
      clip_source_image_id?: string | null;
      camera_movement?: string;
      track?: 'main' | 'broll' | 'audio';
      clip_source_audio_id?: string | null;
      anchor_video_file_id?: string | null;
      anchor_offset_sec?: number | null;
      placement_mode?: 'segment' | 'legacy_absolute';
    }>;
  }>(
    '/api/v1/projects/:id/sections/:sid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const existing = await db.query.timeline_sections.findFirst({
        where: and(
          eq(timeline_sections.id, request.params.sid),
          eq(timeline_sections.project_id, project.id),
        ),
      });
      if (!existing) return reply.code(404).send({ message: 'Section not found' });

      const parsed = PatchSectionSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: firstZodMessage(parsed.error) });

      const {
        simulation_id, sim_script, sim_prompt, sim_meta, clip_source_video_id, clip_in_sec,
        broll_volume, clip_source_image_id, camera_movement, clip_source_audio_id,
        anchor_video_file_id, anchor_offset_sec, placement_mode,
        ...rest
      } = parsed.data;

      // When simulation_id is provided AND changed, denormalize entry_file → simulation_url.
      // If simulation_id is unchanged, leave simulation_url alone — this preserves the
      // generated bridge URL (section_id.html?v=hash) set by the SSE generation endpoint.
      // An EXPLICIT simulation_url in the same request (undo/redo restore) wins over the
      // recompute — the restore is putting back a known-good bridge URL. (sim-persistence fix)
      let resolvedSimUrl: string | null | undefined = rest.simulation_url;
      if (simulation_id !== undefined && simulation_id !== existing.simulation_id && rest.simulation_url === undefined) {
        if (simulation_id) {
          const sim = await db.query.simulations.findFirst({
            where: and(eq(simulations.id, simulation_id), eq(simulations.project_id, project.id)),
          });
          resolvedSimUrl = resolveSimEntryUrl(sim?.entry_file ?? null);
        } else {
          resolvedSimUrl = null;
        }
      }

      const patch: Record<string, unknown> = { ...rest };
      if (simulation_id !== undefined)       patch.simulation_id        = simulation_id || null;
      // A CHANGED simulation invalidates the previously generated bridge: clear the stale
      // sim_meta/sim_script so the UI stops claiming a bridge exists and the next Generate
      // can't wrongly short-circuit through canReuse. Explicit values below (undo restore)
      // still win over this clear. (sim-persistence fix)
      if (simulation_id !== undefined && (simulation_id || null) !== existing.simulation_id) {
        patch.sim_meta = null;
        patch.sim_script = null;
      }
      if (sim_script !== undefined)          patch.sim_script           = sim_script || null;
      if (sim_prompt !== undefined)          patch.sim_prompt           = sim_prompt || null;
      if (sim_meta !== undefined)            patch.sim_meta             = sim_meta ?? null;
      if (resolvedSimUrl !== undefined)      patch.simulation_url       = resolvedSimUrl;
      if (clip_source_video_id !== undefined) patch.clip_source_video_id = clip_source_video_id ?? null;
      if (clip_in_sec !== undefined)         patch.clip_in_sec          = clip_in_sec;
      if (broll_volume !== undefined)        patch.broll_volume         = Math.max(0, Math.min(1, broll_volume));
      if (clip_source_image_id !== undefined) patch.clip_source_image_id = clip_source_image_id ?? null;
      if (camera_movement !== undefined)     patch.camera_movement      = camera_movement;
      if (clip_source_audio_id !== undefined) patch.clip_source_audio_id = clip_source_audio_id ?? null;

      // THE ROW THAT WILL EXIST AFTER THIS WRITE — validated as a whole, because the shape rules are
      // about field COMBINATIONS and a partial update can only be judged against what it merges into.
      // This is what closes the hybrid from BOTH directions: `track` and `clip_source_video_id` can
      // be set independently, in either order, and the request that completes the pair is caught
      // whichever one it is. It is also what makes the interval check honest — the old one compared
      // start to end only when the request happened to send both, so a one-sided trim could invert
      // the window and nothing noticed.
      //
      // ONLY NEW violations are refused. A PATCH may repair a malformed row, or leave it exactly as
      // malformed as it found it, but may not make it worse. Demanding a perfect result instead
      // would brick the editor on every row the missing constraints already let through: the
      // undo/redo restore path PATCHes a section's entire stored body back, so a single legacy
      // b-roll row with a NULL offset would make every undo in that project fail — punishing the
      // user for a defect this endpoint created.
      const introduced = newTimelineSectionViolations(
        existing as TimelineSectionLike,
        { ...existing, ...patch } as TimelineSectionLike,
      );
      if (introduced.length > 0) return reply.code(400).send({ message: introduced[0]!.message });

      // ── Placement (D-01) ────────────────────────────────────────────────────
      //
      // "Moved" means THIS REQUEST GAVE `global_offset_sec` A VALUE IT DID NOT ALREADY HOLD, and the
      // comparison is deliberately against the STORED column rather than the resolved second. The
      // undo/redo restore posts a section's entire stored body back; on an unanchored row that is a
      // no-op and must stay one, so an untouched row is never converted behind the author's back.
      // On an ALREADY-anchored row the editor is posting back the RESOLVED second it was displaying
      // (see `placeSections`), which differs from the stored column exactly when the host has been
      // re-transcoded — and re-anchoring there is right: it pins the clip to the moment the author
      // can see, which is what the restore was asking for.
      const timeline = await mainTimelineFor(project.id);
      const nextRow = { ...existing, ...patch } as PlacementSectionLike;
      const anchor = anchorWriteFor({
        next: nextRow,
        timeline,
        explicit: { anchor_video_file_id, anchor_offset_sec, placement_mode },
        offsetMoved:
          rest.global_offset_sec !== undefined && rest.global_offset_sec !== existing.global_offset_sec,
      });
      if (anchor) {
        if (anchor.anchor_video_file_id && !timeline.byId.has(anchor.anchor_video_file_id)) {
          return reply.code(400).send({ message: 'anchor_video_file_id is not a main video of this project' });
        }
        const anchorViolations = anchorPlacementViolations({ ...nextRow, ...anchor }, timeline);
        if (anchorViolations.length > 0) {
          return reply.code(400).send({ message: anchorViolations[0]!.message });
        }
        patch.anchor_video_file_id = anchor.anchor_video_file_id;
        patch.anchor_offset_sec    = anchor.anchor_offset_sec;
        patch.placement_mode       = anchor.placement_mode;
        if (anchor.global_offset_sec !== undefined) patch.global_offset_sec = anchor.global_offset_sec;
      }

      const [updated] = await db
        .update(timeline_sections)
        .set(patch)
        .where(eq(timeline_sections.id, existing.id))
        .returning();

      // An author who re-places an impacted row has just answered the question its review was
      // asking, so the item closes itself (D-01b). Only on a placement write: a label edit is not
      // an answer. Best-effort by design — see `resolveReviewsAfterReplacement`.
      if (anchor) await resolveReviewsAfterReplacement(existing.id);

      // Enriched, for the reason spelled out on `withServedSimUrls`: a drag, a trim, a move and an
      // undo/redo restore all splice THIS response into the editor's section state — which is also
      // why the resolved placement rides along, so the editor's copy of the row agrees with the
      // viewer's about what second it is at.
      return reply.send(await servedSection(project.id, placeSections([updated], timeline)[0]!));
    },
  );

  // ── Shared helpers for sim-script generation ──────────────────────────────────

  // The generate request body (shared by the POST stream route, the POST non-stream route,
  // and — parsed from the query string — the legacy GET stream route). `prompt` is OPTIONAL:
  // an empty prompt WITH a ui_controls selection is the zero-LLM "minimize UI only" path
  // (owner direction 2026-07-30 — "generate without prompt ⇒ only minimize the ui").
  const GenerateSimScriptSchema = z
    .object({
      prompt:      z.string().max(1000).optional(),
      simple_ui:   z.boolean(),
      auto_script: z.boolean(),
      ui_controls: SimUiSelectionSchema.optional(),
    })
    .refine(d => (d.prompt?.trim().length ?? 0) > 0 || !!d.ui_controls, {
      message: 'Provide a prompt, or select UI controls to minimize.',
    });
  type GenerateSimScriptInput = z.infer<typeof GenerateSimScriptSchema>;
  type SectionRow = typeof timeline_sections.$inferSelect;

  /**
   * The ONE place sim-script generation decides what to do and persists the result — shared
   * by every route (GET/POST stream + non-stream POST) so the canReuse / mechanical / LLM
   * decision, the planVersion-'7' sim_meta shape, and the DB write never drift between them.
   *
   * Three outcomes:
   *   • mechanical  — empty prompt + a selection ⇒ NO LLM: apply the Minimal-UI hide only.
   *   • reuse       — same prompt + own bridge + runtime-param bridge ⇒ no regeneration.
   *   • regenerate  — call the LLM (with the lean Minimal-UI contract block).
   */
  async function generateOrReuseSection(opts: {
    section:    SectionRow;
    project:    { id: string };
    user:       { id: string };
    input:      GenerateSimScriptInput;
    signal:     AbortSignal;
    onEvent?:   (event: string, data: object) => void;
  }): Promise<SectionRow> {
    const { section, project, user, input, signal, onEvent } = opts;
    const svc = getSimService();
    const rawPrompt = (input.prompt ?? '').trim();
    const simpleUi = input.simple_ui;
    const autoScript = input.auto_script;
    const uiControls: SimUiSelection | undefined =
      input.ui_controls ? normalizeSimUiSelection(input.ui_controls) : undefined;

    const storedMeta = section.sim_meta as (Record<string, unknown> & {
      planVersion?: string; sourceHash?: string; prompt?: string;
      supportsRuntimeParams?: boolean; generatedBy?: string;
      conversationHistory?: ConversationMessage[];
    }) | null;

    const patch: Record<string, unknown> = { simple_ui: simpleUi, auto_script: autoScript, sim_script: 'main' };

    // The section-row update runs INSIDE the revision-activation transaction, via the service's
    // persistSection hook (audit P0.4): the pointer flip and the section row commit or roll back
    // TOGETHER, so a client abort or crash can never leave a published revision the section does
    // not reference, or vice versa. Every patch field — not only simulation_url/sim_meta — goes
    // through this single in-transaction write. The hook throwing (section deleted mid-generation)
    // rolls the whole activation back.
    let updated: SectionRow | undefined;
    const persistPatch = async (
      tx: Parameters<SectionPersistHook>[0],
      finalPatch: Record<string, unknown>,
    ): Promise<void> => {
      const [row] = await tx
        .update(timeline_sections)
        .set(finalPatch)
        .where(eq(timeline_sections.id, section.id))
        .returning();
      if (!row) throw new Error('This section was removed during generation.');
      updated = row as SectionRow;
    };

    if (rawPrompt === '') {
      // ── Mechanical Minimal-UI path — zero LLM ────────────────────────────────
      // No prompt means "just minimize the UI as chosen": the hide is applied entirely at
      // runtime via params.hideSelectors; any existing demonstration body is preserved.
      const simRow = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, section.simulation_id!), eq(simulations.project_id, project.id)),
      });
      await svc.applyMinimalUiOnly({
        simId:     section.simulation_id!,
        sectionId: section.id,
        projectId: project.id,
        entryKey:  simRow?.entry_file && !simRow.entry_file.startsWith('http') ? simRow.entry_file : undefined,
        onEvent,
        signal,
        persistSection: async (tx, pub) => {
          // Preserve provenance: the bridge BODY is unchanged (uploadSectionBridge kept any existing
          // demo), so an LLM-authored section stays labeled 'llm' and keeps its prompt + provider/
          // model/confidence/etc. — only the UI selection changed. We do NOT null sim_prompt, and we
          // keep sim_meta.prompt so a later identical-prompt Generate can still canReuse. A section
          // with no prior bridge (fresh) has no provenance to keep ⇒ generatedBy:'mechanical'.
          await persistPatch(tx, {
            ...patch,
            sim_meta: {
              ...(storedMeta ?? {}),
              planVersion:           '7',
              generatedBy:           storedMeta?.generatedBy ?? 'mechanical',
              uiControls,
              bridgeHash:            pub.bridgeHash,
              generatedAt:           new Date().toISOString(),
              supportsRuntimeParams: true,
            },
            simulation_url: pub.sectionUrl,
          });
        },
      });
    } else {
      // ── canReuse: prompt unchanged + own bridge + runtime-param bridge + same selection ──
      const supportsRuntimeParams =
        storedMeta?.supportsRuntimeParams === true ||
        (storedMeta?.generatedBy === 'llm' && storedMeta?.planVersion === '5');
      const builtPrompt = (typeof storedMeta?.prompt === 'string' ? storedMeta.prompt : undefined) ?? section.sim_prompt;
      const urlIsOwn = !!section.simulation_url?.includes(`section=${section.id}`);
      const uiSelectionUnchanged = simUiSelectionsEqual(readStoredUiControls(storedMeta?.uiControls), uiControls);
      const canReuse = builtPrompt === rawPrompt && urlIsOwn && supportsRuntimeParams && uiSelectionUnchanged;

      if (canReuse) {
        onEvent?.('status', { status: 'Toggle updated — bridge handles it at runtime.', type: 'info' });
        const { sectionUrl } = svc.reuseBridgeScript(section.simulation_url!);
        // No publication happened — no revision, no activation transaction to join. The bare
        // toggle write keeps its own abort check, exactly as before.
        patch.simulation_url = sectionUrl;
        if (signal.aborted) throw new Error('generation cancelled');
        const [row] = await db
          .update(timeline_sections)
          .set(patch)
          .where(eq(timeline_sections.id, section.id))
          .returning();
        if (!row) throw new Error('This section was removed during generation.');
        return row;
      }

      const simRow = await db.query.simulations.findFirst({
        where: and(eq(simulations.id, section.simulation_id!), eq(simulations.project_id, project.id)),
      });
      const savedHistory = (storedMeta?.conversationHistory as ConversationMessage[] | undefined) ?? [];
      await svc.generateBridgeScript({
        simId:               section.simulation_id!,
        sectionId:           section.id,
        projectId:           project.id,
        userId:              user.id,
        prompt:              rawPrompt,
        simpleUi,
        autoScript,
        uiControls,
        entryKey:            simRow?.entry_file && !simRow.entry_file.startsWith('http') ? simRow.entry_file : undefined,
        storedSourceHash:    storedMeta?.sourceHash,
        conversationHistory: savedHistory.length > 0 ? savedHistory : undefined,
        onEvent,
        signal,
        persistSection: async (tx, result) => {
          await persistPatch(tx, {
            ...patch,
            sim_prompt: rawPrompt,
            sim_meta: {
              planVersion:        '7',
              generatedBy:        'llm',
              prompt:             rawPrompt,
              uiControls,
              sourceHash:         result.sourceHash,
              bridgeHash:         result.bridgeHash,
              generatedAt:        new Date().toISOString(),
              provider:           result.provider,
              model:              result.model,
              confidence:         result.confidence,
              confidenceLevel:    result.confidenceLevel,
              contextTruncated:   result.contextTruncated,
              retryCount:         result.retryCount,
              retryReason:        result.retryReason,
              warnings:           result.warnings,
              validationErrors:   result.validationErrors,
              validationWarnings: result.validationWarnings,
              supportsRuntimeParams: true,
              runtimeValidated:   false,
              conversationHistory: result.conversationHistory,
            },
            simulation_url: result.sectionUrl,
          });
        },
      });
    }

    // The service resolving means activation committed, which means the hook ran exactly once.
    // Guarded loudly so a service change that stops invoking the hook cannot silently return a
    // stale row. After this point an abort is ignored — the publication is already live.
    if (!updated) throw new Error('Generation completed but the section update never ran.');
    return updated;
  }

  /**
   * SSE transport wrapper shared by the GET (legacy) and POST stream routes: manifest of
   * headers, the per-section concurrency lock, the keep-alive, a stall-aware progress
   * heartbeat, the abort/deadline plumbing, and done/error framing. The route only parses
   * + validates its input (before any bytes are written) and hands it here.
   */
  async function runSseGeneration(
    request: import('fastify').FastifyRequest,
    reply: FastifyReply,
    ctx: { section: SectionRow; project: { id: string }; user: { id: string }; input: GenerateSimScriptInput },
  ): Promise<void> {
    const origin = request.headers.origin;
    reply.raw.setHeader('Access-Control-Allow-Origin', origin ?? '*');
    reply.raw.setHeader('Access-Control-Allow-Credentials', 'true');
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');

    let lastActivityMs = Date.now();
    const sendEvent = (event: string, data: object) => {
      if (event === 'status' || event === 'token') lastActivityMs = Date.now();
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* socket closed */ }
    };

    sendEvent('connected', {});

    if (activeSimGenerations.has(ctx.section.id)) {
      sendEvent('error', { error: 'A generation is already running for this section. Please wait for it to finish.', errorType: 'generation_error' });
      try { reply.raw.end(); } catch { /* already closed */ }
      return;
    }
    activeSimGenerations.add(ctx.section.id);

    const startMs = Date.now();
    // Keep-alive + a stall-aware progress heartbeat: adaptive-thinking models (Opus 4.8)
    // stream NO text during the (long) thinking phase, so the visible status would otherwise
    // freeze for minutes and read as "hung". When the stream has been quiet for >12s we emit
    // an elapsed-time status so the user can see it is still working (backend-007 follow-up).
    const keepAlive = setInterval(() => {
      try { reply.raw.write(': keep-alive\n\n'); } catch { /* socket closed */ }
      if (Date.now() - lastActivityMs > 12_000) {
        sendEvent('status', { status: `Still generating… (${Math.round((Date.now() - startMs) / 1000)}s)`, type: 'progress' });
      }
    }, 15_000);

    const controller = new AbortController();
    request.raw.on('close', () => { controller.abort(); clearInterval(keepAlive); });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, SIM_GEN_TIMEOUT_MS);

    try {
      const updated = await generateOrReuseSection({ ...ctx, signal: controller.signal, onEvent: sendEvent });
      // The `done` frame is applied to the editor AND to the live preview (`applyDone`), and the
      // preview mounts the SERVED url — so the frame has to carry it, or the section editor would
      // remount the just-published revision from the stored value and re-derive UNKNOWN for both
      // capabilities of a package publication has just measured.
      if (!controller.signal.aborted) {
        sendEvent('done', { section: await servedSection(ctx.project.id, updated) });
      }
    } catch (err) {
      if (timedOut) {
        sendEvent('error', { error: 'Generation timed out. Please try again.', errorType: 'generation_error' });
      } else if (!controller.signal.aborted) {
        const errorType = classifySimulationError(err);
        sendEvent('error', { error: ERROR_MESSAGES[errorType] ?? ERROR_MESSAGES.generation_error, errorType });
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(keepAlive);
      activeSimGenerations.delete(ctx.section.id);
      try { reply.raw.end(); } catch { /* already closed */ }
    }
  }

  // GET /api/v1/projects/:id/sections/:sid/generate-sim-script/stream
  // SSE streaming endpoint — auth via ?token= query param (EventSource limitation)
  app.get<{
    Params:      { id: string; sid: string };
    Querystring: { prompt?: string; simple_ui?: string; auto_script?: string; ui_controls?: string };
  }>(
    '/api/v1/projects/:id/sections/:sid/generate-sim-script/stream',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const section = await db.query.timeline_sections.findFirst({
        where: and(
          eq(timeline_sections.id, request.params.sid),
          eq(timeline_sections.project_id, project.id),
        ),
      });
      if (!section) return reply.code(404).send({ message: 'Section not found' });
      if (section.type !== 'simulation') return reply.code(400).send({ message: 'Section is not a simulation section' });
      if (!section.simulation_id)        return reply.code(400).send({ message: 'Section has no simulation selected' });

      // Legacy transport: EventSource can't POST, so prompt/toggles/ui_controls ride the
      // query string (auth via ?token=). New clients use the POST stream route below, which
      // carries the selection in the request BODY with no URL-size cap (the v0.1.x "Too many
      // UI controls" 400 was purely this query-length ceiling). Kept so an old editor tab that
      // is still open across a deploy keeps working.
      let legacyUiControls: unknown;
      const rawUiControls = request.query.ui_controls;
      if (typeof rawUiControls === 'string' && rawUiControls.length > 0) {
        if (rawUiControls.length > SIM_UI_CONTROLS_PARAM_MAX_CHARS) {
          return reply.code(400).send({ message: `ui_controls is too large for the legacy URL transport (max ${SIM_UI_CONTROLS_PARAM_MAX_CHARS} chars) — reload the editor to use the POST route.` });
        }
        try { legacyUiControls = JSON.parse(rawUiControls); }
        catch { return reply.code(400).send({ message: 'ui_controls must be valid JSON' }); }
      }
      const parsed = GenerateSimScriptSchema.safeParse({
        prompt:      request.query.prompt,
        simple_ui:   request.query.simple_ui === 'true',
        auto_script: request.query.auto_script !== 'false',
        ui_controls: legacyUiControls,
      });
      if (!parsed.success) {
        return reply.code(400).send({ message: firstZodMessage(parsed.error) });
      }

      await runSseGeneration(request, reply, { section, project, user, input: parsed.data });
    },
  );

  // POST /api/v1/projects/:id/sections/:sid/generate-sim-script/stream
  // Same SSE stream as the GET route, but the request BODY carries prompt + toggles + the
  // (uncapped) Minimal-UI selection, and auth uses the Authorization header. This is the
  // route the editor uses now: no URL-length limit on ui_controls, real HTTP status codes on
  // validation failure (EventSource could only surface those as a generic "connection lost").
  app.post<{ Params: { id: string; sid: string } }>(
    '/api/v1/projects/:id/sections/:sid/generate-sim-script/stream',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const section = await db.query.timeline_sections.findFirst({
        where: and(eq(timeline_sections.id, request.params.sid), eq(timeline_sections.project_id, project.id)),
      });
      if (!section) return reply.code(404).send({ message: 'Section not found' });
      if (section.type !== 'simulation') return reply.code(400).send({ message: 'Section is not a simulation section' });
      if (!section.simulation_id)        return reply.code(400).send({ message: 'Section has no simulation selected' });

      // Validate BEFORE hijacking the socket so a bad request is a clean HTTP 400/409.
      const parsed = GenerateSimScriptSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ message: firstZodMessage(parsed.error) });
      }

      await runSseGeneration(request, reply, { section, project, user, input: parsed.data });
    },
  );

  // POST /api/v1/projects/:id/sections/:sid/generate-sim-script
  // Non-stream sibling (used by tests / non-SSE callers). Same decision + persistence as the
  // stream routes via generateOrReuseSection — it just returns the section JSON instead of
  // an SSE `done` frame.
  app.post<{ Params: { id: string; sid: string } }>(
    '/api/v1/projects/:id/sections/:sid/generate-sim-script',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const section = await db.query.timeline_sections.findFirst({
        where: and(
          eq(timeline_sections.id, request.params.sid),
          eq(timeline_sections.project_id, project.id),
        ),
      });
      if (!section) return reply.code(404).send({ message: 'Section not found' });
      if (section.type !== 'simulation') return reply.code(400).send({ message: 'Section is not a simulation section' });
      if (!section.simulation_id) return reply.code(400).send({ message: 'Section has no simulation selected' });

      const body = GenerateSimScriptSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: firstZodMessage(body.error) });

      // Same per-section serialization as the SSE path. The lock is released in `finally` — a
      // 'finish'-only listener never fires on a client disconnect mid-generation ('close' is
      // emitted instead), which left the section permanently 409-locked until restart (backend-004).
      if (activeSimGenerations.has(section.id)) {
        return reply.code(409).send({ message: 'A generation is already running for this section. Please wait for it to finish.' });
      }
      activeSimGenerations.add(section.id);

      const controller = new AbortController();
      request.raw.on('close', () => controller.abort());
      const timeout = setTimeout(() => controller.abort(), SIM_GEN_TIMEOUT_MS);

      try {
        const updated = await generateOrReuseSection({
          section, project, user, input: body.data, signal: controller.signal,
        });
        return reply.send(await servedSection(project.id, updated));
      } catch (err) {
        const errorType = classifySimulationError(err);
        // 409 for a lost activation CAS: a concurrent publication won, nothing was overwritten,
        // and the client should simply retry. Reporting it as 500 was accurate about neither the
        // cause nor the remedy — and it pages, because a 5xx rate is what alerting watches.
        const status = errorType === 'not_found' ? 404
          : errorType === 'aborted'  ? 499
          : errorType === 'conflict' ? 409
          : 500;
        return reply.code(status).send({ message: ERROR_MESSAGES[errorType] ?? ERROR_MESSAGES.generation_error, errorType });
      } finally {
        clearTimeout(timeout);
        activeSimGenerations.delete(section.id);
      }
    },
  );

  // DELETE /api/v1/projects/:id/sections/:sid
  app.delete<{ Params: { id: string; sid: string } }>(
    '/api/v1/projects/:id/sections/:sid',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const user = request.dbUser!;
      const project = await editableProject(request.params.id, user);
      if (!project) return reply.code(404).send({ message: 'Project not found' });

      const existing = await db.query.timeline_sections.findFirst({
        where: and(
          eq(timeline_sections.id, request.params.sid),
          eq(timeline_sections.project_id, project.id),
        ),
      });
      if (!existing) return reply.code(404).send({ message: 'Section not found' });

      await db.delete(timeline_sections).where(eq(timeline_sections.id, existing.id));

      return reply.code(204).send();
    },
  );
}
