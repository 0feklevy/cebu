// Global concurrency limiter for ffmpeg/ffprobe child processes.
//
// Every subsystem (HLS transcode, captions, crop, frame-preview, waveform, export capture) spawns
// ffmpeg independently. Without a shared cap, a burst of uploads or timeline scrubs can spawn many
// simultaneous ffmpeg processes and saturate a single-node host. This bounds the *total* across all
// of them (fiji's BrowserPool-as-sole-limiter pattern).

const MAX = Math.max(1, Number(process.env.FFMPEG_CONCURRENCY ?? '2'));

let active = 0;

/** A task waiting for a slot. `settle` resolves or rejects it exactly once. */
interface Waiter {
  grant: () => void;
  reject: (err: Error) => void;
  done: boolean;
}
const queue: Waiter[] = [];

/** Thrown when a task is cancelled before, or while, it waits for a slot. */
export class FfmpegTaskAborted extends Error {
  constructor(message = 'ffmpeg task was cancelled before it started') {
    super(message);
    // Spelled the way `classifyExportFailure` recognises cancellation.
    this.name = 'AbortError';
  }
}

/**
 * Take a slot, honouring cancellation WHILE QUEUED.
 *
 * The subtle part is the waiting task, not the running one. A caller that only attaches its abort
 * listener inside the task body cannot be interrupted while queued — and attaching to an
 * already-aborted signal never fires the listener at all — so a user who pressed stop while other
 * encodes held the slots would have their pass start anyway and run to completion. On the measured
 * 2-vCPU worker that is minutes of work nobody wanted.
 *
 * A cancelled waiter is REMOVED from the queue and rejected immediately. It never takes a slot, so
 * there is nothing to leak, and the next waiter is not delayed by a task that will never run.
 */
async function acquire(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new FfmpegTaskAborted();
  if (active < MAX) {
    active++;
    return;
  }
  return new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      done: false,
      grant: () => { if (!waiter.done) { waiter.done = true; cleanup(); resolve(); } },
      reject: (err) => { if (!waiter.done) { waiter.done = true; cleanup(); reject(err); } },
    };
    const onAbort = (): void => {
      const i = queue.indexOf(waiter);
      if (i !== -1) queue.splice(i, 1); // out of the queue, so no slot is ever handed to it
      waiter.reject(new FfmpegTaskAborted());
    };
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    queue.push(waiter);
  });
}

/** Hand the slot to the next LIVE waiter, or give it back to the pool. */
function release(): void {
  for (;;) {
    const next = queue.shift();
    if (!next) { active = Math.max(0, active - 1); return; }
    if (next.done) continue; // a waiter that aborted between splice and shift — skip, do not leak
    next.grant();             // hand the slot over directly; `active` is unchanged
    return;
  }
}

/**
 * Run an ffmpeg/ffprobe task under the global concurrency cap (FFMPEG_CONCURRENCY, default 2).
 * Pass `signal` so a cancelled task neither starts nor holds up the queue.
 */
export async function runFfmpegLimited<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquire(signal);
  try {
    if (signal?.aborted) throw new FfmpegTaskAborted();
    return await task();
  } finally {
    release();
  }
}

/** Test-only view of the limiter's state, so saturation can be asserted rather than inferred. */
export function ffmpegLimiterState(): { active: number; queued: number; max: number } {
  return { active, queued: queue.length, max: MAX };
}
