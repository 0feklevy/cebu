/**
 * The export-capture container ENTRYPOINT (the Dockerfile's CMD → `node dist/.../isolation/main.js`).
 *
 * This is the integration shim referenced by containerEntrypoint.ts and the runbook: the ONE place
 * that couples the loopback+orchestration half (this layer) to the browser-driver half (the sibling's
 * `SimCaptureBackend`). It stays a shim by construction:
 *
 *   • the backend is loaded by a RUNTIME dynamic import of a module named by
 *     `EXPORT_CAPTURE_BACKEND_MODULE`, not a static import of the sibling's files — so this layer
 *     compiles and ships without depending on which backend file exists, and the container is
 *     configured (not recompiled) to switch backends;
 *   • the renderer identity (image digest, headless-shell version, DPR) is read from env baked into
 *     the image, so the result records exactly which environment produced the frames;
 *   • ANY failure writes a `failed` result.json to /output and exits non-zero, so the trusted side
 *     always gets a diagnosable artifact — never a missing file it has to guess about.
 *
 * VERIFIED-IN-CONTAINER: PENDING. macOS cannot run beginFrame (plan §4, measured); this path is
 * exercised only in the Linux CI container per the runbook checklist.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { RendererIdentity } from '../../types.js';

import { backendToDriver } from './backendAdapter.js';
import {
  CAPTURE_RESULT_FILENAME,
  CAPTURE_SPEC_FILENAME,
  type ContainerCaptureResult,
  type ContainerCaptureSpec,
} from './captureJobBoundary.js';
import { runContainerCapture } from './containerEntrypoint.js';
import { CONTAINER_MOUNTS } from './containerRunArgs.js';
import type { SimCaptureBackend } from '../captureTypes.js';

/** A backend module must default-export or name-export a `createBackend()` factory. */
interface BackendModule {
  createBackend?: () => SimCaptureBackend;
  default?: (() => SimCaptureBackend) | SimCaptureBackend;
}

function rendererIdentityFromEnv(spec: ContainerCaptureSpec): RendererIdentity {
  return {
    imageDigest: process.env.EXPORT_IMAGE_DIGEST ?? 'unknown',
    headlessShellVersion: process.env.CHROME_HEADLESS_SHELL_VERSION ?? 'unknown',
    viewport: { w: spec.width, h: spec.height },
    dpr: Number(process.env.EXPORT_CAPTURE_DPR ?? '1'),
  };
}

async function loadBackend(): Promise<SimCaptureBackend> {
  const moduleSpecifier = process.env.EXPORT_CAPTURE_BACKEND_MODULE;
  if (!moduleSpecifier) {
    throw new Error('EXPORT_CAPTURE_BACKEND_MODULE is not set — the container has no browser backend to load');
  }
  // Variable specifier ⇒ resolved at runtime, not statically bound to the sibling's files.
  const mod = (await import(moduleSpecifier)) as BackendModule;
  const factory = mod.createBackend ?? mod.default;
  if (typeof factory === 'function') return (factory as () => SimCaptureBackend)();
  if (factory && typeof (factory as SimCaptureBackend).captureSection === 'function') return factory as SimCaptureBackend;
  throw new Error(`backend module ${moduleSpecifier} exports neither createBackend() nor a default backend`);
}

async function readSpec(inputDir: string): Promise<ContainerCaptureSpec> {
  const raw = await readFile(join(inputDir, CAPTURE_SPEC_FILENAME), 'utf8');
  return JSON.parse(raw) as ContainerCaptureSpec;
}

async function writeFailure(outputDir: string, sectionId: string, err: unknown): Promise<void> {
  const failed: ContainerCaptureResult = {
    resultVersion: 1,
    sectionId,
    status: 'failed',
    framesDir: null,
    clipPath: null,
    frameCount: 0,
    rendererString: '',
    gate: 'failed',
    reason: err instanceof Error ? err.message : String(err),
    rendererIdentity: {
      imageDigest: process.env.EXPORT_IMAGE_DIGEST ?? 'unknown',
      headlessShellVersion: process.env.CHROME_HEADLESS_SHELL_VERSION ?? 'unknown',
      viewport: { w: 0, h: 0 },
      dpr: Number(process.env.EXPORT_CAPTURE_DPR ?? '1'),
    },
    failure: { code: 'capture_failed', detail: err instanceof Error ? err.stack ?? err.message : String(err) },
  };
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, CAPTURE_RESULT_FILENAME), JSON.stringify(failed, null, 2), 'utf8');
}

async function main(): Promise<void> {
  const inputDir = process.env.EXPORT_CAPTURE_INPUT_DIR ?? CONTAINER_MOUNTS.input;
  const outputDir = process.env.EXPORT_CAPTURE_OUTPUT_DIR ?? CONTAINER_MOUNTS.output;

  let sectionId = 'unknown';
  try {
    const spec = await readSpec(inputDir);
    sectionId = spec.sectionId;
    const backend = await loadBackend();
    const rendererIdentity = rendererIdentityFromEnv(spec);
    await runContainerCapture({
      spec,
      inputDir,
      outputDir,
      driver: backendToDriver(backend, { rendererIdentity }),
    });
    process.exitCode = 0;
  } catch (err) {
    await writeFailure(outputDir, sectionId, err).catch(() => {});
    console.error('[export-capture] failed:', err);
    process.exitCode = 1;
  }
}

void main();
