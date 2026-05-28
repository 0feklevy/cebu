import { z } from 'zod';

export const AlignedWordSchema = z.object({
  word: z.string(),
  start_ms: z.number(),
  end_ms: z.number(),
  turn_index: z.number().int(),
});
export type AlignedWord = z.infer<typeof AlignedWordSchema>;

export const ShotTypeSchema = z.enum([
  'wide',
  'closeup_a',
  'closeup_b',
  'reaction_a',
  'reaction_b',
]);
export type ShotType = z.infer<typeof ShotTypeSchema>;

export const CameraCutSchema = z.object({
  frame_start: z.number().int(),
  frame_end: z.number().int(),
  shot: ShotTypeSchema,
  scene_idx: z.number().int(),
});
export type CameraCut = z.infer<typeof CameraCutSchema>;

export const CameraPlanSchema = z.object({
  fps: z.number().int().default(30),
  cuts: z.array(CameraCutSchema),
});
export type CameraPlan = z.infer<typeof CameraPlanSchema>;

export const SceneSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  script_version: z.number().int(),
  idx: z.number().int(),
  speaker: z.enum(['host_a', 'host_b']),
  start_ms: z.number().int(),
  end_ms: z.number().int(),
  transcript: z.string(),
  aligned_words: z.array(AlignedWordSchema).default([]),
  emotion: z.string().default('neutral'),
  audio_tags: z.array(z.string()).default([]),
  is_hook: z.boolean().default(false),
  audio_chunk_url: z.string().nullable().default(null),
  shot: ShotTypeSchema.nullable().default(null),
});
export type SceneData = z.infer<typeof SceneSchema>;
