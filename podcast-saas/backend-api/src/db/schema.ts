import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  bigint,
  jsonb,
  timestamp,
  unique,
  uniqueIndex,
  index,
  check,
  foreignKey,
  real,
  doublePrecision,
  pgEnum,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const projectTierEnum = pgEnum('project_tier', ['standard', 'premium', 'hybrid']);
// Per-project visibility (migration 036): private = owner only; unlisted = owner or a valid
// share link; public = anyone by id. Drafts default to private (not world-readable by id).
export const projectVisibilityEnum = pgEnum('project_visibility', ['private', 'unlisted', 'public']);
export const projectStatusEnum = pgEnum('project_status', [
  'draft',
  'ingesting',
  'scripting',
  'script_ready',
  'approved',
  'generating',
  'ready',
  'failed',
]);
export const formatEnum = pgEnum('format', ['16:9', '9:16', '1:1']);
export const pacingEnum = pgEnum('pacing', ['relaxed', 'standard', 'energetic']);
export const emotionalStyleEnum = pgEnum('emotional_style', [
  'analytical',
  'warm',
  'playful',
  'serious',
]);
export const corpusSourceTypeEnum = pgEnum('corpus_source_type', [
  'pdf',
  'web',
  'youtube',
  'audio',
  'image',
  'text',
  'document',
]);
export const corpusIngestionStatusEnum = pgEnum('corpus_ingestion_status', [
  'pending',
  'processing',
  'ready',
  'failed',
]);
export const scriptStatusEnum = pgEnum('script_status', [
  'drafting',
  'rewriting',
  'validating',
  'ready',
  'approved',
  'failed',
]);
// 'anam' added by migration 075 — the avatar vendor's platform key becomes admin-manageable.
export const providerEnum = pgEnum('provider', ['claude', 'openai', 'gemini', 'elevenlabs', 'anam', 'groq']);
export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export const ttsProviderEnum = pgEnum('tts_provider', ['elevenlabs', 'gemini']);
export const shotTypeEnum = pgEnum('shot_type', [
  'wide',
  'closeup_a',
  'closeup_b',
  'reaction_a',
  'reaction_b',
]);
export const audioRenderStatusEnum = pgEnum('audio_render_status', [
  'pending',
  'processing',
  'ready',
  'failed',
]);

// Course publishing (migration 030)
export const publishStateEnum = pgEnum('publish_state', [
  'draft',
  'unlisted',
  'published',
  'archived',
]);
export const courseKindEnum = pgEnum('course_kind', ['single', 'playlist']);
export const archiveDispositionEnum = pgEnum('archive_disposition', [
  'temporary',
  'permanent',
  'redirect',
]);

// ── Tables ────────────────────────────────────────────────────────────────────

export const orgs = pgTable('orgs', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  owner_user_id: uuid('owner_user_id'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  firebase_uid: text('firebase_uid').unique().notNull(),
  email: text('email'),
  display_name: text('display_name'),
  is_anonymous: boolean('is_anonymous').default(false).notNull(),
  is_admin: boolean('is_admin').default(false).notNull(),
  default_org_id: uuid('default_org_id').references(() => orgs.id),
  weekly_token_limit: integer('weekly_token_limit'),
  monthly_token_limit: integer('monthly_token_limit'),
  stripe_customer_id: text('stripe_customer_id'),  // Stripe customer for pay-to-unlock (migration 024)
  anam_api_key_encrypted: text('anam_api_key_encrypted'),  // BYOK Anam key (migration 029)
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }),
});

export const api_keys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').references(() => orgs.id),
  user_id: uuid('user_id').references(() => users.id),
  provider: providerEnum('provider').notNull(),
  encrypted_key: text('encrypted_key').notNull(),
  kms_key_id: text('kms_key_id'),
  created_by: uuid('created_by').references(() => users.id),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const hosts = pgTable('hosts', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').references(() => orgs.id),
  name: text('name').notNull(),
  role: text('role').notNull(),
  persona_text: text('persona_text').notNull(),
  portrait_ref_urls: text('portrait_ref_urls').array(),
  voice_id: text('voice_id'),
  seed: bigint('seed', { mode: 'bigint' }),
  prompt_lock: text('prompt_lock'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id')
    .references(() => orgs.id)
    .notNull(),
  created_by: uuid('created_by').references(() => users.id),
  title: text('title'),
  tier: projectTierEnum('tier').default('standard').notNull(),
  topic: text('topic'),
  style_preset: text('style_preset'),
  host_a_id: uuid('host_a_id').references(() => hosts.id),
  host_b_id: uuid('host_b_id').references(() => hosts.id),
  format: formatEnum('format').default('16:9').notNull(),
  target_duration_min: integer('target_duration_min'),
  pacing: pacingEnum('pacing'),
  emotional_style: emotionalStyleEnum('emotional_style'),
  status: projectStatusEnum('status').default('draft').notNull(),
  // Access control (migration 036). New projects are private by default; existing rows were
  // backfilled to 'public' to preserve prior by-id access. See requireProjectAccess.
  visibility: projectVisibilityEnum('visibility').notNull().default('private'),
  share_token:       text('share_token').unique(),
  share_enabled_at:  timestamp('share_enabled_at', { withTimezone: true }),
  // Creator-controlled permalink (migration 043): public URL is {PUBLIC_SITE_URL}/{slug}.
  // One namespace with playlists.slug; uniqueness enforced by permalinkService + partial index.
  slug: text('slug'),
  // Pay-to-unlock (migration 024)
  access_type: text('access_type').notNull().default('free'),
  price_cents: integer('price_cents'),
  currency:    text('currency').notNull().default('usd'),
  // Auto-generated metadata (migration 025)
  thumbnail_url:   text('thumbnail_url'),
  thumbnail_key:   text('thumbnail_key'),
  metadata_status: text('metadata_status').notNull().default('none'), // none|processing|ready|failed
  // Transcript-derived SEO (migration 034) — generated from the captions once ready.
  seo_description: text('seo_description'),
  /** The language the project's video is already spoken in; null = undeclared, vendor auto-detects. */
  source_language: text('source_language'),
  /**
   * Where `source_language` came from (migration 070): 'declared' | 'detected' | 'vendor'.
   *
   * A guess and an assertion must not be stored identically. Detection can be wrong, and acting on
   * a wrong one silently removes a language the creator wanted; knowing the provenance is what lets
   * the UI say WHY a row is greyed out and offer to change it. Null beside a non-null language
   * predates this column and is read as 'declared' — the conservative reading.
   */
  source_language_origin: text('source_language_origin'),
  seo_keywords:    text('seo_keywords'),
  // View counter (migration 027)
  view_count: integer('view_count').notNull().default(0),
  // Per-video Ask-the-Avatar persona config (migration 029) — greeting, system
  // prompt, knowledge, language, avatarId/voiceId/llmId, advanced flags.
  avatar_config: jsonb('avatar_config'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const corpora = pgTable('corpora', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id')
    .references(() => projects.id)
    .notNull(),
  source_type: corpusSourceTypeEnum('source_type').notNull(),
  source_url: text('source_url'),
  storage_url: text('storage_url'),
  extracted_md: text('extracted_md'),
  hash: text('hash'),
  metadata: jsonb('metadata'),
  ingestion_status: corpusIngestionStatusEnum('ingestion_status').default('pending').notNull(),
  error: text('error'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const scripts = pgTable(
  'scripts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .references(() => projects.id)
      .notNull(),
    version: integer('version').notNull(),
    structural_json: jsonb('structural_json'),
    draft_body_json: jsonb('draft_body_json'),
    body_json: jsonb('body_json'),
    validation_errors: jsonb('validation_errors'),
    pass0_model: text('pass0_model'),
    pass0_input_tokens: integer('pass0_input_tokens'),
    pass0_output_tokens: integer('pass0_output_tokens'),
    pass0_cost_cents: integer('pass0_cost_cents'),
    pass1_model: text('pass1_model'),
    pass1_input_tokens: integer('pass1_input_tokens'),
    pass1_output_tokens: integer('pass1_output_tokens'),
    pass1_cost_cents: integer('pass1_cost_cents'),
    pass2_model: text('pass2_model'),
    pass2_input_tokens: integer('pass2_input_tokens'),
    pass2_output_tokens: integer('pass2_output_tokens'),
    pass2_cost_cents: integer('pass2_cost_cents'),
    status: scriptStatusEnum('status').default('drafting').notNull(),
    approved_at: timestamp('approved_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq_project_version: unique().on(t.project_id, t.version),
  }),
);

export const system_prompts = pgTable('system_prompts', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').unique().notNull(),
  name: text('name').notNull(),
  content: text('content').notNull(),
  is_customized: boolean('is_customized').default(false).notNull(),
  updated_by: uuid('updated_by').references(() => users.id),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const admin_settings = pgTable('admin_settings', {
  id: integer('id').primaryKey().default(1),
  billing_enabled: boolean('billing_enabled').default(true).notNull(),
  generation_paused: boolean('generation_paused').default(false).notNull(),
  generation_paused_message: text('generation_paused_message'),
  maintenance_mode: boolean('maintenance_mode').default(false).notNull(),
  maintenance_message: text('maintenance_message'),
  anonymous_user_limit: integer('anonymous_user_limit').default(3).notNull(),
  // Admin-controlled per-user generation quota (off by default = unlimited). When enabled, caps
  // billable LLM calls per user per rolling 24h (security-101).
  generation_limit_enabled: boolean('generation_limit_enabled').default(false).notNull(),
  generation_daily_limit: integer('generation_daily_limit').default(50).notNull(),
  default_provider: providerEnum('default_provider').default('gemini').notNull(),
  temperature: real('temperature').default(0.7).notNull(),
  max_tokens: integer('max_tokens').default(32000).notNull(),
  extended_thinking_enabled: boolean('extended_thinking_enabled').default(true).notNull(),
  thinking_budget_tokens: integer('thinking_budget_tokens').default(8000).notNull(),
  utility_model: text('utility_model').default('claude-haiku-4-5').notNull(),
  generation_model: text('generation_model').default('gemini-2.0-flash').notNull(),
  complex_model: text('complex_model').default('claude-opus-4-8').notNull(),
  complex_min_corpus_tokens: integer('complex_min_corpus_tokens').default(50000).notNull(),
  complex_min_retries: integer('complex_min_retries').default(2).notNull(),
  // Audio / TTS settings
  tts_provider: text('tts_provider').default('elevenlabs').notNull(),
  elevenlabs_model: text('elevenlabs_model').default('eleven_v3').notNull(),
  default_voice_id_a: text('default_voice_id_a'),
  // Anam default look/brain — admin-managed since 077; env vars are the fallback.
  avatar_default_avatar_id: text('avatar_default_avatar_id'),
  avatar_default_voice_id: text('avatar_default_voice_id'),
  avatar_default_llm_id: text('avatar_default_llm_id'),
  default_voice_id_b: text('default_voice_id_b'),
  // When true, a video's avatar uses its owner's own Anam key (BYOK); otherwise
  // the shared server ANAM_API_KEY is used for everyone (migration 029).
  avatar_byok_enabled: boolean('avatar_byok_enabled').default(false).notNull(),
  // Podcast Studio writers'-room model + effort (migration 044).
  podcast_model:  text('podcast_model').default('claude-opus-4-8').notNull(),
  podcast_effort: text('podcast_effort').default('max').notNull(),
  // Viewer simulation-pool kill switch (migration 048): 'adaptive' = package-identity
  // resident pool; 'single' = conservative one-frame-on-activation fallback.
  sim_pool_mode: text('sim_pool_mode').default('adaptive').notNull(),
  // ── RUM kill switch (migration 051) ─────────────────────────────────────────
  // 0 = collect nothing. Flippable at runtime with no deploy. The reader treats a missing column as
  // 0, so an image that boots before 051 is applied simply collects nothing.
  rum_sample_rate: real('rum_sample_rate').default(0).notNull(),
  rum_retention_days: integer('rum_retention_days').default(30).notNull(),
  // ── Priority 8 runtime kill switches (migration 052) ────────────────────────
  // All default to today's behaviour; each is flippable at runtime with no deploy.
  sim_scheduler_mode: text('sim_scheduler_mode').default('off').notNull(),
  sim_adaptive_quality: boolean('sim_adaptive_quality').default(false).notNull(),
  sim_boundary_sentinel: boolean('sim_boundary_sentinel').default(false).notNull(),
  sim_transition_coordinator: boolean('sim_transition_coordinator').default(false).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const token_usage = pgTable('token_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }), // keep usage history when project deleted
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  task: text('task').notNull(),
  input_tokens: integer('input_tokens').notNull(),
  cached_input_tokens: integer('cached_input_tokens').default(0).notNull(),
  output_tokens: integer('output_tokens').notNull(),
  // Fractional cents (migration 046) — sub-cent utility calls must not round to "free".
  cost_cents: doublePrecision('cost_cents').default(0).notNull(),
  used_personal_key: boolean('used_personal_key').default(false).notNull(),
  // What was actually bought, for the vendors that do not sell tokens (migration 073). TTS bills
  // per character, dubbing per source-minute, avatars per session-minute. NULL on LLM rows, whose
  // amount is already in the token columns above — see UsageTrackingService for why a guessed unit
  // is worse than an absent one.
  quantity: doublePrecision('quantity'),
  unit: text('unit'),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  // "what did each provider cost, per day" — the admin surface's only query (migration 073).
  idxProviderOccurred: index('idx_token_usage_provider_occurred').on(t.provider, t.occurred_at),
  // Hot path: the rolling-24h generation-cap count (migration 046).
  idxUserOccurred: index('idx_token_usage_user_occurred').on(t.user_id, t.occurred_at),
}));

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  project_id: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  status: jobStatusEnum('status').default('queued').notNull(),
  attempts: integer('attempts').default(0).notNull(),
  last_error: text('last_error'),
  idempotency_key: text('idempotency_key').unique(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  finished_at: timestamp('finished_at', { withTimezone: true }),
});

export const audio_renders = pgTable('audio_renders', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').references(() => projects.id).notNull(),
  script_version: integer('script_version').notNull(),
  status: audioRenderStatusEnum('status').default('pending').notNull(),
  provider: ttsProviderEnum('provider'),
  master_audio_url: text('master_audio_url'),
  duration_ms: integer('duration_ms'),
  alignment_json_url: text('alignment_json_url'),
  cost_cents: integer('cost_cents').default(0).notNull(),
  error: text('error'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  finished_at: timestamp('finished_at', { withTimezone: true }),
});

export const scenes = pgTable(
  'scenes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id').references(() => projects.id).notNull(),
    script_version: integer('script_version').notNull(),
    idx: integer('idx').notNull(),
    speaker: text('speaker').notNull(),
    start_ms: integer('start_ms').notNull(),
    end_ms: integer('end_ms').notNull(),
    transcript: text('transcript').notNull(),
    aligned_words: jsonb('aligned_words'),
    emotion: text('emotion').default('neutral').notNull(),
    audio_tags: text('audio_tags').array().default([]).notNull(),
    is_hook: boolean('is_hook').default(false).notNull(),
    audio_chunk_url: text('audio_chunk_url'),
    shot: shotTypeEnum('shot'),
    active_version: integer('active_version').default(1).notNull(),
  },
  (t) => ({
    uniq_project_scene: unique().on(t.project_id, t.script_version, t.idx),
  }),
);

export const camera_plans = pgTable(
  'camera_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id').references(() => projects.id).notNull(),
    script_version: integer('script_version').notNull(),
    cuts_json: jsonb('cuts_json').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    uniq_project_plan: unique().on(t.project_id, t.script_version),
  }),
);

