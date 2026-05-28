import { z } from 'zod';

export const SpeakerSchema = z.enum(['host_a', 'host_b']);
export type Speaker = z.infer<typeof SpeakerSchema>;

export const AudioTagSchema = z.enum([
  'laughs',
  'sighs',
  'interrupting',
  'hesitates',
  'whispers',
  'excited',
  'pauses',
]);
export type AudioTag = z.infer<typeof AudioTagSchema>;

export const EmotionSchema = z.enum([
  'neutral',
  'enthusiastic',
  'thoughtful',
  'agreeing',
  'analytical',
  'amused',
  'surprised',
  'curious',
  'concerned',
  'excited',
  'confused',
  'impressed',
  'skeptical',
  'empathetic',
]);
export type Emotion = z.infer<typeof EmotionSchema>;

export const BRollSpecSchema = z.object({
  type: z.enum(['stat', 'quote', 'illustration', 'cinematic', 'diagram', 'user_image']),
  prompt: z.string().optional(),
  user_image_url: z.string().url().optional(),
});
export type BRollSpec = z.infer<typeof BRollSpecSchema>;

export const DialogueTurnSchema = z.object({
  speaker: SpeakerSchema,
  text: z.string().min(1),
  audio_tags: z.array(AudioTagSchema).catch([]),
  emotion: EmotionSchema.catch('neutral').default('neutral'),
  duration_hint_sec: z.number().positive().catch(5).optional(),
  is_hook: z.boolean().catch(false).default(false),
  b_roll: BRollSpecSchema.nullable().catch(null).default(null),
});
export type DialogueTurn = z.infer<typeof DialogueTurnSchema>;

export const ScriptSchema = z.object({
  title: z.string().catch('Untitled'),
  intro_runtime_sec: z.number().positive().catch(5),
  turns: z.array(DialogueTurnSchema).min(1),
  outro_runtime_sec: z.number().positive().catch(5),
  total_estimated_seconds: z.number().positive().catch(600),
});
export type Script = z.infer<typeof ScriptSchema>;

export const KnowledgeAnchorSchema = z.object({
  anchor: z.string(),
  type: z.enum(['person', 'date', 'historical_event', 'method', 'model', 'application', 'limitation', 'surprising_fact']),
  why_it_matters: z.string(),
  where_to_use: z.enum(['opening', 'foundation', 'complexity', 'application', 'ending']),
});

export const MetaphorSpineSchema = z.object({
  primary_metaphor: z.string(),
  why_it_fits: z.string(),
  how_it_evolves: z.array(z.string()),
  secondary_metaphors_allowed: z.array(z.string()),
});

export const CuriosityHandoffSchema = z.object({
  from_beat: z.string(),
  handoff_question: z.string(),
});

export const StructuralAnalysisSchema = z.object({
  title: z.string(),
  thesis: z.string(),
  hook_scenario: z.string().catch(''),
  audience_persona: z.string(),
  topic_map: z.array(
    z.object({
      topic: z.string(),
      key_facts: z.array(z.string()),
      tensions: z.array(z.string()),
      analogies: z.array(z.string()),
    }),
  ),
  knowledge_anchors: z.array(KnowledgeAnchorSchema).catch([]),
  metaphor_spine: MetaphorSpineSchema.catch({
    primary_metaphor: '',
    why_it_fits: '',
    how_it_evolves: [],
    secondary_metaphors_allowed: [],
  }),
  curiosity_handoffs: z.array(CuriosityHandoffSchema).catch([]),
  narrative_arc: z.array(z.string()),
  pacing_seconds: z.array(z.number().positive()),
});
export type StructuralAnalysis = z.infer<typeof StructuralAnalysisSchema>;

export const ScriptVersionSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  version: z.number().int().positive(),
  structural_json: StructuralAnalysisSchema.nullable(),
  draft_body_json: ScriptSchema.nullable(),
  body_json: ScriptSchema.nullable(),
  validation_errors: z.unknown().nullable(),
  status: z.enum(['drafting', 'rewriting', 'validating', 'ready', 'approved', 'failed']),
  approved_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
  pass0_model: z.string().nullable(),
  pass1_model: z.string().nullable(),
  pass2_model: z.string().nullable(),
});
export type ScriptVersion = z.infer<typeof ScriptVersionSchema>;
