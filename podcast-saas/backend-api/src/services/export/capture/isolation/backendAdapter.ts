/**
 * The alignment bridge between the sibling's IN-PROCESS backend contract (`capture/captureTypes.ts`)
 * and this layer's CONTAINER file-boundary (plan §0.2).
 *
 * The sibling owns `SimCaptureBackend` — `captureSection(spec)` where `spec.servedSimUrl` is, in its
 * own words, "the loopback URL the package is served from on the trusted side (§0.2)". This layer owns
 * that loopback server and the container. This file is the ONE place both are imported: it turns a
 * `SimCaptureBackend` into the `SimCaptureDriver` that `containerEntrypoint.runContainerCapture` drives.
 *
 * Two responsibilities beyond the type translation:
 *   1. it builds the backend's `CaptureSpec` from this layer's `ContainerCaptureSpec` + the loopback
 *      entry URL — so the backend never constructs a URL and never sees the external origin;
 *   2. it RELOCATES the backend's output into the /output mount. The backend chooses where to write
 *      (its `CaptureResult.framesDir`/`clipPath`), which in the container is the ephemeral tmpfs — so
 *      those bytes must be copied onto the bind-mounted /output before the container exits, or the
 *      trusted side has nothing to read. The result's paths are then rewritten OUTPUT-RELATIVE.
 *
 * The real container `main` (documented in the runbook) is essentially:
 *   runContainerCapture({ driver: backendToDriver(beginFrameBackend, { rendererIdentity }) })
 */

import { cp, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  CaptureResult as BackendCaptureResult,
  CaptureSpec as BackendCaptureSpec,
  SimCaptureBackend,
} from '../captureTypes.js';
import type { RendererIdentity } from '../../types.js';

import type { ContainerCaptureResult, ContainerCaptureSpec } from './captureJobBoundary.js';
import type { SimCaptureDriver } from './containerEntrypoint.js';

/** Output-relative directory the relocated frames land in. */
export const RELOCATED_FRAMES_DIR = 'frames';

/**
 * The ONE name a relocated clip may have. Previously the adapter kept `basename(result.clipPath)`,
 * so the artifact name in `result.json` was chosen by the in-container backend — and the trusted
 * side then resolved that name against its output directory. Normalising here means the trusted
 * side's allowlist (`ALLOWED_ARTIFACT_PATHS`) matches by construction rather than by agreement, and
 * one fewer string crosses the boundary carrying a filename's worth of freedom.
 */
export const RELOCATED_CLIP_FILE = 'section.mp4';

export interface BackendAdapterOptions {
  /** The capture-environment identity (image digest, headless-shell version, viewport, DPR). */
  rendererIdentity: RendererIdentity;
}

/** Turn this layer's `ContainerCaptureSpec` + loopback entry URL into the backend's `CaptureSpec`. */
export function toBackendSpec(spec: ContainerCaptureSpec, servedSimUrl: string): BackendCaptureSpec {
  return {
    servedSimUrl,
    sectionId: spec.sectionId,
    simpleUi: spec.startScript.simpleUi,
    autoScript: spec.startScript.autoScript,
    uiHide: spec.startScript.uiHide,
    durationSec: spec.durationSec,
    fps: spec.fps,
    width: spec.width,
    height: spec.height,
    // The backend seeds mulberry32 from this; a null hash means "no stable seed" → empty string.
    configHash: spec.configHash ?? '',
    posterKey: spec.posterKey ?? '',
  };
}

/**
 * Adapt a `SimCaptureBackend` into the container's `SimCaptureDriver`. The signal is honoured at the
 * CONTAINER level (the orchestrator `docker kill`s on the wall clock); the backend's `captureSection`
 * takes no signal, so this adapter cannot interrupt it mid-call — documented, not hidden.
 */
export function backendToDriver(backend: SimCaptureBackend, opts: BackendAdapterOptions): SimCaptureDriver {
  return {
    async drive({ entryUrl, spec, outputDir }): Promise<ContainerCaptureResult> {
      const result = await backend.captureSection(toBackendSpec(spec, entryUrl));
      const { framesDir, clipPath } = await relocateArtifacts(result, outputDir);
      return {
        resultVersion: 1,
        sectionId: spec.sectionId,
        // The container ran and produced a result; `gate` says whether the trusted side should trust it.
        status: 'ok',
        framesDir,
        clipPath,
        frameCount: result.frameCount,
        rendererString: result.rendererString,
        gate: result.gate,
        reason: result.reason ?? null,
        rendererIdentity: opts.rendererIdentity,
        failure: null,
      };
    },
  };
}

/**
 * Copy the backend's artifacts (which it wrote wherever it chose — the ephemeral tmpfs) onto the
 * /output bind mount, and return their OUTPUT-RELATIVE paths. Exactly one of framesDir/clipPath is
 * expected; both-null is tolerated (the caller records a zero-frame result).
 */
async function relocateArtifacts(
  result: BackendCaptureResult,
  outputDir: string,
): Promise<{ framesDir: string | null; clipPath: string | null }> {
  await mkdir(outputDir, { recursive: true });
  let framesDir: string | null = null;
  let clipPath: string | null = null;

  if (result.framesDir) {
    const dest = join(outputDir, RELOCATED_FRAMES_DIR);
    await cp(result.framesDir, dest, { recursive: true });
    framesDir = RELOCATED_FRAMES_DIR;
  }
  if (result.clipPath) {
    await copyFile(result.clipPath, join(outputDir, RELOCATED_CLIP_FILE));
    clipPath = RELOCATED_CLIP_FILE;
  }
  return { framesDir, clipPath };
}
