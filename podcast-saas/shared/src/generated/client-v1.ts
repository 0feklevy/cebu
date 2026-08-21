/// <reference lib="dom" />
import type { CreateProject, PlatformSettings } from '../types/project.js';
import type { Host, CreateHost } from '../types/host.js';
import type { Corpus } from '../types/corpus.js';
import type {
  CreatePodcastShow,
  UpdatePodcastShow,
  CreatePodcastEpisode,
  UpdatePodcastEpisode,
  CreatePodcastSource,
  PodcastNichePack,
  PodcastStyleConfig,
  PodcastScriptBody,
  PodcastTurn,
  PodcastScriptStatus,
} from '../types/podcast.js';
import type {
  PodcastStudioResponse,
  PodcastStudioClip,
  PodcastMixSnapshotInfo,
  MixTimeline,
} from '../types/podcastStudio.js';

export interface PodcastShow {
  id: string;
  org_id: string;
  created_by: string | null;
  title: string | null;
  description: string | null;
  language: string;
  teacher_name: string;
  teacher_voice_id: string | null;
  learner_name: string;
  learner_voice_id: string | null;
  teacher_persona: string | null;
  learner_persona: string | null;
  niche_pack: PodcastNichePack;
  style_config: PodcastStyleConfig | null;
  memory_json: unknown;
  created_at: string;
  updated_at: string;
  episode_count?: number;
}

