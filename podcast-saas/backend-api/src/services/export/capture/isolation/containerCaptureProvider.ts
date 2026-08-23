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
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { captureSpaceVerdict, freeBytesFor } from './captureSpace.js';
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
  MAX_ARTIFACT_FILE_BYTES,
  assertFrameSet,
  assertRendererProfileName,
  assertWithinOutputDir,
  openArtifactHandle,
  frameFileName,
  buildCaptureSpec,
  expectedFrameCount,
  writeCaptureInput,
  type CaptureInputFile,
  type CaptureJobBoundary,
  type ContainerCaptureResult,
  type DockerCaptureBoundaryConfig,
} from './captureJobBoundary.js';
import { assertCdiDeviceName } from './containerRunArgs.js';
import { isStageablePackagePath, parseSimPackageKey, type SimPackageKey } from './simPackageKey.js';
import { prepareOfflinePackage } from '../dependencies/offlinePackage.js';
import { assertClipMatches, probeClip, probeImage, type ProbedImage, type ProbedVideo } from './artifactProbe.js';

/** The pixel-reading half of artifact validation, injectable so unit fakes need not be real media. */
export interface ArtifactProbes {
  probeImage(path: string, opts?: { signal?: AbortSignal }): Promise<ProbedImage>;
  probeClip(path: string, opts?: { signal?: AbortSignal }): Promise<ProbedVideo>;
}
import { runFfmpegLimited } from '../../../ffmpegLimit.js';

// ── servedUrl → storage keys ────────────────────────────────────────────────────────────────────

export type ParsedSimSource = SimPackageKey;

/**
 * Parse a served sim URL (`…/sim-public/<key>?section=…#simboot=…`) into PACKAGE terms — the
 * package root, and the entry path relative to it with its nesting intact.
 *
 * It does NOT anchor on the entry document's directory. That was the v0.1.23 incident: a package's
 * generated runtime (`bridge.js`, `guidance.js`) lives at the PACKAGE ROOT and a nested entry
 * references it as `../bridge.js`, so staging `dirname(entryKey)` dropped the one file that emits
 * SIM_READY and every capture timed out at `bridge_ready`. The package boundary is a grammar
 * (`simPackageKey.ts`), not a guess. Returns null for a URL that does not address a sim-public
 * key, or whose key the grammar refuses.
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
  return parseSimPackageKey(entryKey);
}

/** Defensive ceiling on one package's total bytes — a runaway prefix must fail loudly, not OOM. */
export const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

/**
 * Stage the package WHOLE, from its root, layout preserved — so every relative reference the
 * stored HTML makes (`../bridge.js`, `./src/main.js`, an author's `../assets/model.glb`) resolves
 * inside the container exactly as it does in the viewer. No file is special-cased.
 *
 * A LEGACY root is shared with the system's `revisions/` and `posters/` subtrees, so those are
 * excluded — staging them would ship the package's entire publication history and every poster
 * rendition into the capture container.
 */
