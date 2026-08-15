/**
 * The TRUSTED DEPENDENCY REGISTRY — the only place capture dependency bytes come from.
 *
 * The capture container has no network by design, so a simulation's CDN import map cannot resolve
 * inside it (the v0.1.26 incident: dead canvas, empty renderer string, gate correctly failing).
 * The answer is not to open the network; it is to materialise those modules from a pack that was
 * pinned, vendored and hash-recorded on the TRUSTED side, long before any untrusted code runs.
 *
 * Three properties this file is responsible for:
 *
 *  1. IMMUTABILITY — a pack is `name@version` with per-file SHA-256. Bytes are read from the
 *     repository (they ship inside the backend image), never fetched. `latest` does not exist here.
 *  2. INTEGRITY — every file is verified against `registry.json` on load. A drifted checkout or a
 *     tampered vendor tree fails CLOSED, loudly, before anything is staged. Capturing "three, some
 *     version" would silently change what the product renders.
 *  3. BOUNDEDNESS — a pack cannot grow without limit into every capture job's input mount.
 *
 * The registry knows nothing about any particular simulation. Adding a library or a version is a
 * data change (`vendor/sim-deps/build-pack.mjs` + a commit), never an edit to the capture provider.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TrustedDependencyDescriptor } from 'shared/sim/captureDependencies';

import { logger } from '../../../../lib/logger.js';

/** Caps on one pack's materialisation, so a vendored dependency can never dominate a capture job. */
export const MAX_VENDOR_FILES = 400;
export const MAX_VENDOR_TOTAL_BYTES = 32 * 1024 * 1024;
export const MAX_VENDOR_FILE_BYTES = 8 * 1024 * 1024;

export interface VendoredFile {
  /** Path RELATIVE to the staged package root (`__flowvid_vendor/three/0.169.0/build/three.module.js`). */
  path: string;
  content: Buffer;
}

interface RegistryFile {
  registryVersion: number;
  packs: TrustedDependencyDescriptor[];
}

/**
 * Locate `vendor/sim-deps` by walking up from this module.
 *
 * Deliberately not `process.cwd()`: the worker, the test runner and the one-off diagnostic all run
 * with different working directories, and a registry that resolves in one and not the others is a
 * capture that silently loses its dependencies in production. Walking from the module works
 * identically for `src/**` under tsx and `dist/**` under node.
 */
function findVendorRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'vendor', 'sim-deps');
    if (existsSync(join(candidate, 'registry.json'))) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cached: Promise<TrustedDependencyRegistry> | null = null;

/**
 * The loaded, integrity-verified registry. Files are read lazily (per pack, on first use) but their
 * DECLARED integrity is loaded up front, so a malformed registry is a startup-shaped failure rather
 * than a mid-capture one.
 */
export class TrustedDependencyRegistry {
  constructor(
    private readonly root: string,
    readonly packs: readonly TrustedDependencyDescriptor[],
  ) {}

  /** Every descriptor, for the closure planner. */
  descriptors(): readonly TrustedDependencyDescriptor[] {
    return this.packs;
  }

  /**
   * Read one pack's files, VERIFYING every byte against the recorded hash, and return them at their
   * staged (package-root-relative) paths. Any mismatch, missing file or breached cap throws.
   */
  async materialise(descriptor: TrustedDependencyDescriptor): Promise<VendoredFile[]> {
    const entries = Object.entries(descriptor.files);
    if (entries.length > MAX_VENDOR_FILES) {
      throw new Error(
        `trusted dependency ${descriptor.name}@${descriptor.version}: ${entries.length} files exceeds the ${MAX_VENDOR_FILES} cap`,
      );
    }
    const prefix = `${'__flowvid_vendor'}/${descriptor.name}/${descriptor.version}/`;
    const out: VendoredFile[] = [];
    let total = 0;
    for (const [relative, meta] of entries) {
      if (meta.bytes > MAX_VENDOR_FILE_BYTES) {
        throw new Error(
          `trusted dependency ${descriptor.name}@${descriptor.version}: ${relative} is ${meta.bytes} bytes, over the per-file cap`,
        );
      }
      const abs = join(this.root, descriptor.name, descriptor.version, relative);
      let content: Buffer;
      try {
        content = await readFile(abs);
      } catch {
        throw new Error(
          `trusted dependency ${descriptor.name}@${descriptor.version}: vendored file missing on disk: ${relative}`,
        );
      }
      const actual = createHash('sha256').update(content).digest('hex');
      if (actual !== meta.sha256) {
        // The supply-chain assertion. Capturing different bytes under the same dependency identity
        // is exactly the failure pinning exists to prevent, so this is fatal, never a warning.
        throw new Error(
          `trusted dependency ${descriptor.name}@${descriptor.version}: integrity mismatch for ${relative} ` +
            `(expected ${meta.sha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)`,
        );
      }
      total += content.byteLength;
      if (total > MAX_VENDOR_TOTAL_BYTES) {
        throw new Error(
          `trusted dependency ${descriptor.name}@${descriptor.version}: exceeds the ${MAX_VENDOR_TOTAL_BYTES}-byte pack cap`,
        );
      }
      out.push({ path: `${prefix}${relative}`, content });
    }
    return out;
  }
}

/** An empty registry — the honest state when no vendor pack ships with this build. */
const EMPTY = new TrustedDependencyRegistry('', []);

/** Load (and cache) the registry. Never throws: a missing pack degrades to "nothing is trusted". */
export function loadTrustedRegistry(): Promise<TrustedDependencyRegistry> {
  cached ??= (async () => {
    const root = findVendorRoot();
    if (!root) {
      logger.warn('export(deps): no vendor/sim-deps registry found — no external dependency can be satisfied offline');
      return EMPTY;
    }
    try {
      const raw = await readFile(join(root, 'registry.json'), 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed.registryVersion !== 1 || !Array.isArray(parsed.packs)) {
        throw new Error(`unsupported registryVersion ${String(parsed.registryVersion)}`);
      }
      logger.info(
        { packs: parsed.packs.map((p) => `${p.name}@${p.version}`) },
        'export(deps): trusted dependency registry loaded',
      );
      return new TrustedDependencyRegistry(root, parsed.packs);
    } catch (err) {
      logger.error({ err }, 'export(deps): trusted dependency registry is unreadable — treating as empty');
      return EMPTY;
    }
  })();
  return cached;
}

/** Test seam: forget the cached registry. */
export function resetTrustedRegistryCache(): void {
  cached = null;
}