export interface PodcastEpisode {
  id: string;
  show_id: string;
  episode_number: number | null;
  title: string | null;
  brief: string | null;
  target_minutes: number;
  language: string | null;
  status: 'draft' | 'scripting' | 'script_ready' | 'approved' | 'rendering' | 'ready' | 'failed';
  memory_summary: unknown;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface PodcastSource {
  id: string;
  episode_id: string;
  kind: 'file' | 'url' | 'note';
  storage_key: string | null;
  source_url: string | null;
  extracted_md: string | null;
  title: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  created_at: string;
}

export interface PodcastEpisodeWithSources extends PodcastEpisode {
  sources: PodcastSource[];
}

export interface SharedVoice {
  voice_id: string;
  public_owner_id: string;
  name: string;
  gender?: string | null;
  age?: string | null;
  accent?: string | null;
  descriptive?: string | null;
  use_case?: string | null;
  category?: string | null;
  language?: string | null;
  preview_url?: string | null;
}

export interface PodcastScript {
  id: string;
  episode_id: string;
  version: number;
  status: PodcastScriptStatus;
  story_json: unknown;
  materials_json: unknown;
  review_json: unknown;
  body_json: PodcastScriptBody | null;
  content_hash: string | null;
  telemetry: unknown;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PodcastScriptVersion {
  id: string;
  version: number;
  status: PodcastScriptStatus;
  approved_at: string | null;
  created_at: string;
}

export interface PodcastScriptResponse {
  script: PodcastScript | null;
  versions: PodcastScriptVersion[];
}

export interface PodcastRender {
  id: string;
  episode_id: string;
  script_version: number | null;
  status: 'queued' | 'synthesizing' | 'stitching' | 'encoding' | 'ready' | 'failed';
  progress: { stage?: string; chunksDone?: number; chunksTotal?: number } | null;
  master_mp4_key: string | null;
  master_mp3_key: string | null;
  master_wav_key?: string | null;
  duration_ms: number | null;
  script_hash: string | null;
  cost_cents: number | null;
  error: string | null;
  kind?: 'auto' | 'mix';
  format?: 'mp4' | 'mp3' | 'wav' | null;
  created_at: string;
  updated_at: string;
  mp4_url: string | null;
  mp3_url: string | null;
  wav_url?: string | null;
}

export interface PodcastRendersResponse {
  renders: PodcastRender[];
  changed_since_render: boolean;
  /** Newest script version that has a body (any status) — the audio tab syncs against this. */
  latest_script_version: number | null;
  latest_script_status: 'drafting' | 'reviewing' | 'rewriting' | 'compiling' | 'ready' | 'approved' | 'failed' | null;
}

export interface ApiConfig {
  baseURL: string;
  getToken: () => Promise<string | null>;
}

/** POST /projects/:id/duplicate — accepted, or joined to an already-running copy. */
export interface StartedDuplication {
  duplication_id: string;
  status: ProjectDuplicationStatus;
  /** True when this call attached to a duplication that was already in flight. */
  already_running?: boolean;
}

export type ProjectDuplicationStatus = 'queued' | 'copying' | 'committing' | 'ready' | 'failed';

/**
 * Progress of one duplication. `target_project_id` is null until `status === 'ready'` — the copy's
 * project row is created in a single commit at the end, so there is nothing to link to before then.
 */
export interface ProjectDuplication {
  id: string;
  status: ProjectDuplicationStatus;
  target_project_id: string | null;
  objects_total: number;
  objects_copied: number;
  error: string | null;
}

/** POST /projects/:id/export — accepted, or joined to an already-running export. */
export interface StartedExport {
  export_id: string;
  status: ProjectExportStatus;
  /** True when this call attached to an export that was already in flight. */
  already_running?: boolean;
}

export type ProjectExportStatus =
  | 'queued' | 'planning' | 'capturing' | 'assembling' | 'uploading' | 'ready' | 'failed' | 'cancelled';

/**
 * `full` — the master is the whole composition. `degraded` — at least one window resolved to a
 * fallback (Phase 1: every simulation exports as its poster still) or a planned layer was
 * skipped; the specifics are in `warnings`.
 */
export type ProjectExportQuality = 'full' | 'degraded';

/**
 * Progress of one linear video export. `download_url` is present only when `status === 'ready'` —
 * it is a short-lived presigned URL minted per poll, so it is read from the response and used,
 * never stored. `warnings` are the plan's honest record of what the export deliberately left out
 * (RAW simulation sections, out-of-scope layers, poster stand-ins) — the UI shows them per line
 * rather than flattening them into a boolean.
 */
export interface ProjectExport {
  id: string;
  status: ProjectExportStatus;
  quality_state: ProjectExportQuality;
  objects_total: number;
  objects_done: number;
  error: string | null;
  download_url?: string | null;
  warnings: string[];
  cancel_requested?: boolean;
}

/**
 * POST /projects/:id/export answers 409 with this body when the export WOULD be degraded and the
 * caller did not pass `allow_degraded: true` — the consent dialog's machine-readable half.
 */
export interface DegradedExportRefusal {
  code: 'degraded_only';
  message: string;
  warnings: string[];
}

export interface Project {
  id: string;
  org_id: string;
  title: string | null;
  topic: string | null;
  status: string;
  visibility?: 'private' | 'unlisted' | 'public';
  created_by: string | null;
  share_token?: string | null;
  /** Creator-controlled permalink (043) — public URL is {PUBLIC_SITE_URL}/{slug}. */
  slug?: string | null;
  access_type?: 'free' | 'paid';
  price_cents?: number | null;
  currency?: string;
  thumbnail_url?: string | null;
  seo_description?: string | null;
  seo_keywords?: string | null;
  metadata_status?: string;
  view_count?: number;
  created_at: string;
  /** 'owner' for own projects, 'collaborator' for projects shared with you (042). */
  collab_role?: 'owner' | 'collaborator';
}

// ── Collaboration (migration 042) ───────────────────────────────────────────

export interface CollaboratorEntry {
  id: string;
  email: string;
  user_id: string | null;
  display_name: string | null;
  /** 'active' once the email maps to a real account, 'pending' before signup. */
  status: 'active' | 'pending';
  created_at: string;
}

export interface CollaboratorsResponse {
  owner: { user_id: string; email: string | null; display_name: string | null } | null;
  viewer_role: 'owner' | 'collaborator';
  collaborators: CollaboratorEntry[];
}

// ── Billing / pay-to-unlock ─────────────────────────────────────────────────

export type ContentType = 'project' | 'playlist';

export interface BillingStatus {
  enabled: boolean;
  publishableKey: string | null;
  platformFeePercent: number;
}

export interface ContentAccess {
  accessType: 'free' | 'paid';
  priceCents: number | null;
  currency: string;
  title: string | null;
  hasAccess: boolean;
  isOwner: boolean;
  locked: boolean;
}

export interface ContentPricing {
  access_type: 'free' | 'paid';
  price_cents: number | null;
  currency: string;
}

export interface Purchase {
  id: string;
  content_type: ContentType;
  content_id: string;
  title: string | null;
  amount_cents: number;
  currency: string;
  purchased_at: string;
}

export interface BillingTransaction {
  id: string;
  type: string;
  status: string;
  amount_cents: number;
  currency: string;
  platform_fee_cents: number;
  creator_payout_cents: number;
  content_type: ContentType;
  content_id: string;
  description: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CreatorEarnings {
  salesCount: number;
  totalGrossCents: number;
  totalNetCents: number;
  currency: string;
  recent: Array<{
    id: string;
    content_type: ContentType;
    title: string | null;
    amount_cents: number;
    creator_payout_cents: number;
    currency: string;
    completed_at: string | null;
  }>;
}

/** A viewer player-config response may instead be a paywall stub. */
export interface LockedContent {
  locked: true;
  content_type: ContentType;
  content_id: string;
  title: string | null;
  price_cents: number | null;
  currency: string;
}

export interface VideoFile {
  id: string;
  project_id: string;
  filename: string;
  file_size: number | null;
  storage_key: string | null;
  status: string;
  duration_sec: number | null;
  hls_status: 'pending' | 'processing' | 'ready' | 'failed';
  hls_master_key: string | null;
  hls_error: string | null;
  waveform_peaks: string | null;  // JSON-encoded float[200] 0–1, set after HLS transcode
  is_broll: boolean;              // true for AI-generated broll source files
  hls_url: string | null;   // computed: public HLS URL (only set when hls_status === 'ready')
  raw_url?: string | null;  // present in upload response and hls-status poll; absent in list
  crop_status: string;      // none | processing | ready | failed
  crop_updated_at: string | null;
  created_at: string;
}

export interface HlsStatusResponse {
  id: string;
  hls_status: 'pending' | 'processing' | 'ready' | 'failed';
  hls_url: string | null;
  raw_url: string | null;   // presigned download URL for raw source file, TTL 3600s
  duration_sec: number | null;
  hls_error: string | null;
  hls_current_tier: string | null;   // e.g. '360p', '480p', '720p', '1080p'
  hls_360p_ready: boolean;           // true once the 360p playlist is uploaded
}

export interface TimelineSection {
  id: string;
  project_id: string;
  video_file_id: string;
  start_sec: number;
  end_sec: number;
  type: string;
  label: string | null;
  notes: string | null;
  sort_order: number | null;
  /**
   * The STORED url — what this section last published. Written only by the generation that
   * published it, and the only value the client ever writes back (undo/redo restore, duplicate).
   */
  simulation_url: string | null;
  /**
   * ── The three ADDITIVE, DERIVED fields ────────────────────────────────────────────────────
   *
   * All three are projections of the simulation's LIVE bytes, not properties of the section row,
   * and all three now ride on EVERY section-shaped response: the two bootstrap reads
   * (GET /sections, GET /editor-state), the two writes (POST /sections, PATCH /sections/:sid) and
   * the two sim-script generation responses. Server side they are one type —
   * `ServedSimFields` in backend-api/src/services/simulation/simulationUrlResolver.ts — so a
   * fourth cannot be added to one producer and forgotten by another.
   *
   * They stay OPTIONAL here on purpose. Optional is the honest description of a field a client may
   * legitimately not have: a section constructed locally, a response from an older backend across
   * a deploy, a fixture. Every consumer therefore reads them three-state — `served ?? stored` for
   * the url, `?? null` (never `?? false`) for the two capabilities — and UNKNOWN keeps meaning
   * UNKNOWN instead of collapsing into an answer nothing measured.
   *
   * NEVER PERSIST ANY OF THEM. The editor copies `simulation_url` verbatim into PATCH/POST bodies
   * (undo/redo restore, duplicate section); writing a resolved url back would record a revision id
   * captured at read time into a column whose meaning is "what THIS section published".
   */
  /**
   * The url whose bytes are LIVE right now: `simulation_url` with the simulation's active
   * revision pointer resolved into it (audit §9.6). Render paths read
   * `simulation_served_url ?? simulation_url`.
   */
  simulation_served_url?: string | null;
  /**
   * Does the LIVE revision's bridge post SCRIPT_APPLIED (migration 055, audit P0.5)?
   *
   * Three states, and `null` is one of them: UNKNOWN means no record exists — a package published
   * before the column, or a row read without it — and the apply gate treats unknown as its own
   * bounded case rather than as either answer.
   */
  bridge_ack_capable?: boolean | null;
  /**
   * Does the LIVE revision's ENTRY document need `<script type="importmap">` to run at all
   * (migration 057, audit P0.8)?
   *
   * `true` on a browser without import-map support means the package can never paint, so the
   * surface shows the reason instead of a spinner or a blank frame (`lib/sim/browserFloor.ts`).
   * `null` is UNKNOWN and is NEVER read as "requires" — guessing would poster every legacy package
   * on an older browser for a need it may not have.
   *
   * Undeclared until now while the other two were declared, which is precisely how the write
   * endpoints came to drop it with nothing failing to compile: `evaluateFloor` reads the field
   * structurally, so a response missing it type-checks perfectly and simply answers "runnable".
   */
  requires_import_maps?: boolean | null;
  simulation_id:  string | null;
  sim_script:     string | null;
  sim_prompt:     string | null;
  simple_ui:      boolean;
  auto_script:    boolean;
  track: 'main' | 'broll' | 'audio';    // default 'main'
  global_offset_sec: number | null;     // broll/audio: absolute start time on main timeline
  sim_meta: SimMeta | null;             // bridge generation plan metadata
  clip_source_video_id: string | null;  // clip type: which library video to play
  clip_in_sec: number | null;           // clip type: in-point in source video (seconds)
  broll_volume: number;
  clip_source_image_id: string | null;  // image clip: which uploaded image to show
  camera_movement: string;              // image clip: 'zoom_in' | 'zoom_out' | 'pan_right' | 'pan_left' | 'dolly_in' | 'drift'
  clip_source_audio_id: string | null;  // audio cutaway: which uploaded audio file to play
  // ── Segment-relative placement (D-01) ──────────────────────────────────────────────────────
  //
  // `global_offset_sec` above is an absolute second, and an absolute second stops meaning what its
  // author meant the moment a main video is re-transcoded to a different length. The anchor is a
  // MAIN VIDEO SEGMENT plus a time inside it, so the overlay moves with the content it was placed
  // over. Optional here because they arrive with migration 063 and nothing on the client writes
  // them: the server derives the anchor from the `global_offset_sec` a drag already sends.
  //
  // NOTE FOR THE CLIENT: on a broll or audio row, `global_offset_sec` as SERVED by GET /sections is
  // the RESOLVED second, not the raw column — the editor and the viewer have to lay the same
  // overlay out at the same place, and the resolver is the only thing that knows where that is.
  anchor_video_file_id?: string | null;
  anchor_offset_sec?: number | null;
  placement_mode?: 'segment' | 'legacy_absolute';
  placement?: {
    absolute_sec: number;
    source: 'anchor' | 'absolute' | 'native_host';
    containing_segment_id: string | null;
    post_roll_sec: number;                 // seconds past the end of the main timeline; 0 inside it
    degradation: string | null;            // non-null when the anchor could not be used
  };
  created_at: string;
}

export interface TimelineMarker {
  id: string;
  project_id: string;
  at_sec: number;              // absolute position on the global main timeline
  label: string | null;
  notes: string | null;
  color: string;               // hex, defaults to '#ef4444' (red)
  created_at: string;
}

// Aggregate editor bootstrap — the 6 editor lists in one round-trip. Each field is shaped
// identically to its standalone list endpoint (loadperf-003).
export interface EditorState {
  videos: VideoFile[];
  sections: TimelineSection[];
  simulations: Simulation[];
  brollJobs: VideoGenerationJob[];
  images: ImageFile[];
  audioFiles: AudioFile[];
}

export interface ImageFile {
  id: string;
  project_id: string;
  filename: string;
  storage_key: string;
  original_url: string;
  width: number | null;
  height: number | null;
  crop_x: number;
  crop_y: number;
  crop_w: number;
  crop_h: number;
  created_at: string;
}

export interface AudioFile {
  id: string;
  project_id: string;
  filename: string;
  storage_key: string;
  url: string;
  duration_sec: number | null;
  created_at: string;
}

/**
 * The persisted Minimal-UI selection (`sim_meta.uiControls`).
 *
 * Structural on purpose. The authoritative `SimUiSelection` lives in each side's own
 * `simUiControls` module (client-web/lib, backend-api/src/services/simulation), and this is a
 * description of the JSONB that was written, not a third owner of the contract: `kind` is widened
 * to `string` so a real `SimUiSelection` assigns INTO it, never the other way round. Readers that
 * need the narrow union keep going through `getStoredSelection`, which sanitizes untrusted JSON.
 */
export interface SimMetaUiControls {
  controls: Array<{ selector: string; kind: string; label: string; hidden?: boolean }>;
  show:     string[];
  hide:     string[];
}

/**
 * `timeline_sections.sim_meta` — the bridge-generation PROVENANCE record, as the server writes it.
 *
 * Every field is optional, and that is the honest shape of this column rather than laziness. It is
 * untyped JSONB with four distinct populations in it at once:
 *
 *   • `{}` — a section that has never been generated;
 *   • the mechanical Minimal-UI write (`planVersion: '7'`, no LLM fields);
 *   • the LLM write (`planVersion: '7'`, the full `BridgeGenerationResult` provenance);
 *   • pre-7 "BridgePlan" rows still in the table, which SectionEditor still renders.
 *
 * The previous declaration described ONLY the fourth, and declared its fields REQUIRED — so it
 * matched no row the current code writes, and the readers that needed the real fields cast past
 * it (`simMeta as unknown as Record<string, unknown>`; "uiControls is not declared on the
 * generated SimMeta type yet"). types-001. `shared/src/__tests__/simMetaShape.test.ts` holds the
 * literal objects both write sites build, annotated with this type, so a drift between the two
 * fails `pnpm --filter shared typecheck`.
 */
export interface SimMeta {
  // ── Written by every planVersion-7 generation ────────────────────────────────
  /** '7' for anything the current controller writes; '5' and below are legacy BridgePlan rows. */
  planVersion?:         string;
  /** 'llm' when a prompt built the bridge, 'mechanical' for a hide-only Minimal-UI pass. */
  generatedBy?:         string;
  /** ISO timestamp of the write. */
  generatedAt?:         string;
  bridgeHash?:          string;
  /** True when the published bridge honours `startScript.params` (hideSelectors at runtime). */
  supportsRuntimeParams?: boolean;
  /** The user's Minimal-UI selection, persisted at generation time. */
  uiControls?:          SimMetaUiControls;

