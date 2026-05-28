import { z } from 'zod';
import { CreateHostSchema } from './host.js';

export const StylePresetSchema = z.enum([
  'educational-deep-dive',
  'interview',
  'debate',
  'storytelling',
  'news-analysis',
  'comedy',
]);
export type StylePreset = z.infer<typeof StylePresetSchema>;

export const FormatSchema = z.enum(['16:9', '9:16', '1:1']);
export type Format = z.infer<typeof FormatSchema>;

export const PacingSchema = z.enum(['relaxed', 'standard', 'energetic']);
export type Pacing = z.infer<typeof PacingSchema>;

export const EmotionalStyleSchema = z.enum(['analytical', 'warm', 'playful', 'serious']);
export type EmotionalStyle = z.infer<typeof EmotionalStyleSchema>;

export const ProjectTierSchema = z.enum(['standard', 'premium', 'hybrid']);
export type ProjectTier = z.infer<typeof ProjectTierSchema>;

export const ProjectStatusSchema = z.enum([
  'draft',
  'ingesting',
  'scripting',
  'script_ready',
  'approved',
  'generating',
  'ready',
  'failed',
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const CreateProjectSchema = z.object({
  topic: z.string().min(1).max(1000),
  style_preset: StylePresetSchema.optional(),
  host_a_id: z.string().uuid().optional(),
  host_b_id: z.string().uuid().optional(),
  host_a: CreateHostSchema.optional(),
  host_b: CreateHostSchema.optional(),
  format: FormatSchema.optional(),
  target_duration_min: z.number().int().min(1).max(120).optional(),
  pacing: PacingSchema.optional(),
  emotional_style: EmotionalStyleSchema.optional(),
});
export type CreateProject = z.infer<typeof CreateProjectSchema>;

export const PlatformSettingsSchema = z.object({
  billing_enabled: z.boolean(),
  maintenance_mode: z.boolean(),
  maintenance_message: z.string().nullable(),
  generation_paused: z.boolean(),
  generation_paused_message: z.string().nullable(),
  anonymous_user_limit: z.number(),
});
export type PlatformSettings = z.infer<typeof PlatformSettingsSchema>;