// ── Video Editor ──────────────────────────────────────────────────────────────

export const videoFileStatusEnum = pgEnum('video_file_status', [
  'uploading',
  'ready',
  'failed',
]);

export const hlsTranscodeStatusEnum = pgEnum('hls_transcode_status', [
  'pending',
  'processing',
  'ready',
  'failed',
]);

export const video_files = pgTable('video_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  file_size: bigint('file_size', { mode: 'number' }),
  storage_key: text('storage_key'),
  status: videoFileStatusEnum('status').notNull().default('uploading'),
  duration_sec: real('duration_sec'),
  hls_status: hlsTranscodeStatusEnum('hls_status').notNull().default('pending'),
  hls_master_key: text('hls_master_key'),
  hls_current_tier: text('hls_current_tier'),
  hls_360p_key: text('hls_360p_key'),
  hls_started_at: timestamp('hls_started_at', { withTimezone: true }),
  hls_finished_at: timestamp('hls_finished_at', { withTimezone: true }),
  hls_error: text('hls_error'),
  waveform_peaks: text('waveform_peaks'),  // JSON array of 200 floats 0–1, set after transcode
  is_broll: boolean('is_broll').notNull().default(false),  // true for AI-generated broll source files
  // Smart portrait-crop metadata (migration 022) — computed in the background
  crop_status: text('crop_status').notNull().default('none'),   // none | processing | ready | failed
  crop_key: text('crop_key'),                                    // storage key of the crop-metadata JSON
  crop_source_hash: text('crop_source_hash'),                    // idempotency: re-run when the source changes
  crop_error: text('crop_error'),
  crop_updated_at: timestamp('crop_updated_at', { withTimezone: true }),
  crop_algo_version: text('crop_algo_version'),                  // which algorithm produced crop_key (migration 066)
  // Auto captions (migration 031) — generated as WebVTT from the source audio.
  captions_status: text('captions_status').notNull().default('none'), // none | processing | ready | failed
  captions_vtt_key: text('captions_vtt_key'),               // optional object-storage backup (legacy)
  captions_vtt: text('captions_vtt'),                        // WebVTT stored in DB (migration 033) — source of truth
  captions_source_hash: text('captions_source_hash'),
  captions_error: text('captions_error'),
  captions_updated_at: timestamp('captions_updated_at', { withTimezone: true }),
  // Branching (migration 037) — which sequence this main segment belongs to and its
  // order within it. Null for non-branching projects and for broll source files.
  sequence_id: uuid('sequence_id'),                          // FK → branch_sequences (declared below)
  sequence_order: integer('sequence_order'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Content-addressed bytes shared with other projects (078). Null on rows that predate dedup. */
  blob_id: uuid('blob_id').references(() => media_blobs.id),
});

/**
 * HLS run trees retired by a re-transcode, pending grace-period deletion (migration 053).
 *
 * A re-transcode flips the DB pointer to a fresh versioned tree; the OLD tree is recorded here
 * instead of being deleted under viewers mid-session, and the hourly sweep
 * (sweepRetiredHlsRuns) deletes the storage prefix only once `retire_after` has passed.
 *
 * No FK on video_file_id: entity deletion purges the whole hls/{id}/ storage prefix itself and
 * drops these rows explicitly (deleteHlsRetirementRowsForVideo), so a FK would only turn that
 * ordinary cleanup into a constraint hazard.
 */
export const hls_retired_runs = pgTable(
  'hls_retired_runs',
  {
    id:            uuid('id').primaryKey().defaultRandom(),
    video_file_id: uuid('video_file_id').notNull(),
    /** The retired run tree's storage prefix, e.g. `hls/{videoFileId}/{runId}`. */
    prefix:        text('prefix').notNull().unique(),
    retired_at:    timestamp('retired_at', { withTimezone: true }).notNull().defaultNow(),
    retire_after:  timestamp('retire_after', { withTimezone: true }).notNull(),
    deleted_at:    timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    idx_video: index('idx_hls_retired_runs_video').on(t.video_file_id),
    // idx_hls_retired_runs_due — the partial index (WHERE deleted_at IS NULL) the sweep uses —
    // is declared in 053 only: Drizzle's index builder has no WHERE clause (see the
    // sim_revisions note below), and declaring it here without one would create a total index.
  }),
);

export type HlsRetiredRunRow = typeof hls_retired_runs.$inferSelect;

