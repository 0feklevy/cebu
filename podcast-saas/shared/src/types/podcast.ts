import { z } from 'zod';

/**
 * Podcast Studio shared types (migration 044).
 *
 * A standalone product: Shows → Episodes. Two hosts with fixed roles —
 * teacher (default Brittney) explains, learner (default Titan) asks/guesses.
 *
 * The Turn schema mirrors the archived DialogueTurn resilience pattern (`.catch()`
 * on every LLM-fallible field) so a slightly-malformed model response degrades
 * gracefully instead of throwing. Audio tags live INLINE inside `text`
 * ("[laughs] Right. [thoughtful] But wait…") because ElevenLabs v3 places a tag
 * immediately before the words it affects — there is no separate tags array.
 */

// ── Roles & enums ─────────────────────────────────────────────────────────────

export const PodcastSpeakerSchema = z.enum(['teacher', 'learner']);
export type PodcastSpeaker = z.infer<typeof PodcastSpeakerSchema>;

export const PodcastNichePackSchema = z.enum(['general', 'science']);
export type PodcastNichePack = z.infer<typeof PodcastNichePackSchema>;

export const PodcastEpisodeStatusSchema = z.enum([
  'draft',
  'scripting',
  'script_ready',
  'approved',
  'rendering',
  'ready',
  'failed',
]);
export type PodcastEpisodeStatus = z.infer<typeof PodcastEpisodeStatusSchema>;

export const PodcastScriptStatusSchema = z.enum([
  'drafting',
  'reviewing',
  'rewriting',
  'compiling',
  'ready',
  'approved',
  'failed',
]);
export type PodcastScriptStatus = z.infer<typeof PodcastScriptStatusSchema>;

export const PodcastRenderStatusSchema = z.enum([
  'queued',
  'synthesizing',
  'stitching',
  'encoding',
  'ready',
  'failed',
]);
export type PodcastRenderStatus = z.infer<typeof PodcastRenderStatusSchema>;

export const PodcastSourceKindSchema = z.enum(['file', 'url', 'note']);
export type PodcastSourceKind = z.infer<typeof PodcastSourceKindSchema>;

// ── The dialogue turn ─────────────────────────────────────────────────────────

export const PodcastTurnSchema = z.object({
  // Stable, edit-surviving id. Constrained to a safe token: it is used verbatim in
  // filesystem paths during render (clip_<id>.wav), so `..`/slashes must be rejected.
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  speaker: PodcastSpeakerSchema.catch('learner'),
  text: z.string().min(1),                         // ≤ ~280 chars; audio tags INLINE
  overlap: z.boolean().catch(false).default(false),// backchannel — synthesized separately & overlaid
  pause_after_ms: z.number().int().nonnegative().catch(0).nullable().optional(), // null clears the override
  is_hook: z.boolean().catch(false).default(false),
  beat: z.string().catch('').default(''),          // beat id — chunking is per-beat
});
export type PodcastTurn = z.infer<typeof PodcastTurnSchema>;

// Editor-write schema: identical to PodcastTurnSchema but allows EMPTY text, because a
// just-inserted line is legitimately blank mid-edit. Blank turns are dropped at render time.
export const PodcastEditorTurnSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  speaker: PodcastSpeakerSchema.catch('learner'),
  text: z.string().max(600),
  overlap: z.boolean().catch(false).default(false),
  pause_after_ms: z.number().int().nonnegative().catch(0).nullable().optional(),
  is_hook: z.boolean().catch(false).default(false),
  beat: z.string().catch('').default(''),
});
export type PodcastEditorTurn = z.infer<typeof PodcastEditorTurnSchema>;

export const PodcastScriptBodySchema = z.object({
  title: z.string().catch('Untitled Episode'),
  turns: z.array(PodcastTurnSchema).min(1),
  open_loop: z.string().catch('').optional(),      // teaser for the next episode
});
export type PodcastScriptBody = z.infer<typeof PodcastScriptBodySchema>;

// ── Style config (podcastfy-style knobs; the owner's extra-prompt slot) ───────

export const PodcastStyleConfigSchema = z.object({
  humor: z.enum(['dry', 'light', 'playful']).optional(),
  analogy_density: z.enum(['sparse', 'balanced', 'rich']).optional(),
  user_instructions: z.string().max(4000).optional(), // free-text extra prompt merged into the writers' room
});
export type PodcastStyleConfig = z.infer<typeof PodcastStyleConfigSchema>;

// ── Create / update request bodies ────────────────────────────────────────────

export const CreatePodcastShowSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  language: z.string().max(16).optional(),
  niche_pack: PodcastNichePackSchema.optional(),
});
export type CreatePodcastShow = z.infer<typeof CreatePodcastShowSchema>;

export const UpdatePodcastShowSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  language: z.string().max(16).optional(),
  teacher_name: z.string().max(80).optional(),
  learner_name: z.string().max(80).optional(),
  teacher_voice_id: z.string().max(120).nullable().optional(),
  learner_voice_id: z.string().max(120).nullable().optional(),
  teacher_persona: z.string().max(4000).nullable().optional(),
  learner_persona: z.string().max(4000).nullable().optional(),
  niche_pack: PodcastNichePackSchema.optional(),
  style_config: PodcastStyleConfigSchema.nullable().optional(),
  memory_json: z.unknown().optional(),
});
export type UpdatePodcastShow = z.infer<typeof UpdatePodcastShowSchema>;

// target_minutes: 0 = "auto" (the writers' room picks the ideal length); 3–20 = explicit.
export const CreatePodcastEpisodeSchema = z.object({
  title: z.string().max(200).optional(),
  brief: z.string().max(20000).optional(),
  target_minutes: z.number().int().min(0).max(20).optional(),
  language: z.string().max(16).optional(),
});
export type CreatePodcastEpisode = z.infer<typeof CreatePodcastEpisodeSchema>;

export const UpdatePodcastEpisodeSchema = z.object({
  title: z.string().max(200).nullable().optional(),
  brief: z.string().max(20000).nullable().optional(),
  target_minutes: z.number().int().min(0).max(20).optional(),
  language: z.string().max(16).nullable().optional(),
});
export type UpdatePodcastEpisode = z.infer<typeof UpdatePodcastEpisodeSchema>;

export const CreatePodcastSourceSchema = z.object({
  kind: PodcastSourceKindSchema,
  source_url: z.string().url().max(2000).optional(),
  title: z.string().max(300).optional(),
  extracted_md: z.string().optional(),   // for kind='note' the body is the extracted markdown
});
export type CreatePodcastSource = z.infer<typeof CreatePodcastSourceSchema>;
