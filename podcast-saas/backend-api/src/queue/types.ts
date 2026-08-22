import type { MetadataOptions } from '../services/generateVideoMetadata.js';

/**
 * Background job contract (Phase A — queue extraction).
 *
 * Each job is identified by a name and carries a JSON-serialisable payload, so a future
 * durable driver (pg-boss) can persist it across process boundaries. Today the only driver
 * is `inline` (see inlineDriver.ts) and behaviour is identical to the historical
 * `setImmediate(runX(...))` producers.
 */
/**
 * Every job kind, as a VALUE as well as a type.
 *
 * It is a runtime array because "which jobs exist" is something the system has to be able to check
 * against "which jobs are durable" — a union type cannot be iterated, and while it could not, the
 * answer to that question went unasked and eight job kinds sat on the inline driver (job-queue-005).
 */
export const JOB_NAMES = [
  'transcode',
  'captions',
  'crop',
  'metadata',
  'podcast_script',
  'podcast_render',
  'podcast_clips',
  'podcast_mix_export',
  'video_generate',
  'project_duplicate',
  'project_export',
  'dub',
  'audio_edition',
] as const;

export type JobName = (typeof JOB_NAMES)[number];

export interface JobPayloads {
  // `replaced` says the write path swapped this video's MEDIA rather than re-encoding what was
  // already there. It does not change the transcode; it decides which of D-01b's two cases a
  // resulting placement review is filed under, and that is not recoverable after the fact. It is
  // deliberately NOT part of the singleton key: two deliveries for one video file are still one
  // HLS ladder, and `runVideoTranscode` re-derives the case from the media when the flag is lost
  // to that collapse.
  transcode: { videoFileId: string; replaced?: boolean };
  captions: { videoId: string; force?: boolean };
  crop: { videoFileId: string };
  metadata: { projectId: string; videoFileId: string } & MetadataOptions;
  podcast_script: { scriptId: string; directorNotes?: string | null };
  podcast_render: { renderId: string };
  podcast_clips: { mixId: string };        // Audio Studio: synth + persist per-turn clips, build initial timeline
  podcast_mix_export: { renderId: string }; // Audio Studio: render a master from the user-edited mix
  video_generate: { jobId: string };        // B-roll: external video gen (submit/poll/download/transcode)
  project_duplicate: { duplicationId: string }; // Duplicate project: copy bytes, then commit the row graph
  project_export: { exportId: string };         // Linear video export: plan, capture (Phase 2), assemble, upload
  // Multi-language dubbing. The payload is the video_dubs row id and nothing else: every parameter
  // of the job (language, provider, vendor ids, source hash) lives on that row, so a delivery can
  // never carry a stale copy of something the row has since changed — and, more to the point, a
  // retry cannot re-derive a DIFFERENT billable job from the same payload.
  dub: { dubId: string; force?: boolean };
  /** P3-B/A2.1 — derive a project's listenable edition. `language: null` is the source track. */
  audio_edition: { projectId: string; language?: string | null; force?: boolean };
}

export type JobHandlers = {
  [N in JobName]: (payload: JobPayloads[N]) => Promise<unknown>;
};

export interface Queue {
  /** Schedule a background job. Fire-and-forget (the inline driver swallows + logs errors). */
  enqueue<N extends JobName>(name: N, payload: JobPayloads[N]): void;
}