async function fetchPackageFiles(
  storage: StorageService,
  source: ParsedSimSource,
): Promise<CaptureInputFile[]> {
  const prefix = `${source.packageRoot}/`;
  const keys = await storage.listObjects(prefix);
  if (keys.length === 0) {
    throw new Error(`container capture: no package objects under ${prefix}`);
  }
  const files: CaptureInputFile[] = [];
  let total = 0;
  let skipped = 0;
  for (const key of keys) {
    const rel = key.slice(prefix.length);
    if (!rel) continue;
    if (!isStageablePackagePath(source.layout, rel)) {
      skipped += 1;
      continue;
    }
    const content = await storage.readObject(key);
    total += content.byteLength;
    if (total > MAX_PACKAGE_BYTES) {
      throw new Error(`container capture: package under ${prefix} exceeds ${MAX_PACKAGE_BYTES} bytes`);
    }
    files.push({ path: rel, content });
  }
  if (!files.some((f) => f.path === source.entryPath)) {
    throw new Error(
      `container capture: entry ${source.entryPath} is not among the ${files.length} staged files of ${prefix}`,
    );
  }
  if (skipped > 0) {
    logger.debug({ packageRoot: source.packageRoot, skipped }, 'export(container-capture): skipped system-owned keys');
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
  opts: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: ENCODE_TIMEOUT_MS },
): Promise<void> {
  // Through the GLOBAL cap, like every other ffmpeg in the process. This encode was the one
  // exception, so a burst of captures could put an unbounded number of x264 runs on a host whose
  // whole point is that it has two cores — and the limiter that exists to prevent exactly that
  // never saw them.
  return runFfmpegLimited(() => new Promise<void>((resolve, reject) => {
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
    let settled = false;
    // ffmpeg reads the frame files itself, on the TRUSTED host. Every input it opens has already
    // been lstat'd as a regular file, but an encode still needs its own ceiling: without one, a
    // single slow or pathological input holds this promise — and therefore the whole export job —
    // open forever, since `close`/`error` were the only ways out.
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); } };
    // On timeout/abort the child is killed but the promise settles only in the 'close' handler:
    // settling here would release the global ffmpeg slot while the dying process still holds CPU
    // and file descriptors, so a burst of cancellations could briefly run more ffmpeg than the cap.
    let killReason: string | null = null;
    const kill = (why: string) => {
      killReason = why;
      proc.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill(`exceeded ${opts.timeoutMs} ms`), Math.max(1, opts.timeoutMs));
    const onAbort = () => kill('was cancelled');
    const signal = opts.signal;
    if (signal?.aborted) { kill('was cancelled'); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stderr.on('data', (d) => { if (stderr.length < 8192) stderr += String(d); });
    proc.on('error', (err) => done(() => reject(err)));
    proc.on('close', (code) => {
      done(() => {
        if (killReason) reject(new Error(`container capture: frame encode ${killReason}`));
        else if (code === 0) resolve();
        else reject(new Error(`container capture: frame encode exited ${code}: ${stderr.slice(-400)}`));
      });
    });
  }), opts.signal);
}

// ── Configuration ───────────────────────────────────────────────────────────────────────────────

/**
 * The sandbox mechanisms an OPERATOR may select via environment. Deliberately narrower than the
 * assembler's `SandboxMechanism`: 'seccomp-profile' needs a curated profile file and stays a
 * code-level decision — env can choose a mechanism from this allow-list, never arbitrary docker
 * arguments.
 */
export const ENV_SANDBOX_MECHANISMS = ['userns', 'sys-admin'] as const;
export type EnvSandboxMechanism = (typeof ENV_SANDBOX_MECHANISMS)[number];

export interface ContainerCaptureConfig {
  image: string;
  /**
   * Which renderer every capture from this provider must use. Resolved ONCE, on the trusted side,
   * from `EXPORT_CAPTURE_RENDERER`; the container never reads the environment for it.
   */
  rendererProfile: 'swiftshader' | 'hardware';
  /** CDI name of the one GPU hardware captures may use. Ignored entirely under swiftshader. */
  gpuCdiDevice: string;
  /** Host-visible parent for input/output mounts; null = os tmpdir (bare-metal backend only). */
  workDir: string | null;
  user: string;
  cpus: string;
  memoryMb: number;
  pidsLimit: number;
  tmpfsScratchMb: number;
  /** Per-capture output ceiling in MB (media-009). 0 disables it. */
  maxOutputMb: number;
  stopTimeoutSec: number;
  dockerBin: string;
  /**
   * How Chrome's sandbox is granted what it needs (NEVER `--no-sandbox`). 'userns' is the
   * least-privilege default; 'sys-admin' (= `--cap-add SYS_ADMIN` + `SYS_CHROOT`, both proven
   * required) is for hosts whose AppArmor blocks unprivileged user namespaces — Ubuntu ≥23.10
   * with `kernel.apparmor_restrict_unprivileged_userns=1`.
   */
  sandboxMechanism: EnvSandboxMechanism;
}

