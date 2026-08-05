/**
 * Publishing an existing legacy package as its first immutable revision (Priority 7.7).
 *
 * WHAT THIS IS AND IS NOT
 * This COPIES a simulation's current mutable prefix into a revision prefix and verifies it. It does
 * NOT activate. Activation is a separate, explicitly-gated call, because the moment a simulation
 * gains an active revision its identity axis changes — `packageRevisionFor` switches from
 * `sha256(simId ∥ bridgeHash)` to `sha256('rev' ∥ revisionId)` — and every `sim_posters` row for
 * that package is keyed on the OLD value. The poster lookup deliberately has no fallback, so
 * activating before posters have been re-captured renders every section of that package posterless.
 * Separating publish from activate is what lets a canary + poster capture run in between.
 *
 * COPY, NEVER MOVE
 * The legacy objects are left exactly where they are. Migration 050's rollback reverts every
 * simulation to that path, and it has to still hold a servable package. There is also no
 * CopyObject in the storage interface, so a copy is readObject + uploadFile — the full bytes
 * through the Node heap, one file at a time. That is slow and memory-shaped for image-heavy
 * packages, which is why this is a script and not a request handler.
 *
 * THE ENTRY PATH IS THE SHARP EDGE
 * `simulations.entry_file` has two historical shapes — a bare storage key on new rows, a full URL on
 * legacy ones — which is why `deriveEntryRelPath` exists. A revision whose `entry_path` is NULL is
 * unactivatable (the promote CAS requires it), and that failure would otherwise surface only AFTER
 * every byte had been copied. So it is resolved and rejected up front.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { simulations } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import type { StorageService } from '../storage/StorageService.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { RevisionService } from './RevisionService.js';
import { deriveEntryRelPath, getSimulationContentType } from './SimulationService.js';
import {
  SIM_MANIFEST_VERSION,
  normalizeManifestPath,
  type SimFileRole,
  type SimManifest,
  type SimManifestFile,
} from 'shared/sim/simManifest';
import { revisionIdFromKey } from 'shared/sim/simRevision';

export interface MigrationResult {
  simulationId: string;
  revisionId: string | null;
  revisionNumber: number | null;
  filesCopied: number;
  bytesCopied: number;
  entryPath: string | null;
  /** Present when the migration refused or failed. Nothing was activated either way. */
  error?: string;
  skipped?: 'already-migrated' | 'no-files' | 'no-entry-path';
}

/**
 * Classify one legacy object by its manifest-relative path.
 *
 * The generated runtime is recognised by name because that is how it is written today; everything
 * else is customer content. Getting this wrong is not cosmetic — `role` decides the Cache-Control a
 * file is stored with, and mislabelling the entry document as an asset would have it served
 * immutable despite the serve-time boot-snippet injection.
 */
export function roleForLegacyPath(relPath: string, entryRelPath: string): SimFileRole {
  if (relPath === entryRelPath) return 'entry';
  if (/^(runtime\/)?(bridge|guidance)\.js$/i.test(relPath)) return 'runtime';
  return 'asset';
}

/**
 * Where a legacy file lands inside the revision.
 *
 * Customer bytes are nested under `package/` so a customer file called `manifest.json`, or a
 * customer directory called `runtime`, cannot shadow ours. That has to be structural: a name-based
 * guard would be a denylist, and the customer chooses the names.
 */
export function revisionPathForLegacy(relPath: string, role: SimFileRole): string {
  if (role === 'runtime') return relPath.startsWith('runtime/') ? relPath : `runtime/${relPath}`;
  return `package/${relPath}`;
}

export class RevisionMigration {
  constructor(
    private readonly storage: StorageService = getStorageAdapter(),
    private readonly revisions: RevisionService = new RevisionService(storage),
  ) {}

