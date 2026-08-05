/**
 * Poster storage, checksums, invalidation and cleanup (Priority 5.5).
 *
 * WHAT A POSTER IS FOR
 * A poster is the still picture shown in place of a live simulation frame during the window where
 * showing the real frame would be wrong (the package has not acknowledged the configuration yet) or
 * pointless (there is not enough section time left to be worth a live bring-up). That substitution
 * only works if the poster shows what the live frame WOULD have shown — same variant, same
 * Minimal-UI state, same hidden controls, same initial camera, same aspect, same quality profile.
 * So a poster is keyed by the full presentation identity, never by the package
 * (shared/src/sim/posterIdentity.ts), and this service never invents or relaxes that key.
 *
 * THE TWO DIRECTIONS OF INCONSISTENCY ARE NOT SYMMETRIC
 * A DB row with no bytes behind it is a user-visible defect: the player resolves "this identity has
 * a poster", renders an <img>, and the viewer sees a broken image over their video. Bytes with no
 * row are invisible — they cost storage until the next sweep and nothing else. Every write here is
 * therefore ordered so that a crash at any point leaves the invisible failure, not the visible one:
 *
 *   store:      upload bytes, THEN insert the row
 *   invalidate: delete the rows, THEN delete the bytes
 *   cleanup:    delete the rows, THEN delete the bytes
 *
 * BLAST RADIUS
 * `invalidate` and `cleanupOrphans` are the only two operations in this product that delete storage
 * objects they did not individually name at the call site, so both are written to fail closed:
 * they refuse a prefix that is not clearly one simulation's own directory, they refuse to act on a
 * listing that errored, and they never delete an object whose path they could not parse back into
 * the identity it claims to be.
 */

import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { sim_posters } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { deleteWithFallback } from '../storage/deleteWithFallback.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';

import {
  POSTER_CONTENT_TYPES,
  formatsFor,
  parsePosterPath,
  parsePosterVariants,
  posterIdentityString,
  posterRootPrefix,
  posterStoragePath,
  type PosterFormat,
  type PosterKey,
  type PosterRecord,
  type PosterSizeName,
  type PosterVariantRecord,
} from 'shared/sim/posterIdentity';
import type { SimAspectProfile, SimQualityProfile } from 'shared/sim/simIdentity';

// ─── Inputs / results ─────────────────────────────────────────────────────────────────────────

/** One encoded image produced by the capture pass, ready to store. */
export interface PosterRendition {
  size: PosterSizeName;
  format: PosterFormat;
  bytes: Buffer;
  width: number;
  height: number;
  /** True when this image was captured over a transparent background. */
  transparent: boolean;
}

export interface StorePosterOptions {
  /**
   * When the picture was captured. Injected rather than read from the clock so that a capture that
   * takes minutes is stamped with the moment it was TAKEN, not the moment the upload finished —
   * the timestamp is used to reason about staleness against package edits.
   */
  capturedAt?: Date;
}

export interface InvalidateResult {
  /** Identities whose rows were removed. */
  deletedIdentities: string[];
  /** Storage keys that were deleted (or attempted — object deletion is best-effort). */
  deletedObjects: string[];
}

export interface CleanupResult {
  /** Storage keys deleted by this sweep. */
  deleted: string[];
  /** Storage keys deliberately left alone — live posters, and anything unrecognised. */
  kept: string[];
  /** Identities whose DB rows were removed because they are no longer live. */
  deletedIdentities: string[];
}

export interface CleanupOptions {
  /**
   * Permit a sweep with no live identities at all. Off by default: an empty `liveKeys` is
   * indistinguishable from a caller that failed to load its sections, and in that case the sweep
   * would delete every poster the package has. Posters are regenerable, so this is not data loss —
   * it is an unnecessary re-run of the (expensive) capture pass for every section.
   */
  allowEmptyLiveKeys?: boolean;
}

/**
 * Poster objects are content-addressed by identity: the path already contains the package revision,
 * the variant, the config hash, the aspect and the quality profile, so the bytes at a given path
 * never legitimately change. They can therefore be cached for a year and served from a CDN edge
 * without any revalidation, which is the entire point of having a poster.
 */
const POSTER_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const UPLOAD_ATTEMPTS = 3;

// ─── Service ──────────────────────────────────────────────────────────────────────────────────