  // ── LLM path only (from BridgeGenerationResult) ──────────────────────────────
  /** The prompt the bridge was BUILT from — compared against `sim_prompt` by the canReuse gate. */
  prompt?:              string;
  sourceHash?:          string;
  provider?:            string;
  model?:               string;
  confidence?:          number;
  confidenceLevel?:     'high' | 'medium' | 'low';
  contextTruncated?:    boolean;
  retryCount?:          number;
  retryReason?:         string | null;
  warnings?:            string[];
  validationErrors?:    string[];
  validationWarnings?:  string[];
  runtimeValidated?:    boolean;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;

  // ── Legacy BridgePlan (planVersion <= 5) ─────────────────────────────────────
  // Kept, not deleted: these rows are still in the table and SectionEditor's "Last generation"
  // card still renders them. Dropping them here would only push that reader back to casting.
  targetControlId?:     string | null;
  hideControlIds?:      string[];
  hideButtonIds?:       string[];
  hideSelectorStrings?: string[];
  animation?: {
    enabled:      boolean;
    controllerId: string | null;
    min:          number;
    max:          number;
    step:         number;
    intervalMs:   number;
    showOptimal:  boolean;
  } | null;
}

export interface VideoGenerationJob {
  id: string;
  project_id: string;
  section_id: string | null;
  video_file_id: string | null;
  model: 'kling' | 'seedance' | 'veo';
  original_prompt: string;
  enhanced_prompt: string | null;
  enhance_enabled: boolean;
  target_duration_sec: number;
  target_global_offset_sec: number;
  // Resolved AT ENQUEUE (D-01) and copied verbatim onto the published section: this job can finish
  // twenty-five minutes after the author chose the spot, and inferring the anchor at completion
  // would read a timeline they never saw. Null when the project had no main video to anchor to.
  target_anchor_video_file_id?: string | null;
  target_anchor_offset_sec?: number | null;
  external_task_id: string | null;
  status:
    | 'queued' | 'enhancing' | 'submitting' | 'generating'
    | 'downloading' | 'transcoding' | 'ready' | 'failed';
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export type GuidanceTrigger =
  | { kind: 'feature'; targetId: string; events: Array<'pointerdown' | 'input' | 'change'> }
  | { kind: 'config';  predicateBody: string; observables: string[]; debounce?: number };

export interface GuidanceEntry {
  id:         string;
  kind:       'feature' | 'config';
  title:      string;
  narration:  string;
  enabled:    boolean;
  trigger:    GuidanceTrigger;
  audioUrl:   string | null;
  confidence: number;
  warnings:   string[];
}

export interface GuidanceMeta {
  provider?:     string;
  model?:        string;
  confidence?:   number;
  sourceHash?:   string;
  mdUrl?:        string;
  guidanceHash?: string;
  language?:     string;
  generatedAt?:  string;
  publishedAt?:  string;
  entryCount?:   number;
  droppedCount?: number;
  warnings?:     string[];
}

export type GuidanceStatus = 'none' | 'analyzing' | 'draft' | 'publishing' | 'ready' | 'error';

export interface Simulation {
  id:               string;
  project_id:       string;
  name:             string;
  storage_prefix:   string;
  entry_file:       string;
  bridge_functions: Array<{ name: string; windowFn: string; description: string }> | null;
  status:           'processing' | 'ready' | 'failed';
  error:            string | null;
  guidance?:        GuidanceEntry[] | null;
  guidance_status?: GuidanceStatus;
  guidance_meta?:   GuidanceMeta | null;
  guidance_error?:  string | null;
  created_at:       string;
}

export interface SimFile {
  key:      string;
  filename: string;
  ext:      string;
  url:      string;
  isText:   boolean;
}

// ── Playlists ───────────────────────────────────────────────────────────────

export interface Playlist {
  id: string;
  org_id: string;
  created_by: string | null;
  title: string | null;
  description: string | null;
  autoplay: boolean;
  show_sidebar: boolean;
  allow_shuffle: boolean;
  banner_url: string | null;
  banner_storage_key: string | null;
  banner_prompt: string | null;
  banner_provider: string | null;
  share_token: string | null;
  share_enabled_at: string | null;
  /** Creator-controlled permalink (043) — a playlist with a slug is public at {PUBLIC_SITE_URL}/{slug}. */
  slug?: string | null;
  access_type?: 'free' | 'paid';
  price_cents?: number | null;
  currency?: string;
  view_count?: number;
  created_at: string;
  updated_at: string;
  /** 'owner' for own playlists, 'collaborator' for playlists shared with you (042). */
  collab_role?: 'owner' | 'collaborator';
}

// ── Permalinks (migration 043) ───────────────────────────────────────────────

export interface PermalinkInfo {
  slug: string | null;
  /** Full public URL ({PUBLIC_SITE_URL}/{slug}), null when no slug is set. */
  permalinkUrl: string | null;
  /** Prefill suggestion derived from the title; only sent while slug is null. */
  suggestedSlug?: string | null;
  /** Public site origin the permalink lives under (no trailing slash). */
  baseUrl: string;
  /** Projects only — the permalink is live only while visibility === 'public'. */
  visibility?: 'private' | 'unlisted' | 'public';
}

export interface PermalinkAvailability {
  /** The normalised slug that would actually be saved (null when input is unusable). */
  slug: string | null;
  available: boolean;
  reason?: 'invalid' | 'reserved' | 'taken';
  message?: string;
}

// ── Library share (migration 065) ────────────────────────────────────────────
//
// The five routes of the materials mini-site. Declared here because this file is HAND-maintained
// and nothing enforces it against the Fastify routes — a backend change does not break the build,
// so an omission here is silent drift rather than a compile error.
//
// The public read is deliberately NOT a method on this client: `client-web/lib/libraryApi.ts`
// fetches it server-side with ISR tags and validates it against `LibraryViewSchema`, and routing it
// through the browser client would lose both. Its path is recorded here so the contract is
// complete: GET /api/v1/public/library/:slug?type= → LibraryView | 404.

export interface LibraryShareInfo {
  /** The public path segment, `{title-slug}-{code13}`. Null when the project has no live link. */
  slug: string | null;
  /** Full public URL ({PUBLIC_SITE_URL}/{slug}/library), null when there is no link. */
  url: string | null;
  /** The code-free `/{permalink}/library` form — only when the project is public with a permalink. */
  cleanUrl: string | null;
  includeTypes: Array<'simulation' | 'image' | 'video' | 'audio'> | null;
  expiresAt: string | null;
  createdAt: string | null;
  /** The project's title, so the share dialog can name what is being shared. */
  title: string | null;
}

export interface PlaylistItem {
  id: string;
  project_id: string;
  position: number;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  status: string;
}

export interface PlaylistWithItems extends Playlist {
  items: PlaylistItem[];
}

export interface PlaylistSummary extends Playlist {
  item_count: number;
  thumbnail_url?: string | null;
}

// Public play-config — each item carries its full project PlayerConfig.
//
// The viewer owns PlayerConfig's precise shape, and that is deliberate: restating a 60-field
// player contract here would give it two owners. What was NOT deliberate is expressing "the viewer
// owns it" as `any` (types-012) — `any` does not say "unspecified", it switches type checking OFF
// for every expression downstream of it, so `item.config.segmnets.length` compiles. `unknown` says
// the same thing about ownership and keeps the compiler on: a reader must narrow, exactly as
// client-web's own copy of this type does by declaring `config: PlayerConfig`.
export interface PlaylistPlayItem {
  project_id: string;
  title: string | null;
  description: string | null;
  thumbnail_url: string | null;
  config: unknown;
}

export interface PlaylistPlayConfig {
  id: string;
  title: string | null;
  description: string | null;
  autoplay: boolean;
  show_sidebar: boolean;
  allow_shuffle: boolean;
  banner_url: string | null;
  banner_prompt: string | null;
  banner_provider: string | null;
  items: PlaylistPlayItem[];
}

// ── Branching Interactive Videos (migration 037) ──────────────────────────────
export type BranchDestinationType =
  | 'sequence' | 'project' | 'playlist' | 'external_url'
  | 'simulation_full' | 'quiz' | 'back' | 'restart' | 'end';

export interface BranchSequence {
  id: string;
  project_id: string;
  label: string;
  is_entry: boolean;
  sort_order: number;
  graph_x: number;
  graph_y: number;
  created_at: string;
}

export interface BranchChoicePoint {
  id: string;
  project_id: string;
  sequence_id: string;
  lead_in_sec: number;
  timeout_sec: number | null;
  behavior: 'continue' | 'pause' | 'loop';
  prompt: string | null;
  layout: string;
  default_edge_id: string | null;
  created_at: string;
}

export interface BranchEdge {
  id: string;
  project_id: string;
  choice_point_id: string | null;
  label: string | null;
  description: string | null;
  thumbnail_url: string | null;
  sort_order: number;
  destination_type: BranchDestinationType;
  dest_sequence_id: string | null;
  dest_project_id: string | null;
  dest_playlist_id: string | null;
  dest_url: string | null;
  dest_simulation_id: string | null;
  dest_quiz_id: string | null;
  trigger_event: string | null;
  trigger_match: Record<string, unknown> | null;
  created_at: string;
}

export interface BranchVideoAssignment {
  id: string;
  filename: string;
  duration_sec: number | null;
  sequence_id: string | null;
  sequence_order: number | null;
}

export interface BranchGraph {
  sequences: BranchSequence[];
  choice_points: BranchChoicePoint[];
  edges: BranchEdge[];
  videos: BranchVideoAssignment[];
}

export interface BranchValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  sequence_id?: string;
  edge_id?: string;
}

export interface BranchAnalytics {
  total_events: number;
  sessions: number;
  completes: number;
  edge_choice_counts: Record<string, number>;
  sequence_enter_counts: Record<string, number>;
}

// ── Multi-language dubbing (migration 067) ──────────────────────────────────

/** A language this product can dub into. `code` is also the public URL suffix, 1:1. */
export interface DubbingLanguageOption {
  code: string;
  /** English name, for a UI that has no better idea what the reader speaks. */
  name: string;
  /** The language's own name — what a viewer picking it should actually see. */
  endonym: string;
  /** True when this is the language the video is already in — shown, but never a valid target. */
  is_source?: boolean;
  /** Right-to-left script; the caption overlay needs it to set `dir`. */
  rtl: boolean;
}

/** One video's dub in one language, as the creator's settings page sees it. */
export interface ProjectDub {
  id: string;
  video_file_id: string;
  language: string;
  language_name: string;
  language_endonym: string;
  rtl: boolean;
  provider: string;
  /** queued | processing | completed | stale | failed — the vendor's own target statuses. */
  status: string;
  /**
   * Whether this dub may actually be served. NOT the same as `status === 'completed'`: a
   * watermarked dub is finished and paid for but is never published to viewers.
   */
  servable: boolean;
  hls_url: string | null;
  captions_url: string | null;
  cost_cents: number | null;
  error: string | null;
  updated_at: string | null;
}

/** What a dubbing run would cost, shown BEFORE it is started. */
export interface DubCostEstimate {
  language_count: number;
  total_duration_sec: number;
  /** The headline figure the UI leads with, per source-minute per language. */
  usd_per_minute_per_language: number;
  /** Cost of dubbing this whole project into ONE language — multiply by the selection. */
  usd_per_language: number;
  estimated_usd: number;
  estimated_credits: number;
  /** True when the account's plan watermarks output, which makes a dub unpublishable. */
  watermarked: boolean;
  /** Set only when the plan watermarks — says what an operator must change. */
  watermark_notice: string | null;
}

export interface ProjectDubsResponse {
  /** The project's declared source language, or null when it has never been declared. */
  source_language?: string | null;
  dubs: ProjectDub[];
  supported_languages: DubbingLanguageOption[];
  estimate: DubCostEstimate;
}

export class ClientV1Api {
  private config: ApiConfig;

