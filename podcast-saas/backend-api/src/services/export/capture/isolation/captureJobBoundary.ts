/**
 * The trusted/untrusted boundary (plan §0.2): the interface between ProjectExportService (TRUSTED —
 * has the DB, mints presigned GET/PUT) and the capture container (UNTRUSTED — runs arbitrary sim JS).
 *
 * The rule the whole security architecture rests on: THE CONTAINER NEVER HOLDS A CREDENTIAL. So the
 * boundary is deliberately narrow and one-directional in each leg:
 *
 *   IN  → the package bytes (already downloaded by the trusted job via presigned GET) + a capture
 *         SPEC that is pure description. The spec carries no URL to any external origin, no presigned
 *         URL, no DB handle, no cookie, no token — only what the browser needs to reproduce what the
 *         viewer runs: the package-relative entry path, the `?section=&v=` query and `#simboot=`
 *         fragment preserved VERBATIM, the exact `startScript` params, the configHash (the PRNG seed),
 *         duration/fps, and where to write frames.
 *   OUT → frames/clip written to the output mount, plus a RESULT describing what was produced and the
 *         renderer identity. The trusted side reads that off the shared dir and does the presigned PUT
 *         itself. Nothing leaves the container over a network; there is no network.
 *
 * `buildCaptureSpec` and `parseCaptureResult` are pure and unit-tested on macOS. `DockerCaptureBoundary`
 * is the real implementation that spawns the container — it composes the pure pieces with the run-arg
 * assembler and a wall-clock kill, and is marked "verified-in-container: PENDING" because macOS cannot
 * run the container (beginFrame is Linux-only — plan §4, measured).
 *
 * ALIGNMENT with the sibling's `capture/captureTypes.ts` (which exists): that file is the IN-PROCESS
 * backend contract — `SimCaptureBackend.captureSection(spec)` where `spec.servedSimUrl` is exactly the
 * loopback URL THIS layer serves. To avoid a name collision with its `CaptureSpec`/`CaptureResult`
 * (the in-process shapes), the FILE-boundary shapes here are `ContainerCaptureSpec` /
 * `ContainerCaptureResult` — the JSON written to / read from the container's mounts. The bridge
 * between the two lives in `backendAdapter.ts`, which is the one place that imports both. The result
 * fields are named to match the sibling's `CaptureResult` (`framesDir`/`clipPath`/`frameCount`/
 * `rendererString`/`gate`/`reason`) so the container result is a strict superset of the in-process one.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import type { RendererIdentity, SimCaptureWindow } from '../../types.js';

import { sanitizeUntrustedText } from '../captureTypes.js';

import { buildContainerRunArgv, type ContainerRunSpec } from './containerRunArgs.js';

/** The current spec/result wire version. Bump on any breaking shape change. */
export const CAPTURE_SPEC_VERSION = 1 as const;

/** Filenames the trusted side and the container agree on, under the input/output mounts. */
export const CAPTURE_SPEC_FILENAME = 'capture-spec.json';
export const CAPTURE_RESULT_FILENAME = 'result.json';

/**
 * Substrings that must never appear as a key anywhere in a capture spec. This is belt-and-braces on
 * top of the type: the spec is serialized to a file the untrusted container reads, so a credential
 * leaking in by a future careless edit would be a credential handed to untrusted code. `buildCaptureSpec`
 * scans its own output and throws; a test asserts the serialized spec is clean.
 */
export const FORBIDDEN_SPEC_KEY_SUBSTRINGS: readonly string[] = [
  'secret',
  'password',
  'passwd',
  'token',
  'credential',
  'cookie',
  'authorization',
  'apikey',
  'api_key',
  'presign',
  'aws_',
  'access_key',
  'database_url',
  'connectionstring',
  'connection_string',
  'privatekey',
  'private_key',
];

/** The exact `startScript` params the player sends — mirrored so capture runs the same script. */
export interface CaptureStartScript {
  simpleUi: boolean;
  autoScript: boolean;
  /** sim_meta.uiControls.hide, exactly as the player passes hideSelectors. */
  uiHide: string[];
}

export interface CaptureOutputSpec {
  /** 'jpeg' is the measured throughput lever (q80 ≈ 24 ms/frame vs 267 ms default PNG). */
  format: 'jpeg' | 'png';
  /** JPEG quality (ignored for png). */
  quality: number;
  /** Frame directory, RELATIVE to the output mount (/output). */
  frameDir: string;
  /** printf-style frame name, e.g. "frame-%06d.jpg". */
  namePattern: string;
}

