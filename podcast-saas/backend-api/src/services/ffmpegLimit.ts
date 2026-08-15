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

/** Thrown when a queued task is cancelled before it ever reaches a slot. */
class QueuedTaskAborted extends Error {
  constructor() {
    super('ffmpeg task was cancelled before it started');
    // Spelled the way `classifyExportFailure` recognises cancellation.
    this.name = 'AbortError';
  }
}

/**
 * Run an ffmpeg/ffprobe task under the global concurrency cap (FFMPEG_CONCURRENCY, default 2).
 *
 * `signal` matters most for the task that is still WAITING. A caller that only attaches its abort
 * listener inside the task body cannot be interrupted while queued — and worse, attaching to an
 * already-aborted signal never fires the listener at all — so a user who pressed stop while two
 * other encodes held the slots would have their pass start anyway and run to completion. On the
 * measured 2-vCPU host that is minutes of work nobody wanted. Checked before the wait, again after
 * the slot is granted, and released to the next waiter either way.
 */
export async function runFfmpegLimited<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new QueuedTaskAborted();
  await acquire();
  try {
    if (signal?.aborted) throw new QueuedTaskAborted();
    return await task();
  } finally {
    release();
  }
}
