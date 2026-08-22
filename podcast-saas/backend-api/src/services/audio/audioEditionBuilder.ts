/**
 * Turning a project into one listenable file — the ffmpeg half of P3-B / A2.1.
 *
 * The decisions live next door in `audioEdition.ts` and are tested there. This module does the
 * work: pull each segment's source media, take its audio, join them into one m4a, and hand back
 * the artifact. It is deliberately thin, because everything here is expensive to test and cheap
 * to get right, and everything next door is the opposite.
 *
 * ── WHY THIS IS NOT THE EXPORT PATH ───────────────────────────────────────────────────────────
 * The GPU export host exists because rendering a simulation to video needs a browser and a GPU.
 * Audio extraction needs neither. Routing this through the export queue would put a cheap job
 * behind an expensive one, make a five-second task wait on a five-minute one, and give the
 * feature an operational cost it does not have. It runs on the ordinary pg-boss queue.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFfmpegLimited } from '../ffmpegLimit.js';
import { logger } from '../../lib/logger.js';

/** One input to the join, already resolved to a local file. */
export interface EditionInput {
  localPath: string;
  /** For the log line when this specific input is the one that fails. */
  label: string;
}

/** Run ffmpeg, resolving on success and rejecting with the tail of stderr on failure. */
function ff(args: string[]): Promise<void> {
  return runFfmpegLimited(
    () =>
      new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        const err: Buffer[] = [];
        proc.stderr.on('data', (d: Buffer) => err.push(d));
        proc.on('close', (code) => {
          if (code === 0) return resolve();
          // The LAST 600 characters, not the first: ffmpeg's banner and stream dumps are at the
          // top and the reason it stopped is at the bottom.
          reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-600)}`));
        });
        proc.on('error', (e) =>
          reject(
            (e as NodeJS.ErrnoException).code === 'ENOENT'
              ? new Error('ffmpeg not found on server')
              : e,
          ),
        );
      }),
  );
}

/**
 * The concat demuxer's list file.
 *
 * Exported and pure because the QUOTING is the whole problem. The demuxer's format takes a path
 * inside single quotes, and a path containing a quote — which a temp directory derived from a
 * user-supplied title can carry — terminates the string early and turns the rest of the filename
 * into demuxer directives. ffmpeg's own escape is doubling, not backslashes, and getting that
 * wrong fails either loudly (a parse error) or quietly (a shorter episode than expected).
 */
export function concatListFile(inputs: readonly EditionInput[]): string {
  return inputs.map((i) => `file '${i.localPath.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/**
 * Join every input into one AAC m4a.
 *
 * The concat DEMUXER rather than the concat filter: the demuxer streams, holding one input open
 * at a time, while the filter opens all of them at once. A forty-segment lesson is a normal
 * project here, and forty simultaneously-open decoders on a shared box is how one cheap job takes
 * the container down for every other one.
 *
 * `-vn` because a segment's source file is a VIDEO, and this is the step that makes it audio.
 * Re-encoding rather than copying is deliberate: the segments can differ in codec, sample rate and
 * channel count, and `-c copy` across a mismatch produces a file that plays for exactly as long as
 * the first segment's parameters hold and then goes silent or garbles — on some players only,
 * which is the worst way to find out.
 */
export async function joinToM4a(
  inputs: readonly EditionInput[],
  outPath: string,
  opts: { sampleRate?: number; bitrate?: string } = {},
): Promise<void> {
  if (inputs.length === 0) throw new Error('an audio edition needs at least one input');

  const dir = await mkdtemp(join(tmpdir(), 'flowvid-edition-'));
  const listPath = join(dir, 'inputs.txt');
  try {
    await writeFile(listPath, concatListFile(inputs), 'utf8');
    await ff([
      // `-safe 0` is required for absolute paths, which these always are. The demuxer's safe mode
      // exists to stop a list file from referencing arbitrary paths; here WE wrote the list, from
      // paths we downloaded ourselves, so the check protects nothing and blocks everything.
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-vn',
      '-ac', '2',
      '-ar', String(opts.sampleRate ?? 44_100),
      '-c:a', 'aac',
      '-b:a', opts.bitrate ?? '96k',
      // Spoken word at 96k stereo is transparent enough and roughly a third the size of the
      // video's own audio track — which matters because the PWA precaches this whole file so a
      // dropped connection mid-drive does not stop playback.
      '-movflags', '+faststart',
      // Without faststart the moov atom lands at the END, so a browser must download the entire
      // file before it can start playing. For a forty-minute lesson on mobile data that is the
      // difference between "plays" and "does not".
      '-y', outPath,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch((e: unknown) => {
      // A leaked temp directory is a disk-space problem, not a correctness one, so it must never
      // mask the real error from the try block.
      logger.warn({ err: e, dir }, 'audio edition: temp list directory could not be removed');
    });
  }
}

/** Measured duration of the finished artifact, in milliseconds. */
export async function probeDurationMs(path: string): Promise<number> {
  const out = await runFfmpegLimited(
    () =>
      new Promise<string>((resolve, reject) => {
        const proc = spawn(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const chunks: Buffer[] = [];
        const err: Buffer[] = [];
        proc.stdout.on('data', (d: Buffer) => chunks.push(d));
        proc.stderr.on('data', (d: Buffer) => err.push(d));
        proc.on('close', (code) =>
          code === 0
            ? resolve(Buffer.concat(chunks).toString().trim())
            : reject(new Error(`ffprobe ${code}: ${Buffer.concat(err).toString().slice(-300)}`)),
        );
        proc.on('error', reject);
      }),
  );
  const sec = Number(out);
  // MEASURED, not summed. The sum of the inputs is what we EXPECTED; this is what the file
  // actually contains, and the two disagreeing is the signal that a segment was dropped.
  return Number.isFinite(sec) ? Math.round(sec * 1000) : 0;
}

/**
 * The storage key for an edition.
 *
 * Under `editions/{projectId}/`, which is a PRIVATE prefix — the same decision as `exports/`, and
 * for the same reason. A project's audio is only public when the project is, and that is decided
 * per request against the project's own visibility, not by where the bytes happen to live. The
 * `podcasts/` prefix is public and would have been the convenient place to put this; it is
 * exactly the mistake that made a customer's uploaded brief world-readable (security-016).
 */
export function editionStorageKey(projectId: string, language: string | null, sourceHash: string): string {
  const lang = language ?? 'source';
  // The hash is IN the key, so a rebuilt edition is a new object rather than an overwrite. An
  // overwrite would be served from every CDN and browser cache that still holds the old bytes,
  // under a URL that now promises different audio.
  return `editions/${projectId}/${lang}-${sourceHash.slice(0, 16)}.m4a`;
}