/**
 * Read the provider configuration from the environment; null unless the image is named.
 * An UNRECOGNISED sandbox mechanism throws rather than defaulting: on a userns-restricted host a
 * silent 'userns' fallback would fail every capture with "No usable sandbox!", which is exactly
 * the quiet degradation this feature's history teaches us to refuse.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ContainerCaptureConfig | null {
  const image = env.EXPORT_CAPTURE_IMAGE?.trim();
  if (!image) return null;
  const int = (v: string | undefined, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
  };
  const rawMechanism = env.EXPORT_CAPTURE_SANDBOX_MECHANISM?.trim();
  const sandboxMechanism = (rawMechanism || 'userns') as EnvSandboxMechanism;
  if (!ENV_SANDBOX_MECHANISMS.includes(sandboxMechanism)) {
    throw new Error(
      `EXPORT_CAPTURE_SANDBOX_MECHANISM: unknown value ${JSON.stringify(rawMechanism)}; ` +
      `allowed: ${ENV_SANDBOX_MECHANISMS.join(', ')}`,
    );
  }
  // Same shape as the sandbox mechanism above, for the same reason: an operator typo must be a
  // startup error, not a silent fallback to the slow path on a machine bought for the fast one.
  const rawRenderer = env.EXPORT_CAPTURE_RENDERER?.trim();
  const rendererProfile = (rawRenderer || 'swiftshader') as 'swiftshader' | 'hardware';
  if (rendererProfile !== 'swiftshader' && rendererProfile !== 'hardware') {
    throw new Error(
      `EXPORT_CAPTURE_RENDERER: unknown value ${JSON.stringify(rawRenderer)}; allowed: swiftshader, hardware`,
    );
  }
  // Validated HERE, at config time on the trusted side, so a typo is a startup error rather than
  // a docker error minutes into the first hardware capture. Only consulted when the profile is
  // hardware; the default is the first (usually only) GPU.
  const gpuCdiDevice = env.EXPORT_CAPTURE_GPU_CDI_DEVICE?.trim() || 'nvidia.com/gpu=0';
  if (rendererProfile === 'hardware') assertCdiDeviceName(gpuCdiDevice);
  return {
    image,
    rendererProfile,
    gpuCdiDevice,
    workDir: env.EXPORT_CAPTURE_WORKDIR?.trim() || null,
    user: env.EXPORT_CAPTURE_USER?.trim() || '10001:10001',
    cpus: env.EXPORT_CAPTURE_CPUS?.trim() || '2',
    memoryMb: int(env.EXPORT_CAPTURE_MEMORY_MB, 2048),
    pidsLimit: int(env.EXPORT_CAPTURE_PIDS_LIMIT, 256),
    tmpfsScratchMb: int(env.EXPORT_CAPTURE_TMPFS_MB, 512),
    // Per-capture output ceiling (media-009). 4 GB is far above any real section — a 60 s 1080p
    // capture at 30 fps predicts well under 1 GB even at the worst-case bytes-per-pixel — so this
    // refuses the absurd rather than the merely large. 0 disables the ceiling and leaves only the
    // free-space check.
    maxOutputMb: int(env.EXPORT_CAPTURE_MAX_OUTPUT_MB, 4096),
    stopTimeoutSec: int(env.EXPORT_CAPTURE_STOP_TIMEOUT_SEC, 10),
    dockerBin: env.EXPORT_CAPTURE_DOCKER_BIN?.trim() || 'docker',
    sandboxMechanism,
  };
}

/**
 * The exact boundary configuration a capture config produces — extracted (and exported) so the
 * env → config → boundary → argv chain is assertable in the unit suite link by link.
 */
export function boundaryConfigFrom(config: ContainerCaptureConfig): DockerCaptureBoundaryConfig {
  return {
    image: config.image,
    user: config.user,
    cpus: config.cpus,
    memoryMb: config.memoryMb,
    pidsLimit: config.pidsLimit,
    tmpfsScratchMb: config.tmpfsScratchMb,
    stopTimeoutSec: config.stopTimeoutSec,
    dockerBin: config.dockerBin,
    sandboxMechanism: config.sandboxMechanism,
    gpuCdiDevice: config.gpuCdiDevice,
  };
}

/** Per-section hard wall clock: handshake+warmup slack plus real-time-scaled capture, capped. */
/**
 * Ceiling on the trusted-host frame encode. It runs AFTER the container is gone, so it is outside
 * the capture wall clock entirely — without its own bound it is an unbounded operation inside a
 * bounded job.
 */
export const ENCODE_TIMEOUT_MS = 10 * 60 * 1000;

export function wallClockCapSec(durationSec: number): number {
  return Math.min(600, Math.ceil(90 + durationSec * 6));
}

// ── The provider ────────────────────────────────────────────────────────────────────────────────

export class ContainerCaptureProvider implements SimCaptureBackend {
  readonly name = 'container-beginframe';
  private available: boolean | null = null;