export class PosterService {
  /**
   * Store every rendition of one poster identity and record it.
   *
   * Returns the persisted record (read back from the row that was written) rather than the record
   * that was intended, so a caller never reports success on a write the database rejected.
   */
  async storePoster(
    simulationId: string,
    storagePrefix: string,
    key: PosterKey,
    renditions: readonly PosterRendition[],
    opts: StorePosterOptions = {},
  ): Promise<PosterRecord> {
    assertNonEmpty(simulationId, 'simulationId');
    const prefix = assertSweepablePrefix(storagePrefix);
    assertValidKey(key);
    const transparent = validateRenditions(renditions);

    const identity = posterIdentityString(key);
    const capturedAt = opts.capturedAt ?? new Date();

    const variants: PosterVariantRecord[] = renditions.map((r) => ({
      size: r.size,
      format: r.format,
      path: posterStoragePath(prefix, key, r.size, r.format),
      checksum: sha256OfBytes(r.bytes),
      contentType: POSTER_CONTENT_TYPES[r.format],
      width: r.width,
      height: r.height,
      bytes: r.bytes.length,
    }));

    // Bytes first — see the ordering note at the top of the file. A failure here leaves whatever
    // renditions already landed as unreferenced objects at deterministic paths: a retry overwrites
    // them exactly (the path is a pure function of the identity) and a sweep collects them if the
    // capture is abandoned.
    for (let i = 0; i < variants.length; i++) {
      await this.uploadRendition(variants[i].path, renditions[i].bytes, variants[i].contentType);
    }

    const [row] = await db
      .insert(sim_posters)
      .values({
        simulation_id: simulationId,
        package_revision: key.packageRevision,
        variant_key: key.variantKey,
        config_hash: key.configHash,
        aspect_profile: key.aspectProfile,
        quality_profile: key.qualityProfile,
        identity,
        variants,
        transparent,
        captured_at: capturedAt,
      })
      .onConflictDoUpdate({
        target: [sim_posters.simulation_id, sim_posters.identity],
        set: {
          package_revision: key.packageRevision,
          variant_key: key.variantKey,
          config_hash: key.configHash,
          aspect_profile: key.aspectProfile,
          quality_profile: key.qualityProfile,
          variants,
          transparent,
          captured_at: capturedAt,
        },
      })
      .returning();

    if (!row) {
      throw new Error(`Poster row for ${identity} was not returned by the upsert — poster not recorded`);
    }
    return rowToRecord(row);
  }

  async getPoster(simulationId: string, key: PosterKey): Promise<PosterRecord | null> {
    assertNonEmpty(simulationId, 'simulationId');
    const identity = posterIdentityString(key);
    const row = await db.query.sim_posters.findFirst({
      where: and(eq(sim_posters.simulation_id, simulationId), eq(sim_posters.identity, identity)),
    });
    return row ? rowToRecord(row) : null;
  }

  async listPosters(simulationId: string): Promise<PosterRecord[]> {
    assertNonEmpty(simulationId, 'simulationId');
    const rows = await db.query.sim_posters.findMany({
      where: eq(sim_posters.simulation_id, simulationId),
    });
    return rows.map(rowToRecord);
  }

  /**
   * Revision-change invalidation: drop every poster of this simulation that belongs to a DIFFERENT
   * package revision than the one now current.
   *
   * This is the one invalidation that cannot be handled by the key alone. A new config, aspect or
   * quality mints a NEW identity and therefore simply has no poster yet — nothing stale is ever
   * reused. A new package revision does the same, but leaves the previous revision's posters behind
   * forever, because no future key will ever name them again.
   */
  async invalidate(simulationId: string, packageRevision: string): Promise<InvalidateResult> {
    assertNonEmpty(simulationId, 'simulationId');
    // An empty revision would make the `!=` predicate match every row: the caller would be asking
    // to delete every poster of the package while believing it was keeping the current ones.
    assertNonEmpty(packageRevision, 'packageRevision');

    const stale = await db.query.sim_posters.findMany({
      where: and(
        eq(sim_posters.simulation_id, simulationId),
        ne(sim_posters.package_revision, packageRevision),
      ),
    });
    if (stale.length === 0) return { deletedIdentities: [], deletedObjects: [] };

    const objects = stale.flatMap((row) => deletableVariantPaths(row.identity, row.variants));

    // Rows first: a row that outlives its bytes renders a broken image to a viewer, while bytes
    // that outlive their row are invisible and are collected by the next `cleanupOrphans`.
    await db.delete(sim_posters).where(
      inArray(
        sim_posters.id,
        stale.map((r) => r.id),
      ),
    );

    for (const path of objects) await deleteWithFallback(path);

    logger.info(
      { simulationId, packageRevision, identities: stale.length, objects: objects.length },
      '[posters] invalidated posters from superseded package revisions',
    );
    return { deletedIdentities: stale.map((r) => r.identity), deletedObjects: objects };
  }

