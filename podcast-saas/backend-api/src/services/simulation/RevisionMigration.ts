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
import {
  BRIDGE_CAPABILITIES_KEY,
  detectBridgeCapabilities,
  detectEntryCapabilities,
  type BridgeCapabilities,
} from 'shared/sim/bridgeCapability';
import { deriveEntryRelPath, getSimulationContentType } from './SimulationService.js';
import {
  SIM_MANIFEST_VERSION,
  normalizeManifestPath,
  type SimFileRole,
  type SimManifest,
  type SimManifestFile,
} from 'shared/sim/simManifest';
import { revisionIdFromKey, isSystemOwnedKey, PACKAGE_SUBDIR } from 'shared/sim/simRevision';

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
 *
 * THE PACKAGE MOVES AS ONE, PRESERVING ITS INTERNAL LAYOUT.
 *
 * `role` is metadata ABOUT a file, not a location FOR it. Hoisting runtime files into a sibling
 * `runtime/` directory moved them out from under the entry document's relative resolution: a legacy
 * package of `index.html` + `bridge.js` became `package/index.html` + `runtime/bridge.js`, so the
 * entry's `<script src="bridge.js">` resolved to `package/bridge.js` and every migrated package
 * loaded a 404 bridge. It published and validated green, because nothing in the manifest checks
 * that a relative reference still resolves. The same break hit any relative reference to
 * `guidance.js`, and the principle generalises: this migration copies bytes it did not author, so
 * it must not rearrange what those bytes point at.
 *
 * Nothing depended on the `runtime/` location — `manifest.runtime` is built from these very paths,
 * and `RUNTIME_SUBDIR` has no other consumer — so the role is still carried by the manifest entry
 * while the path stays faithful to the package the customer uploaded.
 */
export function revisionPathForLegacy(relPath: string, _role: SimFileRole): string {
  return `${PACKAGE_SUBDIR}/${relPath}`;
}

/** One legacy object, classified and mapped to where it lands inside a revision. */
export interface LegacyCopyPlanItem {
  /** The legacy storage key the bytes are read from. */
  key: string;
  /** Normalized prefix-relative path of the legacy object. */
  rel: string;
  role: SimFileRole;
  /** Manifest path inside the revision (`package/<rel>` — layout preserved). */
  revisionPath: string;
}

/**
 * Plan the FULL-PACKAGE copy of a legacy mutable prefix into a revision.
 *
 * Extracted from `publishLegacyAsRevision` so the LIVE generation path (migration-on-write in
 * `SimulationService.uploadSectionBridge`) copies a legacy package with EXACTLY the same
 * classification and layout rules as the operator migration — two copies of this logic would agree
 * until one changed, and then a live-published package would differ structurally from a migrated
 * one for no reason anyone chose.
 *
 * Pure over `allKeys` rather than listing storage itself: the live path may be running on a
 * storage token without ListBucket, where the caller's best available key set comes from the
 * entry-HTML reference probe — the plan must work over whatever keys the caller could actually see.
 *
 * Two exclusions, both deliberate:
 *   - keys inside ANY revision (`revisionIdFromKey`) — a revision must never be re-copied into a
 *     revision; and
 *   - system-owned subtrees (`isSystemOwnedKey`: `revisions/`, `posters/`) — captured posters are
 *     revision-scoped evidence, not customer package content, and republishing them as `package/`
 *     assets would bloat every future copy of the package forever.
 */