  /**
   * `probes` is injectable for the same reason `boundary` and `storage` are: the unit suite drives
   * this class with fake frame bytes, and a real `ffprobe` over 'a' and 'b' proves nothing except
   * that ffprobe works. The DEFAULT is the real implementation, so production always measures; the
   * end-to-end encode test exercises that path against genuine frames.
   */
  constructor(
    private readonly config: ContainerCaptureConfig,
    private readonly boundary: CaptureJobBoundary = new DockerCaptureBoundary(boundaryConfigFrom(config)),
    private readonly storage: StorageService = getStorageAdapter(),
    private readonly probes: ArtifactProbes = { probeImage, probeClip },
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

  async captureSection(spec: CaptureSpec, signal?: AbortSignal): Promise<CaptureResult> {
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
      // The spec's value when the caller names one (the controlled-experiment path the plan
      // demands), the shipped default otherwise — resolved HERE, once, for the container path.
      warmupFrames: spec.warmupFrames ?? DEFAULT_WARMUP_FRAMES,
      // The JOB's frozen choice wins; the provider's env-resolved config covers only direct callers
      // (diagnostic scripts) that carry no plan. An operator flipping EXPORT_CAPTURE_RENDERER after
      // enqueue must not change what an already-created job renders with — the plan was described,
      // consented to and fingerprinted under one profile, and it runs under that profile.
      rendererProfile: assertRendererProfileName(spec.rendererProfile ?? this.config.rendererProfile),
      wallClockTimeoutSec: wallClockCapSec(spec.durationSec),
    });

    const base = this.config.workDir ?? tmpdir();
    await mkdir(base, { recursive: true });

