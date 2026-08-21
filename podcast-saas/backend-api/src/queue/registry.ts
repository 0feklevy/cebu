import type { JobHandlers } from './types.js';
import { runVideoTranscode } from '../services/video/runVideoTranscode.js';
import { runCaptionJobNow } from '../services/captions/CaptionService.js';
import { runDubJobNow } from '../services/dubbing/DubbingService.js';
import { runCropAnalysis } from '../services/crop/runCropAnalysis.js';
import { generateVideoMetadata } from '../services/generateVideoMetadata.js';
import { runPodcastScriptJob } from '../services/podcast/runPodcastScript.js';
import { runPodcastRenderJob } from '../services/podcast/audio/runPodcastRender.js';
import { runPodcastClipsJob } from '../services/podcast/audio/runPodcastClips.js';
import { runPodcastMixExportJob } from '../services/podcast/audio/runPodcastMixExport.js';
import { runVideoGenerateLimited } from '../jobs/video.generate.js';
import { ProjectDuplicationService } from '../services/project/ProjectDuplicationService.js';
import { ProjectExportService } from '../services/export/ProjectExportService.js';
import { resolveConfiguredCaptureProvider } from '../services/export/capture/isolation/containerCaptureProvider.js';

/**
 * Maps each job name to its existing service entrypoint. Handlers are thin adapters from
 * the serialisable payload to the current function signatures — no logic lives here.
 *
 * Handlers reference the service functions lazily (via the arrow bodies), which also breaks
 * the registry → service → queue import cycle: nothing is invoked at module-eval time.
 */
export const handlers: JobHandlers = {
  transcode: (p) => runVideoTranscode(p.videoFileId, { replaced: p.replaced === true }),
  captions: (p) => runCaptionJobNow(p.videoId, { force: p.force }),
  crop: (p) => runCropAnalysis(p.videoFileId),
  metadata: (p) => generateVideoMetadata(p.projectId, p.videoFileId, p),
  podcast_script: (p) => runPodcastScriptJob(p),
  podcast_render: (p) => runPodcastRenderJob(p),
  podcast_clips: (p) => runPodcastClipsJob(p),
  podcast_mix_export: (p) => runPodcastMixExportJob(p),
  video_generate: (p) => runVideoGenerateLimited(p.jobId),
  // Constructed per job rather than shared, so the adapter is resolved when the job RUNS. A
  // module-scope instance would capture whatever adapter existed at import time, which in tests is
  // whichever suite imported the registry first.
  project_duplicate: (p) => new ProjectDuplicationService().run(p.duplicationId),
  // Same per-job construction, same reason as above: the adapter is resolved when the job RUNS.
  // The 3rd arg is the sim capture backend. `resolveConfiguredCaptureProvider()` is null unless
  // EXPORT_CAPTURE_IMAGE names the pinned worker image — null keeps the shipped poster-fallback
  // behaviour; configured, sim sections are captured in the isolated container (the Phase-2 path).
  project_export: (p) =>
    new ProjectExportService(undefined, null, resolveConfiguredCaptureProvider()).run(p.exportId),
  dub: (p) => runDubJobNow(p.dubId, { force: p.force }),
};