/**
 * The description written to the container's input mount (`capture-spec.json`). Pure data: no
 * credentials, no external URLs — the browser loads everything from the loopback server that serves
 * the package on the input mount. `backendAdapter.ts` turns this + the loopback entry URL into the
 * sibling's in-process `CaptureSpec` (with `servedSimUrl`).
 */
export interface ContainerCaptureSpec {
  specVersion: typeof CAPTURE_SPEC_VERSION;
  sectionId: string;
  simulationId: string | null;
  /** The PRNG seed axis (mulberry32) — already the identity axis this codebase enforces. */
  configHash: string | null;
  /** Package-relative entry document, from the manifest's `entry` (e.g. "package/index.html"). */
  entryPath: string;
  /** The `?section=&v=` query preserved VERBATIM (empty string if none). NOT an external origin. */
  entryQuery: string;
  /** The `#simboot=` fragment preserved VERBATIM (empty string if none). */
  entryFragment: string;
  startScript: CaptureStartScript;
  durationSec: number;
  fps: number;
  /** Capture width/height in CSS px — the export grid (1920×1080). */
  width: number;
  height: number;
  /** Discarded warmup frames before the real capture (compositor staleness — plan §4). */
  warmupFrames: number;
  /** Poster identity the trusted side falls back to if capture fails; opaque to the container. */
  posterKey: string | null;
  output: CaptureOutputSpec;
  /** Per-section hard wall-clock cap; the orchestrator SIGKILLs the container on expiry. */
  wallClockTimeoutSec: number;
}

/**
 * What the container writes to `${output}/result.json`, read back by the trusted side. Field names
 * match the sibling's in-process `CaptureResult` (`framesDir`/`clipPath`/`frameCount`/`rendererString`/
 * `gate`/`reason`) so the adapter's translation is a widening, plus the container-level identity the
 * in-process shape does not carry.
 */
export interface ContainerCaptureResult {
  resultVersion: typeof CAPTURE_SPEC_VERSION;
  sectionId: string;
  /** 'ok' = the container ran and produced a result; the `gate` verdict says whether to trust it. */
  status: 'ok' | 'failed';
  /** Output-relative frames directory (numbered frames), or null when a clip was produced instead. */
  framesDir: string | null;
  /** Output-relative encoded clip, or null when a frames directory was produced instead. */
  clipPath: string | null;
  /** Frames actually produced; the trusted side asserts it equals round(durationSec × fps). */
  frameCount: number;
  /** UNMASKED_RENDERER_WEBGL — the auditor for "silent degradation to a 2D fallback" (plan §4 mode 2). */
  rendererString: string;
  /** The rendering sanity gate verdict (§0.3): 'failed' is trustworthy, 'passed' is strong evidence. */
  gate: 'passed' | 'failed';
  /** Why the gate failed, or a note on a pass. */
  reason: string | null;
  /** The capture-environment identity — which image/viewport/DPR produced these frames. */
  rendererIdentity: RendererIdentity;
  failure: { code: string; detail: string } | null;
}

// ── Options for building a spec from a plan window ──────────────────────────────────────────────

export interface BuildCaptureSpecOptions {
  /** From the sim manifest's `entry` — the package-relative document the loopback server serves at /. */
  entryPath: string;
  output: CaptureOutputSpec;
  fps: number;
  /** Capture grid — 1920×1080 (EXPORT_GRID). */
  width: number;
  height: number;
  warmupFrames: number;
  wallClockTimeoutSec: number;
}

/** Recursively assert no key contains a forbidden substring. Throws with the offending path. */
function assertNoForbiddenKeys(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoForbiddenKeys(v, `${path}[${i}]`));
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    for (const bad of FORBIDDEN_SPEC_KEY_SUBSTRINGS) {
      if (lower.includes(bad)) {
        throw new Error(`captureJobBoundary: forbidden credential-shaped key ${JSON.stringify(key)} at ${path}`);
      }
    }
    assertNoForbiddenKeys(v, `${path}.${key}`);
  }
}

/**
 * Extract ONLY the query and fragment from a served URL, dropping the origin and path. Handles both
 * an absolute URL and a stored relative one (no origin) without inventing anything.
 */