export const simulations = pgTable('simulations', {
  id:               uuid('id').primaryKey().defaultRandom(),
  project_id:       uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name:             text('name').notNull(),
  storage_prefix:   text('storage_prefix').notNull(),
  entry_file:       text('entry_file').notNull(),  // full public URL of injected entry HTML
  bridge_functions: jsonb('bridge_functions'),
  status:           text('status').notNull().default('processing'),
  error:            text('error'),
  // ── Guided Simulation (migration 019) — mother-sim-level voice guidance ──────
  guidance:         jsonb('guidance'),                              // GuidanceEntry[] (draft or published)
  guidance_status:  text('guidance_status').notNull().default('none'), // none|analyzing|draft|publishing|ready|error
  guidance_meta:    jsonb('guidance_meta'),                         // {provider,model,confidence,sourceHash,mdUrl,guidanceHash,language,generatedAt,entryCount,droppedCount}
  guidance_error:   text('guidance_error'),
  // ── Publish-time canary verdict (migration 049) ─────────────────────────────
  // NULL until a canary has run against this package. Nothing may infer "legacy" from a NULL —
  // it means unclassified, and an unclassified package keeps the pre-v3 behaviour exactly.
  // Hash of the CURRENT combined bridge.js. The package revision is derived from it, so it must be
  // package-scoped — see migration 049 for why the per-section `?v=` parameter is not.
  bridge_hash:      text('bridge_hash'),
  package_class:    text('package_class'),                          // SimPackageClass | null
  canary_report:    jsonb('canary_report'),                         // CanaryReport | null
  canary_at:        timestamp('canary_at', { withTimezone: true }),
  // ── Immutable package revisions (migration 050) ─────────────────────────────
  // THE POINTER. The only mutable thing about a revisioned package: everything it points at lives
  // under a path containing the revision id and is never rewritten. NULL means this simulation has
  // no revisions and serves from its legacy mutable prefix — packageRevisionFor() falls back to the
  // pre-revision derivation for exactly that case, which is what makes 050 strictly additive.
  //
  // No .references() here: the FK is declared in 050 and adding it to the Drizzle table would make
  // simulations and sim_revisions mutually recursive at module scope. It is enforced in the DB.
  active_revision_id:        uuid('active_revision_id'),
  // Full storage key of the active revision's entry document. Denormalised so buildPlayerConfig —
  // the hottest read path — resolves the pointer without joining. Written in the SAME UPDATE as
  // active_revision_id; simulations_active_revision_pair_chk forbids them from disagreeing.
  active_revision_entry_key: text('active_revision_entry_key'),
  // Monotonic allocator for revision_number, incremented under the row lock. Never max()+1.
  revision_counter:          integer('revision_counter').notNull().default(0),
  // Derived from this package's canary report at publication (migration 051). A scalar, so the
  // hottest read path never pulls canary_report JSONB to learn one number.
  prepare_budget_ms:         integer('prepare_budget_ms'),
  // Does the ACTIVE revision's bridge acknowledge applied sections with SCRIPT_APPLIED?
  // (migration 055). A three-state projection of `sim_revisions.metadata.bridgeCapabilities`,
  // written in the same pointer-flip statement as package_class for the same reason: the answer
  // describes BYTES, so it must travel with the pointer or a rollback would leave it describing a
  // revision that is no longer served. NULL means UNKNOWN — every package published before 055 —
  // and the viewer's apply gate handles unknown as its own case rather than guessing either way.
  bridge_ack_capable:        boolean('bridge_ack_capable'),
  // Does the ACTIVE revision's ENTRY DOCUMENT carry `<script type="importmap">`? (migration 057,
  // audit P0.8.) Same shape and same statement as `bridge_ack_capable` for the same reason: it is a
  // property of the published bytes, projected from `sim_revisions.metadata.bridgeCapabilities` at
  // the pointer flip, so a rollback describes the revision that is actually served. NULL means
  // UNKNOWN, and unknown is never treated as "requires" — a browser without import-map support
  // degrades exactly the packages recorded as needing them and nothing else.
  requires_import_maps:      boolean('requires_import_maps'),
  created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One immutable published package revision (migration 050).
 *
 * A revision's bytes are written once, under a prefix containing its id, and never rewritten.
 * Switching which revision is live is a single pointer update on `simulations`, so a viewer holding
 * the old pointer keeps receiving a complete, self-consistent old package rather than a mix.
 *
 * The canary verdict lives HERE and not only on the simulation row because activation and rollback
 * change which bytes are served WITHOUT touching bridge_hash — and bridge_hash is what currently
 * clears the row-level verdict. A verdict that survived a rollback would grant the modern runtime
 * path to bytes no canary ever ran against.
 */
export const sim_revisions = pgTable(
  'sim_revisions',
  {
    id:                       uuid('id').primaryKey().defaultRandom(),
    simulation_id:            uuid('simulation_id').notNull().references(() => simulations.id, { onDelete: 'cascade' }),
    revision_number:          integer('revision_number').notNull(),
    status:                   text('status').notNull().default('draft'),   // SimRevisionStatus
    manifest_hash:            text('manifest_hash'),
    entry_path:               text('entry_path'),                          // prefix-relative, inside the revision
    bridge_protocol_version:  integer('bridge_protocol_version'),
    runtime_protocol_version: integer('runtime_protocol_version'),
    package_class:            text('package_class'),                       // SimPackageClass | null
    canary_report:            jsonb('canary_report'),
    canary_at:                timestamp('canary_at', { withTimezone: true }),
    rollback_of_revision_id:  uuid('rollback_of_revision_id'),             // FK declared in 050
    created_by:               text('created_by'),                          // may be a script, so no FK
    metadata:                 jsonb('metadata'),
    created_at:               timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activated_at:             timestamp('activated_at', { withTimezone: true }),
    retired_at:               timestamp('retired_at', { withTimezone: true }),
  },
  (t) => ({
    uniq_sim_number: unique('uniq_sim_revisions_sim_number').on(t.simulation_id, t.revision_number),
    idx_sim_activated: index('idx_sim_revisions_sim_activated').on(t.simulation_id, t.activated_at),
    idx_status_created: index('idx_sim_revisions_status_created').on(t.status, t.created_at),
    // uniq_sim_revisions_active — the partial unique index enforcing at most one active revision
    // per simulation — is declared in 050 only. Drizzle's index builder has no WHERE clause, so
    // expressing it here would silently create a TOTAL unique index and forbid a simulation from
    // ever having a second revision.
  }),
);

/**
 * Captured poster images, one row per presentation identity (migration 049).
 *
 * `identity` is posterIdentityString(key) — the five key fields joined — and is the only part of a
 * poster that a storage path can be parsed back into, which is what makes the orphan sweep possible.
 * It is UNIQUE per simulation, so re-capturing the same identity upserts rather than accumulating.
 */
export const sim_posters = pgTable(
  'sim_posters',
  {
    id:               uuid('id').primaryKey().defaultRandom(),
    simulation_id:    uuid('simulation_id').notNull().references(() => simulations.id, { onDelete: 'cascade' }),
    package_revision: text('package_revision').notNull(),
    variant_key:      text('variant_key').notNull(),
    config_hash:      text('config_hash').notNull(),
    aspect_profile:   text('aspect_profile').notNull(),   // SimAspectProfile
    quality_profile:  text('quality_profile').notNull(),  // SimQualityProfile
    identity:         text('identity').notNull(),
    variants:         jsonb('variants').notNull(),        // PosterVariantRecord[]
    transparent:      boolean('transparent').notNull().default(false),
    captured_at:      timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq_sim_identity: unique('uniq_sim_posters_sim_identity').on(t.simulation_id, t.identity),
    idx_revision: index('idx_sim_posters_revision').on(t.simulation_id, t.package_revision),
  }),
);

// Image files uploaded by the user for animated still-image overlays (migration 018)
/**
 * One row per distinct piece of content, however many projects reference it (migration 078).
 * Identity is the PAIR (sha256, byte_size) — see contentIdentity.ts for why the hash alone is not
 * the key, and 078_media_blobs.sql for why there is no ref_count column.
 */
/**
 * "Save bridge" (migration 079): a section's bridge setup, saved under a user-chosen label,
 * loadable onto another simulation. RECIPE fields (prompt/toggles/selection) apply anywhere;
 * the ARTIFACT (main_body) applies only after SimBridgeContract verification proves every anchor
 * it binds to exists in the target — otherwise the load regenerates from the recipe.
 */
/**
 * A simulation's files, stored ONCE however many simulations contain them (migration 080).
 * `blob_id` has no ON DELETE action on purpose: Postgres then refuses to drop a blob any
 * simulation still references — the same enforced invariant 078 relies on.
 */
export const sim_files = pgTable('sim_files', {
  simulation_id: uuid('simulation_id').notNull().references(() => simulations.id, { onDelete: 'cascade' }),
  rel_path:      text('rel_path').notNull(),
  blob_id:       uuid('blob_id').notNull().references(() => media_blobs.id),
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.simulation_id, t.rel_path] }),
}));

