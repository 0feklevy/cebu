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
  real,
  pgEnum,
} from 'drizzle-orm/pg-core';

// ── Enums ─────────────────────────────────────────────────────────────────────

export const projectTierEnum = pgEnum('project_tier', ['standard', 'premium', 'hybrid']);
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
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const token_usage = pgTable('token_usage', {
  id: uuid('id').primaryKey().defaultRandom(),
  user_id: uuid('user_id').references(() => users.id),
  project_id: uuid('project_id').references(() => projects.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  task: text('task').notNull(),
  input_tokens: integer('input_tokens').notNull(),
  cached_input_tokens: integer('cached_input_tokens').default(0).notNull(),
  output_tokens: integer('output_tokens').notNull(),
  cost_cents: integer('cost_cents').default(0).notNull(),
  used_personal_key: boolean('used_personal_key').default(false).notNull(),
  occurred_at: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
});

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: text('type').notNull(),
  project_id: uuid('project_id').references(() => projects.id),
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
  created_at:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
  track: text('track').notNull().default('main'),           // 'main' | 'broll'
  global_offset_sec: real('global_offset_sec'),             // broll only: absolute start on main timeline
  sim_meta: jsonb('sim_meta'),                              // bridge generation plan metadata (migration 013)
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

// ── Type exports ──────────────────────────────────────────────────────────────

export type Org = typeof orgs.$inferSelect;
export type User = typeof users.$inferSelect;
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
export type TimelineSection = typeof timeline_sections.$inferSelect;
export type VideoGenerationJob = typeof video_generation_jobs.$inferSelect;
export type CameraPlan = typeof camera_plans.$inferSelect;
export type SimulationRow = typeof simulations.$inferSelect;