  /**
   * Sweep poster objects that no live section configuration can ever ask for again.
   *
   * `liveKeys` is the authoritative set: every identity the package's current sections would
   * request. Anything else under the poster root is unreachable — an old config hash, an aspect the
   * section no longer uses, a revision that `invalidate` failed to finish.
   */
  async cleanupOrphans(
    simulationId: string,
    storagePrefix: string,
    liveKeys: readonly PosterKey[],
    opts: CleanupOptions = {},
  ): Promise<CleanupResult> {
    assertNonEmpty(simulationId, 'simulationId');
    const prefix = assertSweepablePrefix(storagePrefix);

    const live = new Set<string>();
    for (const key of liveKeys) {
      assertValidKey(key);
      live.add(posterIdentityString(key));
    }
    if (live.size === 0 && !opts.allowEmptyLiveKeys) {
      throw new Error(
        'Refusing to sweep posters with an empty liveKeys set — pass allowEmptyLiveKeys to delete every poster of this package deliberately',
      );
    }

    const root = posterRootPrefix(prefix);

    let keys: string[];
    try {
      keys = await getStorageAdapter().listObjects(root);
    } catch (err) {
      // A failed listing is an EMPTY listing as far as the code below is concerned, and an empty
      // listing looks exactly like "there is nothing to keep". Refuse rather than sweep blind.
      throw new Error(
        `Refusing to sweep posters under ${root} — listing failed: ${(err as Error).message ?? String(err)}`,
        { cause: err },
      );
    }

    const deleted: string[] = [];
    const kept: string[] = [];
    for (const objectKey of keys) {
      // Only ever act on keys the listing placed inside the root we asked about. An adapter that
      // returns keys outside the requested prefix is a bug, but not one that should be allowed to
      // widen a delete.
      if (!objectKey.startsWith(`${root}/`)) {
        kept.push(objectKey);
        continue;
      }
      const parsed = parsePosterPath(objectKey);
      if (!parsed) {
        // Not a poster path. It might be a future rendition format, a stray upload, or a directory
        // marker; whatever it is, this sweep does not know what it is FOR and must not remove it.
        kept.push(objectKey);
        continue;
      }
      if (live.has(parsed.identity)) kept.push(objectKey);
      else deleted.push(objectKey);
    }

    const orphanRows = (
      await db.query.sim_posters.findMany({ where: eq(sim_posters.simulation_id, simulationId) })
    ).filter((row) => !live.has(row.identity));

    // Rows first, for the same reason as `invalidate`.
    if (orphanRows.length > 0) {
      await db.delete(sim_posters).where(
        inArray(
          sim_posters.id,
          orphanRows.map((r) => r.id),
        ),
      );
    }

    for (const path of deleted) await deleteWithFallback(path);

    if (deleted.length > 0 || orphanRows.length > 0) {
      logger.info(
        { simulationId, root, deleted: deleted.length, kept: kept.length, rows: orphanRows.length },
        '[posters] swept orphaned posters',
      );
    }
    return { deleted, kept, deletedIdentities: orphanRows.map((r) => r.identity) };
  }

  /**
   * Cloud-only upload with retry, mirroring `uploadWithFallback`. It cannot BE `uploadWithFallback`
   * because that helper has no way to set Cache-Control, and a poster served with the bucket
   * default (`no-cache` on Supabase) is revalidated on every single section entry — which defeats
   * the one thing a poster is for, appearing instantly.
   */
  private async uploadRendition(path: string, bytes: Buffer, contentType: string): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < UPLOAD_ATTEMPTS; attempt++) {
      try {
        await getStorageAdapter().uploadFile(path, bytes, contentType, POSTER_CACHE_CONTROL);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < UPLOAD_ATTEMPTS - 1) {
          logger.warn(
            { path, attempt, err: (err as Error).message?.slice(0, 120) },
            '[posters] poster upload failed — retrying',
          );
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        }
      }
    }
    throw lastErr;
  }
}

export const posterService = new PosterService();

// ─── Helpers ──────────────────────────────────────────────────────────────────────────────────

/** Full 64-hex sha256 of the encoded bytes. Not truncated: this one proves bytes, not names. */
export function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`PosterService: ${field} is required`);
  }
}

/**
 * Accept only a prefix that is unambiguously ONE simulation's own directory.
 *
 * Everything this returns is fed to a recursive list-and-delete. `simulations` alone would sweep
 * every package in the product; `''` or `/` would sweep the bucket. A `..` segment cannot escape an
 * object-storage prefix, but it CAN on the local-disk adapter, which resolves keys against a base
 * directory. Requiring at least two segments is the cheap structural check that separates
 * "a specific thing" from "a whole tier".
 */
export function assertSweepablePrefix(storagePrefix: string): string {
  if (typeof storagePrefix !== 'string') {
    throw new Error('PosterService: storagePrefix must be a string');
  }
  const normalized = storagePrefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (normalized.length === 0) {
    throw new Error('PosterService: refusing to operate on an empty storage prefix');
  }
  const segments = normalized.split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) {
    throw new Error(`PosterService: refusing to operate on a storage prefix with empty or relative segments: ${storagePrefix}`);
  }
  if (segments.length < 2) {
    throw new Error(
      `PosterService: refusing to operate on the top-level prefix "${normalized}" — a poster sweep must be scoped to one simulation`,
    );
  }
  // Wildcards are meaningless as an S3 prefix but are expanded by some tooling and by the local
  // adapter's path join. A prefix containing one was not built by this codebase.
  if (/[*?]/.test(normalized)) {
    throw new Error(`PosterService: refusing to operate on a storage prefix containing wildcards: ${storagePrefix}`);
  }
  return normalized;
}

