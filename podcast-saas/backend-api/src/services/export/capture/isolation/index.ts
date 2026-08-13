/**
 * Export-capture isolation — the trusted-side orchestration around the untrusted capture container
 * (plan §0.2, made real). See md-files/EXPORT-CAPTURE-ISOLATION.md for the threat model, every
 * control and why, the container-verification checklist, and the deploy story.
 *
 * The public surface the trusted backend (ProjectExportService) and the container entrypoint import:
 *   • the loopback package server — serves the package from 127.0.0.1 so the container needs no network;
 *   • the hardened `docker run` arg assembler — the least-privilege runtime as a pinned flag set;
 *   • the trusted/untrusted boundary — a credential-free spec in, frames + result out;
 *   • the container entrypoint glue — wires the loopback server to the (injected) browser driver.
 */

export {
  LoopbackPackageServer,
  contentTypeForPath,
  PACKAGE_CACHE_CONTROL,
  type LoopbackPackageFile,
  type LoopbackPackageServerOptions,
} from './loopbackPackageServer.js';

export {
  buildContainerRunArgv,
  CONTAINER_MOUNTS,
  type ContainerRunSpec,
  type SandboxMechanism,
} from './containerRunArgs.js';

export {
  buildCaptureSpec,
  parseCaptureResult,
  readCaptureResult,
  writeCaptureInput,
  cleanupCaptureIo,
  expectedFrameCount,
  DockerCaptureBoundary,
  CAPTURE_SPEC_VERSION,
  CAPTURE_SPEC_FILENAME,
  CAPTURE_RESULT_FILENAME,
  FORBIDDEN_SPEC_KEY_SUBSTRINGS,
  type ContainerCaptureSpec,
  type ContainerCaptureResult,
  type CaptureStartScript,
  type CaptureOutputSpec,
  type CaptureIo,
  type CaptureInputFile,
  type CaptureJobBoundary,
  type DockerCaptureBoundaryConfig,
  type BuildCaptureSpecOptions,
} from './captureJobBoundary.js';

export {
  runContainerCapture,
  type SimCaptureDriver,
  type RunContainerCaptureDeps,
} from './containerEntrypoint.js';

export {
  backendToDriver,
  toBackendSpec,
  RELOCATED_FRAMES_DIR,
  type BackendAdapterOptions,
} from './backendAdapter.js';

export { readManifestFilesFromInput } from './packageInput.js';
