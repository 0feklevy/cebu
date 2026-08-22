/**
 * Will this capture's frames fit on the disk they are about to be written to? (media-009)
 *
 * ── WHAT IS UNBOUNDED TODAY ───────────────────────────────────────────────────────────────────
 * A capture writes one JPEG per frame into a host directory under `workDir ?? tmpdir()`, and
 * `expectedFrameCount` is `durationSec * fps`. Nothing compares the product of those to the space
 * available. The container is bounded on CPU, memory, pids, tmpfs scratch and wall clock — every
 * dimension except the one it actually fills.
 *
 * The arithmetic is not marginal. A 1920×1080 section at 30 fps produces 30 frames a second, and
 * the wall-clock cap allows a capture to run for ten minutes. At the ceiling below that is
 * comfortably into tens of gigabytes.
 *
 * ── WHY REFUSING BEFOREHAND, RATHER THAN CLEANING UP AFTER ────────────────────────────────────
 * Running out of disk mid-capture does not fail politely. ffmpeg's frame writes start failing
 * partway through, the frame sequence is left with holes, and the assembler covers a hole by
 * stretching or repeating — a visibly broken export blamed on the simulation. Worse, the host it
 * fills is the one running the database and the API, so the blast radius is the whole box rather
 * than one export.
 *
 * Refusing costs one export. Filling the disk costs the service. Same reasoning as the simulation
 * ZIP download, which sums as it reads and bails the moment the running total crosses its cap
 * (performance-005 / security-007) rather than discovering the problem from an OOM.
 *
 * ── WHY A PREDICTION AND NOT A MEASUREMENT ────────────────────────────────────────────────────
 * The frames are written by the sandboxed process inside the container, so the trusted side cannot
 * watch the total grow the way the ZIP reader can. What it CAN do is compute the worst case before
 * anything starts, from three numbers it already has.
 */
import { statfs } from 'node:fs/promises';

/**
 * Upper bound on a JPEG frame, in bytes per pixel.
 *
 * The captures are `format: 'jpeg', quality: 80`. Photographic content at q80 lands around
 * 0.1–0.2 bytes per pixel; a WebGL simulation with hard edges, text and high-contrast particles
 * compresses far worse than a photograph, and a full-frame noise pattern is the pathological case.
 *
 * 0.5 is chosen to sit ABOVE anything a real q80 encode produces rather than to be an average. A
 * ceiling that is usually right and occasionally low is a ceiling that lets the failure through on
 * exactly the frames that are hardest to compress — which are the ones a simulation produces.
 */
export const JPEG_BYTES_PER_PIXEL_CEILING = 0.5;

/**
 * Fraction of the free space a capture may plan to consume.
 *
 * Not 1.0, for two reasons that both bite at the same moment: the assembled clip is written to the
 * same filesystem while the frames are still there, and this host also runs Postgres, which does
 * not degrade gracefully when its filesystem fills.
 */
export const FREE_SPACE_HEADROOM = 0.7;

export interface CapturePrediction {
  frames: number;
  bytesPerFrame: number;
  totalBytes: number;
}

/** Worst-case bytes for a capture of `frames` frames at this resolution. */
export function predictCaptureBytes(args: { frames: number; width: number; height: number }): CapturePrediction {
  const frames = Math.max(0, Math.ceil(args.frames));
  const bytesPerFrame = Math.ceil(Math.max(0, args.width) * Math.max(0, args.height) * JPEG_BYTES_PER_PIXEL_CEILING);
  return { frames, bytesPerFrame, totalBytes: frames * bytesPerFrame };
}

/** The two fields of a `statfs` result this module reads. Named so it can be faked in a test. */
export interface FsSpace {
  bsize: number;
  bavail: number;
  bfree: number;
}

/**
 * Bytes free on the filesystem holding `path`, or null when it cannot be determined.
 *
 * `statfs` is injectable because the choice below is a real decision and an untestable one
 * otherwise: a mutation swapping `bavail` for `bfree` passed every test in this file when the
 * reading was done inline, which means the distinction existed only in a comment.
 */
export async function freeBytesFor(
  path: string,
  statfsImpl: (p: string) => Promise<FsSpace> = statfs as unknown as (p: string) => Promise<FsSpace>,
): Promise<number | null> {
  try {
    const fs = await statfsImpl(path);
    // `bavail` is what a NON-ROOT process may use. `bfree` includes the blocks reserved for root —
    // typically 5% of the filesystem — and the export worker does not run as root, so `bfree`
    // promises room this process can never actually write into. On a nearly full disk that
    // difference is the whole margin.
    return Number(fs.bsize) * Number(fs.bavail);
  } catch {
    return null;
  }
}

export interface SpaceVerdict {
  /** Human-readable reason, or null when the capture may proceed. */
  refusal: string | null;
  prediction: CapturePrediction;
}

const mb = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * May this capture start?
 *
 * ── WHY AN UNMEASURABLE FILESYSTEM DOES NOT REFUSE ────────────────────────────────────────────
 * `statfs` can fail — an unusual mount, a platform that does not implement it, a permissions
 * quirk. Treating that as "no space" would stop every export on that host for a reason that has
 * nothing to do with space, and the operator's first symptom would be a refusal message naming a
 * number nobody can see.
 *
 * The CEILING still applies in that case, so an absurd request is refused either way. What is lost
 * is only the check against a disk that happens to be nearly full — and that one already had a
 * second line of defence in the post-run artifact probes.
 *
 * This is a deliberate exception to fail-closed, and it is narrow: it applies when the MEASUREMENT
 * is unavailable, never when the measurement says there is not enough room.
 */
export function captureSpaceVerdict(args: {
  frames: number;
  width: number;
  height: number;
  freeBytes: number | null;
  ceilingBytes: number;
}): SpaceVerdict {
  const prediction = predictCaptureBytes(args);

  if (args.ceilingBytes > 0 && prediction.totalBytes > args.ceilingBytes) {
    return {
      prediction,
      refusal:
        `This section would capture ${prediction.frames} frames at up to ${mb(prediction.totalBytes)}, ` +
        `over the ${mb(args.ceilingBytes)} per-capture ceiling. Shorten the simulation section, ` +
        `lower the export resolution or frame rate, or raise EXPORT_CAPTURE_MAX_OUTPUT_MB.`,
    };
  }

  if (args.freeBytes !== null) {
    const usable = args.freeBytes * FREE_SPACE_HEADROOM;
    if (prediction.totalBytes > usable) {
      return {
        prediction,
        refusal:
          `This section would capture up to ${mb(prediction.totalBytes)} but only ${mb(usable)} of ` +
          `the ${mb(args.freeBytes)} free is safe to use. Free space on the export host and retry.`,
      };
    }
  }

  return { prediction, refusal: null };
}
