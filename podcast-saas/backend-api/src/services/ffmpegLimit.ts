// Global concurrency limiter for ffmpeg/ffprobe child processes.
//
// Every subsystem (HLS transcode, captions, crop, frame-preview, waveform) spawns
// ffmpeg independently. Without a shared cap, a burst of uploads or timeline scrubs
// can spawn many simultaneous ffmpeg processes and saturate a single-node host.
// This bounds the *total* across all of them (fiji's BrowserPool-as-sole-limiter pattern).

const MAX = Math.max(1, Number(process.env.FFMPEG_CONCURRENCY ?? '2'));

let active = 0;
const queue: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX) {
    active++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => queue.push(resolve));
}

function release(): void {
  const next = queue.shift();
  if (next) {
    next(); // hand the slot directly to the next waiter (active stays the same)
  } else {
    active = Math.max(0, active - 1);
  }
}

/** Run an ffmpeg/ffprobe task under the global concurrency cap (FFMPEG_CONCURRENCY, default 2). */
export async function runFfmpegLimited<T>(task: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await task();
  } finally {
    release();
  }
}
