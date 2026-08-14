/**
 * The PRODUCTION capture provider — the caller the boundary documented but nobody wrote.
 *
 * `CaptureJobBoundary`'s contract says: "The caller (ProjectExportService) owns download
 * (presigned GET), `writeCaptureInput`, reading the frames, and the presigned PUT." Until this
 * file, that caller did not exist: the job registry constructed `ProjectExportService()` with a
 * null capture provider, so production exports logged `captureBackend:false` and every sim window
 * degraded to the base video / poster — the container infrastructure (run-arg assembler, boundary,
 * worker image) sat dormant.
 *
 * This provider is that caller, one section at a time:
 *
 *   servedUrl ──parse──▶ storage keys ──readObject──▶ input mount (+ capture-spec.json)
 *      ──DockerCaptureBoundary──▶ /output result ──(frames? ffmpeg encode)──▶ clipPath
 *
 * It is ENV-GATED and null by default: `EXPORT_CAPTURE_IMAGE` names the pinned worker image and is
 * the on-switch; without it `resolveConfiguredCaptureProvider()` returns null and the shipped
 * poster-fallback behaviour is byte-identical to before this file existed. When the backend itself
 * runs in a container, `EXPORT_CAPTURE_WORKDIR` must be a HOST path bind-mounted into the backend
 * at the SAME path — the docker daemon resolves `-v` against the host filesystem, not this process.
 *
 * VERIFIED-IN-CONTAINER: PENDING — like `DockerCaptureBoundary`, the docker execution itself can
 * only be exercised on a Linux host (md-files/EXPORT-CAPTURE-ISOLATION.md §7 checklist). The pure
 * pieces (URL→key parsing, config, spec building, result mapping) are unit-tested everywhere.
 */

import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { logger } from '../../../../lib/logger.js';
import { getStorageAdapter } from '../../../storage/getStorageAdapter.js';
import type { StorageService } from '../../../storage/StorageService.js';
import type { SimCaptureWindow } from '../../types.js';
import {
  CaptureUnavailable,
  DEFAULT_WARMUP_FRAMES,
  type CaptureResult,
  type CaptureSpec,
  type SimCaptureBackend,
} from '../captureTypes.js';
import {
  DockerCaptureBoundary,
  buildCaptureSpec,
  writeCaptureInput,
  type CaptureInputFile,
  type CaptureJobBoundary,
  type ContainerCaptureResult,
} from './captureJobBoundary.js';

// ── servedUrl → storage keys ────────────────────────────────────────────────────────────────────

export interface ParsedSimSource {
  /** Storage key of the entry document (no query/fragment), e.g. `simulations/p/s/revisions/r/package/index.html`. */
  entryKey: string;
  /** The prefix every package file lives under — the entry document's directory. */
  baseDir: string;
  /** Entry path RELATIVE to `baseDir` — what the container's loopback server serves at `/`. */
  entryPath: string;
}

/**
 * Parse a served sim URL (`…/sim-public/<key>?section=…#simboot=…`) back into storage terms.
 * Anchoring the package root at the ENTRY DOCUMENT'S DIRECTORY works for both layouts — revisioned
 * (`…/revisions/{rev}/package/index.html`) and legacy flat keys — because a package's assets are
 * relative references resolved against the entry document, which is exactly the shape the loopback
 * server reproduces. Returns null for a URL that does not address a sim-public key.
 */
export function parseServedSimUrl(servedUrl: string): ParsedSimSource | null {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(servedUrl).pathname);
  } catch {
    return null;
  }
  const marker = '/sim-public/';
  const at = pathname.indexOf(marker);
  if (at === -1) return null;
  const entryKey = pathname.slice(at + marker.length).replace(/^\/+/, '');
  const lastSlash = entryKey.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const baseDir = entryKey.slice(0, lastSlash);
  const entryPath = entryKey.slice(lastSlash + 1);
  if (!entryPath) return null;
  return { entryKey, baseDir, entryPath };
}

/** Defensive ceiling on one package's total bytes — a runaway prefix must fail loudly, not OOM. */
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