function extractQueryFragment(servedUrl: string): { query: string; fragment: string } {
  try {
    const u = new URL(servedUrl);
    return { query: u.search, fragment: u.hash }; // each includes its leading '?'/'#', or '' when absent
  } catch {
    const hashIdx = servedUrl.indexOf('#');
    const fragment = hashIdx === -1 ? '' : servedUrl.slice(hashIdx);
    const withoutHash = hashIdx === -1 ? servedUrl : servedUrl.slice(0, hashIdx);
    const qIdx = withoutHash.indexOf('?');
    const query = qIdx === -1 ? '' : withoutHash.slice(qIdx);
    return { query, fragment };
  }
}

/**
 * Build the container capture spec for one `sim-capture` plan window.
 *
 * The window's `servedUrl` is the EXTERNAL viewer URL (e.g. https://api.…/sim-public/…?section=…).
 * We deliberately DROP its origin and path: the container never touches that origin — the package is
 * served from loopback. We keep ONLY its query and fragment, verbatim, because losing `?section=&v=`
 * loses dispatch and losing `#simboot=` loses the pre-paint UI cloak (plan §4). The entry path comes
 * from the manifest, not the URL.
 *
 * Throws if the window has no `servedUrl` (nothing to capture — the trusted side must route it to a
 * poster fallback before calling here) or if the assembled spec somehow contains a credential-shaped
 * key.
 */
export function buildCaptureSpec(window: SimCaptureWindow, opts: BuildCaptureSpecOptions): ContainerCaptureSpec {
  if (!window.servedUrl) {
    throw new Error(`buildCaptureSpec: section ${window.sectionId} has no servedUrl; route it to poster fallback, do not capture`);
  }

  const { query: entryQuery, fragment: entryFragment } = extractQueryFragment(window.servedUrl);

  const durationSec = Math.max(0, window.endSec - window.startSec);

  const spec: ContainerCaptureSpec = {
    specVersion: CAPTURE_SPEC_VERSION,
    sectionId: window.sectionId,
    simulationId: window.simulationId,
    configHash: window.configHash,
    entryPath: opts.entryPath,
    entryQuery,
    entryFragment,
    startScript: {
      simpleUi: window.simpleUi,
      autoScript: window.autoScript,
      uiHide: window.uiHide ?? [],
    },
    durationSec,
    fps: opts.fps,
    width: opts.width,
    height: opts.height,
    warmupFrames: opts.warmupFrames,
    posterKey: window.posterKey,
    output: opts.output,
    wallClockTimeoutSec: opts.wallClockTimeoutSec,
  };

  assertNoForbiddenKeys(spec);
  return spec;
}

/** How many frames the container must produce for a spec — the count the trusted side gates on. */
export function expectedFrameCount(spec: ContainerCaptureSpec): number {
  return Math.round(spec.durationSec * spec.fps);
}

// ── Result parsing / validation ─────────────────────────────────────────────────────────────────

function isRendererIdentity(v: unknown): v is RendererIdentity {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.imageDigest === 'string' &&
    typeof o.headlessShellVersion === 'string' &&
    typeof o.dpr === 'number' &&
    typeof o.viewport === 'object' && o.viewport !== null &&
    typeof (o.viewport as Record<string, unknown>).w === 'number' &&
    typeof (o.viewport as Record<string, unknown>).h === 'number'
  );
}

/**
 * The only artifact names the container may hand back. `result.json` names WHERE its output is, and
 * the trusted side then reads that path — so the field is an instruction from untrusted code to a
 * privileged reader, and an allowlist is the only safe shape for it. Anything else (a traversal, an
 * absolute path, a second directory level) is refused rather than sanitised: there is no legitimate
 * reason for the entrypoint to name anything but these two, and "sanitise" invites a bypass.
 */
const ALLOWED_ARTIFACT_PATHS = new Set(['frames', 'section.mp4']);

/**
 * Reject any artifact path that is not one of the two names above.
 *
 * Without this, `join(outputDir, result.clipPath)` in the provider escapes on `../` — `join` only
 * ignores a leading `/`, it does not confine — and the trusted worker would `copyFile` an arbitrary
 * host file into the section clip, which `ProjectExportService` then uploads to storage and serves.
 * That is arbitrary host-file exfiltration through the export artifact, driven entirely by a string
 * the untrusted container chose. Path confinement at read time (`assertWithinOutputDir`) closes the
 * symlink half of the same hole; this closes the name half.
 */