    // WILL THE FRAMES FIT? (media-009) The container is bounded on CPU, memory, pids, tmpfs scratch
    // and wall clock — every dimension except the one it actually fills. Nothing compared
    // `durationSec * fps` frames at this resolution to the space on the disk receiving them.
    //
    // Running out mid-capture does not fail politely: the frame sequence is left with holes, and
    // the assembler covers a hole by stretching or repeating, so the export is visibly broken and
    // the simulation gets the blame. And the filesystem it fills is the one Postgres is on.
    //
    // Checked AFTER `mkdir(base)` so the measurement is of a directory that exists, and before the
    // job directory is created so a refusal leaves nothing behind.
    {
      const verdict = captureSpaceVerdict({
        frames: expectedFrameCount(containerSpec),
        width: spec.width,
        height: spec.height,
        freeBytes: await freeBytesFor(base),
        ceilingBytes: this.config.maxOutputMb * 1024 * 1024,
      });
      if (verdict.refusal) {
        throw new Error(`container capture refused: ${verdict.refusal}`);
      }
    }
    const jobDir = await mkdtemp(join(base, `capture-${spec.sectionId.slice(0, 8)}-`));
    const inputDir = join(jobDir, 'input');
    const outputDir = join(jobDir, 'output');
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    try {
      const stored = await fetchPackageFiles(this.storage, source);
      // Offline closure: the capture container has no network, so a package whose import map names
      // a CDN cannot boot in it (v0.1.26 — dead canvas, empty renderer). Trusted pinned packs are
      // materialised into the COPY and the copy's import map is retargeted at them. Storage is
      // never written; the stored package is byte-identical before and after an export.
      const offline = await prepareOfflinePackage(stored, source.entryPath);
      const files = offline.files;
      await writeCaptureInput(inputDir, files, containerSpec);
      // The staging report the v0.1.23 forensics needed and did not have: which boundary was used,
      // where the entry sits inside it, and whether the package's generated runtime came along.
      logger.info(
        {
          section: spec.sectionId,
          files: files.length,
          layout: source.layout,
          packageRoot: source.packageRoot,
          entryPath: source.entryPath,
          hasBridge: files.some((f) => f.path === 'bridge.js'),
          vendoredPacks: offline.vendoredPacks,
          vendoredBytes: offline.vendoredBytes,
          rewrittenSpecifiers: offline.rewrittenSpecifiers,
          neutralisedUrls: offline.neutralisedUrls,
          image: this.config.image,
        },
        'export(container-capture): input staged — running worker container',
      );

      // The export job's cancellation signal, not a fresh one. A capture is the longest-running
      // thing an export does; passing `new AbortController().signal` here meant a cancelled export
      // kept both vCPUs pinned until the wall clock killed the container. The boundary already
      // knows how to stop a container on abort — it was simply never told.
      const result: ContainerCaptureResult = await this.boundary.runCapture(
        containerSpec,
        { inputDir, outputDir },
        signal ?? new AbortController().signal,
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
      // From here to the return, clipOut is THIS function's to clean up: on any throw — probe
      // mismatch, encode failure, cancellation — an un-deleted clipOut is a permanent leak on the
      // worker host, because ownership only transfers to the service with a successful return.
      try {
      // `result.json` is written by the untrusted side, so the paths in it are an instruction from
      // untrusted code to a privileged reader. The name is allowlisted at parse time, confined by
      // realpath, and CONSUMED THROUGH the validated O_NOFOLLOW descriptor — copying by pathname
      // after a separate check reintroduced the exact swap window the descriptor closes.
      if (result.clipPath) {
        const real = await assertWithinOutputDir(outputDir, result.clipPath);
        const handle = await openArtifactHandle(real, result.clipPath, MAX_ARTIFACT_FILE_BYTES);
        try {
          await pipeline(handle.createReadStream(), createWriteStream(clipPath, { flags: 'wx' }));
        } finally {
          await handle.close();
        }
      } else if (result.framesDir) {
        // Confining the DIRECTORY was not enough. ffmpeg opens each `frame-%06d.jpg` itself, in the
        // host namespace, following every symlink — so a link inside a confined directory still
        // reaches any host file. `assertFrameSet` lstats every entry against the count the TRUSTED
        // side expects…
        const framesReal = await assertFrameSet(outputDir, result.framesDir, {
          expectedFrames: expectedFrameCount(containerSpec),
          namePattern: containerSpec.output.namePattern,
        });
        // …and then EVERY frame is copied through its own validated O_NOFOLLOW descriptor into a
        // trusted-only directory, and probed there. Two gaps close at once: ffmpeg never reads the
        // container-writable mount (so nothing can be swapped between validation and encode), and
        // every frame is decode-validated — probing only the first and last let a wrong-sized or
        // undecodable MIDDLE frame through, to be discovered by a viewer mid-video. The probes run
        // under the global ffmpeg cap; at production frame counts this is seconds against a capture
        // that takes minutes.
        const expectedFrames = expectedFrameCount(containerSpec);
        const trustedFrames = join(jobDir, 'trusted-frames');
        await mkdir(trustedFrames, { recursive: true });
        for (let index = 0; index < expectedFrames; index++) {
          const name = frameFileName(containerSpec.output.namePattern, index);
          const handle = await openArtifactHandle(join(framesReal, name), name, MAX_ARTIFACT_FILE_BYTES);
          try {
            await pipeline(handle.createReadStream(), createWriteStream(join(trustedFrames, name), { flags: 'wx' }));
          } finally {
            await handle.close();
          }
          const probed = await this.probes.probeImage(join(trustedFrames, name), { signal });
          if (probed.width !== spec.width || probed.height !== spec.height) {
            throw new Error(
              `container capture: ${name} is ${probed.width}x${probed.height}, not the requested ${spec.width}x${spec.height}`,
            );
          }
        }

        await encodeFramesToClip(
          trustedFrames,
          containerSpec.output.namePattern,
          spec.fps,
          { width: spec.width, height: spec.height },
          clipPath,
          { timeoutMs: ENCODE_TIMEOUT_MS, signal },
        );
      } else {
        return {
          frameCount: result.frameCount,
          rendererString: result.rendererString,
          gate: 'failed',
          reason: 'container produced neither a clip nor a frames directory',
        };
      }
      // And the clip itself, against the window it has to fill. A clip short by two frames leaves a
      // gap the assembler covers by stretching or repeating — visible, and blamed on the simulation.
      await stat(clipPath);
      assertClipMatches(
        await this.probes.probeClip(clipPath, { signal }),
        {
          width: spec.width,
          height: spec.height,
          fps: spec.fps,
          frames: expectedFrameCount(containerSpec),
        },
        `container capture ${spec.sectionId}`,
      );
      // The cost split rides the SUCCESS log, structured, on the host — the run that answers "why
      // is this slow" is the one that worked, and until this line the validated numbers stopped at
      // the boundary parse and reached no log or metric anything could read.
      logger.info(
        {
          section: spec.sectionId,
          frameCount: result.frameCount,
          renderer: result.rendererString,
          rendererProfile: containerSpec.rendererProfile,
          cost: result.cost,
        },
        'export(container-capture): section captured',
      );
      return {
        clipPath,
        frameCount: result.frameCount,
        rendererString: result.rendererString,
        gate: 'passed',
        reason: result.reason ?? undefined,
        cost: result.cost ?? undefined,
      };
      } catch (err) {
        // Ownership of clipOut transfers only with a successful return. Any throw before that —
        // probe mismatch, encode failure, cancellation — and the directory is ours to delete, or it
        // is a permanent leak on the worker host.
        await rm(clipOut, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
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
  logger.info({ image: config.image, rendererProfile: config.rendererProfile }, 'export: container capture provider configured');
  return new ContainerCaptureProvider(config);
}
