import { spawn } from 'child_process';
import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { logger } from '../../lib/logger.js';

export interface TurnAudioSegment {
  audioBuffer: Buffer;
  audioFormat: 'mp3' | 'wav';
  durationMs: number;
  turnIndex: number;
}

export interface MasterAudioResult {
  masterBuffer: Buffer;
  totalDurationMs: number;
  turnOffsetMs: number[];   // master timeline start for each turn
}

const CROSSFADE_MS = 80;
const CROSSFADE_S = CROSSFADE_MS / 1000;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    proc.stderr.on('data', (d: Buffer) => stderr.push(d));
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(stderr).toString().slice(-500)}`));
      }
    });
    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('ffmpeg not found — install ffmpeg on the server'));
      } else {
        reject(err);
      }
    });
  });
}

export class MasterAudioService {
  async assemble(segments: TurnAudioSegment[]): Promise<MasterAudioResult> {
    const workDir = join(tmpdir(), `audio_${randomBytes(8).toString('hex')}`);
    await mkdir(workDir, { recursive: true });

    // Compute turn offsets accounting for crossfades
    const turnOffsetMs: number[] = [];
    let accumulated = 0;
    for (let i = 0; i < segments.length; i++) {
      turnOffsetMs.push(accumulated);
      const overlap = i < segments.length - 1 ? CROSSFADE_MS : 0;
      accumulated += segments[i].durationMs - overlap;
    }
    const totalDurationMs = Math.max(0, accumulated);

    // Write each turn to a temp file using the correct extension for its format
    const turnPaths: string[] = [];
    for (let i = 0; i < segments.length; i++) {
      const ext = segments[i].audioFormat === 'wav' ? 'wav' : 'mp3';
      const p = join(workDir, `turn_${i}.${ext}`);
      await writeFile(p, segments[i].audioBuffer);
      turnPaths.push(p);
    }

    const outputPath = join(workDir, 'master.wav');

    if (turnPaths.length === 1) {
      // Single turn: just normalize
      await runFfmpeg([
        '-y', '-i', turnPaths[0],
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-ar', '44100',
        outputPath,
      ]);
    } else {
      // Build filter_complex for N-way crossfade chain
      const inputArgs = turnPaths.flatMap((p) => ['-i', p]);
      const filterParts: string[] = [];
      let prevLabel = '[0]';

      for (let i = 1; i < turnPaths.length; i++) {
        const outLabel = i === turnPaths.length - 1 ? '[xout]' : `[x${i}]`;
        filterParts.push(
          `${prevLabel}[${i}]acrossfade=d=${CROSSFADE_S}:c1=exp:c2=exp${outLabel}`,
        );
        prevLabel = outLabel;
      }

      const filterComplex = filterParts.join('; ');
      const loudnormFilter = `[xout]loudnorm=I=-16:TP=-1.5:LRA=11[out]`;

      await runFfmpeg([
        '-y',
        ...inputArgs,
        '-filter_complex', `${filterComplex}; ${loudnormFilter}`,
        '-map', '[out]',
        '-ar', '44100',
        outputPath,
      ]);
    }

    const masterBuffer = await readFile(outputPath);

    // Cleanup temp files (non-blocking)
    void Promise.all([
      ...turnPaths.map((p) => unlink(p).catch(() => null)),
      unlink(outputPath).catch(() => null),
    ]);

    logger.info(
      { turns: segments.length, totalDurationMs, workDir },
      'Master audio assembled',
    );

    return { masterBuffer, totalDurationMs, turnOffsetMs };
  }

  // Extract a time-range sub-clip from the master buffer
  async extractChunk(
    masterBuffer: Buffer,
    startMs: number,
    endMs: number,
  ): Promise<Buffer> {
    const workDir = join(tmpdir(), `chunk_${randomBytes(6).toString('hex')}`);
    await mkdir(workDir, { recursive: true });

    const masterPath = join(workDir, 'master.wav');
    const chunkPath = join(workDir, 'chunk.wav');

    await writeFile(masterPath, masterBuffer);

    await runFfmpeg([
      '-y',
      '-i', masterPath,
      '-ss', (startMs / 1000).toFixed(3),
      '-to', (endMs / 1000).toFixed(3),
      '-c', 'copy',
      chunkPath,
    ]);

    const chunk = await readFile(chunkPath);
    void Promise.all([unlink(masterPath), unlink(chunkPath)]).catch(() => null);

    return chunk;
  }
}
