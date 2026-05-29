import { task } from '@trigger.dev/sdk/v3';
import { runVideoTranscode } from '../services/video/runVideoTranscode.js';

export const videoTranscodeTask = task({
  id: 'video.transcode',
  maxDuration: 3600,
  retry: { maxAttempts: 2, factor: 2, minTimeoutInMs: 10000 },

  run: async ({ video_file_id }: { video_file_id: string }) => {
    const result = await runVideoTranscode(video_file_id);
    return { video_file_id, ...result };
  },
});