export function planLegacyCopy(opts: {
  allKeys: string[];
  prefix: string;
  entryRelPath: string;
}): { planned: LegacyCopyPlanItem[]; entry: LegacyCopyPlanItem | null } {
  const prefix = opts.prefix.replace(/\/+$/, '');
  const planned = opts.allKeys
    .filter((k) => k.startsWith(`${prefix}/`))
    .filter((k) => revisionIdFromKey(k) === null && !isSystemOwnedKey(k, prefix))
    .map((key) => {
      const rel = key.slice(prefix.length + 1);
      const norm = normalizeManifestPath(rel);
      return norm ? { key, rel: norm } : null;
    })
    .filter((x): x is { key: string; rel: string } => x !== null)
    .map(({ key, rel }) => {
      const role = roleForLegacyPath(rel, opts.entryRelPath);
      return { key, rel, role, revisionPath: revisionPathForLegacy(rel, role) };
    });
  return { planned, entry: planned.find((p) => p.role === 'entry') ?? null };
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
    // `planLegacyCopy` excludes every key inside a revision (a revision must never be re-copied
    // into a revision — after the first migration the listing includes every revision's own files)
    // and the system-owned subtrees (captured posters are not customer package content).
    const { planned, entry } = planLegacyCopy({ allKeys, prefix, entryRelPath });
    if (planned.length === 0) return { ...base, skipped: 'no-files' };

    if (!entry) {
      return { ...base, skipped: 'no-entry-path', error: `entry ${entryRelPath} not present under ${prefix}` };
    }

    if (opts.dryRun) {
      return { ...base, filesCopied: planned.length, entryPath: entry.revisionPath };
    }

    // CLASSIFY THE PACKAGE WHILE WE HAVE ITS BYTES (P0.5 bridge ack, P0.8 import maps).
    //
    // The apply gate holds a painted document until the requested section acknowledges, and it can
    // only skip that hold for a package RECORDED as unable to acknowledge. A revision published
    // without that record reads as UNKNOWN, which is the cautious answer — a bounded cover instead
    // of a possibly-wrong reveal — but for a legacy package that genuinely never acks, the cover is
    // the one it will show on every entry, forever, until someone republishes it.
    //
    // This migration is copying the very bytes that answer the question, so it answers it. Reading
    // bridge.js once more here is a rounding error against a migration that reads every file in the
    // package, and it converts most of the unknown population at the moment it is already being
    // rewritten. A package with no bridge at all records nothing and stays honestly unknown.
    const bridgeItem = planned.find((p) => p.role === 'runtime' && /(^|\/)bridge\.js$/i.test(p.rel));
    let capabilities: Partial<BridgeCapabilities> | undefined;
    if (bridgeItem) {
      try {
        capabilities = detectBridgeCapabilities((await this.storage.readObject(bridgeItem.key)).toString('utf-8'));
      } catch (err) {
        // Unreadable here means unreadable in the copy loop below, which will fail the migration
        // properly. Recording nothing keeps the answer UNKNOWN rather than guessing `false`.
        logger.warn({ err, key: bridgeItem.key }, 'revision migration: bridge unreadable for capability detection');
      }
    }

    // THE SAME ARGUMENT, ASKED OF THE ENTRY DOCUMENT (P0.8).
    //
    // A legacy package that resolves `three` through `<script type="importmap">` cannot paint at
    // all on Safari/iOS 16.3 or older, and until the requirement is recorded the viewer has no way
    // to know it should show the poster instead of a frame that will stay blank forever. The entry
    // bytes are in hand here for the same reason the bridge's are, so the same question gets the
    // same treatment — including its failure mode: an unreadable entry records NOTHING and stays
    // honestly UNKNOWN, because a guessed `false` is the blank frame in a nicer costume.
    //
    // The two detections are INDEPENDENT. A package with no bridge still has an entry document, and
    // its import-map answer is worth just as much on its own.
    try {
      const entryHtml = (await this.storage.readObject(entry.key)).toString('utf-8');
      capabilities = { ...capabilities, ...detectEntryCapabilities(entryHtml) };
    } catch (err) {
      logger.warn({ err, key: entry.key }, 'revision migration: entry unreadable for capability detection');
    }

    const draft = await this.revisions.createDraft({
      simulationId: sim.id,
      createdBy: opts.createdBy ?? 'revision-migration',
      metadata: {
        migratedFromLegacyPrefix: prefix,
        legacyBridgeHash: sim.bridge_hash,
        ...(capabilities ? { [BRIDGE_CAPABILITIES_KEY]: capabilities } : {}),
      },
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
  /** Who produced this revision — defaults to the operator migration. */
  createdBy?: string;
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
    createdBy: opts.createdBy ?? 'revision-migration',
  };
}