export const saved_bridges = pgTable('saved_bridges', {
  id:          uuid('id').primaryKey().defaultRandom(),
  created_by:  uuid('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  label:       text('label').notNull(),
  // The recipe — always applicable.
  sim_prompt:  text('sim_prompt'),
  simple_ui:   boolean('simple_ui').notNull().default(false),
  auto_script: boolean('auto_script').notNull().default(true),
  ui_controls: jsonb('ui_controls'),
  // The artifact — gated behind contract verification.
  main_body:   text('main_body'),
  contract:    jsonb('contract'),
  // Provenance and drift detection; never a hard link — a preset must outlive its source.
  source_simulation_id: uuid('source_simulation_id').references(() => simulations.id, { onDelete: 'set null' }),
  source_bridge_hash:   text('source_bridge_hash'),
  source_hash:          text('source_hash'),
  conversation_history: jsonb('conversation_history'),
  created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const media_blobs = pgTable('media_blobs', {
  id:               uuid('id').primaryKey().defaultRandom(),
  sha256:           text('sha256').notNull(),
  byte_size:        bigint('byte_size', { mode: 'number' }).notNull(),
  storage_key:      text('storage_key').notNull(),
  content_type:     text('content_type'),
  created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  last_verified_at: timestamp('last_verified_at', { withTimezone: true }),
  orphaned_at:      timestamp('orphaned_at', { withTimezone: true }),
});

export const image_files = pgTable('image_files', {
  id:           uuid('id').primaryKey().defaultRandom(),
  project_id:   uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  filename:     text('filename').notNull(),
  storage_key:  text('storage_key').notNull(),
  original_url: text('original_url').notNull(),
  width:        integer('width'),
  height:       integer('height'),
  // Crop region as fractions of the original image (0.0–1.0)
  crop_x: real('crop_x').notNull().default(0),
  crop_y: real('crop_y').notNull().default(0),
  crop_w: real('crop_w').notNull().default(1),
  crop_h: real('crop_h').notNull().default(1),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Content-addressed bytes shared with other projects (078). Null on rows that predate dedup. */
  blob_id: uuid('blob_id').references(() => media_blobs.id),
});

export const audio_files = pgTable('audio_files', {
  id:          uuid('id').primaryKey().defaultRandom(),
  project_id:  uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  filename:    text('filename').notNull(),
  storage_key: text('storage_key').notNull(),
  url:         text('url').notNull(),
  duration_sec: real('duration_sec'),
  created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Content-addressed bytes shared with other projects (078). Null on rows that predate dedup. */
  blob_id: uuid('blob_id').references(() => media_blobs.id),
});

export const timeline_sections = pgTable('timeline_sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  video_file_id: uuid('video_file_id').notNull().references(() => video_files.id, { onDelete: 'cascade' }),
  start_sec: real('start_sec').notNull(),
  end_sec: real('end_sec').notNull(),
  type: text('type').notNull(),
  label: text('label'),
  notes: text('notes'),
  sort_order: integer('sort_order'),
  simulation_url: text('simulation_url'),
  simulation_id: uuid('simulation_id').references(() => simulations.id, { onDelete: 'set null' }),
  sim_script:  text('sim_script'),
  sim_prompt:  text('sim_prompt'),
  simple_ui:   boolean('simple_ui').notNull().default(false),
  auto_script: boolean('auto_script').notNull().default(true),
  // B-roll multi-track support (migration 010)
  track: text('track').notNull().default('main'),           // 'main' | 'broll' | 'audio'
  global_offset_sec: real('global_offset_sec'),             // broll/audio only: absolute start on main timeline
  sim_meta: jsonb('sim_meta'),                              // bridge generation plan metadata (migration 013)
  // Clip source fields (migration 014) — used by the new "clip" section type
  clip_source_video_id: uuid('clip_source_video_id').references(() => video_files.id, { onDelete: 'set null' }),
  clip_in_sec: real('clip_in_sec').default(0),              // in-point in source video (seconds)
  // Audio gain control (migration 017) — used for broll audio volume 0.0–1.0
  broll_volume: real('broll_volume').notNull().default(1.0),
  // Image clip fields (migration 018) — still image with animated camera movement
  clip_source_image_id: uuid('clip_source_image_id').references(() => image_files.id, { onDelete: 'set null' }),
  camera_movement: text('camera_movement').notNull().default('zoom_in'),
  // Audio-only cutaway (migration 020) — broll section backed by uploaded audio file
  clip_source_audio_id: uuid('clip_source_audio_id').references(() => audio_files.id, { onDelete: 'set null' }),
  // ── Segment-relative placement (migration 063, D-01) ───────────────────────────────────────
  //
  // `global_offset_sec` above is an ABSOLUTE second, and that is the defect: re-transcode a main
  // video to a slightly different length and every b-roll after it still fires at the second it was
  // saved at, which is now a different moment. The number was never wrong; it stopped meaning what
  // the author intended.
  //
  // The anchor is a MAIN VIDEO SEGMENT plus a time inside it, so the overlay moves with the content
  // it was placed over. It is its own column pair rather than a reuse of `video_file_id`, because on
  // a b-roll row `video_file_id` already means the b-roll SOURCE asset — a video that has no
  // position on the main timeline at all.
  //
  // NULLABLE, and `placement_mode` defaults to 'legacy_absolute': this is the expand half of an
  // expand/contract rollout. `resolveSectionPlacement` (shared) reads the anchor first and falls
  // back to `global_offset_sec`, so one deploy serves both populations. NOTHING is backfilled —
  // mapping a row's absolute second onto today's segments would canonise a placement that is
  // already wrong. See `planAnchorBackfill` for the dry run that reports instead of converting.
  //
  // NO ACTION since 069, and it was ON DELETE SET NULL before that. 063 chose SET NULL to protect
  // the CONTENT — deleting a main video must not delete the b-roll placed over it — and that half
  // was right. What it left was a SILENT orphaning: every anchored overlay lost its anchor and fell
  // back to a wall-clock second that was now wrong, with nothing said to anyone. D-01b asks for the
  // opposite default, so the delete is now refused by the database and the route runs a
  // transactional preflight that makes the author choose (detach, or delete the dependents). A row
  // with `placement_mode='segment'` and a NULL anchor is still reachable — it is what an explicit
  // `detach` leaves behind — and that is why the mode is a stored column and not a computed
  // `anchor_video_file_id != null`: "was anchored, lost its host" is not "was never anchored".
  anchor_video_file_id: uuid('anchor_video_file_id').references(() => video_files.id),
  anchor_offset_sec: real('anchor_offset_sec'),
  placement_mode: text('placement_mode').notNull().default('legacy_absolute'),   // 'segment' | 'legacy_absolute'
  // Which b-roll GENERATION produced this row (migration 062). NULL for every hand-made section.
  //
  // This is the idempotency key of the generation pipeline, not a display field: a `video_generate`
  // job is delivered at least once (pg-boss retries, startup re-drive), and without a key on the
  // section a retry simply appended a second overlay at the same offset. SET NULL so deleting the
  // finished job never deletes the b-roll.
  //
  // uniq_timeline_sections_generation_job — the PARTIAL unique index that makes a second section
  // for one generation impossible — is declared in migration 062 only, for the same reason
  // project_exports and project_duplications give for theirs: Drizzle's index builder has no WHERE
  // clause, and a TOTAL unique index here would permit exactly ONE hand-made section per database.
  //
  // NO `.references()` here, and the omission is deliberate. The real FK
  // (→ video_generation_jobs(id) ON DELETE SET NULL) is declared in 062 and enforced by the
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * PLACEMENTS A MEDIA CHANGE LEFT OUTSIDE THEIR HOST — the queue, not the fix (migration 069, D-01b).
 *
 * A b-roll anchored twelve seconds into "the intro" is still twelve seconds into the intro after
 * the intro is re-transcoded; that is what 063's anchor is for, and it needs no help. But an author
 * who REPLACES the intro with a shorter file has left a placement with no honest answer, and the
 * three ways to compute one are all wrong: clamping it to the new end destroys the authored value
 * in place, zeroing it moves the clip to the top of the video, and attaching it to the next segment
 * invents an intent nobody expressed. So nothing is computed. The row is kept exactly as authored
 * and one row lands here for a person to settle.
 *
 * The numbers are captured AT DETECTION on purpose. By the time anyone opens the list the timeline
 * may have moved again, and "60 s → 12 s" is the only form in which the finding is still checkable.
 *
 * `uniq_placement_impact_open` — at most one OPEN item per (section, reason) — is declared in
 * migration 069 only: it is PARTIAL (`WHERE resolved_at IS NULL`), and Drizzle's index builder has
 * no WHERE clause, so declaring it here would forbid a section from ever having a second review
 * after the first was resolved. Same for `idx_placement_impact_open_by_project`.
 */
export const placement_impact_reviews = pgTable('placement_impact_reviews', {
  id:                       uuid('id').primaryKey().defaultRandom(),
  project_id:               uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** CASCADE: a review of a section that no longer exists is noise. Deleting the clip IS an answer. */
  section_id:               uuid('section_id').notNull().references(() => timeline_sections.id, { onDelete: 'cascade' }),
  /**
   * SET NULL, not CASCADE, for one reason code: `host_deleted_detached` is written in the same
   * transaction that deletes the host, and CASCADE would delete the review as fast as it appeared.
   * The host's name lives in `detail` for that case, because the id will not survive.
   */
  host_video_file_id:       uuid('host_video_file_id').references(() => video_files.id, { onDelete: 'set null' }),
  /** anchor_out_of_range | source_window_out_of_range | host_deleted_detached */
  reason:                   text('reason').notNull(),
  /** duration_correction | media_replace | host_delete — recorded, because it is not recoverable later. */
  change_kind:              text('change_kind').notNull(),
  host_duration_before_sec: real('host_duration_before_sec'),
  host_duration_after_sec:  real('host_duration_after_sec'),
  /** As stored on the row. NOT a proposal: nothing here is ever applied to a placement. */
  anchor_offset_sec:        real('anchor_offset_sec'),
  window_start_sec:         real('window_start_sec'),
  window_end_sec:           real('window_end_sec'),
  /** Where the row played at detection — the number that lets a person find the clip. */
  absolute_sec:             real('absolute_sec'),
  detail:                   text('detail'),
  detected_at:              timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  resolved_at:              timestamp('resolved_at', { withTimezone: true }),
  /** re_placed | accepted | dismissed. There is deliberately no `auto_fixed`. */
  resolution:               text('resolution'),
});

export type PlacementImpactReview = typeof placement_impact_reviews.$inferSelect;
export type NewPlacementImpactReview = typeof placement_impact_reviews.$inferInsert;

// Editor timeline markers (migration 041) — Premiere-style flags the editor drops at a point
// on the timeline (button or "m" hotkey) so they don't forget a note while cutting. Positioned
// by absolute seconds on the global main timeline; rendered as a red vertical line + note.
export const timeline_markers = pgTable('timeline_markers', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // ABSOLUTE, and kept as the fallback rather than replaced (migration 076). A marker that predates
  // the anchor columns resolves exactly as it always has; one that has been moved since carries the
  // anchor pair below and follows its content when an earlier clip changes length.
  at_sec: real('at_sec').notNull(),
  anchor_video_file_id: uuid('anchor_video_file_id').references(() => video_files.id, { onDelete: 'set null' }),
  anchor_offset_sec: real('anchor_offset_sec'),
  // `segment` | `legacy_absolute`. A column rather than a computed `anchor_video_file_id != null`,
  // so a row whose host was deleted stays distinguishable from one that was never anchored — see
  // the `anchor_missing` degradation in shared/timeline/placement.ts.
  placement_mode: text('placement_mode').notNull().default('legacy_absolute'),
  label: text('label'),
  notes: text('notes'),
  color: text('color').notNull().default('#ef4444'),         // red, matching the playhead
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const video_generation_jobs = pgTable('video_generation_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  section_id: uuid('section_id').references(() => timeline_sections.id, { onDelete: 'set null' }),
  video_file_id: uuid('video_file_id').references(() => video_files.id, { onDelete: 'set null' }),
  model: text('model').notNull(),                           // 'kling' | 'seedance' | 'veo'
  original_prompt: text('original_prompt').notNull(),
  enhanced_prompt: text('enhanced_prompt'),
  enhance_enabled: boolean('enhance_enabled').notNull().default(true),
  target_duration_sec: real('target_duration_sec').notNull(),
  target_global_offset_sec: real('target_global_offset_sec').notNull(),
  // WHERE THE FINISHED CLIP GOES — captured AT ENQUEUE TIME (migration 063, D-01).
  //
  // `target_global_offset_sec` alone is an absolute second, and this job can take twenty-five
  // minutes. The timeline is editable that whole time: re-transcode a main video, or drop another
  // clip in, and the second the author aimed at is no longer the moment they aimed at. Inferring
  // the anchor at COMPLETION would read the moved timeline and recreate exactly that race, so the
  // anchor is resolved once, from the timeline the author was looking at when they pressed the
  // button, and the finaliser copies it onto the section verbatim.
  //
  // Nullable: a project with no main video has nothing to anchor to, and the job still runs. The
  // section it publishes then falls back to `legacy_absolute`, which is the pre-063 behaviour.
  target_anchor_video_file_id: uuid('target_anchor_video_file_id').references(() => video_files.id, { onDelete: 'set null' }),
  target_anchor_offset_sec: real('target_anchor_offset_sec'),
  external_task_id: text('external_task_id'),
  status: text('status').notNull().default('queued'),
  // queued | enhancing | submitting | generating | downloading | transcoding | ready | failed
  error: text('error'),
  // ── The lease (migration 062) ──────────────────────────────────────────────────────────────
  // The job is delivered at least once and runs for up to ~25 minutes. These three columns are
  // what stop two workers running it at the same time, and what let a run that DIED be told apart
  // from one that is merely slow. Same shape and same numbers as project_exports/project_duplications.
  //
  // `updated_at` is the heartbeat, beaten on a timer by the live run.
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  // `claimed_by` is a FENCING TOKEN, one value per RUN — every write after the claim carries
  // `WHERE claimed_by = <my token>`, so a reclaimed run's writes become no-ops rather than races.
  claimed_by: text('claimed_by'),
  // Incremented BY THE CLAIM, so "has anyone run this row before?" is answerable without a race.
  // It exists for exactly one decision: never re-submit to the paid provider after a crash that
  // may already have submitted. Not a retry budget — pg-boss owns those.
  attempts: integer('attempts').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  finished_at: timestamp('finished_at', { withTimezone: true }),
});

// Playlists — ordered collections of projects played back-to-back (migration 021)
export const playlists = pgTable('playlists', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').references(() => orgs.id).notNull(),
  created_by: uuid('created_by').references(() => users.id),
  title: text('title'),
  description: text('description'),
  autoplay:      boolean('autoplay').notNull().default(true),       // auto-advance with countdown
  show_sidebar:  boolean('show_sidebar').notNull().default(true),   // YouTube-style aside + description
  allow_shuffle: boolean('allow_shuffle').notNull().default(true),
  banner_url: text('banner_url'),
  banner_storage_key: text('banner_storage_key'),
  banner_prompt: text('banner_prompt'),
  banner_provider: text('banner_provider'),
  share_token:      text('share_token').unique(),
  share_enabled_at: timestamp('share_enabled_at', { withTimezone: true }),
  // Creator-controlled permalink (migration 043). A playlist with a slug is public
  // at {PUBLIC_SITE_URL}/{slug} (playlists have no visibility column — slug = public).
  slug: text('slug'),
  // Pay-to-unlock (migration 024)
  access_type: text('access_type').notNull().default('free'),
  price_cents: integer('price_cents'),
  currency:    text('currency').notNull().default('usd'),
  // View counter (migration 027)
  view_count: integer('view_count').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One public link to a project's MATERIALS — simulations, images, video files and sounds
 * (migration 065). Not `projects.share_token`: this capability opens a read-only materials page
 * and nothing else, so minting it never publishes the video.
 *
 * `slug` is `slugify(projects.title) + '-' + code`, which puts the capability INSIDE the path
 * segment. That is the load-bearing choice — it gives the ISR page exactly one cache key per
 * share, so revoking is a complete purge, and it detaches the link from `projects.slug`, which
 * the permalink editor lets the creator rewrite or clear at any moment.
 *
 * Writes zero bucket objects. The page re-emits URLs the materials already have.
 */
export const library_shares = pgTable('library_shares', {
  id:            uuid('id').primaryKey().defaultRandom(),
  project_id:    uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  slug:          text('slug').notNull(),
  /** The 13-char base32 capability, also the slug suffix. NEVER emitted in a public response. */
  code:          text('code').notNull(),
  include_types: text('include_types').array().notNull(),
  expires_at:    timestamp('expires_at', { withTimezone: true }),
  revoked_at:    timestamp('revoked_at', { withTimezone: true }),
  /** Cache-MISS counter, not a visitor counter — ISR caps it at one per path per 60s. */
  render_count:  integer('render_count').notNull().default(0),
  created_by:    uuid('created_by').references(() => users.id),
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const playlist_items = pgTable(
  'playlist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playlist_id: uuid('playlist_id').notNull().references(() => playlists.id, { onDelete: 'cascade' }),
    project_id:  uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq_playlist_project: unique().on(t.playlist_id, t.project_id),
  }),
);

// Collaboration (migration 042) — invite users by email to co-edit a project or playlist.
// Polymorphic like user_purchases. invited_email is lowercased.
//
// `invited_email` records WHO AN INVITATION IS ADDRESSED TO. It is NOT a credential, and nothing
// may authorize on it. A row grants access only once `user_id` is set, and `user_id` is set only by
// the auth middleware when the signing-in account presents a token with email_verified === true.
// Invite creation always writes user_id = null, even when an account with that address already
// exists — resolving it early would hand access to an address nobody has proven they own.
//
// The previous comment here described the opposite ("user_id is resolved at invite time when the
// user exists, otherwise matched by email once they sign in"). That behaviour was removed: it let
// an unverified account authorize by raw email match, which is broad edit authority.
export const collaborators = pgTable(
  'collaborators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    content_type:  text('content_type').notNull(),          // project | playlist
    content_id:    uuid('content_id').notNull(),
    invited_email: text('invited_email').notNull(),
    user_id:    uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    invited_by: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq_content_email: unique().on(t.content_type, t.content_id, t.invited_email),
  }),
);

// Billing (migration 024) — pay-to-unlock transactions + persistent purchases.
export const billing_transactions = pgTable('billing_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  stripe_checkout_session_id: text('stripe_checkout_session_id'),
  stripe_payment_intent_id:   text('stripe_payment_intent_id'),
  type:   text('type').notNull().default('charge'),       // charge | refund
  status: text('status').notNull().default('pending'),    // pending | succeeded | failed | refunded
  amount_cents:        integer('amount_cents').notNull(),
  currency:            text('currency').notNull().default('usd'),
  platform_fee_cents:  integer('platform_fee_cents').notNull().default(0),
  creator_payout_cents: integer('creator_payout_cents').notNull().default(0),
  payer_user_id:   uuid('payer_user_id').references(() => users.id, { onDelete: 'set null' }),
  payer_email:     text('payer_email'),
  creator_user_id: uuid('creator_user_id').references(() => users.id, { onDelete: 'set null' }),
  content_type:    text('content_type').notNull(),         // project | playlist
  content_id:      uuid('content_id').notNull(),
  description:     text('description'),
  error:           text('error'),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completed_at: timestamp('completed_at', { withTimezone: true }),
});

export const user_purchases = pgTable(
  'user_purchases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    user_id:      uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    content_type: text('content_type').notNull(),          // project | playlist
    content_id:   uuid('content_id').notNull(),
    transaction_id: uuid('transaction_id').references(() => billing_transactions.id, { onDelete: 'set null' }),
    amount_cents: integer('amount_cents').notNull(),
    currency:     text('currency').notNull().default('usd'),
    purchased_at: timestamp('purchased_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq_user_content: unique().on(t.user_id, t.content_type, t.content_id),
  }),
);

// ── Ask-the-Avatar (migration 028) — interactive avatar + visual Library ───────

// The avatar's visual Library. scope='basic' are assets the editor put in the
// project; scope='extended' are visuals the avatar generated and stored for reuse.
export const avatar_visuals = pgTable('avatar_visuals', {
  id:                 uuid('id').primaryKey().defaultRandom(),
  project_id:         uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }), // null = global
  scope:              text('scope').notNull().default('extended'),    // basic | extended
  source:             text('source').notNull().default('generated'),  // editor | generated | uploaded
  character_id:       text('character_id').notNull().default('einstein'),
  visual_type:        text('visual_type').notNull(),                  // image | equation | chart | diagram | simulation
  lookup_key:         text('lookup_key'),
  caption:            text('caption'),
  alt_text:           text('alt_text'),
  image_url:          text('image_url'),
  image_key:          text('image_key'),
  dalle_prompt:       text('dalle_prompt'),
  visual_spec:        jsonb('visual_spec'),
  sim_storage_prefix: text('sim_storage_prefix'),
  sim_entry_url:      text('sim_entry_url'),
  use_count:          integer('use_count').notNull().default(0),
  created_by:         uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  created_at:         timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const avatar_conversations = pgTable('avatar_conversations', {
  id:           uuid('id').primaryKey().defaultRandom(),
  session_key:  text('session_key').notNull(),
  character_id: text('character_id').notNull(),
  project_id:   uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  role:         text('role').notNull(),       // user | persona
  content:      text('content').notNull(),
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const avatar_profiles = pgTable('avatar_profiles', {
  id:          uuid('id').primaryKey().defaultRandom(),
  session_key: text('session_key').notNull().unique(),
  facts:       jsonb('facts').notNull().default({}),
  updated_at:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Course publishing layer (migration 030) ───────────────────────────────────
// A course owns the public URL, publication state, canonical host, course-level
// SEO and (future) custom-domain config. It has one lesson (single-video course)
// or many ordered lessons (playlist course). The reusable interactive content
// stays in `projects`; a lesson references a project. SEO columns are overrides
// only (nullable) — effective values are resolved at render time, never stored.

export const courses = pgTable(
  'courses',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    org_id:     uuid('org_id').references(() => orgs.id).notNull(),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    kind:       courseKindEnum('kind').notNull().default('single'),

    // Source content (server-rendered landing page text)
    title:                 text('title'),
    subtitle:              text('subtitle'),
    description:           text('description'),
    learning_outcomes:     jsonb('learning_outcomes'),       // string[]
    instructor_name:       text('instructor_name'),
    instructor_bio:        text('instructor_bio'),
    instructor_avatar_url: text('instructor_avatar_url'),
    cover_image_url:       text('cover_image_url'),
    cover_image_key:       text('cover_image_key'),

    // Publication state machine
    publish_state:            publishStateEnum('publish_state').notNull().default('draft'),
    published_at:             timestamp('published_at', { withTimezone: true }),
    archived_at:              timestamp('archived_at', { withTimezone: true }),
    archive_disposition:      archiveDispositionEnum('archive_disposition'),
    archived_replacement_url: text('archived_replacement_url'),

    // Routing / SEO (overrides only — nullable)
    slug:            text('slug').notNull(),
    canonical_host:  text('canonical_host'),     // null = platform default host
    canonical_url:   text('canonical_url'),       // explicit full canonical override
    seo_title:       text('seo_title'),
    seo_description: text('seo_description'),
    og_title:        text('og_title'),
    og_description:  text('og_description'),
    og_image_url:    text('og_image_url'),
    og_image_key:    text('og_image_key'),
    language:        text('language').notNull().default('en'),
    indexable:       boolean('indexable').notNull().default(true),

    // Backfill provenance (one course per legacy source)
    legacy_playlist_id: uuid('legacy_playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
    legacy_project_id:  uuid('legacy_project_id').references(() => projects.id, { onDelete: 'set null' }),

    view_count: integer('view_count').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Unique slug under the canonical-host strategy (default host = sentinel)
    uniqHostSlug:       uniqueIndex('uniq_courses_host_slug').on(sql`COALESCE(${t.canonical_host}, '@platform')`, t.slug),
    uniqLegacyPlaylist: uniqueIndex('uniq_courses_legacy_playlist').on(t.legacy_playlist_id).where(sql`${t.legacy_playlist_id} IS NOT NULL`),
    uniqLegacyProject:  uniqueIndex('uniq_courses_legacy_project').on(t.legacy_project_id).where(sql`${t.legacy_project_id} IS NOT NULL`),
    idxOrg:             index('idx_courses_org').on(t.org_id),
    idxPublishState:    index('idx_courses_publish_state').on(t.publish_state),
    slugFormatChk:      check('courses_slug_format_chk', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    languageFormatChk:  check('courses_language_format_chk', sql`${t.language} ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'`),
    outcomesArrayChk:   check('courses_outcomes_array_chk', sql`${t.learning_outcomes} IS NULL OR jsonb_typeof(${t.learning_outcomes}) = 'array'`),
    // Archive state machine (see migration 030 for the full rationale).
    archivedDispositionChk: check('courses_archived_requires_disposition_chk', sql`${t.publish_state} <> 'archived' OR ${t.archive_disposition} IS NOT NULL`),
    archivedTimestampChk:   check('courses_archived_requires_timestamp_chk', sql`${t.publish_state} <> 'archived' OR ${t.archived_at} IS NOT NULL`),
    redirectUrlChk:         check('courses_redirect_requires_url_chk', sql`${t.archive_disposition} <> 'redirect' OR (${t.archived_replacement_url} IS NOT NULL AND length(btrim(${t.archived_replacement_url})) > 0)`),
    replacementUrlOnlyChk:  check('courses_replacement_url_only_redirect_chk', sql`${t.archived_replacement_url} IS NULL OR ${t.archive_disposition} = 'redirect'`),
    nonArchivedCleanChk:    check('courses_non_archived_clean_chk', sql`${t.publish_state} = 'archived' OR (${t.archive_disposition} IS NULL AND ${t.archived_replacement_url} IS NULL AND ${t.archived_at} IS NULL)`),
  }),
);

export const course_lessons = pgTable(
  'course_lessons',
  {
    id:        uuid('id').primaryKey().defaultRandom(),
    course_id: uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
    // CASCADE: deleting the source project/video removes its lesson (so a video
    // can always be deleted from the home page). Course deletion still cascades
    // to its lessons; this only adds removal when the underlying project is gone.
    project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    position:   integer('position').notNull(),

    // Lesson routing + optional SEO overrides (null = inherit course)
    slug:            text('slug').notNull(),
    title:           text('title'),
    summary:         text('summary'),
    seo_title:       text('seo_title'),
    seo_description: text('seo_description'),
    og_title:        text('og_title'),
    og_description:  text('og_description'),
    og_image_url:    text('og_image_url'),
    language:        text('language'),
    indexable:       boolean('indexable'),

    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqCourseSlug:     unique('uniq_lesson_course_slug').on(t.course_id, t.slug),
    uniqCourseProject:  unique('uniq_lesson_course_project').on(t.course_id, t.project_id),
    // DEFERRABLE so a single transaction can reorder positions without tripping
    // (the DEFERRABLE clause itself lives in migration 030; Drizzle can't express it).
    uniqCoursePosition: unique('uniq_lesson_course_position').on(t.course_id, t.position),
    // Target of the composite FK from project_redirect_targets.
    uniqIdProject:      unique('uniq_lesson_id_project').on(t.id, t.project_id),
    idxCourse:          index('idx_course_lessons_course').on(t.course_id),
    idxProject:         index('idx_course_lessons_project').on(t.project_id),
    slugFormatChk:      check('course_lessons_slug_format_chk', sql`${t.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    positionChk:        check('course_lessons_position_chk', sql`${t.position} >= 0`),
    languageFormatChk:  check('course_lessons_language_format_chk', sql`${t.language} IS NULL OR ${t.language} ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'`),
  }),
);

// Future custom-domain → course mapping. Present now so custom domains can be
// added later without changing the course/lesson model. The canonical resolver
// consults this table; absence of a row ⇒ platform default host.
export const course_custom_domains = pgTable(
  'course_custom_domains',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    course_id:   uuid('course_id').notNull().references(() => courses.id, { onDelete: 'cascade' }),
    hostname:    text('hostname').notNull(),
    is_primary:  boolean('is_primary').notNull().default(false),
    verified:    boolean('verified').notNull().default(false),
    verified_at: timestamp('verified_at', { withTimezone: true }),
    created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqHostname:    unique('uniq_custom_domain_hostname').on(t.hostname),
    uniqPrimary:     uniqueIndex('uniq_custom_domain_primary').on(t.course_id).where(sql`${t.is_primary}`),
    hostnameLowerChk: check('custom_domain_hostname_lower_chk', sql`${t.hostname} = lower(${t.hostname})`),
  }),
);

// Canonical lesson a legacy project's /v/<shareToken> link redirects to. One per
// project; the composite FK proves the target lesson belongs to this project.
export const project_redirect_targets = pgTable(
  'project_redirect_targets',
  {
    project_id:       uuid('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
    course_lesson_id: uuid('course_lesson_id').notNull(),
    is_ambiguous:     boolean('is_ambiguous').notNull().default(false),
    candidate_count:  integer('candidate_count').notNull().default(1),
    created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sameProjectFk: foreignKey({
      columns: [t.course_lesson_id, t.project_id],
      foreignColumns: [course_lessons.id, course_lessons.project_id],
      name: 'fk_redirect_lesson_same_project',
    }).onDelete('cascade'),
    candidateCountChk: check('project_redirect_candidate_count_chk', sql`${t.candidate_count} >= 1`),
    idxLesson:         index('idx_project_redirect_lesson').on(t.course_lesson_id),
  }),
);

// ── Branching Interactive Videos (migration 037) ──────────────────────────────
// A project's timeline becomes a graph of "sequences" (sub-timelines). Main video
// segments are assigned to a sequence via video_files.sequence_id. A sequence may end
// with a choice point whose edges route the viewer to a destination. Backward-compat:
// a project with no branch_sequences rows is one implicit linear sequence.

export const branch_sequences = pgTable(
  'branch_sequences',
  {
    id:         uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    label:      text('label').notNull().default('Sequence'),
    is_entry:   boolean('is_entry').notNull().default(false),  // the graph's start node
    sort_order: integer('sort_order').notNull().default(0),
    graph_x:    real('graph_x').notNull().default(0),          // React-Flow canvas position
    graph_y:    real('graph_y').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxProject: index('idx_branch_sequences_project').on(t.project_id),
    // At most one entry sequence per project.
    uniqEntry:  uniqueIndex('uniq_branch_entry').on(t.project_id).where(sql`${t.is_entry}`),
  }),
);

export const branch_choice_points = pgTable(
  'branch_choice_points',
  {
    id:          uuid('id').primaryKey().defaultRandom(),
    project_id:  uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sequence_id: uuid('sequence_id').notNull().references(() => branch_sequences.id, { onDelete: 'cascade' }),
    lead_in_sec: real('lead_in_sec').notNull().default(10),    // appears N sec before sequence end
    timeout_sec: real('timeout_sec'),                          // null = wait indefinitely
    // What the video does while waiting for a choice (creator-configurable).
    behavior:    text('behavior').notNull().default('continue'),  // continue | pause | loop
    prompt:      text('prompt'),
    layout:      text('layout').notNull().default('cards'),    // cards | buttons | quiz
    default_edge_id: uuid('default_edge_id'),                  // FK enforced in SQL (forward ref)
    created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxSequence:   index('idx_branch_cp_sequence').on(t.sequence_id),
    idxProject:    index('idx_branch_cp_project').on(t.project_id),
    behaviorChk:   check('branch_cp_behavior_chk', sql`${t.behavior} IN ('continue', 'pause', 'loop')`),
  }),
);

export const branch_edges = pgTable(
  'branch_edges',
  {
    id:              uuid('id').primaryKey().defaultRandom(),
    project_id:      uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    // null = auto edge (no overlay) or a sim-triggered edge (Phase 4).
    choice_point_id: uuid('choice_point_id').references(() => branch_choice_points.id, { onDelete: 'cascade' }),
    label:           text('label'),
    description:     text('description'),
    thumbnail_url:   text('thumbnail_url'),
    sort_order:      integer('sort_order').notNull().default(0),

    destination_type: text('destination_type').notNull(),     // see check below
    // Polymorphic refs — exactly one set is meaningful per destination_type.
    dest_sequence_id:   uuid('dest_sequence_id').references(() => branch_sequences.id, { onDelete: 'cascade' }),
    dest_project_id:    uuid('dest_project_id').references(() => projects.id, { onDelete: 'set null' }),
    dest_playlist_id:   uuid('dest_playlist_id').references(() => playlists.id, { onDelete: 'set null' }),
    dest_url:           text('dest_url'),
    dest_simulation_id: uuid('dest_simulation_id').references(() => simulations.id, { onDelete: 'set null' }),
    dest_quiz_id:       uuid('dest_quiz_id'),                  // quiz table is Phase 4

    // Simulation-triggered condition (Phase 4).
    trigger_event:   text('trigger_event'),
    trigger_match:   jsonb('trigger_match'),

    created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxChoicePoint: index('idx_branch_edges_cp').on(t.choice_point_id),
    idxProject:     index('idx_branch_edges_project').on(t.project_id),
    destTypeChk:    check('branch_edges_dest_type_chk', sql`${t.destination_type} IN ('sequence', 'project', 'playlist', 'external_url', 'simulation_full', 'quiz', 'back', 'restart', 'end')`),
  }),
);