  constructor(config: ApiConfig) {
    this.config = config;
  }

  private async request<T>(
    path: string,
    opts: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const token = await this.config.getToken();
    const hasBody = opts.body !== undefined;
    const res = await fetch(this.config.baseURL + path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string };
      throw new Error(err.message ?? `HTTP ${res.status}`);
    }

    // 204 No Content and genuinely empty bodies must not be fed to JSON.parse.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async requestText(path: string): Promise<string> {
    const token = await this.config.getToken();
    const res = await fetch(this.config.baseURL + path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }

  private async requestBlob(path: string): Promise<Blob> {
    const token = await this.config.getToken();
    const res = await fetch(this.config.baseURL + path, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }

  private async requestMultipart<T>(path: string, formData: FormData): Promise<T> {
    const token = await this.config.getToken();
    const res = await fetch(this.config.baseURL + path, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText })) as { message?: string };
      throw new Error(err.message ?? `HTTP ${res.status}`);
    }

    return res.json() as Promise<T>;
  }

  // ── Platform ──────────────────────────────────────────────────────────────

  getPlatformSettings(): Promise<PlatformSettings> {
    return this.request('/api/v1/platform/settings');
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  createProject(body: CreateProject): Promise<{ id: string; status: string }> {
    return this.request('/api/v1/projects', { method: 'POST', body });
  }

  getProject(projectId: string): Promise<Project> {
    return this.request(`/api/v1/projects/${projectId}`);
  }

  listProjects(): Promise<Project[]> {
    return this.request('/api/v1/projects');
  }

  renameProject(projectId: string, title: string): Promise<Project> {
    return this.request(`/api/v1/projects/${projectId}`, { method: 'PATCH', body: { title } });
  }

  /**
   * Start an independent copy of a project — media, timeline, branching, simulations and
   * authoring inputs.
   *
   * Returns a DUPLICATION id, not a project id. The copy's project row is written only once every
   * byte has landed, in a single transaction, so that a failed copy leaves nothing behind; until
   * then there is no project to hand back. Poll `getProjectDuplication` and navigate when
   * `target_project_id` appears.
   */
  duplicateProject(projectId: string): Promise<StartedDuplication> {
    return this.request(`/api/v1/projects/${projectId}/duplicate`, { method: 'POST' });
  }

  getProjectDuplication(projectId: string, duplicationId: string): Promise<ProjectDuplication> {
    return this.request(`/api/v1/projects/${projectId}/duplications/${duplicationId}`);
  }

  /**
   * Start a linear video export of a project — main video, clips, images and audio spliced
   * server-side; scripted simulation sections captured (Phase 1: poster stills, recorded as
   * warnings), RAW "show full simulation" sections excluded by design.
   *
   * When the export would be DEGRADED (any simulation window falling back to its poster —
   * Phase 1: all of them) the server answers 409 `degraded_only` unless `allowDegraded` is
   * passed: show the returned warnings, get consent, retry with `allowDegraded: true`.
   *
   * Returns an EXPORT id. Poll `getProjectExport` and offer `download_url` when `ready`.
   */
  startProjectExport(projectId: string, opts: { allowDegraded?: boolean } = {}): Promise<StartedExport> {
    return this.request(`/api/v1/projects/${projectId}/export`, {
      method: 'POST',
      body: { allow_degraded: opts.allowDegraded ?? false },
    });
  }

  getProjectExport(projectId: string, exportId: string): Promise<ProjectExport> {
    return this.request(`/api/v1/projects/${projectId}/exports/${exportId}`);
  }

  /** Ask a running export to stop. The runner honours it between phases; poll for the outcome. */
  cancelProjectExport(projectId: string, exportId: string): Promise<ProjectExport> {
    return this.request(`/api/v1/projects/${projectId}/exports/${exportId}/cancel`, { method: 'POST' });
  }

  // Set who can view this project by id: private (owner only), unlisted (owner or a valid
  // share link), or public (anyone). Drafts default to private.
  setProjectVisibility(projectId: string, visibility: 'private' | 'unlisted' | 'public'): Promise<Project> {
    return this.request(`/api/v1/projects/${projectId}`, { method: 'PATCH', body: { visibility } });
  }

  updateProjectMeta(projectId: string, body: { title?: string; description?: string | null }): Promise<Project> {
    return this.request(`/api/v1/projects/${projectId}/meta`, { method: 'PATCH', body });
  }

  regenerateVideoMetadata(projectId: string, opts?: { prompt?: string; model?: 'gpt-4o-mini' | 'gpt-4o' }): Promise<{ status: string }> {
    return this.request(`/api/v1/projects/${projectId}/generate-metadata`, { method: 'POST', body: opts ?? {} });
  }

  // Generate a NEW thumbnail IMAGE with an image model from the video's known
  // info (title + SEO summary/keywords) + an optional hint. Returns the URL and
  // the updated project.
  generateAiThumbnail(projectId: string, hint?: string): Promise<{ thumbnail_url: string; project: Project }> {
    return this.request(`/api/v1/projects/${projectId}/thumbnail/generate-ai`, {
      method: 'POST',
      body: hint ? { hint } : {},
    });
  }

  enhanceThumbnailPrompt(projectId: string, prompt: string): Promise<{ prompt: string }> {
    return this.request(`/api/v1/projects/${projectId}/enhance-thumbnail-prompt`, { method: 'POST', body: { prompt } });
  }

  uploadProjectThumbnail(projectId: string, file: File): Promise<Project> {
    const formData = new FormData();
    formData.set('file', file);
    return this.requestMultipart(`/api/v1/projects/${projectId}/thumbnail`, formData);
  }

  deleteProject(projectId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}`, { method: 'DELETE' });
  }

  // ── Hosts ─────────────────────────────────────────────────────────────────

  listHosts(): Promise<Host[]> {
    return this.request('/api/v1/hosts');
  }

  createHost(body: CreateHost): Promise<Host> {
    return this.request('/api/v1/hosts', { method: 'POST', body });
  }

  // ── Corpus ────────────────────────────────────────────────────────────────

  addCorpus(
    projectId: string,
    bodyOrFormData: FormData | { source_url?: string; text?: string; source_type?: string },
    isMultipart?: boolean,
  ): Promise<Corpus> {
    const path = `/api/v1/projects/${projectId}/corpus`;
    if (isMultipart && bodyOrFormData instanceof FormData) {
      return this.requestMultipart(path, bodyOrFormData);
    }
    return this.request(path, { method: 'POST', body: bodyOrFormData });
  }

  getCorpusStatus(projectId: string, corpusId: string): Promise<Corpus> {
    return this.request(`/api/v1/projects/${projectId}/corpus/${corpusId}`);
  }

  // ── Videos ────────────────────────────────────────────────────────────────

  // Phase 2 presigned direct-to-cloud upload: get a PUT URL, PUT the file to it,
  // then confirm. (Multipart POST /videos/upload is still available as a fallback.)
  getVideoUploadUrl(
    projectId: string,
    body: { filename: string; content_type: string },
  ): Promise<{ upload_url: string; storage_key: string; content_type: string }> {
    return this.request(`/api/v1/projects/${projectId}/videos/upload-url`, { method: 'POST', body });
  }

  confirmVideoUpload(
    projectId: string,
    body: { storage_key: string; filename: string; file_size: number; replace_video_id?: string; duration_sec?: number },
  ): Promise<VideoFile> {
    return this.request(`/api/v1/projects/${projectId}/videos/confirm`, { method: 'POST', body });
  }

  // Multipart upload (large videos): start → presign each part (PUT direct to storage)
  // → complete (or abort). Only the part PUTs touch storage; these calls are plain JSON.
  startMultipartUpload(
    projectId: string,
    body: { filename: string; content_type: string; file_size: number },
  ): Promise<{ upload_id: string; storage_key: string; content_type: string; part_size: number }> {
    return this.request(`/api/v1/projects/${projectId}/videos/upload/multipart/start`, { method: 'POST', body });
  }

  getMultipartPartUrl(
    projectId: string,
    body: { storage_key: string; upload_id: string; part_number: number },
  ): Promise<{ url: string; part_number: number }> {
    return this.request(`/api/v1/projects/${projectId}/videos/upload/multipart/part-url`, { method: 'POST', body });
  }

  completeMultipartUpload(
    projectId: string,
    body: {
      storage_key: string;
      upload_id: string;
      filename: string;
      file_size: number;
      parts: { partNumber: number; etag: string }[];
      replace_video_id?: string;
      duration_sec?: number;
    },
  ): Promise<VideoFile> {
    return this.request(`/api/v1/projects/${projectId}/videos/upload/multipart/complete`, { method: 'POST', body });
  }

  abortMultipartUpload(
    projectId: string,
    body: { storage_key: string; upload_id: string },
  ): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/videos/upload/multipart/abort`, { method: 'POST', body });
  }

