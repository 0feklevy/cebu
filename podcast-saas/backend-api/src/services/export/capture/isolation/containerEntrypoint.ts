/**
 * The trusted orchestration that runs INSIDE the container (plan §0.2), wiring the loopback package
 * server to the browser driver.
 *
 * This is the code the container's CMD ultimately runs. Its job is small and entirely trusted:
 *
 *   1. read the capture spec + package bytes off the read-only input mount;
 *   2. start the loopback package server on 127.0.0.1 (the only reachable address in `--network none`);
 *   3. hand the driver the loopback ENTRY URL (with `?section=&v=` and `#simboot=` preserved) and let
 *      it capture frames to the output mount;
 *   4. write the result manifest to the output mount and stop the server.
 *
 * The browser DRIVER (headless-shell launch, beginFrame loop, injection, the paint/WebGL gate) is the
 * SIBLING's territory — this module never imports it. It is injected as a `SimCaptureDriver`, which
 * keeps three things true at once: this file compiles and unit-tests on macOS with a fake driver; it
 * never reaches into the sibling's `capture/*` files; and the container's real `main` is a ~10-line
 * shim (documented in the runbook) that injects the actual driver. That shim is the only file that
 * couples the two halves, and it lives at the integration seam, not here.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readManifestFilesFromInput } from './packageInput.js';
import {
  CAPTURE_RESULT_FILENAME,
  CAPTURE_SPEC_FILENAME,
  parseCaptureResult,
  type ContainerCaptureResult,
  type ContainerCaptureSpec,
} from './captureJobBoundary.js';
import { LoopbackPackageServer, type LoopbackPackageFile } from './loopbackPackageServer.js';
import { CONTAINER_MOUNTS } from './containerRunArgs.js';

/**
 * What the sibling's browser driver must implement. It receives an already-loopback entry URL — it
 * never constructs an external one — and writes frames under `outputDir`, returning the result the
 * container hands back to the trusted side.
 */
export interface SimCaptureDriver {
  drive(input: {
    /** `http://127.0.0.1:<port>/<entry>?section=…&v=…#simboot=…` — loopback, query/fragment intact. */
    entryUrl: string;
    spec: ContainerCaptureSpec;
    /** Absolute path of the output mount to write frames + clip into. */
    outputDir: string;
    signal: AbortSignal;
  }): Promise<ContainerCaptureResult>;
}

export interface RunContainerCaptureDeps {
  /** Loaded package files (path + bytes). Defaults to reading them off the input mount via the manifest. */
  packageFiles?: readonly LoopbackPackageFile[];
  /** The already-parsed spec. Defaults to reading `${input}/capture-spec.json`. */
  spec?: ContainerCaptureSpec;
  inputDir?: string;
  outputDir?: string;
  driver: SimCaptureDriver;
  signal?: AbortSignal;
  /** Server factory seam for tests. */
  makeServer?: (files: readonly LoopbackPackageFile[], entryPath: string) => LoopbackPackageServer;
}

function defaultMakeServer(files: readonly LoopbackPackageFile[], entryPath: string): LoopbackPackageServer {
  // Port 0 ⇒ the OS picks a free loopback port; the driver reads it from the entry URL below.
  return new LoopbackPackageServer(files, { host: '127.0.0.1', port: 0, entryPath });
}

/**
 * Orchestrate one section's capture. Pure of any credential and of the browser driver's identity —
 * the driver is a parameter, the server is loopback-only, the I/O is the two mounts. Unit-tested on
 * macOS with a fake driver; the real driver only runs in the Linux container.
 */
export async function runContainerCapture(deps: RunContainerCaptureDeps): Promise<ContainerCaptureResult> {
  const inputDir = deps.inputDir ?? CONTAINER_MOUNTS.input;
  const outputDir = deps.outputDir ?? CONTAINER_MOUNTS.output;

  const spec = deps.spec ?? (await loadSpec(inputDir));
  const packageFiles = deps.packageFiles ?? (await readManifestFilesFromInput(inputDir));

  const makeServer = deps.makeServer ?? defaultMakeServer;
  const server = makeServer(packageFiles, spec.entryPath);

  const controller = new AbortController();
  const signal = deps.signal ?? controller.signal;

  await mkdir(outputDir, { recursive: true });
  await server.start();
  try {
    const entryUrl = server.entryUrl(spec.entryQuery, spec.entryFragment);
    const result = await deps.driver.drive({ entryUrl, spec, outputDir, signal });
    // Round-trip through the validator so a driver-shaped bug is caught before the trusted side reads it.
    const validated = parseCaptureResult(result as unknown);
    await writeFile(join(outputDir, CAPTURE_RESULT_FILENAME), JSON.stringify(validated, null, 2), 'utf8');
    return validated;
  } finally {
    await server.stop();
  }
}

async function loadSpec(inputDir: string): Promise<ContainerCaptureSpec> {
  const raw = await readFile(join(inputDir, CAPTURE_SPEC_FILENAME), 'utf8');
  const parsed = JSON.parse(raw) as ContainerCaptureSpec;
  return parsed;
}