// Branching analytics (migration 038) — viewer path events. Soft refs to sequence/edge.
export const branch_path_events = pgTable(
  'branch_path_events',
  {
    id:               uuid('id').primaryKey().defaultRandom(),
    project_id:       uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    session_id:       text('session_id').notNull(),
    event_type:       text('event_type').notNull(),       // sequence_enter | choice | complete
    sequence_id:      uuid('sequence_id'),
    edge_id:          uuid('edge_id'),
    destination_type: text('destination_type'),
    created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxProject: index('idx_branch_events_project').on(t.project_id),
    idxEdge:    index('idx_branch_events_edge').on(t.edge_id),
  }),
);

// ── Podcast Studio (migration 044) — standalone homepage product ──────────────
// Shows → Episodes. NOT related to video projects. Two-host generator: multi-agent
// writers' room → editable per-turn script → ElevenLabs v3 export → single-channel MP4.

export const podcast_shows = pgTable('podcast_shows', {
  id:               uuid('id').primaryKey().defaultRandom(),
  org_id:           uuid('org_id').notNull().references(() => orgs.id),
  created_by:       uuid('created_by').references(() => users.id),
  title:            text('title'),
  description:      text('description'),
  language:         text('language').notNull().default('en'),
  teacher_name:     text('teacher_name').notNull().default('Brittney'),
  teacher_voice_id: text('teacher_voice_id'),
  learner_name:     text('learner_name').notNull().default('Titan'),
  learner_voice_id: text('learner_voice_id'),
  teacher_persona:  text('teacher_persona'),
  learner_persona:  text('learner_persona'),
  niche_pack:       text('niche_pack').notNull().default('general'),
  style_config:     jsonb('style_config'),
  memory_json:      jsonb('memory_json'),
  tts_seed:         bigint('tts_seed', { mode: 'number' }),
  created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxOrg:     index('idx_podcast_shows_org').on(t.org_id),
  idxCreator: index('idx_podcast_shows_creator').on(t.created_by),
}));