export function assertArtifactPath(value: unknown, field: 'framesDir' | 'clipPath'): asserts value is string {
  if (typeof value !== 'string') throw new Error(`parseCaptureResult: bad ${field}`);
  if (!ALLOWED_ARTIFACT_PATHS.has(value)) {
    throw new Error(`parseCaptureResult: ${field} must name a known artifact, got ${JSON.stringify(value.slice(0, 64))}`);
  }
}

/**
 * Resolve an artifact inside the job's output directory, following no symlink out of it.
 *
 * The output mount is writable by the container, so it can plant a symlink named exactly `frames`
 * or `section.mp4` pointing anywhere on the host; `copyFile` and ffmpeg both follow symlinks, so the
 * name allowlist alone is not enough. `realpath` collapses every link in the chain, including
 * intermediate ones, and the result must still sit under the real output directory.
 */
export async function assertWithinOutputDir(outputDir: string, artifact: string): Promise<string> {
  const rootReal = await realpath(outputDir);
  let targetReal: string;
  try {
    targetReal = await realpath(join(rootReal, artifact));
  } catch (err) {
    throw new Error(`capture artifact ${artifact} is not readable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (targetReal !== rootReal && !targetReal.startsWith(prefix)) {
    throw new Error(`capture artifact ${artifact} resolves outside the output directory — refusing to read it`);
  }
  return targetReal;
}

/**
 * Parse + validate the container's result JSON. Rejects anything malformed rather than trusting a
 * shape from untrusted code — the result is written by the trusted entrypoint, but it lands on a
 * mount the browser could in principle also write, so it is treated as untrusted input.
 */
export function parseCaptureResult(raw: unknown): ContainerCaptureResult {
  const o = (typeof raw === 'string' ? safeJsonParse(raw) : raw) as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') throw new Error('parseCaptureResult: not an object');
  if (o.resultVersion !== CAPTURE_SPEC_VERSION) throw new Error(`parseCaptureResult: unsupported resultVersion ${String(o.resultVersion)}`);
  if (typeof o.sectionId !== 'string') throw new Error('parseCaptureResult: sectionId missing');
  if (o.status !== 'ok' && o.status !== 'failed') throw new Error(`parseCaptureResult: bad status ${String(o.status)}`);
  if (typeof o.frameCount !== 'number' || !Number.isInteger(o.frameCount) || o.frameCount < 0) {
    throw new Error('parseCaptureResult: bad frameCount');
  }
  if (o.framesDir !== null && o.framesDir !== undefined) assertArtifactPath(o.framesDir, 'framesDir');
  if (o.clipPath !== null && o.clipPath !== undefined) assertArtifactPath(o.clipPath, 'clipPath');
  if (typeof o.rendererString !== 'string') throw new Error('parseCaptureResult: bad rendererString');
  if (o.gate !== 'passed' && o.gate !== 'failed') throw new Error(`parseCaptureResult: bad gate ${String(o.gate)}`);
  if (!isRendererIdentity(o.rendererIdentity)) throw new Error('parseCaptureResult: bad rendererIdentity');

  return {
    resultVersion: CAPTURE_SPEC_VERSION,
    sectionId: o.sectionId,
    status: o.status,
    framesDir: (o.framesDir as string | null) ?? null,
    clipPath: (o.clipPath as string | null) ?? null,
    frameCount: o.frameCount,
    // Free-text fields cross the trust boundary: the container is untrusted and these end up in
    // logs, the job row, and the user-visible warning list. Strip control characters and cap the
    // length HERE, once, so no caller has to remember to.
    rendererString: sanitizeUntrustedText(o.rendererString, { maxBytes: 256, maxLines: 1 }),
    gate: o.gate,
    reason: typeof o.reason === 'string' ? sanitizeUntrustedText(o.reason, { maxBytes: 1_024, maxLines: 12 }) : null,
    rendererIdentity: o.rendererIdentity,
    failure:
      o.failure && typeof o.failure === 'object'
        ? {
            code: sanitizeUntrustedText(String((o.failure as Record<string, unknown>).code ?? 'unknown'), {
              maxBytes: 64,
              maxLines: 1,
            }),
            detail: sanitizeUntrustedText(String((o.failure as Record<string, unknown>).detail ?? ''), {
              maxBytes: 2_048,
              maxLines: 40,
            }),
          }
        : null,
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    throw new Error('parseCaptureResult: invalid JSON');
  }
}

// ── Filesystem I/O for the mounts (trusted side) ────────────────────────────────────────────────

/** One package file to materialize on the input mount (same shape the loopback server consumes). */
export interface CaptureInputFile {
  /** Normalized, prefix-relative POSIX path. */
  path: string;
  content: Buffer;
}

/**
 * Write the read-only input mount: the package bytes at their manifest-relative paths, plus the
 * capture spec at `capture-spec.json`. The trusted side calls this before launching the container;
 * the container's entrypoint reads them back and serves the package from loopback.
 */
export async function writeCaptureInput(
  inputDir: string,
  packageFiles: readonly CaptureInputFile[],
  spec: ContainerCaptureSpec,
): Promise<void> {
  await mkdir(inputDir, { recursive: true });
  for (const file of packageFiles) {
    if (file.path.includes('..') || file.path.startsWith('/') || file.path.includes('\\')) {
      // The package was vetted upstream, but this write must not be the place a bad path escapes.
      throw new Error(`writeCaptureInput: unsafe package path ${JSON.stringify(file.path)}`);
    }
    const dest = join(inputDir, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, file.content);
  }
  await writeFile(join(inputDir, CAPTURE_SPEC_FILENAME), JSON.stringify(spec, null, 2), 'utf8');
}

/** Read + validate the container's result off the output mount. */
export async function readCaptureResult(outputDir: string): Promise<ContainerCaptureResult> {
  const raw = await readFile(join(outputDir, CAPTURE_RESULT_FILENAME), 'utf8');
  return parseCaptureResult(raw);
}

// ── The boundary interface + the docker-backed implementation ───────────────────────────────────

export interface CaptureIo {
  /** Host dir mounted read-only at /input. */
  inputDir: string;
  /** Host dir mounted read-write at /output. */
  outputDir: string;
}

/**
 * The one call the trusted backend (ProjectExportService) makes to render one sim section. The
 * implementation runs the container; the caller owns download (presigned GET), `writeCaptureInput`,
 * reading the frames, and the presigned PUT. The container is a pure function from (input mount,
 * spec) to (output mount, result) with no credential in scope.
 */
export interface CaptureJobBoundary {
  runCapture(spec: ContainerCaptureSpec, io: CaptureIo, signal: AbortSignal): Promise<ContainerCaptureResult>;
}

export interface DockerCaptureBoundaryConfig {
  /** Pinned image (digest in prod). */
  image: string;
  user: string;
  cpus: string;
  memoryMb: number;
  pidsLimit: number;
  tmpfsScratchMb: number;
  stopTimeoutSec: number;
  sandboxMechanism?: ContainerRunSpec['sandboxMechanism'];
  seccompProfilePath?: string;
  /** The docker (or podman) binary. */
  dockerBin?: string;
}

/** Escalation grace after the graceful wall-clock kill before the hard SIGKILL, ms. */
const KILL_ESCALATION_MS = 5_000;

/**
 * Runs the capture in a hardened container. VERIFIED-IN-CONTAINER: PENDING — macOS cannot run
 * beginFrame (plan §4, measured), so this path is exercised only in the Linux CI container per the
 * runbook's checklist. The pure pieces it composes (`buildContainerRunArgv`, `parseCaptureResult`)
 * are unit-tested here on macOS.
 */
export class DockerCaptureBoundary implements CaptureJobBoundary {
  constructor(private readonly config: DockerCaptureBoundaryConfig) {}

  async runCapture(spec: ContainerCaptureSpec, io: CaptureIo, signal: AbortSignal): Promise<ContainerCaptureResult> {
    const dockerBin = this.config.dockerBin ?? 'docker';
    const containerName = `export-capture-${spec.sectionId}-${Date.now().toString(36)}`;

    const argv = buildContainerRunArgv({
      image: this.config.image,
      containerName,
      inputDir: io.inputDir,
      outputDir: io.outputDir,
      user: this.config.user,
      cpus: this.config.cpus,
      memoryMb: this.config.memoryMb,
      pidsLimit: this.config.pidsLimit,
      tmpfsScratchMb: this.config.tmpfsScratchMb,
      stopTimeoutSec: this.config.stopTimeoutSec,
      sandboxMechanism: this.config.sandboxMechanism,
      seccompProfilePath: this.config.seccompProfilePath,
    });

    const exit = await this.spawnDocker(dockerBin, argv, containerName, spec.wallClockTimeoutSec, signal);
    if (exit.code === 0) return readCaptureResult(io.outputDir);

    // Non-zero exit. The entrypoint promises a `failed` result.json for ANY failure — honour that
    // promise on the trusted side instead of discarding it (the v0.1.22 incident hid its root
    // cause behind a bare "exited 1" for days). SEMANTIC RULE: exit≠0 may surface as a CLASSIFIED
    // FAILURE, never as a success — an `ok` result next to a non-zero exit is itself an error.
    let onDisk: ContainerCaptureResult | null;
    try {
      onDisk = await readCaptureResult(io.outputDir);
    } catch {
      onDisk = null; // no readable artifact — fall through to the stderr-carrying error
    }
    if (onDisk && onDisk.status === 'failed') return onDisk;
    if (onDisk) {
      throw new Error(
        `export capture container exited ${exit.code ?? 'null'} but result.json claims status "${onDisk.status}" — ` +
          `refusing the contradiction${exit.stderrTail ? `; stderr tail: ${exit.stderrTail}` : ''}`,
      );
    }
    throw new Error(
      `export capture container exited ${exit.code ?? 'null'} with no readable result.json` +
        (exit.stderrTail ? `; stderr tail: ${exit.stderrTail}` : ''),
    );
  }

  private spawnDocker(
    dockerBin: string,
    argv: string[],
    containerName: string,
    wallClockTimeoutSec: number,
    signal: AbortSignal,
  ): Promise<{ code: number | null; stderrTail: string }> {
    return new Promise<{ code: number | null; stderrTail: string }>((resolve, reject) => {
      const proc = spawn(dockerBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

      // Bounded, sanitized stderr tail. The stream mixes docker's own errors with the UNTRUSTED
      // sim's output (via the entrypoint's console.error), so it is diagnostic material, not log
      // fodder: keep only the last STDERR_TAIL_BYTES, strip control characters at use time, and
      // never persist it anywhere beyond the thrown error's message.
      let stderrAcc = '';
      proc.stderr?.on('data', (d: Buffer) => {
        stderrAcc = (stderrAcc + d.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });

      // The hard wall-clock kill the plan requires: docker cannot SIGKILL itself on a wall clock, so
      // the orchestrator does it. `docker kill --signal=KILL` terminates the whole container (and
      // thus the browser) — the graceful `--stop-timeout` window only applies to `docker stop`.
      const hardKill = (): void => {
        const killer = spawn(dockerBin, ['kill', '--signal=KILL', containerName], { stdio: 'ignore' });
        killer.on('error', () => {});
      };
      const wallTimer = setTimeout(hardKill, Math.max(1, wallClockTimeoutSec) * 1_000);
      wallTimer.unref();

      let escalationTimer: NodeJS.Timeout | undefined;
      const onAbort = (): void => {
        // Cancellation: graceful stop first, escalate to a hard container kill after the grace window.
        const stopper = spawn(dockerBin, ['stop', containerName], { stdio: 'ignore' });
        stopper.on('error', () => {});
        escalationTimer = setTimeout(hardKill, KILL_ESCALATION_MS);
        escalationTimer.unref();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(wallTimer);
        if (escalationTimer) clearTimeout(escalationTimer);
        signal.removeEventListener('abort', onAbort);
      };

      proc.on('error', (err) => {
        cleanup();
        reject(err);
      });
      proc.on('close', (code) => {
        cleanup();
        resolve({ code, stderrTail: sanitizeStderrTail(stderrAcc) });
      });
    });
  }
}

/** Cap on the raw stderr kept in memory while the container runs. */
const STDERR_TAIL_BYTES = 4_096;
/** Cap on the sanitized tail that may ride inside an error message (untrusted content!). */
const STDERR_MESSAGE_BYTES = 2_048;
const STDERR_MAX_LINES = 40;

/**
 * Make an untrusted stderr tail safe to put in ONE error message: strip control characters
 * (terminal-escape smuggling), collapse to the last few lines, and hard-cap the bytes. Exported
 * so the caps themselves are pinned by tests.
 */
export function sanitizeStderrTail(raw: string): string {
  return sanitizeUntrustedText(raw, { maxBytes: STDERR_MESSAGE_BYTES, maxLines: STDERR_MAX_LINES });
}

/** Best-effort removal of a per-section work dir pair. Used by the orchestrator in a finally. */
export async function cleanupCaptureIo(io: CaptureIo): Promise<void> {
  await Promise.allSettled([
    rm(io.inputDir, { recursive: true, force: true }),
    rm(io.outputDir, { recursive: true, force: true }),
  ]);
}
