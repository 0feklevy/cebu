/**
 * The PRODUCTION plugin contract, tested through the PRODUCTION machinery — no mocked
 * approximation. `loadBackend()` (the real function `main.ts` runs in the container) is pointed at
 * the REAL configured backend module and must come back with a usable `SimCaptureBackend`.
 *
 * THE INCIDENT THIS PINS (v0.1.22): the export-worker image named
 * `dist/services/export/capture/beginFrameBackend.js` in EXPORT_CAPTURE_BACKEND_MODULE, but that
 * module never exported `createBackend()` nor a default — every capture container exited 1 with
 * "exports neither createBackend() nor a default backend" BEFORE any capture code ran, and all 11
 * sim windows degraded. TypeScript could not catch it (a variable dynamic-import specifier is
 * untyped) and no test imported the real module through the real loader — this one does.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadBackend } from '../main.js';
import { backendToDriver } from '../backendAdapter.js';

/**
 * The module the PRODUCTION IMAGE configures — DERIVED from the Dockerfile's
 * `ENV EXPORT_CAPTURE_BACKEND_MODULE`, never hardcoded here. That derivation is the point: a
 * hardcoded path would keep testing `beginFrameBackend` while the image quietly pointed somewhere
 * else, which is precisely the drift class that produced v0.1.22.
 */
const DOCKERFILE = new URL('../../../../../../../deploy/docker/export-worker.Dockerfile', import.meta.url);
const PRODUCTION_BACKEND_MODULE = (() => {
  const text = readFileSync(DOCKERFILE, 'utf8');
  const distPath = /ENV EXPORT_CAPTURE_BACKEND_MODULE=(\S+)/.exec(text)?.[1];
  if (!distPath) throw new Error('export-worker.Dockerfile does not set EXPORT_CAPTURE_BACKEND_MODULE');
  // dist/<path>.js in the image ⇔ src/<path>.ts in this tree. From …/capture/isolation/__tests__/,
  // five levels up is …/backend-api/src.
  const srcRelative = distPath.replace('/app/backend-api/dist/', '').replace(/\.js$/, '.ts');
  return new URL(`../../../../../${srcRelative}`, import.meta.url).href;
})();

const ENV_KEY = 'EXPORT_CAPTURE_BACKEND_MODULE';
const savedEnv = process.env[ENV_KEY];
let scratch: string | null = null;

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('loadBackend × the configured production module (the v0.1.22 contract)', () => {
  it('loads the REAL backend module via the REAL loader and gets a usable SimCaptureBackend', async () => {
    process.env[ENV_KEY] = PRODUCTION_BACKEND_MODULE;
    const backend = await loadBackend();
    expect(typeof backend.captureSection).toBe('function');
    expect(typeof backend.isAvailable).toBe('function');
    expect(typeof backend.name).toBe('string');
    expect(backend.name.length).toBeGreaterThan(0);
  });

  it('the loaded backend is accepted by backendToDriver (the adapter main.ts feeds it to)', async () => {
    process.env[ENV_KEY] = PRODUCTION_BACKEND_MODULE;
    const backend = await loadBackend();
    const driver = backendToDriver(backend, {
      rendererIdentity: {
        imageDigest: 'test', headlessShellVersion: 'test', viewport: { w: 1920, h: 1080 }, dpr: 1,
      },
    });
    expect(typeof driver.drive).toBe('function');
  });
});

describe('loadBackend — adversarial mutations (each must FAIL loudly, not layers later)', () => {
  /** Write a throwaway ESM module and point the loader at it. Real dynamic import, no mocks. */
  async function loadFromSource(source: string): Promise<ReturnType<typeof loadBackend>> {
    scratch = await mkdtemp(join(tmpdir(), 'backend-contract-'));
    const file = join(scratch, 'backend.mjs');
    await writeFile(file, source, 'utf8');
    process.env[ENV_KEY] = pathToFileURL(file).href;
    return loadBackend();
  }

  it('Mutation A — a module with unrelated named exports and NO factory: the exact production error', async () => {
    await expect(
      loadFromSource('export const somethingElse = 1; export function helper() {}'),
    ).rejects.toThrow(/exports neither createBackend\(\) nor a default backend/);
  });

  it('Mutation C — factory returns {}: refused immediately with a clear contract error', async () => {
    await expect(
      loadFromSource('export function createBackend() { return {}; }'),
    ).rejects.toThrow(/captureSection/);
  });

  it('factory returns null: refused immediately', async () => {
    await expect(
      loadFromSource('export function createBackend() { return null; }'),
    ).rejects.toThrow(/returned|captureSection/);
  });

  it('default export is a CLASS (constructor, not an instance/factory): classified, not a late TypeError', async () => {
    await expect(
      loadFromSource('export default class NotABackend { captureSection() {} }'),
    ).rejects.toThrow(/factory|captureSection|constructor|class/i);
  });

  it('Mutation D — factory throws: the failure is surfaced with its own message, not swallowed', async () => {
    await expect(
      loadFromSource('export function createBackend() { throw new Error("boom-from-factory"); }'),
    ).rejects.toThrow(/boom-from-factory/);
  });

  it('unset EXPORT_CAPTURE_BACKEND_MODULE: refused with the documented message', async () => {
    delete process.env[ENV_KEY];
    await expect(loadBackend()).rejects.toThrow(/EXPORT_CAPTURE_BACKEND_MODULE is not set/);
  });
});