export const podcast_episodes = pgTable('podcast_episodes', {
  id:             uuid('id').primaryKey().defaultRandom(),
  show_id:        uuid('show_id').notNull().references(() => podcast_shows.id, { onDelete: 'cascade' }),
  episode_number: integer('episode_number'),
  title:          text('title'),
  brief:          text('brief'),
  target_minutes: integer('target_minutes').notNull().default(8),
  language:       text('language'),
  status:         text('status').notNull().default('draft'),   // draft|scripting|script_ready|approved|rendering|ready|failed
  tts_seed:       bigint('tts_seed', { mode: 'number' }),
  memory_summary: jsonb('memory_summary'),
  error:          text('error'),
  created_at:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxShow: index('idx_podcast_episodes_show').on(t.show_id),
}));

export const podcast_sources = pgTable('podcast_sources', {
  id:           uuid('id').primaryKey().defaultRandom(),
  episode_id:   uuid('episode_id').notNull().references(() => podcast_episodes.id, { onDelete: 'cascade' }),
  kind:         text('kind').notNull(),                        // file | url | note
  storage_key:  text('storage_key'),
  source_url:   text('source_url'),
  extracted_md: text('extracted_md'),
  title:        text('title'),
  status:       text('status').notNull().default('pending'),   // pending|processing|ready|failed
  created_at:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxEpisode: index('idx_podcast_sources_episode').on(t.episode_id),
}));

export const podcast_scripts = pgTable('podcast_scripts', {
  id:             uuid('id').primaryKey().defaultRandom(),
  episode_id:     uuid('episode_id').notNull().references(() => podcast_episodes.id, { onDelete: 'cascade' }),
  version:        integer('version').notNull(),
  status:         text('status').notNull().default('drafting'), // drafting|reviewing|rewriting|compiling|ready|approved|failed
  claimed_at:     timestamp('claimed_at', { withTimezone: true }),
  story_json:     jsonb('story_json'),
  materials_json: jsonb('materials_json'),
  review_json:    jsonb('review_json'),
  body_json:      jsonb('body_json'),
  content_hash:   text('content_hash'),
  telemetry:      jsonb('telemetry'),
  approved_at:    timestamp('approved_at', { withTimezone: true }),
  created_at:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqEpisodeVersion: unique().on(t.episode_id, t.version),
  idxEpisode:         index('idx_podcast_scripts_episode').on(t.episode_id),
}));

export const podcast_chunk_audio = pgTable('podcast_chunk_audio', {
  id:            uuid('id').primaryKey().defaultRandom(),
  episode_id:    uuid('episode_id').notNull().references(() => podcast_episodes.id, { onDelete: 'cascade' }),
  chunk_hash:    text('chunk_hash').notNull(),
  storage_key:   text('storage_key'),
  duration_ms:   integer('duration_ms'),
  segments_json: jsonb('segments_json'),
  kind:          text('kind').notNull().default('chunk'),      // chunk | backchannel
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqEpisodeHash: unique().on(t.episode_id, t.chunk_hash),
  idxEpisode:      index('idx_podcast_chunk_audio_episode').on(t.episode_id),
}));

