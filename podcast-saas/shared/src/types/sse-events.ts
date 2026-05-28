import { z } from 'zod';

export const SSEStageSchema = z.enum([
  'content_moderation',
  'corpus_ingest',
  'structural_analysis',
  'script_draft',
  'script_rewrite',
  'script_validate',
  'audio_tts',
  'audio_assemble',
  'audio_align',
  'scene_segment',
  'camera_plan',
]);
export type SSEStage = z.infer<typeof SSEStageSchema>;

export type StreamEvent =
  | { type: 'connected'; project_id: string }
  | { type: 'status'; stage: SSEStage; message: string; progress?: number }
  | { type: 'structural_ready'; structural_json: unknown }
  | { type: 'script_draft_token'; chunk: string }
  | { type: 'script_draft_ready'; script_version: number }
  | { type: 'script_rewrite_ready'; script_version: number }
  | { type: 'script_ready'; script_version: number; script: unknown }
  | { type: 'done'; project_id: string }
  | { type: 'corpus_ready'; corpus_id: string; extracted_md_preview: string }
  | { type: 'audio_turn_done'; turn_index: number; total_turns: number }
  | { type: 'audio_ready'; render_id: string; duration_ms: number; master_audio_url: string }
  | { type: 'scenes_ready'; scene_count: number }
  | { type: 'camera_plan_ready'; cut_count: number }
  | { type: 'error'; error_type: string; message: string };