  /**
   * Publish a simulation's current bytes as a new revision. Never activates.
   *
   * `dryRun` walks and classifies every object and reports exactly what would be written, without
   * creating a draft or uploading anything — so an operator can see the file list, the entry path
   * and the role assignment before committing a single byte.
   */
  async publishLegacyAsRevision(opts: {
    simulationId: string;
    createdBy?: string;
    dryRun?: boolean;
    /** Re-publish even if the simulation already has an active revision. Off by default. */
    force?: boolean;
  }): Promise<MigrationResult> {
    const base: MigrationResult = {
      simulationId: opts.simulationId, revisionId: null, revisionNumber: null,
      filesCopied: 0, bytesCopied: 0, entryPath: null,
    };

    const [sim] = await db
      .select({
        id: simulations.id,
        storage_prefix: simulations.storage_prefix,
        entry_file: simulations.entry_file,
        bridge_hash: simulations.bridge_hash,
        active_revision_id: simulations.active_revision_id,
      })
      .from(simulations)
      .where(eq(simulations.id, opts.simulationId));
    if (!sim) return { ...base, error: 'simulation not found' };

    if (sim.active_revision_id && !opts.force) {
      return { ...base, skipped: 'already-migrated' };
    }

    const prefix = sim.storage_prefix.replace(/\/+$/, '');

    // Resolve the entry path BEFORE copying anything. A revision with a NULL entry_path is
    // unactivatable, and discovering that after copying a 200 MB package is a waste that also
    // leaves uncollected bytes behind.
    const entryRelPath = deriveEntryRelPath(sim.entry_file, prefix);
    if (!entryRelPath) {
      return { ...base, skipped: 'no-entry-path', error: `cannot derive entry path from ${sim.entry_file}` };
    }

    const allKeys = await this.storage.listObjects(prefix);
    // Never re-copy a revision into a revision. `listObjects` on the simulation prefix returns
    // everything beneath it, which after the first migration includes every revision's own files.
    const legacyKeys = allKeys.filter((k) => revisionIdFromKey(k) === null);
    if (legacyKeys.length === 0) return { ...base, skipped: 'no-files' };

    const planned = legacyKeys
      .map((key) => {
        const rel = key.slice(prefix.length + 1);
        const norm = normalizeManifestPath(rel);
        return norm ? { key, rel: norm } : null;
      })
      .filter((x): x is { key: string; rel: string } => x !== null)
      .map(({ key, rel }) => {
        const role = roleForLegacyPath(rel, entryRelPath);
        return { key, rel, role, revisionPath: revisionPathForLegacy(rel, role) };
      });

    const entry = planned.find((p) => p.role === 'entry');
    if (!entry) {
      return { ...base, skipped: 'no-entry-path', error: `entry ${entryRelPath} not present under ${prefix}` };
    }

    if (opts.dryRun) {
      return { ...base, filesCopied: planned.length, entryPath: entry.revisionPath };
    }

    const draft = await this.revisions.createDraft({
      simulationId: sim.id,
      createdBy: opts.createdBy ?? 'revision-migration',
      metadata: { migratedFromLegacyPrefix: prefix, legacyBridgeHash: sim.bridge_hash },
    });
    const uploading = await this.revisions.beginUpload(sim.id, draft.id);

    const files: SimManifestFile[] = [];
    let bytesCopied = 0;
    try {
      for (const p of planned) {
        const bytes = await this.storage.readObject(p.key);
        files.push(await this.revisions.writeFile(uploading, prefix, {
          manifestPath: p.revisionPath,
          bytes,
          contentType: getSimulationContentType(p.key),
          role: p.role,
        }));
        bytesCopied += bytes.length;
      }
    } catch (err) {
      await this.revisions.markFailed(sim.id, draft.id, 'uploading', String(err).slice(0, 500))
        .catch(() => undefined);
      return { ...base, revisionId: draft.id, revisionNumber: draft.revisionNumber, error: String(err) };
    }

    const validating = await this.revisions.finishUpload(sim.id, draft.id);
    const manifest = buildLegacyManifest({
      sim: { id: sim.id, projectId: projectIdFromPrefix(prefix) },
      revisionId: draft.id,
      revisionNumber: draft.revisionNumber,
      entryPath: entry.revisionPath,
      files,
    });

    const res = await this.revisions.validate(sim.id, validating, prefix, { manifest });
    if (!res.ok) {
      return {
        ...base, revisionId: draft.id, revisionNumber: draft.revisionNumber,
        filesCopied: files.length, bytesCopied, entryPath: entry.revisionPath,
        error: JSON.stringify({ manifest: res.problems, storage: res.verified.problems }).slice(0, 1000),
      };
    }

    logger.info(
      { simulationId: sim.id, revisionId: draft.id, files: files.length, bytes: bytesCopied,
        bytesVerified: res.verified.bytesVerified, metadataUnverified: res.verified.metadataUnverified },
      'published legacy package as revision (NOT activated)',
    );

    return {
      simulationId: sim.id, revisionId: draft.id, revisionNumber: draft.revisionNumber,
      filesCopied: files.length, bytesCopied, entryPath: entry.revisionPath,
    };
  }
}

/**
 * The project id, recovered from the canonical storage prefix.
 *
 * Only used to populate a descriptive manifest field. It is not load-bearing — nothing resolves a
 * path from it — so an unrecognised prefix yields an empty string rather than failing a migration
 * over a cosmetic value.
 */
export function projectIdFromPrefix(prefix: string): string {
  const seg = prefix.split('/');
  return seg[0] === 'simulations' && seg[1] ? seg[1] : '';
}

/**
 * A manifest for a package that was built before manifests existed.
 *
 * `variants` gets a single `main` entry: the legacy package has no per-section variant structure to
 * recover, and an EMPTY variants list fails validation ("a package with no variants serves
 * nothing"). Recording one honest placeholder is better than inventing per-section entries that no
 * canary has confirmed.
 */
export function buildLegacyManifest(opts: {
  sim: { id: string; projectId: string };
  revisionId: string;
  revisionNumber: number;
  entryPath: string;
  files: SimManifestFile[];
}): SimManifest {
  return {
    manifestVersion: SIM_MANIFEST_VERSION,
    simulationId: opts.sim.id,
    projectId: opts.sim.projectId,
    revisionId: opts.revisionId,
    revisionNumber: opts.revisionNumber,
    // Unknown for a legacy package: the bytes predate the versioned runtime, and claiming a version
    // we did not observe would put a false statement in the one document meant to be authoritative.
    bridgeProtocolVersion: 0,
    runtimeProtocolVersion: 0,
    entry: opts.entryPath,
    runtime: opts.files.filter((f) => f.role === 'runtime').map((f) => f.path),
    files: opts.files,
    variants: [{ variantKey: 'main', configHashes: [] }],
    posters: [],
    qualityProfiles: ['high'],
    externalDependencies: [],
    generatedFrom: {},
    canary: { classification: null, ranAt: null, engine: null },
    createdAt: new Date().toISOString(),
    createdBy: 'revision-migration',
  };
}