export const podcast_renders = pgTable('podcast_renders', {
  id:             uuid('id').primaryKey().defaultRandom(),
  episode_id:     uuid('episode_id').notNull().references(() => podcast_episodes.id, { onDelete: 'cascade' }),
  script_version: integer('script_version'),
  status:         text('status').notNull().default('queued'),  // queued|synthesizing|stitching|encoding|ready|failed
  claimed_at:     timestamp('claimed_at', { withTimezone: true }),
  progress:       jsonb('progress'),
  master_mp4_key: text('master_mp4_key'),
  master_mp3_key: text('master_mp3_key'),
  duration_ms:    integer('duration_ms'),
  script_hash:    text('script_hash'),
  timeline_json:  jsonb('timeline_json'),
  cost_cents:     integer('cost_cents'),
  error:          text('error'),
  // Audio Studio (migration 045): kind='mix' exports honor a user-edited timeline.
  kind:            text('kind').notNull().default('auto'),      // auto (legacy one-click) | mix (studio export)
  format:          text('format'),                              // mp4 | mp3 | wav (mix exports)
  master_wav_key:  text('master_wav_key'),
  mix_snapshot_id: uuid('mix_snapshot_id'),
  created_at:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxEpisode: index('idx_podcast_renders_episode').on(t.episode_id),
}));

// ── Audio Studio (migration 045) ──────────────────────────────────────────────

/** Persisted per-turn takes. Immutable, content-addressed, never deleted. */
export const podcast_clips = pgTable('podcast_clips', {
  id:             uuid('id').primaryKey().defaultRandom(),
  episode_id:     uuid('episode_id').notNull().references(() => podcast_episodes.id, { onDelete: 'cascade' }),
  turn_id:        text('turn_id').notNull(),
  take_hash:      text('take_hash').notNull(),
  text_hash:      text('text_hash').notNull(),                  // sha256(speaker|text) — staleness vs current script
  script_version: integer('script_version'),
  storage_key:    text('storage_key').notNull(),
  duration_ms:    integer('duration_ms').notNull(),
  peaks_json:     jsonb('peaks_json'),
  source:         text('source').notNull().default('batch'),    // batch | regen
  created_at:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqTake:   unique().on(t.episode_id, t.turn_id, t.take_hash),
  idxEpisode: index('idx_podcast_clips_episode').on(t.episode_id),
}));

/** ONE mutable studio draft per episode — the user-edited timeline document. */
export const podcast_mixes = pgTable('podcast_mixes', {
  id:             uuid('id').primaryKey().defaultRandom(),
  episode_id:     uuid('episode_id').notNull().unique().references(() => podcast_episodes.id, { onDelete: 'cascade' }),
  script_version: integer('script_version'),
  script_hash:    text('script_hash'),
  status:         text('status').notNull().default('empty'),   // empty | generating | ready | failed
  claimed_at:     timestamp('claimed_at', { withTimezone: true }),
  progress:       jsonb('progress'),
  timeline_json:  jsonb('timeline_json'),
  rev:            integer('rev').notNull().default(0),
  error:          text('error'),
  created_at:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Immutable named versions of the draft (manual save / export freeze / pre-rebuild). */
export const podcast_mix_snapshots = pgTable('podcast_mix_snapshots', {
  id:             uuid('id').primaryKey().defaultRandom(),
  mix_id:         uuid('mix_id').notNull().references(() => podcast_mixes.id, { onDelete: 'cascade' }),
  name:           text('name').notNull(),
  kind:           text('kind').notNull().default('manual'),    // manual | export | pre_rebuild
  script_version: integer('script_version'),
  timeline_json:  jsonb('timeline_json').notNull(),
  render_id:      uuid('render_id'),
  created_at:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxMix: index('idx_podcast_mix_snapshots_mix').on(t.mix_id),
}));

// ── Type exports ──────────────────────────────────────────────────────────────

export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
export type BillingTransaction = typeof billing_transactions.$inferSelect;
export type UserPurchase = typeof user_purchases.$inferSelect;
export type ApiKey = typeof api_keys.$inferSelect;
export type Host = typeof hosts.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Corpus = typeof corpora.$inferSelect;
export type Script = typeof scripts.$inferSelect;
export type SystemPrompt = typeof system_prompts.$inferSelect;
export type AdminSettings = typeof admin_settings.$inferSelect;
export type TokenUsage = typeof token_usage.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AudioRender = typeof audio_renders.$inferSelect;
export type Scene = typeof scenes.$inferSelect;
export type VideoFile = typeof video_files.$inferSelect;
export type ImageFile = typeof image_files.$inferSelect;
export type AudioFile = typeof audio_files.$inferSelect;
export type TimelineSection = typeof timeline_sections.$inferSelect;
export type TimelineMarker = typeof timeline_markers.$inferSelect;
export type VideoGenerationJob = typeof video_generation_jobs.$inferSelect;
export type CameraPlan = typeof camera_plans.$inferSelect;
export type Course = typeof courses.$inferSelect;
export type NewCourse = typeof courses.$inferInsert;
export type CourseLesson = typeof course_lessons.$inferSelect;
export type NewCourseLesson = typeof course_lessons.$inferInsert;
export type CourseCustomDomain = typeof course_custom_domains.$inferSelect;
export type ProjectRedirectTarget = typeof project_redirect_targets.$inferSelect;
export type SimulationRow = typeof simulations.$inferSelect;
/**
 * Sampled field measurements of the simulation pipeline (migration 051).
 *
 * Nothing identifying is stored: `session_id` is random per page load and never persisted on the
 * client, device fields are coarse buckets, and `t_ms` is an offset from session start rather than a
 * wall-clock time so two rows cannot be correlated against an external log.
 */
export const sim_rum_events = pgTable(
  'sim_rum_events',
  {
    id:               uuid('id').primaryKey().defaultRandom(),
    session_id:       text('session_id').notNull(),
    // No FK: a revision may be garbage-collected while its measurements remain useful, and a FK
    // would either block that collection or delete the history explaining why it was withdrawn.
    package_revision: text('package_revision').notNull(),
    kind:             text('kind').notNull(),
    t_ms:             integer('t_ms').notNull(),
    total_ms:         integer('total_ms'),
    prepare_ms:       integer('prepare_ms'),
    present_ms:       integer('present_ms'),
    apply_ms:         integer('apply_ms'),
    furthest_stage:   text('furthest_stage'),
    failure_code:     text('failure_code'),
    dropped:          integer('dropped').notNull().default(0),
    device_memory_gb: integer('device_memory_gb'),
    device_cores:     integer('device_cores'),
    coarse_pointer:   boolean('coarse_pointer'),
    save_data:        boolean('save_data'),
    dpr:              real('dpr'),
    pool_tier:        text('pool_tier'),
    created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idx_created: index('idx_sim_rum_created').on(t.created_at),
    idx_package: index('idx_sim_rum_package').on(t.package_revision, t.kind, t.created_at),
  }),
);

export type SimRumEventRow = typeof sim_rum_events.$inferSelect;
export type NewSimRumEvent = typeof sim_rum_events.$inferInsert;

export type SimRevisionRow = typeof sim_revisions.$inferSelect;
export type NewSimRevision = typeof sim_revisions.$inferInsert;
export type SimPosterRow = typeof sim_posters.$inferSelect;
export type NewSimPoster = typeof sim_posters.$inferInsert;
export type Playlist = typeof playlists.$inferSelect;
export type Collaborator = typeof collaborators.$inferSelect;
export type PlaylistItem = typeof playlist_items.$inferSelect;
export type AvatarVisual = typeof avatar_visuals.$inferSelect;
export type AvatarConversation = typeof avatar_conversations.$inferSelect;
export type AvatarProfile = typeof avatar_profiles.$inferSelect;
export type BranchSequence = typeof branch_sequences.$inferSelect;
export type NewBranchSequence = typeof branch_sequences.$inferInsert;
export type BranchChoicePoint = typeof branch_choice_points.$inferSelect;
export type NewBranchChoicePoint = typeof branch_choice_points.$inferInsert;
export type BranchEdge = typeof branch_edges.$inferSelect;
export type NewBranchEdge = typeof branch_edges.$inferInsert;
export type PodcastShow = typeof podcast_shows.$inferSelect;
export type NewPodcastShow = typeof podcast_shows.$inferInsert;
export type PodcastEpisode = typeof podcast_episodes.$inferSelect;
export type NewPodcastEpisode = typeof podcast_episodes.$inferInsert;
export type PodcastSource = typeof podcast_sources.$inferSelect;
export type NewPodcastSource = typeof podcast_sources.$inferInsert;
export type PodcastScript = typeof podcast_scripts.$inferSelect;
export type NewPodcastScript = typeof podcast_scripts.$inferInsert;
export type PodcastChunkAudio = typeof podcast_chunk_audio.$inferSelect;
export type PodcastRender = typeof podcast_renders.$inferSelect;
export type NewPodcastRender = typeof podcast_renders.$inferInsert;
export type PodcastClip = typeof podcast_clips.$inferSelect;
export type NewPodcastClip = typeof podcast_clips.$inferInsert;
export type PodcastMix = typeof podcast_mixes.$inferSelect;
export type PodcastMixSnapshot = typeof podcast_mix_snapshots.$inferSelect;

/**
 * One "duplicate this project" run (migration 056).
 *
 * The row tracks the WORK, not the result: `target_project_id` stays NULL until the whole copied
 * row graph has been committed in a single transaction, so a duplication that dies half-way leaves
 * orphan storage objects (reapable) and no project at all. See migration 056 for why that ordering
 * is the requirement rather than a preference.
 */
export const project_duplications = pgTable(
  'project_duplications',
  {
    id:                uuid('id').primaryKey().defaultRandom(),
    source_project_id: uuid('source_project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    target_project_id: uuid('target_project_id').references(() => projects.id, { onDelete: 'set null' }),
    requested_by:      uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    status:            text('status').notNull().default('queued'), // queued|copying|committing|ready|failed
    objects_total:     integer('objects_total').notNull().default(0),
    objects_copied:    integer('objects_copied').notNull().default(0),
    bytes_total:       bigint('bytes_total', { mode: 'number' }).notNull().default(0),
    plan:              jsonb('plan'),
    error:             text('error'),
    created_at:        timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finished_at:       timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    idxSource: index('idx_project_duplications_source').on(t.source_project_id, t.created_at),
    // uniq_project_duplications_inflight — the partial unique index that makes a double-click
    // impossible — is declared in 056 only, for the same reason as the sim_revisions note above:
    // Drizzle's index builder has no WHERE clause, and a TOTAL unique index here would forbid a
    // project from ever being duplicated twice.
  }),
);

export type ProjectDuplication = typeof project_duplications.$inferSelect;
export type NewProjectDuplication = typeof project_duplications.$inferInsert;

/**
 * One "export this project as a linear video" run (migration 058).
 *
 * The row tracks the WORK, not the file: `output_key` stays NULL until the assembled master has
 * passed the exit-code and duration gates and its bytes are uploaded, so a cancelled or failed
 * encode — which SIGTERM leaves as a well-formed, playable partial MP4 on disk — can never be
 * published by accident. `plan` is the frozen resolution of the timeline, written before any work,
 * because it is the only way to answer "why does the master look like that?" after the temp
 * directory is gone. See migration 058 for the full argument.
 */