  listVideos(projectId: string): Promise<VideoFile[]> {
    return this.request(`/api/v1/projects/${projectId}/videos`);
  }

  getHlsStatus(projectId: string, videoId: string): Promise<HlsStatusResponse> {
    return this.request(`/api/v1/projects/${projectId}/videos/${videoId}/hls-status`);
  }

  deleteVideo(projectId: string, videoId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/videos/${videoId}`, { method: 'DELETE' });
  }

  recropProject(projectId: string): Promise<{ queued: boolean }> {
    return this.request(`/api/v1/projects/${projectId}/recrop`, { method: 'POST' });
  }

  thumbnailFromTimeline(projectId: string, timeSec: number): Promise<{ thumbnail_url: string }> {
    return this.request(`/api/v1/projects/${projectId}/thumbnail-from-timeline`, {
      method: 'POST',
      body: { time_seconds: timeSec },
    });
  }

  async getFramePreview(projectId: string, timeSec: number): Promise<string> {
    const blob = await this.requestBlob(
      `/api/v1/projects/${projectId}/frame-preview?time_seconds=${encodeURIComponent(timeSec)}`,
    );
    return URL.createObjectURL(blob);
  }

  // ── Timeline Sections ─────────────────────────────────────────────────────

  listSections(projectId: string): Promise<TimelineSection[]> {
    return this.request(`/api/v1/projects/${projectId}/sections`);
  }

  createSection(
    projectId: string,
    body: {
      video_file_id: string;
      start_sec: number;
      end_sec: number;
      type: string;
      label?: string | null;
      notes?: string | null;
      sort_order?: number | null;
      simulation_url?: string | null;
      simulation_id?: string | null;
      sim_script?: string | null;
      sim_prompt?: string | null;
      sim_meta?: SimMeta | null;
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
    },
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/sections`, { method: 'POST', body });
  }

  updateSection(
    projectId: string,
    sectionId: string,
    body: Partial<{ start_sec: number; end_sec: number; type: string; label: string | null; notes: string | null; sort_order: number | null; simulation_url: string | null; simulation_id: string | null; sim_script: string | null; sim_prompt: string | null; sim_meta: SimMeta | null; track: 'main' | 'broll' | 'audio'; global_offset_sec: number | null; clip_source_video_id: string | null; clip_in_sec: number | null; broll_volume: number; simple_ui: boolean; auto_script: boolean; clip_source_image_id: string | null; camera_movement: string; clip_source_audio_id: string | null }>,
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/sections/${sectionId}`, { method: 'PATCH', body });
  }

  deleteSection(projectId: string, sectionId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/sections/${sectionId}`, { method: 'DELETE' });
  }

  // ── Aggregate editor bootstrap ────────────────────────────────────────────

  getEditorState(projectId: string): Promise<EditorState> {
    return this.request(`/api/v1/projects/${projectId}/editor-state`);
  }

  // ── Timeline Markers (editor flags) ───────────────────────────────────────

  listMarkers(projectId: string): Promise<TimelineMarker[]> {
    return this.request(`/api/v1/projects/${projectId}/markers`);
  }

  createMarker(
    projectId: string,
    body: { at_sec: number; label?: string | null; notes?: string | null; color?: string | null },
  ): Promise<TimelineMarker> {
    return this.request(`/api/v1/projects/${projectId}/markers`, { method: 'POST', body });
  }

  updateMarker(
    projectId: string,
    markerId: string,
    body: Partial<{ at_sec: number; label: string | null; notes: string | null; color: string | null }>,
  ): Promise<TimelineMarker> {
    return this.request(`/api/v1/projects/${projectId}/markers/${markerId}`, { method: 'PATCH', body });
  }

  deleteMarker(projectId: string, markerId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/markers/${markerId}`, { method: 'DELETE' });
  }

  // ── Branching Interactive Videos ──────────────────────────────────────────
  getBranching(projectId: string): Promise<BranchGraph> {
    return this.request(`/api/v1/projects/${projectId}/branching`);
  }

  createBranchSequence(
    projectId: string,
    body: { label?: string; is_entry?: boolean; sort_order?: number; graph_x?: number; graph_y?: number } = {},
  ): Promise<BranchSequence> {
    return this.request(`/api/v1/projects/${projectId}/branch/sequences`, { method: 'POST', body });
  }

  updateBranchSequence(
    projectId: string,
    sequenceId: string,
    body: Partial<{ label: string; is_entry: boolean; sort_order: number; graph_x: number; graph_y: number }>,
  ): Promise<BranchSequence> {
    return this.request(`/api/v1/projects/${projectId}/branch/sequences/${sequenceId}`, { method: 'PATCH', body });
  }

  deleteBranchSequence(projectId: string, sequenceId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/branch/sequences/${sequenceId}`, { method: 'DELETE' });
  }

  assignVideoToSequence(
    projectId: string,
    body: { video_file_id: string; sequence_id: string | null; sequence_order?: number | null },
  ): Promise<{ id: string; sequence_id: string | null; sequence_order: number | null }> {
    return this.request(`/api/v1/projects/${projectId}/branch/assign`, { method: 'POST', body });
  }

  createChoicePoint(
    projectId: string,
    body: { sequence_id: string; lead_in_sec?: number; timeout_sec?: number | null; behavior?: 'continue' | 'pause' | 'loop'; prompt?: string | null; layout?: string },
  ): Promise<BranchChoicePoint> {
    return this.request(`/api/v1/projects/${projectId}/branch/choice-points`, { method: 'POST', body });
  }

  updateChoicePoint(
    projectId: string,
    choicePointId: string,
    body: Partial<{ lead_in_sec: number; timeout_sec: number | null; behavior: 'continue' | 'pause' | 'loop'; prompt: string | null; layout: string; default_edge_id: string | null }>,
  ): Promise<BranchChoicePoint> {
    return this.request(`/api/v1/projects/${projectId}/branch/choice-points/${choicePointId}`, { method: 'PATCH', body });
  }

  deleteChoicePoint(projectId: string, choicePointId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/branch/choice-points/${choicePointId}`, { method: 'DELETE' });
  }

  createBranchEdge(
    projectId: string,
    body: {
      choice_point_id?: string | null; label?: string | null; description?: string | null; thumbnail_url?: string | null; sort_order?: number;
      destination_type: BranchDestinationType;
      dest_sequence_id?: string | null; dest_project_id?: string | null; dest_playlist_id?: string | null; dest_url?: string | null; dest_simulation_id?: string | null; dest_quiz_id?: string | null;
      trigger_event?: string | null; trigger_match?: Record<string, unknown> | null;
    },
  ): Promise<BranchEdge> {
    return this.request(`/api/v1/projects/${projectId}/branch/edges`, { method: 'POST', body });
  }

  updateBranchEdge(projectId: string, edgeId: string, body: Partial<Omit<BranchEdge, 'id' | 'project_id' | 'created_at'>>): Promise<BranchEdge> {
    return this.request(`/api/v1/projects/${projectId}/branch/edges/${edgeId}`, { method: 'PATCH', body });
  }

  deleteBranchEdge(projectId: string, edgeId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/branch/edges/${edgeId}`, { method: 'DELETE' });
  }

  validateBranching(projectId: string): Promise<{ issues: BranchValidationIssue[] }> {
    return this.request(`/api/v1/projects/${projectId}/branch/validate`);
  }

  clearBranching(projectId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/branching`, { method: 'DELETE' });
  }

  getBranchAnalytics(projectId: string): Promise<BranchAnalytics> {
    return this.request(`/api/v1/projects/${projectId}/branch/analytics`);
  }

  // ── B-Roll ────────────────────────────────────────────────────────────────

  generateBroll(
    projectId: string,
    body: {
      prompt: string;
      model: 'kling' | 'seedance' | 'veo';
      enhance: boolean;
      target_duration_sec: number;
      target_global_offset_sec: number;
    },
  ): Promise<{ jobId: string; status: string }> {
    return this.request(`/api/v1/projects/${projectId}/broll/generate`, { method: 'POST', body });
  }

  listBrollJobs(projectId: string): Promise<VideoGenerationJob[]> {
    return this.request(`/api/v1/projects/${projectId}/broll/jobs`);
  }

  getBrollJob(projectId: string, jobId: string): Promise<VideoGenerationJob> {
    return this.request(`/api/v1/projects/${projectId}/broll/jobs/${jobId}`);
  }

  deleteBrollJob(projectId: string, jobId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/broll/jobs/${jobId}`, { method: 'DELETE' });
  }

  insertExistingBroll(
    projectId: string,
    body: { video_file_id: string; global_offset_sec: number; start_sec?: number; end_sec?: number },
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/broll/insert-existing`, { method: 'POST', body });
  }

  generateSimScript(
    projectId: string,
    sectionId: string,
    body: { prompt: string; simple_ui: boolean; auto_script: boolean },
  ): Promise<TimelineSection> {
    return this.request(
      `/api/v1/projects/${projectId}/sections/${sectionId}/generate-sim-script`,
      { method: 'POST', body },
    );
  }

  // ── Images ────────────────────────────────────────────────────────────────

  listImages(projectId: string): Promise<ImageFile[]> {
    return this.request(`/api/v1/projects/${projectId}/images`);
  }

  uploadImage(projectId: string, formData: FormData): Promise<ImageFile> {
    return this.requestMultipart(`/api/v1/projects/${projectId}/images`, formData);
  }

  // Replace an existing image's media (keeps the same id, crop, and timeline references).
  replaceImage(projectId: string, imageId: string, formData: FormData): Promise<ImageFile> {
    return this.requestMultipart(`/api/v1/projects/${projectId}/images/${imageId}/replace`, formData);
  }

  patchImageCrop(
    projectId: string,
    imageId: string,
    crop: { crop_x: number; crop_y: number; crop_w: number; crop_h: number },
  ): Promise<ImageFile> {
    return this.request(`/api/v1/projects/${projectId}/images/${imageId}`, { method: 'PATCH', body: crop });
  }

  deleteImage(projectId: string, imageId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/images/${imageId}`, { method: 'DELETE' });
  }

  // ── Audio files ───────────────────────────────────────────────────────────

  listAudioFiles(projectId: string): Promise<AudioFile[]> {
    return this.request(`/api/v1/projects/${projectId}/audio`);
  }

  uploadAudioFile(projectId: string, formData: FormData): Promise<AudioFile> {
    return this.requestMultipart(`/api/v1/projects/${projectId}/audio`, formData);
  }

  deleteAudioFile(projectId: string, audioId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/audio/${audioId}`, { method: 'DELETE' });
  }

  insertAudioCutaway(
    projectId: string,
    body: { audio_file_id: string; global_offset_sec: number; duration_sec: number; video_file_id: string },
  ): Promise<TimelineSection> {
    return this.request(`/api/v1/projects/${projectId}/audio/insert-cutaway`, { method: 'POST', body });
  }

  // ── Simulations ───────────────────────────────────────────────────────────

  listSimulations(projectId: string): Promise<Simulation[]> {
    return this.request(`/api/v1/projects/${projectId}/simulations`);
  }

  uploadSimulation(projectId: string, formData: FormData): Promise<Simulation> {
    return this.requestMultipart(`/api/v1/projects/${projectId}/simulations/upload`, formData);
  }

  deleteSimulation(projectId: string, simId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/simulations/${simId}`, { method: 'DELETE' });
  }

  updateSimulation(projectId: string, simId: string, body: { name: string }): Promise<Simulation> {
    return this.request(`/api/v1/projects/${projectId}/simulations/${simId}`, { method: 'PATCH', body });
  }

  listSimFiles(projectId: string, simId: string): Promise<SimFile[]> {
    return this.request(`/api/v1/projects/${projectId}/simulations/${simId}/files`);
  }

  getSimFileContent(projectId: string, simId: string, key: string): Promise<string> {
    return this.requestText(
      `/api/v1/projects/${projectId}/simulations/${simId}/file-content?key=${encodeURIComponent(key)}`,
    );
  }

  downloadSimZip(projectId: string, simId: string): Promise<Blob> {
    return this.requestBlob(`/api/v1/projects/${projectId}/simulations/${simId}/download.zip`);
  }

  // ── Playlists ───────────────────────────────────────────────────────────────

  listPlaylists(): Promise<PlaylistSummary[]> {
    return this.request('/api/v1/playlists');
  }

  listPlaylistsWithItems(): Promise<PlaylistWithItems[]> {
    return this.request('/api/v1/playlists?with_items=true');
  }

  createPlaylist(body: { title?: string; description?: string }): Promise<PlaylistWithItems> {
    return this.request('/api/v1/playlists', { method: 'POST', body });
  }

  getPlaylist(playlistId: string): Promise<PlaylistWithItems> {
    return this.request(`/api/v1/playlists/${playlistId}`);
  }

  updatePlaylist(
    playlistId: string,
    body: Partial<Pick<Playlist, 'title' | 'description' | 'autoplay' | 'show_sidebar' | 'allow_shuffle' | 'banner_url' | 'banner_prompt' | 'banner_provider'>>,
  ): Promise<PlaylistWithItems> {
    return this.request(`/api/v1/playlists/${playlistId}`, { method: 'PATCH', body });
  }

  uploadPlaylistBanner(playlistId: string, file: File): Promise<PlaylistWithItems> {
    const formData = new FormData();
    formData.append('file', file);
    return this.requestMultipart(`/api/v1/playlists/${playlistId}/banner`, formData);
  }

  generatePlaylistBanner(
    playlistId: string,
    body: { provider: 'openai' | 'gemini'; prompt?: string | null },
  ): Promise<PlaylistWithItems> {
    return this.request(`/api/v1/playlists/${playlistId}/banner/generate`, { method: 'POST', body });
  }

  deletePlaylist(playlistId: string): Promise<void> {
    return this.request(`/api/v1/playlists/${playlistId}`, { method: 'DELETE' });
  }

  setPlaylistItems(playlistId: string, projectIds: string[]): Promise<PlaylistWithItems> {
    return this.request(`/api/v1/playlists/${playlistId}/items`, {
      method: 'PUT',
      body: { items: projectIds.map((project_id) => ({ project_id })) },
    });
  }

  // ── Permalinks (migration 043) ──────────────────────────────────────────

  getProjectPermalink(projectId: string): Promise<PermalinkInfo> {
    return this.request(`/api/v1/projects/${projectId}/permalink`);
  }

  /** Pass null (or '') to remove the permalink. Throws with the server message on 400/409. */
  setProjectPermalink(projectId: string, slug: string | null): Promise<PermalinkInfo> {
    return this.request(`/api/v1/projects/${projectId}/permalink`, { method: 'PUT', body: { slug } });
  }

  getPlaylistPermalink(playlistId: string): Promise<PermalinkInfo> {
    return this.request(`/api/v1/playlists/${playlistId}/permalink`);
  }

  /** Pass null (or '') to remove the permalink. Throws with the server message on 400/409. */
  setPlaylistPermalink(playlistId: string, slug: string | null): Promise<PermalinkInfo> {
    return this.request(`/api/v1/playlists/${playlistId}/permalink`, { method: 'PUT', body: { slug } });
  }

  checkPermalinkAvailability(
    slug: string,
    exclude?: { type: 'project' | 'playlist'; id: string },
  ): Promise<PermalinkAvailability> {
    const params = new URLSearchParams({ slug });
    if (exclude) {
      params.set('exclude_type', exclude.type);
      params.set('exclude_id', exclude.id);
    }
    return this.request(`/api/v1/permalink-availability?${params.toString()}`);
  }

  // ── Library share (migration 065) ───────────────────────────────────────
  //
  // The four OWNER routes. All four answer 404 (never 403) when the caller may not edit the
  // project. The anonymous read that renders the page is fetched server-side by
  // `client-web/lib/libraryApi.ts`, not from here — see the LibraryShareInfo header.

  /** Current link state, or all-nulls when the project has no live link. */
  getLibraryShare(projectId: string): Promise<LibraryShareInfo> {
    return this.request(`/api/v1/projects/${projectId}/library-share`);
  }

  /** Mint. Idempotent — a second call returns the SAME slug, not a second link. 201. */
  createLibraryShare(projectId: string): Promise<LibraryShareInfo> {
    return this.request(`/api/v1/projects/${projectId}/library-share`, { method: 'POST' });
  }

  /** Change the type scope or the expiry. Dispatches an ISR purge for both URL forms. */
  updateLibraryShare(
    projectId: string,
    patch: { includeTypes?: Array<'simulation' | 'image' | 'video' | 'audio'>; expiresAt?: string | null },
  ): Promise<LibraryShareInfo> {
    return this.request(`/api/v1/projects/${projectId}/library-share`, { method: 'PATCH', body: patch });
  }

  /** Revoke: stamps revoked_at and purges the page. 204. */
  revokeLibraryShare(projectId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/library-share`, { method: 'DELETE' });
  }

  getPlaylistShare(playlistId: string): Promise<{ shareToken: string | null; shareUrl: string | null }> {
    return this.request(`/api/v1/playlists/${playlistId}/share`);
  }

  createPlaylistShare(playlistId: string): Promise<{ shareToken: string; shareUrl: string }> {
    return this.request(`/api/v1/playlists/${playlistId}/share`, { method: 'POST' });
  }

  revokePlaylistShare(playlistId: string): Promise<void> {
    return this.request(`/api/v1/playlists/${playlistId}/share`, { method: 'DELETE' });
  }

  // ── Collaboration (migration 042) ──────────────────────────────────────────

  listProjectCollaborators(projectId: string): Promise<CollaboratorsResponse> {
    return this.request(`/api/v1/projects/${projectId}/collaborators`);
  }

  addProjectCollaborator(projectId: string, email: string): Promise<{ collaborators: CollaboratorEntry[] }> {
    return this.request(`/api/v1/projects/${projectId}/collaborators`, {
      method: 'POST',
      body: { email },
    });
  }

  removeProjectCollaborator(projectId: string, collaboratorId: string): Promise<void> {
    return this.request(`/api/v1/projects/${projectId}/collaborators/${collaboratorId}`, { method: 'DELETE' });
  }

  listPlaylistCollaborators(playlistId: string): Promise<CollaboratorsResponse> {
    return this.request(`/api/v1/playlists/${playlistId}/collaborators`);
  }

  addPlaylistCollaborator(playlistId: string, email: string): Promise<{ collaborators: CollaboratorEntry[] }> {
    return this.request(`/api/v1/playlists/${playlistId}/collaborators`, {
      method: 'POST',
      body: { email },
    });
  }

  removePlaylistCollaborator(playlistId: string, collaboratorId: string): Promise<void> {
    return this.request(`/api/v1/playlists/${playlistId}/collaborators/${collaboratorId}`, { method: 'DELETE' });
  }

  getPlaylistPlayConfig(playlistId: string): Promise<PlaylistPlayConfig> {
    return this.request(`/api/v1/playlists/${playlistId}/play-config`);
  }

  // ── Billing / pay-to-unlock ─────────────────────────────────────────────────

  getBillingStatus(): Promise<BillingStatus> {
    return this.request('/api/v1/billing/status');
  }

  getContentAccess(contentType: ContentType, contentId: string): Promise<ContentAccess> {
    return this.request(`/api/v1/billing/access/${contentType}/${contentId}`);
  }

  createCheckout(contentType: ContentType, contentId: string): Promise<{ url: string }> {
    return this.request('/api/v1/billing/checkout', { method: 'POST', body: { content_type: contentType, content_id: contentId } });
  }

  /** Reconcile a Checkout session on the /unlock return — webhook backstop; idempotent. */
  reconcileCheckout(sessionId: string): Promise<{ granted: boolean }> {
    return this.request('/api/v1/billing/checkout/reconcile', { method: 'POST', body: { session_id: sessionId } });
  }

  openBillingPortal(returnUrl?: string): Promise<{ url: string }> {
    return this.request('/api/v1/billing/portal', { method: 'POST', body: { returnUrl } });
  }

  listPurchases(): Promise<Purchase[]> {
    return this.request('/api/v1/billing/purchases');
  }

  listBillingTransactions(): Promise<BillingTransaction[]> {
    return this.request('/api/v1/billing/transactions');
  }

  getCreatorEarnings(): Promise<CreatorEarnings> {
    return this.request('/api/v1/billing/earnings');
  }

  setContentPricing(
    contentType: ContentType,
    contentId: string,
    body: { access_type: 'free' | 'paid'; price_cents?: number | null; currency?: string },
  ): Promise<ContentPricing> {
    return this.request(`/api/v1/billing/pricing/${contentType}/${contentId}`, { method: 'PATCH', body });
  }

  // ── Podcast Studio ──────────────────────────────────────────────────────────

  listPodcastShows(): Promise<PodcastShow[]> {
    return this.request('/api/v1/podcasts');
  }

  createPodcastShow(body: CreatePodcastShow): Promise<PodcastShow> {
    return this.request('/api/v1/podcasts', { method: 'POST', body });
  }

  getPodcastShow(showId: string): Promise<PodcastShow> {
    return this.request(`/api/v1/podcasts/${showId}`);
  }

  updatePodcastShow(showId: string, body: UpdatePodcastShow): Promise<PodcastShow> {
    return this.request(`/api/v1/podcasts/${showId}`, { method: 'PATCH', body });
  }

  deletePodcastShow(showId: string): Promise<void> {
    return this.request(`/api/v1/podcasts/${showId}`, { method: 'DELETE' });
  }

  listPodcastEpisodes(showId: string): Promise<PodcastEpisode[]> {
    return this.request(`/api/v1/podcasts/${showId}/episodes`);
  }

  createPodcastEpisode(showId: string, body: CreatePodcastEpisode): Promise<PodcastEpisode> {
    return this.request(`/api/v1/podcasts/${showId}/episodes`, { method: 'POST', body });
  }

  getPodcastEpisode(showId: string, episodeId: string): Promise<PodcastEpisodeWithSources> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}`);
  }

  updatePodcastEpisode(showId: string, episodeId: string, body: UpdatePodcastEpisode): Promise<PodcastEpisode> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}`, { method: 'PATCH', body });
  }

  deletePodcastEpisode(showId: string, episodeId: string): Promise<void> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}`, { method: 'DELETE' });
  }

  listPodcastSources(showId: string, episodeId: string): Promise<PodcastSource[]> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/sources`);
  }

  createPodcastSource(showId: string, episodeId: string, body: CreatePodcastSource): Promise<PodcastSource> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/sources`, { method: 'POST', body });
  }

  uploadPodcastSource(showId: string, episodeId: string, file: File): Promise<PodcastSource> {
    const formData = new FormData();
    formData.append('file', file);
    return this.requestMultipart(`/api/v1/podcasts/${showId}/episodes/${episodeId}/sources/upload`, formData);
  }

  searchPodcastVoices(params: { search?: string; gender?: string; age?: string; accent?: string; language?: string; category?: string; use_case?: string; page?: number }): Promise<{ voices: SharedVoice[]; has_more: boolean }> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
    return this.request(`/api/v1/podcasts/voices/search?${q.toString()}`);
  }

  selectPodcastVoice(showId: string, body: { role: 'teacher' | 'learner'; public_owner_id: string; voice_id: string; name?: string }): Promise<PodcastShow> {
    return this.request(`/api/v1/podcasts/${showId}/voices`, { method: 'POST', body });
  }

  deletePodcastSource(showId: string, episodeId: string, sourceId: string): Promise<void> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/sources/${sourceId}`, { method: 'DELETE' });
  }

  // ── Podcast script (writers' room + editor) ─────────────────────────────────

  generatePodcastScript(showId: string, episodeId: string, body: { notes?: string } = {}): Promise<{ script_id: string; version: number }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/script/generate`, { method: 'POST', body });
  }

  getPodcastScript(showId: string, episodeId: string, version?: number): Promise<PodcastScriptResponse> {
    const q = version != null ? `?version=${version}` : '';
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/script${q}`);
  }

  updatePodcastTurn(
    showId: string, episodeId: string, version: number, turnId: string,
    patch: Partial<Pick<PodcastTurn, 'text' | 'speaker' | 'overlap' | 'pause_after_ms' | 'is_hook'>>,
  ): Promise<{ script: PodcastScript }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/script/${version}/turns/${turnId}`, { method: 'PATCH', body: patch });
  }

  replacePodcastTurns(showId: string, episodeId: string, version: number, turns: PodcastTurn[]): Promise<{ script: PodcastScript }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/script/${version}/turns`, { method: 'PUT', body: { turns } });
  }

  regeneratePodcastTurn(showId: string, episodeId: string, version: number, turnId: string, body: { hint?: string } = {}): Promise<{ script: PodcastScript; turn: PodcastTurn }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/script/${version}/turns/${turnId}/regenerate`, { method: 'POST', body });
  }

  approvePodcastScript(showId: string, episodeId: string, version: number): Promise<{ script: PodcastScript }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/script/${version}/approve`, { method: 'POST', body: {} });
  }

  // ── Podcast audio export ────────────────────────────────────────────────────

  startPodcastRender(showId: string, episodeId: string): Promise<{ render_id: string }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/render`, { method: 'POST', body: {} });
  }

  listPodcastRenders(showId: string, episodeId: string): Promise<PodcastRendersResponse> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/renders`);
  }

  getPodcastRender(showId: string, episodeId: string, renderId: string): Promise<PodcastRender> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/render/${renderId}`);
  }

  previewPodcastTurn(showId: string, episodeId: string, version: number, turnId: string): Promise<{ url: string }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/script/${version}/turns/${turnId}/preview`, { method: 'POST', body: {} });
  }

  // ── Audio Studio (migration 045) ────────────────────────────────────────────

  getPodcastStudio(showId: string, episodeId: string): Promise<PodcastStudioResponse> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/studio`);
  }

  generatePodcastStudio(showId: string, episodeId: string): Promise<{ mix_id: string; already_running?: boolean }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/studio/generate`, { method: 'POST', body: {} });
  }

  savePodcastMixTimeline(showId: string, episodeId: string, timeline: MixTimeline, baseRev: number): Promise<{ rev: number }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/studio/timeline`, { method: 'PUT', body: { timeline, base_rev: baseRev } });
  }

  revoicePodcastTurnClip(showId: string, episodeId: string, turnId: string): Promise<{ clip: PodcastStudioClip }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/studio/turns/${turnId}/clip`, { method: 'POST', body: {} });
  }

  listPodcastMixSnapshots(showId: string, episodeId: string): Promise<{ snapshots: PodcastMixSnapshotInfo[] }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/studio/snapshots`);
  }

  createPodcastMixSnapshot(showId: string, episodeId: string, name: string): Promise<{ snapshot: PodcastMixSnapshotInfo }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/studio/snapshots`, { method: 'POST', body: { name } });
  }

  restorePodcastMixSnapshot(showId: string, episodeId: string, snapshotId: string): Promise<{ rev: number; timeline: MixTimeline }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/studio/snapshots/${snapshotId}/restore`, { method: 'POST', body: {} });
  }

  exportPodcastMix(showId: string, episodeId: string, format: 'mp4' | 'mp3' | 'wav'): Promise<{ render_id: string; already_running?: boolean }> {
    return this.request(`/api/v1/podcasts/${showId}/episodes/${episodeId}/studio/export`, { method: 'POST', body: { format } });
  }

  // ── Multi-language dubbing (migration 067) ────────────────────────────────

  listProjectDubs(projectId: string): Promise<ProjectDubsResponse> {
    return this.request(`/api/v1/projects/${projectId}/dubs`);
  }

  /**
   * Queue a dub of every main video in the project into one language.
   *
   * THE ONLY BILLABLE CALL ON THIS CLIENT. Answers 202 — the work is queued, not done — and the
   * returned rows start in `queued`. Requesting a language that already has a dub is a no-op
   * rather than a second charge; `force` is what deliberately re-runs one.
   */
  createProjectDub(projectId: string, language: string, force = false): Promise<{ dubs: ProjectDub[] }> {
    return this.request(`/api/v1/projects/${projectId}/dubs`, { method: 'POST', body: { language, force } });
  }

  deleteProjectDub(projectId: string, language: string): Promise<{ removed: number }> {
    return this.request(`/api/v1/projects/${projectId}/dubs/${encodeURIComponent(language)}`, { method: 'DELETE' });
  }
}
