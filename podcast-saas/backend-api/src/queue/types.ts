import type { MetadataOptions } from '../services/generateVideoMetadata.js';

/**
 * Background job contract (Phase A — queue extraction).
 *
 * Each job is identified by a name and carries a JSON-serialisable payload, so a future
 * durable driver (pg-boss) can persist it across process boundaries. Today the only driver
 * is `inline` (see inlineDriver.ts) and behaviour is identical to the historical
 * `setImmediate(runX(...))` producers.
 */
export type JobName = 'transcode' | 'captions' | 'crop' | 'metadata' | 'podcast_script' | 'podcast_render' | 'podcast_clips' | 'podcast_mix_export';

export interface JobPayloads {
  transcode: { videoFileId: string };
  captions: { videoId: string; force?: boolean };
  crop: { videoFileId: string };
  metadata: { projectId: string; videoFileId: string } & MetadataOptions;
  podcast_script: { scriptId: string; directorNotes?: string | null };
  podcast_render: { renderId: string };
  podcast_clips: { mixId: string };        // Audio Studio: synth + persist per-turn clips, build initial timeline
  podcast_mix_export: { renderId: string }; // Audio Studio: render a master from the user-edited mix
}

export type JobHandlers = {
  [N in JobName]: (payload: JobPayloads[N]) => Promise<unknown>;
};

export interface Queue {
  /** Schedule a background job. Fire-and-forget (the inline driver swallows + logs errors). */
  enqueue<N extends JobName>(name: N, payload: JobPayloads[N]): void;
}
