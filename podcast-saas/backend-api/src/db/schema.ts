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
export const providerEnum = pgEnum('provider', ['claude', 'openai', 'gemini', 'elevenlabs']);
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
  complex_model: text('complex_model').default('gemini-2.0-flash').notNull(),
  complex_min_corpus_tokens: integer('complex_min_corpus_tokens').default(50000).notNull(),
  complex_min_retries: integer('complex_min_retries').default(2).notNull(),
  // Audio / TTS settings
  tts_provider: text('tts_provider').default('elevenlabs').notNull(),
  elevenlabs_model: text('elevenlabs_model').default('eleven_v3').notNull(),
  default_voice_id_a: text('default_voice_id_a'),
  default_voice_id_b: text('default_voice_id_b'),
  // When true, a video's avatar uses its owner's own Anam key (BYOK); otherwise
  // the shared server ANAM_API_KEY is used for everyone (migration 029).
  avatar_byok_enabled: boolean('avatar_byok_enabled').default(false).notNull(),
  // Podcast Studio writers'-room model + effort (migration 044).
  podcast_model:  text('podcast_model').default('claude-opus-4-8').notNull(),
  podcast_effort: text('podcast_effort').default('max').notNull(),
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
  occurred_at: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
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
});

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
  created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Image files uploaded by the user for animated still-image overlays (migration 018)
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
});

export const audio_files = pgTable('audio_files', {
  id:          uuid('id').primaryKey().defaultRandom(),
  project_id:  uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  filename:    text('filename').notNull(),
  storage_key: text('storage_key').notNull(),
  url:         text('url').notNull(),
  duration_sec: real('duration_sec'),
  created_at:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Editor timeline markers (migration 041) — Premiere-style flags the editor drops at a point
// on the timeline (button or "m" hotkey) so they don't forget a note while cutting. Positioned
// by absolute seconds on the global main timeline; rendered as a red vertical line + note.
export const timeline_markers = pgTable('timeline_markers', {
  id: uuid('id').primaryKey().defaultRandom(),
  project_id: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  at_sec: real('at_sec').notNull(),                          // absolute position on the global main timeline
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
  external_task_id: text('external_task_id'),
  status: text('status').notNull().default('queued'),
  // queued | enhancing | submitting | generating | downloading | transcoding | ready | failed
  error: text('error'),
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
// Polymorphic like user_purchases. invited_email is lowercased; user_id is resolved at
// invite time when the user exists, otherwise matched by email once they sign in.
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