export const project_exports = pgTable(
  'project_exports',
  {
    id:               uuid('id').primaryKey().defaultRandom(),
    project_id:       uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    requested_by:     uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    status:           text('status').notNull().default('queued'), // queued|planning|capturing|assembling|uploading|ready|failed|cancelled
    // full | degraded. A column, not a plan-jsonb derivation: "is this master the full
    // composition?" is the one fact every poll needs, answered without parsing the plan.
    quality_state:    text('quality_state').notNull().default('full'),
    // forbid | allow_poster. FROZEN at creation and never rewritten: consent was given for the
    // project as it was then, and a retry or a duplicate delivery must honour the same answer.
    // 'forbid' is the default because the product contract is a full-quality render — a capture
    // failure fails the export instead of silently shipping stills.
    degradation_policy: text('degradation_policy').notNull().default('forbid'),
    // The FROZEN execution snapshot's identity: SHA-256 over a canonical form of `plan`, domain
    // separated. The worker verifies it before running, and consent is issued against it — so
    // "the plan the user agreed to" stops being a claim about timing.
    plan_fingerprint: text('plan_fingerprint'),
    // What the run actually did. Kept SEPARATE so `plan` is never rewritten: runtime results used
    // to be merged into it, which overwrote the record of what we were asked to make with the
    // record of what happened — the first thing anyone needs after a bad export.
    effective_plan: jsonb('effective_plan'),
    // Why a run stopped. Also separate, for the same reason.
    failure: jsonb('failure'),
    // Progress the poll can say something true with. `objects_done/total` alone could not: a
    // simulation capture is minutes long and the counter sat still throughout it.
    current_phase: text('current_phase'),
    phase_done: integer('phase_done').notNull().default(0),
    phase_total: integer('phase_total').notNull().default(0),
    current_section_id: uuid('current_section_id'),
    current_section_label: text('current_section_label'),
    capture_stage: text('capture_stage'),
    frames_done: integer('frames_done').notNull().default(0),
    frames_total: integer('frames_total').notNull().default(0),
    // Real poster-fallback windows, not warnings: warnings include planning advisories that are
    // not degradation, so counting them told users their export was degraded when nothing was.
    degraded_windows: integer('degraded_windows').notNull().default(0),
    objects_total:    integer('objects_total').notNull().default(0),
    objects_done:     integer('objects_done').notNull().default(0),
    plan:             jsonb('plan'),
    error:            text('error'),
    // A REQUEST, checked by the runner between phases. The endpoint sets it; only the runner
    // flips status, so the poll cannot observe a terminal row while ffmpeg still runs.
    cancel_requested: boolean('cancel_requested').notNull().default(false),
    output_key:       text('output_key'),
    created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finished_at:      timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    idxProject: index('idx_project_exports_project').on(t.project_id, t.created_at),
    // uniq_project_exports_inflight — the partial unique index that makes a double-click
    // impossible — is declared in 058 only, exactly like project_duplications above: Drizzle's
    // index builder has no WHERE clause, and a TOTAL unique index here would forbid a project
    // from ever being exported twice.
  }),
);

export type ProjectExport = typeof project_exports.$inferSelect;
export type NewProjectExport = typeof project_exports.$inferInsert;

/**
 * Multi-language dubbing — one row per (video, target language, provider) (migration 067).
 *
 * `video_files.captions_vtt` is a single text column with no language dimension, so the /he /es /en
 * product plan cannot be expressed by widening that row. This is the child table that carries the
 * language axis: the dubbed audio, the muxed video, the per-language HLS rendition, and — crucially
 * — the captions THAT DUB PRODUCED.
 *
 * The captions column is not a convenience. Captions for a dubbed language must come from whatever
 * produced the audio the viewer is hearing: two independent translations of one source diverge, and
 * a viewer with captions on would read one wording while hearing another. So a row's `captions_vtt`
 * and its `audio_key` are always two halves of the same translation.
 *
 * `uniqVideoLangProvider` is the last line of the double-billing defence — see the migration header
 * for the other three layers and why a vendor with no idempotency key needs all four.
 */
export const video_dubs = pgTable(
  'video_dubs',
  {
    id:              uuid('id').primaryKey().defaultRandom(),
    video_file_id:   uuid('video_file_id').notNull().references(() => video_files.id, { onDelete: 'cascade' }),
    target_language: text('target_language').notNull(),
    provider:        text('provider').notNull().default('elevenlabs'),
    el_project_id:   text('el_project_id'),
    el_language_id:  text('el_language_id'),
    /** Seam for the classic dubbing surface. Nothing writes it on the v2 path. */
    el_dubbing_id:   text('el_dubbing_id'),
    status:          text('status').notNull().default('queued'),
    /** Which pipeline step is running (migration 070). See services/dubbing/stages.ts. */
    stage:            text('stage'),
    /** When that step began — the only signal a bar has inside a vendor wait that reports nothing. */
    stage_entered_at: timestamp('stage_entered_at', { withTimezone: true }),
    audio_key:       text('audio_key'),
    muxed_video_key: text('muxed_video_key'),
    hls_master_key:  text('hls_master_key'),
    captions_vtt:    text('captions_vtt'),
    source_hash:     text('source_hash'),
    revision:        integer('revision'),
    output_revision: integer('output_revision'),
    billed_minutes:  doublePrecision('billed_minutes'),
    cost_cents:      doublePrecision('cost_cents'),
    /** Produced under a watermarking plan ⇒ never served to a viewer. See migration 067. */
    watermarked:     boolean('watermarked').notNull().default(false),
    error:           text('error'),
    claimed_at:      timestamp('claimed_at', { withTimezone: true }),
    created_at:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at:      timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqVideoLangProvider: unique('uniq_video_dubs_video_lang_provider').on(
      t.video_file_id, t.target_language, t.provider,
    ),
    idxVideo:          index('idx_video_dubs_video').on(t.video_file_id),
    idxStatusClaimed:  index('idx_video_dubs_status_claimed').on(t.status, t.claimed_at),
    idxVideoStatus:    index('idx_video_dubs_video_status').on(t.video_file_id, t.status),
    languageFormatChk: check('video_dubs_language_format_chk', sql`${t.target_language} ~ '^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$'`),
    statusChk:         check('video_dubs_status_chk', sql`${t.status} IN ('queued', 'processing', 'completed', 'stale', 'failed')`),
    providerChk:       check('video_dubs_provider_chk', sql`${t.provider} IN ('elevenlabs', 'whisper+llm')`),
    // idx_video_dubs_el_project — the partial index (WHERE el_project_id IS NOT NULL) the crash
    // recovery path uses — is declared in 067 only: Drizzle's index builder has no WHERE clause,
    // and declaring it here without one would create a total index over a mostly-null column.
  }),
);

export type VideoDub = typeof video_dubs.$inferSelect;
export type NewVideoDub = typeof video_dubs.$inferInsert;

/**
 * The cluster-wide dubbing concurrency pool (migration 067).
 *
 * The vendor allows 3 concurrent dubbing jobs PER WORKSPACE, and this deployment is one workspace —
 * so every tenant's dubs contend for the same three slots. That bound belongs to the account, not
 * to a process, which is why pg-boss's `localConcurrency` cannot express it: that number is
 * per-worker, and two worker containers each running "one at a time" are two concurrent jobs.
 *
 * Rows are fixed (seeded 1..3) and claimed with `FOR UPDATE SKIP LOCKED`, so two workers cannot
 * take the same slot and a worker that finds none knows the pool is genuinely full. A slot is a
 * LEASE that expires on its own — a crashed worker costs one lease period of throughput rather
 * than permanently shrinking the pool.
 */
export const dubbing_slots = pgTable('dubbing_slots', {
  slot_no:    integer('slot_no').primaryKey(),
  /** The video_dubs.id currently holding this slot — diagnostics only. */
  holder:     text('holder'),
  /** NULL or in the past ⇒ free. */
  expires_at: timestamp('expires_at', { withTimezone: true }),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Audio editions (migration 071, P3-B/A2.1) ─────────────────────────────────

/**
 * The listenable form of a project that already exists.
 *
 * DERIVED, never generated. One ffmpeg pass over the narration and guidance audio the project
 * already has — the same inputs `buildPlayerConfig` resolves — mixed to a single m4a, with
 * chapters from `timeline_sections` and captions re-emitted from the existing VTT. There is no
 * second content pipeline and no LLM anywhere in it.
 *
 * ONE ROW PER (project, language), with NULL meaning the source track. A dubbed project's edition
 * reuses that dub's mix and ITS captions, so `/{slug}/audio` and `/{slug}/he/audio` are separate
 * artifacts a listener may hold links to simultaneously — see migration 071 for why the
 * uniqueness is two partial indexes rather than one composite.
 */
export const project_audio_editions = pgTable('project_audio_editions', {
  id:            uuid('id').primaryKey().defaultRandom(),
  project_id:    uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** NULL = the project's source language; otherwise a BCP-47 code matching a completed dub. */
  language:      text('language'),
  status:        text('status').notNull().default('none'),   // none | processing | ready | failed
  /** Idempotency, as captions and crop already do it: same inputs ⇒ no work. */
  source_hash:   text('source_hash'),
  m4a_key:       text('m4a_key'),
  duration_ms:   integer('duration_ms'),
  /** Chapter marks stored WITH the artifact — sections can be edited after it is built. */
  chapters_json: jsonb('chapters_json'),
  captions_vtt:  text('captions_vtt'),
  error:         text('error'),
  claimed_at:    timestamp('claimed_at', { withTimezone: true }),
  created_at:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxProject: index('idx_project_audio_editions_project').on(t.project_id),
  idxStatus:  index('idx_project_audio_editions_status').on(t.status, t.claimed_at),
}));

// ── Raise Your Hand (migration 072, P3-B/A2.4) ────────────────────────────────

/**
 * A listener's question, at the moment they had it.
 *
 * WHO PAYS DECIDES THE SHAPE. The asking surface is public and the project owner pays for every
 * answer, so a question can exist WITHOUT one — costing nothing — and `answered_at` rather than
 * `created_at` is the billable event. The daily cap counts rows by `answered_at`, which is what
 * makes a saved question structurally incapable of consuming budget.
 *
 * `asked_by` is null for an anonymous listener, which is the common case: the audio page is public
 * and asking must not require an account.
 */
export const listener_questions = pgTable('listener_questions', {
  id:          uuid('id').primaryKey().defaultRandom(),
  project_id:  uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** NULL = the source-language edition, matching project_audio_editions (migration 071). */
  language:    text('language'),
  /** Where in the lesson — the same words mean different questions at minute 2 and minute 40. */
  position_ms: integer('position_ms').notNull(),
  question:    text('question').notNull(),
  answer:      text('answer'),
  asked_by:    uuid('asked_by').references(() => users.id, { onDelete: 'set null' }),
  status:      text('status').notNull().default('saved'),   // saved | answered | failed
  /** THE BILLABLE TIMESTAMP. Set only when a model was actually called. */
  answered_at: timestamp('answered_at', { withTimezone: true }),
  cost_cents:  integer('cost_cents'),
  created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxProject: index('idx_listener_questions_project').on(t.project_id, t.created_at),
}));