async function fetchPackageFiles(
  storage: StorageService,
  source: ParsedSimSource,
): Promise<CaptureInputFile[]> {
  const prefix = `${source.baseDir}/`;
  const keys = await storage.listObjects(prefix);
  if (keys.length === 0) {
    throw new Error(`container capture: no package objects under ${prefix}`);
  }
  const files: CaptureInputFile[] = [];
  let total = 0;
  for (const key of keys) {
    const rel = key.slice(prefix.length);
    if (!rel) continue;
    const content = await storage.readObject(key);
    total += content.byteLength;
    if (total > MAX_PACKAGE_BYTES) {
      throw new Error(`container capture: package under ${prefix} exceeds ${MAX_PACKAGE_BYTES} bytes`);
    }
    files.push({ path: rel, content });
  }
  return files;
}

// ── frames → clip (when the container backend emits frames rather than a clip) ──────────────────

/** Encode the container's frame directory to the yuv420p clip the assembler's gate requires. */
function encodeFramesToClip(
  framesDir: string,
  namePattern: string,
  fps: number,
  dims: { width: number; height: number },
  clipPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-nostats', '-y',
      // -framerate BEFORE -i: image2's input rate, so no frames are dropped or duplicated.
      '-framerate', String(fps),
      '-start_number', '0',
      '-i', join(framesDir, namePattern),
      // JPEG frames are full-range (yuvj); the assembler's gate requires limited-range yuv420p.
      '-vf', `scale=${dims.width}:${dims.height}:out_range=tv,format=yuv420p`,
      '-color_range', 'tv',
      '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      clipPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`container capture: frame encode exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

// ── Configuration ───────────────────────────────────────────────────────────────────────────────

export interface ContainerCaptureConfig {
  image: string;
  /** Host-visible parent for input/output mounts; null = os tmpdir (bare-metal backend only). */
  workDir: string | null;
  user: string;
  cpus: string;
  memoryMb: number;
  pidsLimit: number;
  tmpfsScratchMb: number;
  stopTimeoutSec: number;
  dockerBin: string;
}

/** Read the provider configuration from the environment; null unless the image is named. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ContainerCaptureConfig | null {
  const image = env.EXPORT_CAPTURE_IMAGE?.trim();
  if (!image) return null;
  const int = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  return {
    image,
    workDir: env.EXPORT_CAPTURE_WORKDIR?.trim() || null,
    user: env.EXPORT_CAPTURE_USER?.trim() || '10001:10001',
    cpus: env.EXPORT_CAPTURE_CPUS?.trim() || '2',
    memoryMb: int(env.EXPORT_CAPTURE_MEMORY_MB, 2048),
    pidsLimit: int(env.EXPORT_CAPTURE_PIDS_LIMIT, 256),
    tmpfsScratchMb: int(env.EXPORT_CAPTURE_TMPFS_MB, 512),
    stopTimeoutSec: int(env.EXPORT_CAPTURE_STOP_TIMEOUT_SEC, 10),
    dockerBin: env.EXPORT_CAPTURE_DOCKER_BIN?.trim() || 'docker',
  };
}

/** Per-section hard wall clock: handshake+warmup slack plus real-time-scaled capture, capped. */
export function wallClockCapSec(durationSec: number): number {
  return Math.min(600, Math.ceil(90 + durationSec * 6));
}

// ── The provider ────────────────────────────────────────────────────────────────────────────────

export class ContainerCaptureProvider implements SimCaptureBackend {
  readonly name = 'container-beginframe';
  private available: boolean | null = null;

  constructor(
    private readonly config: ContainerCaptureConfig,
    private readonly boundary: CaptureJobBoundary = new DockerCaptureBoundary({
      image: config.image,
      user: config.user,
      cpus: config.cpus,
      memoryMb: config.memoryMb,
      pidsLimit: config.pidsLimit,
      tmpfsScratchMb: config.tmpfsScratchMb,
      stopTimeoutSec: config.stopTimeoutSec,
      dockerBin: config.dockerBin,
    }),
    private readonly storage: StorageService = getStorageAdapter(),
  ) {}

  /** Cheap preflight: the docker binary answers and the pinned image is present on this host. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    this.available = await new Promise<boolean>((resolve) => {
      const proc = spawn(this.config.dockerBin, ['image', 'inspect', this.config.image], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
    if (!this.available) {
      logger.warn(
        { image: this.config.image, dockerBin: this.config.dockerBin },
        'export(container-capture): worker image not runnable on this host — sim windows fall back to posters',
      );
    }
    return this.available;
  }

  async captureSection(spec: CaptureSpec): Promise<CaptureResult> {
    if (!(await this.isAvailable())) {
      throw new CaptureUnavailable('container capture: worker image is not runnable on this host');
    }
    const source = parseServedSimUrl(spec.servedSimUrl);
    if (!source) {
      throw new CaptureUnavailable(`container capture: servedSimUrl is not a sim-public key: ${spec.servedSimUrl}`);
    }

    // The boundary's spec builder owns validation (query/fragment split, forbidden-key sweep) —
    // feed it a window-shaped view of the flat spec rather than duplicating those rules here.
    const windowView: SimCaptureWindow = {
      kind: 'sim-capture',
      sectionId: spec.sectionId,
      label: null,
      startSec: 0,
      endSec: spec.durationSec,
      simulationId: null,
      servedUrl: spec.servedSimUrl,
      simpleUi: spec.simpleUi,
      autoScript: spec.autoScript,
      uiHide: [...spec.uiHide],
      configHash: spec.configHash || null,
      posterKey: spec.posterKey || null,
    };
    const containerSpec = buildCaptureSpec(windowView, {
      entryPath: source.entryPath,
      output: { format: 'jpeg', quality: 80, frameDir: 'frames', namePattern: 'frame-%06d.jpg' },
      fps: spec.fps,
      width: spec.width,
      height: spec.height,
      warmupFrames: DEFAULT_WARMUP_FRAMES,
      wallClockTimeoutSec: wallClockCapSec(spec.durationSec),
    });

    const base = this.config.workDir ?? tmpdir();
    await mkdir(base, { recursive: true });
    const jobDir = await mkdtemp(join(base, `capture-${spec.sectionId.slice(0, 8)}-`));
    const inputDir = join(jobDir, 'input');
    const outputDir = join(jobDir, 'output');
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    try {
      const files = await fetchPackageFiles(this.storage, source);
      await writeCaptureInput(inputDir, files, containerSpec);
      logger.info(
        { section: spec.sectionId, files: files.length, image: this.config.image },
        'export(container-capture): input staged — running worker container',
      );

      const result: ContainerCaptureResult = await this.boundary.runCapture(
        containerSpec,
        { inputDir, outputDir },
        new AbortController().signal,
      );

      if (result.status === 'failed' || result.gate === 'failed') {
        // A loud, classified degradation — the service records the reason and uses the poster.
        return {
          frameCount: result.frameCount,
          rendererString: result.rendererString,
          gate: 'failed',
          reason: result.reason ?? result.failure?.detail ?? 'container capture failed',
        };
      }

      // The clip must outlive jobDir (removed in `finally`), so it gets a sibling directory. The
      // service consumes it immediately for the splice; the OS tmp reaper owns the leftovers, the
      // same lifecycle every other capture backend's clip has.
      const clipOut = await mkdtemp(join(base, `clip-${spec.sectionId.slice(0, 8)}-`));
      const clipPath = join(clipOut, 'section.mp4');
      if (result.clipPath) {
        await copyFile(join(outputDir, result.clipPath), clipPath);
      } else if (result.framesDir) {
        await encodeFramesToClip(
          join(outputDir, result.framesDir),
          containerSpec.output.namePattern,
          spec.fps,
          { width: spec.width, height: spec.height },
          clipPath,
        );
      } else {
        return {
          frameCount: result.frameCount,
          rendererString: result.rendererString,
          gate: 'failed',
          reason: 'container produced neither a clip nor a frames directory',
        };
      }
      await stat(clipPath);
      logger.info(
        { section: spec.sectionId, frameCount: result.frameCount, renderer: result.rendererString },
        'export(container-capture): section captured',
      );
      return {
        clipPath,
        frameCount: result.frameCount,
        rendererString: result.rendererString,
        gate: 'passed',
        reason: result.reason ?? undefined,
      };
    } finally {
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * The production injection seam: a configured provider, or null — the shipped default, in which
 * exports behave byte-identically to before this file existed (poster fallback for sim windows).
 * `EXPORT_CAPTURE_IMAGE` is the on-switch; see the runbook for the full deployment contract.
 */
export function resolveConfiguredCaptureProvider(): SimCaptureBackend | null {
  const config = configFromEnv();
  if (!config) return null;
  logger.info({ image: config.image }, 'export: container capture provider configured');
  return new ContainerCaptureProvider(config);
}
