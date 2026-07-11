import type { JobHandlers } from './types.js';
import { runVideoTranscode } from '../services/video/runVideoTranscode.js';
import { runCaptionJobNow } from '../services/captions/CaptionService.js';
import { runCropAnalysis } from '../services/crop/runCropAnalysis.js';
import { generateVideoMetadata } from '../services/generateVideoMetadata.js';
import { runPodcastScriptJob } from '../services/podcast/runPodcastScript.js';
import { runPodcastRenderJob } from '../services/podcast/audio/runPodcastRender.js';
import { runPodcastClipsJob } from '../services/podcast/audio/runPodcastClips.js';
import { runPodcastMixExportJob } from '../services/podcast/audio/runPodcastMixExport.js';
import { runVideoGenerateLimited } from '../jobs/video.generate.js';

/**
 * Maps each job name to its existing service entrypoint. Handlers are thin adapters from
 * the serialisable payload to the current function signatures — no logic lives here.
 *
 * Handlers reference the service functions lazily (via the arrow bodies), which also breaks
 * the registry → service → queue import cycle: nothing is invoked at module-eval time.
 */
export const handlers: JobHandlers = {
  transcode: (p) => runVideoTranscode(p.videoFileId),
  captions: (p) => runCaptionJobNow(p.videoId, { force: p.force }),
  crop: (p) => runCropAnalysis(p.videoFileId),
  metadata: (p) => generateVideoMetadata(p.projectId, p.videoFileId, p),
  podcast_script: (p) => runPodcastScriptJob(p),
  podcast_render: (p) => runPodcastRenderJob(p),
  podcast_clips: (p) => runPodcastClipsJob(p),
  podcast_mix_export: (p) => runPodcastMixExportJob(p),
  video_generate: (p) => runVideoGenerateLimited(p.jobId),
};