const ASPECTS: readonly SimAspectProfile[] = ['wide', 'standard', 'portrait', 'native'];
const QUALITIES: readonly SimQualityProfile[] = ['high', 'balanced', 'low'];

function assertValidKey(key: PosterKey): void {
  assertNonEmpty(key.packageRevision, 'key.packageRevision');
  assertNonEmpty(key.variantKey, 'key.variantKey');
  assertNonEmpty(key.configHash, 'key.configHash');
  if (!ASPECTS.includes(key.aspectProfile)) {
    throw new Error(`PosterService: unknown aspectProfile ${String(key.aspectProfile)}`);
  }
  if (!QUALITIES.includes(key.qualityProfile)) {
    throw new Error(`PosterService: unknown qualityProfile ${String(key.qualityProfile)}`);
  }
}

/**
 * Validate the rendition set and resolve the poster's single transparency flag.
 *
 * Transparency is a property of the CAPTURE, not of an individual encode, so a set that disagrees
 * about it describes two different pictures and there is no honest value to record. The
 * format restriction comes from `formatsFor`: a transparent poster is stored as PNG only, and
 * accepting anything else here would put a format in the row that the reader's preference order
 * was never told to expect.
 */
function validateRenditions(renditions: readonly PosterRendition[]): boolean {
  if (renditions.length === 0) {
    throw new Error('PosterService: a poster needs at least one rendition');
  }

  const transparent = renditions[0].transparent;
  const seen = new Set<string>();
  const allowed = formatsFor(transparent);

  for (const r of renditions) {
    if (r.transparent !== transparent) {
      throw new Error('PosterService: renditions disagree about transparency — they are not one capture');
    }
    const slot = `${r.size}/${r.format}`;
    if (seen.has(slot)) {
      throw new Error(`PosterService: duplicate rendition ${slot} — both would be stored at the same path`);
    }
    seen.add(slot);
    if (!allowed.includes(r.format)) {
      throw new Error(
        `PosterService: format ${r.format} is not permitted for a ${transparent ? 'transparent' : 'opaque'} poster`,
      );
    }
    if (!Buffer.isBuffer(r.bytes) || r.bytes.length === 0) {
      throw new Error(`PosterService: rendition ${slot} has no bytes`);
    }
    if (!Number.isInteger(r.width) || !Number.isInteger(r.height) || r.width <= 0 || r.height <= 0) {
      throw new Error(`PosterService: rendition ${slot} has invalid dimensions ${r.width}x${r.height}`);
    }
  }
  return transparent;
}

/**
 * Paths from a row are only deleted when the path still parses AND still claims the identity of the
 * row that carries it. Without both checks, `variants` — a JSONB blob — would be an arbitrary
 * delete primitive for anything that can write to the table.
 */
function deletableVariantPaths(identity: string, rawVariants: unknown): string[] {
  const out: string[] = [];
  for (const variant of parseVariants(rawVariants)) {
    const parsed = parsePosterPath(variant.path);
    if (!parsed || parsed.identity !== identity) {
      logger.warn(
        { identity, path: variant.path },
        '[posters] skipping delete of a variant path that does not belong to its identity',
      );
      continue;
    }
    out.push(variant.path);
  }
  return out;
}

/**
 * The stored-blob reader lives in `shared/src/sim/posterIdentity` because the player-config builder
 * reads the same rows on the serving path. Aliased rather than inlined at each call site so the two
 * readers provably share one validation, which is what stops an unvalidated `path` from an
 * arbitrary JSONB write reaching either a delete or a public URL.
 */
const parseVariants = parsePosterVariants;

interface PosterRowShape {
  identity: string;
  package_revision: string;
  variant_key: string;
  config_hash: string;
  aspect_profile: string;
  quality_profile: string;
  variants: unknown;
  transparent: boolean;
  captured_at: Date;
}

function rowToRecord(row: PosterRowShape): PosterRecord {
  return {
    key: {
      packageRevision: row.package_revision,
      variantKey: row.variant_key,
      configHash: row.config_hash,
      aspectProfile: row.aspect_profile as SimAspectProfile,
      qualityProfile: row.quality_profile as SimQualityProfile,
    },
    identity: row.identity,
    variants: parseVariants(row.variants),
    transparent: row.transparent,
    capturedAt: row.captured_at.toISOString(),
    packageRevision: row.package_revision,
  };
}
