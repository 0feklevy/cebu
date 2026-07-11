import type { PodcastRender } from 'shared/src/generated/client-v1';

/** Pick the presigned download URL that matches the render's exported format. */
export function renderDownloadUrl(r: PodcastRender): string | null {
  const byFormat = r.format === 'mp3' ? r.mp3_url
    : r.format === 'wav' ? (r.wav_url ?? null)
      : r.format === 'mp4' ? r.mp4_url
        : null;
  return byFormat ?? r.mp4_url ?? r.mp3_url ?? r.wav_url ?? null;
}
