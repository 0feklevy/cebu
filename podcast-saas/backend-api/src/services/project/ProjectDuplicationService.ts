/**
 * Duplicate a project into a fully independent working copy (plan §8).
 *
 * ORDERING — WHY IT IS THIS AND NOT ANYTHING ELSE
 * Rows are transactional; bytes are not. So the run is:
 *
 *   1. SNAPSHOT   read every source row once, outside any transaction
 *   2. PLAN       allocate every new id and every destination key, in memory
 *   3. COPY       write the bytes into the (not-yet-referenced) destination keys
 *   4. COMMIT     insert the whole row graph in ONE transaction, in FK order
 *   5. ASSERT     re-read the copy and prove no reference escapes it
 *
 * A failure anywhere before step 4 leaves orphan objects at deterministic keys — reapable, and
 * harmless because nothing points at them — and NO project. A failure inside step 4 rolls back the
 * same way. The inverse ordering (rows first) would produce a project whose media 404s, which is
 * indistinguishable to a viewer from data loss. This is the ordering `RevisionService` and
 * `PosterService` already use, for the same reason.
 *
 * THE THREE HARD PARTS (plan §8.1)
 *  1. CROSS-ROW IDENTITY. `timeline_sections` references video files, simulations, and three
 *     separate clip sources; `branch_edges` reference choice points and sequences; `video_files`
 *     reference sequences. One `IdAllocator` is threaded through every step, `requireInternal`
 *     throws rather than letting an unmapped id pass through, and step 5 re-reads the committed
 *     rows and proves it. There is no path where an unmapped id becomes a stored reference.
 *  2. STORAGE IS NOT TRANSACTIONAL. See the ordering above.
 *  3. HLS RETENTION. The copy gets its OWN `hls/{newVideoFileId}/…` tree, copied byte for byte.
 *     Referencing the source's tree would be cheaper and wrong: a later re-transcode of the
 *     ORIGINAL retires that tree, `sweepRetiredHlsRuns` deletes it after the grace window, and the
 *     copy stops playing for a reason nobody would ever trace back to here. Refcounting shared
 *     media is exactly the complexity P0.3 declined.
 */

import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../../db/index.js';
import {
  audio_files, avatar_visuals, branch_choice_points, branch_edges, branch_sequences,
  camera_plans, corpora, image_files, project_duplications, projects, scenes, scripts,
  sim_posters, sim_revisions, simulations, timeline_markers, timeline_sections, video_files,
  branch_path_events, collaborators, course_lessons, playlist_items, token_usage,
  video_generation_jobs, jobs, avatar_conversations, audio_renders, project_redirect_targets,
  billing_transactions, user_purchases,
} from '../../db/schema.js';
import type { StorageService } from '../storage/StorageService.js';
import { getStorageAdapter } from '../storage/getStorageAdapter.js';
import { logger } from '../../lib/logger.js';
import { normalizePrefix } from '../storage/prefixScope.js';
import { MULTIPART_COPY_MAX_BYTES } from '../storage/s3Copy.js';
import {
  IdAllocator, PACKAGE_ROOT_EXCLUDED_SUBDIRS, freshSiblingKey, mapStorageKey, rebaseUrl,
  rerootUrlThroughCopies, rewriteKeyByIds, rewriteSectionParam,
  duplicatedMetadataStatus, duplicatedProjectStatus, duplicatedTitle,
  type DuplicationPlan, type StorageCopy,
} from './duplicationPlan.js';
import { bridgeAckCapableFromMetadata, requiresImportMapsFromMetadata } from 'shared/sim/bridgeCapability';
import { packageRevisionFor } from 'shared/sim/simRevision';
import { derivePackageRevision } from 'shared/sim/simIdentity';
import {
  parsePosterVariants, posterIdentityString, posterStoragePath,
  type PosterKey, type PosterVariantRecord,
} from 'shared/sim/posterIdentity';
import type { SimAspectProfile, SimQualityProfile } from 'shared/sim/simIdentity';

// ── Tuning ────────────────────────────────────────────────────────────────────────────────────

/**
 * The byte ceiling a duplication refuses above.
 *
 * There is no plan-limit system in this product to hook into — no storage quota, no per-tier caps,
 * nothing that maps a user to an allowance (the only quota that exists counts LLM calls). Rather
 * than invent one, this is a flat guard rail against the pathological case: duplicating a
 * multi-hundred-gigabyte project, twice, by accident. It is compared against
 * `DuplicationPlan.estimatedBytes`, which is a FLOOR, so the guard errs towards allowing.
 * Answering §8.4 Q4: hard refuse, because there is no billing relationship to fall back on.
 */
export const DUPLICATE_MAX_BYTES_DEFAULT = 50 * 1024 * 1024 * 1024;

export function duplicateMaxBytes(env: string | undefined = process.env.PROJECT_DUPLICATE_MAX_BYTES): number {
  if (env === undefined || env.trim() === '') return DUPLICATE_MAX_BYTES_DEFAULT;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : DUPLICATE_MAX_BYTES_DEFAULT;
}

/** How often the runner writes progress back to the job row while copying. */
const PROGRESS_EVERY = 25;

/**
 * How often a LIVE run touches its job row, and how long a row may go untouched before it is
 * declared dead.
 *
 * WHY A ROW HAS TO BE ABLE TO DIE
 * `project_duplicate` runs on the inline driver — no durability, no retries — and shutdown drains
 * for 25 seconds against a copy the UI itself says takes minutes. So a deploy, a crash or an OOM
 * mid-copy leaves the row stuck in `copying` forever. Migration 056's partial unique index on
 * `(source_project_id) WHERE status IN ('queued','copying','committing')` then makes that dead row
 * BLOCK every future duplication of the project, and the endpoint hands the client the dead row
 * with `already_running: true`, which the poll follows forever at frozen progress. Nothing in the
 * system reaped it. So the row has to be able to be recognised as dead, and the recognition has to
 * be something the next attempt can do for itself.
 *
 * THE RULE, AND WHY THE HEARTBEAT COMES WITH IT
 * "No write to `updated_at` for `DUPLICATION_STALE_AFTER_MS`" is only a safe liveness test if a
 * live run is GUARANTEED to write. Object-count progress is not that guarantee: it fires every 25
 * objects, and a plan of twenty very large masters can legitimately go far longer than any sane
 * window between two of them. So `run()` also beats a bare `updated_at` on a timer for as long as
 * it holds the row. Twenty missed beats before the row is considered abandoned.
 */
export const DUPLICATION_HEARTBEAT_MS = 15_000;
export const DUPLICATION_STALE_AFTER_MS = 20 * DUPLICATION_HEARTBEAT_MS;

/** The moment before which an in-flight duplication row is no longer believed to be running. */
export function duplicationStaleBefore(now: Date = new Date()): Date {
  return new Date(now.getTime() - DUPLICATION_STALE_AFTER_MS);
}

/** The in-flight statuses migration 056's partial unique index refuses a second row for. */
export const DUPLICATION_IN_FLIGHT_STATUSES = ['queued', 'copying', 'committing'] as const;

/** What a reaped run tells the user. Actionable, because the action is simply "try again". */
export const DUPLICATION_ABANDONED_MESSAGE =
  'The copy stopped before it finished (the server restarted). Nothing was created; you can start it again.';

/** A duplication that cannot proceed for a reason the caller should see, not a 500. */
export class DuplicationRefused extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'DuplicationRefused';
  }
}

// ── Snapshot ──────────────────────────────────────────────────────────────────────────────────

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

/** Every source row the copy is built from, read once. */
export interface DuplicationSnapshot {
  project: Row<typeof projects>;
  videoFiles: Row<typeof video_files>[];
  imageFiles: Row<typeof image_files>[];
  audioFiles: Row<typeof audio_files>[];
  sections: Row<typeof timeline_sections>[];
  markers: Row<typeof timeline_markers>[];
  sequences: Row<typeof branch_sequences>[];
  choicePoints: Row<typeof branch_choice_points>[];
  edges: Row<typeof branch_edges>[];
  sims: Row<typeof simulations>[];
  /** The ACTIVE revision of each simulation that has one. At most one per simulation. */
  activeRevisions: Row<typeof sim_revisions>[];
  posters: Row<typeof sim_posters>[];
  scripts: Row<typeof scripts>[];
  scenes: Row<typeof scenes>[];
  cameraPlans: Row<typeof camera_plans>[];
  corpora: Row<typeof corpora>[];
  avatarVisuals: Row<typeof avatar_visuals>[];
  /** table → rows that exist on the source and are deliberately not copied; null = not countable. */
  excludedCounts: Record<string, number | null>;
}

/**
 * What is deliberately left behind, and why. Kept as data rather than prose so the dry run can
 * report it and a test can assert the copy's side is empty for every one of them.
 */
const EXCLUSIONS: Readonly<Record<string, string>> = {
  branch_path_events:       'viewer analytics — belongs to the original\'s audience',
  sim_rum_events:           'field measurements, keyed by package revision, not by project',
  token_usage:              'billing/audit history of generations that happened to the original',
  billing_transactions:     'money that changed hands for the original',
  user_purchases:           'access grants people bought for the original',
  jobs:                     'in-flight work; the copy has none',
  video_generation_jobs:    'in-flight work; the copy has none',
  audio_renders:            'render job rows whose outputs are re-derivable; a copy starts unrendered',
  collaborators:            'access grants — the duplicator invites their own collaborators',
  project_redirect_targets: 'publication binding of the original\'s share links',
  course_lessons:           'publication binding — a copy is not published anywhere',
  playlist_items:           'publication binding — a copy is in no playlist',
  avatar_conversations:     'viewers\' conversations with the original',
};

/**
 * A plan plus everything derived alongside it that the commit needs.
 *
 * The posters travel WITH the plan rather than being recomputed at commit time. Re-deriving them
 * would work — the id allocator memoises, so the second derivation returns the same paths — but it
 * would be a second derivation of the destinations the byte copy already committed to, which is the
 * exact shape of mistake `mapStorageKey`'s doc comment argues against. One derivation, carried.
 */
export interface PlannedDuplication {
  plan: DuplicationPlan;
  ids: IdAllocator;
  posters: PlannedPoster[];
}

// ── Service ───────────────────────────────────────────────────────────────────────────────────

export class ProjectDuplicationService {
  constructor(private readonly storage: StorageService = getStorageAdapter()) {}

  // ─── 1. Snapshot ────────────────────────────────────────────────────────────────────────────

  /**
   * Read the whole source project. Returns null when it does not exist.
   *
   * Deliberately NOT inside a transaction: the byte copy that follows takes minutes, and holding a
   * read transaction open across it would pin the source's rows for the duration. The copy is
   * therefore "as of the moment you clicked" — an edit made to the source mid-copy is simply not in
   * it, which is the same guarantee every other snapshot-shaped operation in the product makes.
   */
  async loadSnapshot(sourceProjectId: string): Promise<DuplicationSnapshot | null> {
    const project = await db.query.projects.findFirst({ where: eq(projects.id, sourceProjectId) });
    if (!project) return null;

    const [
      videoFiles, imageFiles, audioFiles, sections, markers,
      sequences, choicePoints, edges, sims,
      scriptRows, sceneRows, cameraPlanRows, corpusRows, avatarVisualRows,
    ] = await Promise.all([
      db.select().from(video_files).where(eq(video_files.project_id, sourceProjectId)),
      db.select().from(image_files).where(eq(image_files.project_id, sourceProjectId)),
      db.select().from(audio_files).where(eq(audio_files.project_id, sourceProjectId)),
      db.select().from(timeline_sections).where(eq(timeline_sections.project_id, sourceProjectId)),
      db.select().from(timeline_markers).where(eq(timeline_markers.project_id, sourceProjectId)),
      db.select().from(branch_sequences).where(eq(branch_sequences.project_id, sourceProjectId)),
      db.select().from(branch_choice_points).where(eq(branch_choice_points.project_id, sourceProjectId)),
      db.select().from(branch_edges).where(eq(branch_edges.project_id, sourceProjectId)),
      db.select().from(simulations).where(eq(simulations.project_id, sourceProjectId)),
      db.select().from(scripts).where(eq(scripts.project_id, sourceProjectId)),
      db.select().from(scenes).where(eq(scenes.project_id, sourceProjectId)),
      db.select().from(camera_plans).where(eq(camera_plans.project_id, sourceProjectId)),
      db.select().from(corpora).where(eq(corpora.project_id, sourceProjectId)),
      db.select().from(avatar_visuals).where(eq(avatar_visuals.project_id, sourceProjectId)),
    ]);

    const simIds = sims.map((s) => s.id);
    const activeIds = sims.map((s) => s.active_revision_id).filter((x): x is string => !!x);
    const [activeRevisions, posters] = await Promise.all([
      activeIds.length
        ? db.select().from(sim_revisions).where(inArray(sim_revisions.id, activeIds))
        : Promise.resolve([]),
      simIds.length
        ? db.select().from(sim_posters).where(inArray(sim_posters.simulation_id, simIds))
        : Promise.resolve([]),
    ]);

    return {
      project, videoFiles, imageFiles, audioFiles, sections, markers,
      sequences, choicePoints, edges, sims, activeRevisions, posters,
      scripts: scriptRows, scenes: sceneRows, cameraPlans: cameraPlanRows,
      corpora: corpusRows, avatarVisuals: avatarVisualRows,
      excludedCounts: await this.countExcluded(sourceProjectId),
    };
  }

  /**
   * Row counts for the tables a duplicate deliberately starts empty. Dry-run reporting only.
   *
   * EVERY table named in `EXCLUSIONS` is counted here, and the count is `null` — never 0 — when the
   * table genuinely cannot be counted for one project. The plan is stored so an operator can answer
   * "what did this copy?" months later; a hard-coded 0 for a table nobody queried answers that
   * question WRONG, and it is indistinguishable from an honest empty.
   *
   * `sim_rum_events` is the one that cannot be counted: it is keyed by package revision with no
   * project column at all (deliberately — see migration 051's privacy note), so there is no
   * project-scoped number to report. It reports `null`, which the dry run renders as "not counted".
   */
  private async countExcluded(projectId: string): Promise<Record<string, number | null>> {
    const one = async (label: string, run: () => Promise<{ n: number | string }[]>): Promise<[string, number | null]> => {
      try {
        const [row] = await run();
        return [label, Number(row?.n ?? 0)];
      } catch (err) {
        // A table that is not migrated yet must not fail a dry run — and must not claim zero.
        logger.debug({ err, label }, 'duplication: excluded-row count unavailable');
        return [label, null];
      }
    };
    const n = sql<number>`count(*)`.as('n');
    const pairs = await Promise.all([
      one('branch_path_events', () => db.select({ n }).from(branch_path_events).where(eq(branch_path_events.project_id, projectId))),
      one('token_usage', () => db.select({ n }).from(token_usage).where(eq(token_usage.project_id, projectId))),
      one('jobs', () => db.select({ n }).from(jobs).where(eq(jobs.project_id, projectId))),
      one('video_generation_jobs', () => db.select({ n }).from(video_generation_jobs).where(eq(video_generation_jobs.project_id, projectId))),
      one('audio_renders', () => db.select({ n }).from(audio_renders).where(eq(audio_renders.project_id, projectId))),
      one('collaborators', () => db.select({ n }).from(collaborators).where(and(eq(collaborators.content_type, 'project'), eq(collaborators.content_id, projectId)))),
      one('project_redirect_targets', () => db.select({ n }).from(project_redirect_targets).where(eq(project_redirect_targets.project_id, projectId))),
      one('course_lessons', () => db.select({ n }).from(course_lessons).where(eq(course_lessons.project_id, projectId))),
      one('playlist_items', () => db.select({ n }).from(playlist_items).where(eq(playlist_items.project_id, projectId))),
      one('avatar_conversations', () => db.select({ n }).from(avatar_conversations).where(eq(avatar_conversations.project_id, projectId))),
      // Billing is POLYMORPHIC (`content_type`/`content_id`), like collaborators — the rows that
      // belong to this project are found the same way, not by a project_id column.
      one('billing_transactions', () => db.select({ n }).from(billing_transactions).where(and(eq(billing_transactions.content_type, 'project'), eq(billing_transactions.content_id, projectId)))),
      one('user_purchases', () => db.select({ n }).from(user_purchases).where(and(eq(user_purchases.content_type, 'project'), eq(user_purchases.content_id, projectId)))),
    ]);
    // Not a count of zero: `sim_rum_events` has no project dimension to count along at all.
    return { ...Object.fromEntries(pairs), sim_rum_events: null };
  }

  // ─── 2. Plan ────────────────────────────────────────────────────────────────────────────────

  /**
   * Allocate every new identity and every destination key. Pure with respect to the database and
   * to storage — the only impurity is uuid minting, which is what makes the dry run cheap enough to
   * run as an ordinary read.
   */
  buildPlan(snap: DuplicationSnapshot): PlannedDuplication {
    const ids = new IdAllocator();
    const warnings: string[] = [];
    const storage: StorageCopy[] = [];
    const src = snap.project;
    const targetProjectId = ids.next(src.id);

    // Identities first, ALL of them, before any key is derived: a key's destination is a function
    // of the id map, so the map has to be complete before the first rewrite.
    for (const v of snap.videoFiles) ids.next(v.id);
    for (const i of snap.imageFiles) ids.next(i.id);
    for (const a of snap.audioFiles) ids.next(a.id);
    for (const s of snap.sequences) ids.next(s.id);
    for (const c of snap.choicePoints) ids.next(c.id);
    for (const e of snap.edges) ids.next(e.id);
    for (const s of snap.sims) ids.next(s.id);
    for (const r of snap.activeRevisions) ids.next(r.id);
    for (const s of snap.sections) ids.next(s.id);
    for (const m of snap.markers) ids.next(m.id);
    for (const s of snap.scripts) ids.next(s.id);
    for (const s of snap.scenes) ids.next(s.id);
    for (const c of snap.cameraPlans) ids.next(c.id);
    for (const c of snap.corpora) ids.next(c.id);
    for (const v of snap.avatarVisuals) ids.next(v.id);

    const idMap = ids.snapshot();
    /** Derive a destination key from the id map, or mint a sibling when the key embeds no id. */
    const dest = (key: string): string => rewriteKeyByIds(key, idMap) ?? freshSiblingKey(key);

    // ── Project thumbnail ──
    if (src.thumbnail_key) {
      storage.push({ kind: 'object', from: src.thumbnail_key, to: dest(src.thumbnail_key), reason: 'project thumbnail' });
    }

    // ── Avatar-circle face images ──
    // The one storage namespace a project owns that NO column names: circle faces are uploaded to
    // `avatar-circles/{projectId}/{uuid}{ext}` and addressed only by the public URL embedded in
    // `projects.avatar_config.avatarCircles.faces[].imageUrl`. Copied by prefix (the URLs are
    // rebased at commit time), because the alternative is a copy whose faces point into the
    // ORIGINAL's namespace — which project DELETE purges wholesale. Delete the original and the
    // copy's presenters silently become broken images, with nothing left to trace it back to.
    storage.push({
      kind: 'prefix',
      from: `avatar-circles/${src.id}`,
      to: `avatar-circles/${targetProjectId}`,
      reason: 'avatar circle face images',
    });

    // ── Video files: the raw master, the HLS tree, the crop metadata, the legacy caption blob ──
    let estimatedBytes = 0;
    const oversize: DuplicationPlan['oversize'] = [];
    for (const v of snap.videoFiles) {
      if (v.storage_key) {
        storage.push({ kind: 'object', from: v.storage_key, to: dest(v.storage_key), reason: `video ${v.filename} master` });
        estimatedBytes += v.file_size ?? 0;
        // Found HERE, at plan time, because this is the only moment the size is known before any
        // byte is written. The ceiling is what a RANGED MULTIPART copy can address, not the 5 GiB
        // one `CopyObject` alone can: the adapters cross that one for themselves now, so a 6 GB
        // master is copyable and must not be refused. Past this one there is no further fallback,
        // and no retry can produce one.
        if ((v.file_size ?? 0) > MULTIPART_COPY_MAX_BYTES) {
          oversize.push({ key: v.storage_key, bytes: v.file_size!, what: v.filename });
        }
      }
      // The WHOLE tree, versioned runs and legacy layout alike. Copying by prefix rather than by
      // the two pointer columns is what keeps the variant playlists and every segment they name.
      storage.push({ kind: 'prefix', from: `hls/${v.id}`, to: `hls/${ids.next(v.id)}`, reason: `video ${v.filename} HLS ladder` });
      if (v.crop_key) storage.push({ kind: 'object', from: v.crop_key, to: dest(v.crop_key), reason: 'smart-crop metadata' });
      if (v.captions_vtt_key) storage.push({ kind: 'object', from: v.captions_vtt_key, to: dest(v.captions_vtt_key), reason: 'captions backup' });
    }

    for (const i of snap.imageFiles) {
      storage.push({ kind: 'object', from: i.storage_key, to: dest(i.storage_key), reason: `image ${i.filename}` });
    }
    for (const a of snap.audioFiles) {
      storage.push({ kind: 'object', from: a.storage_key, to: dest(a.storage_key), reason: `audio ${a.filename}` });
    }

    // ── Simulations ──
    const revisionBySim = new Map(snap.activeRevisions.map((r) => [r.simulation_id, r]));
    for (const s of snap.sims) {
      const newSimId = ids.next(s.id);
      const oldPrefix = normalizePrefix(s.storage_prefix);
      const newPrefix = rewriteKeyByIds(oldPrefix, idMap) ?? `simulations/${targetProjectId}/${newSimId}`;
      const rev = revisionBySim.get(s.id);
      if (rev) {
        const newRevId = ids.next(rev.id);
        storage.push({
          kind: 'prefix',
          from: `${oldPrefix}/revisions/${rev.id}`,
          to: `${newPrefix}/revisions/${newRevId}`,
          reason: `simulation "${s.name}" active revision #${rev.revision_number}`,
        });
      } else {
        warnings.push(`simulation "${s.name}" has no active revision — its legacy mutable prefix is copied instead`);
      }
      // The mutable prefix is copied too (minus the system-owned subtrees, which are handled
      // above and below): `simulations.entry_file` still points into it on pre-revision rows, and
      // "replace simulation" writes the customer bundle there. The enumeration happens at copy
      // time, not here, so the plan does not have to list every file of every package.
      storage.push({
        kind: 'package-root',
        from: oldPrefix,
        to: newPrefix,
        reason: `simulation "${s.name}" package bytes (excluding revisions/ and posters/)`,
      });
    }

    // ── Posters ──
    // A poster's identity contains the package revision, which changes by construction (the copy
    // gets a new revision id), AND the variant key, which is a SECTION id and is also remapped. So
    // a poster cannot be copied verbatim: its identity, its storage path and its row all move
    // together, or the copy holds posters no lookup will ever ask for.
    const posterPlan = this.planPosters(snap, ids, idMap, warnings);
    storage.push(...posterPlan.copies);

    // ── Avatar library visuals ──
    for (const v of snap.avatarVisuals) {
      if (v.image_key) storage.push({ kind: 'object', from: v.image_key, to: dest(v.image_key), reason: 'avatar library image' });
      if (v.sim_storage_prefix) {
        const from = normalizePrefix(v.sim_storage_prefix);
        storage.push({ kind: 'prefix', from, to: dest(from), reason: 'avatar library simulation' });
      }
    }

    // ── Corpora ──
    // `corpora.storage_url` is a full URL with no shadow key column, so the key has to be recovered
    // from it the same way CorpusBuilder does. When that recovery does not land on a real object
    // the row still copies — `extracted_md` is what every downstream reader actually uses — but its
    // `storage_url` is dropped rather than left pointing at the original's bytes.
    for (const c of snap.corpora) {
      const key = corpusKeyFromUrl(c.storage_url);
      if (key) storage.push({ kind: 'object', from: key, to: dest(key), reason: 'corpus source file' });
    }

    const rowCounts: Record<string, number> = {
      projects: 1,
      video_files: snap.videoFiles.length,
      image_files: snap.imageFiles.length,
      audio_files: snap.audioFiles.length,
      timeline_sections: snap.sections.length,
      timeline_markers: snap.markers.length,
      branch_sequences: snap.sequences.length,
      branch_choice_points: snap.choicePoints.length,
      branch_edges: snap.edges.length,
      simulations: snap.sims.length,
      sim_revisions: snap.activeRevisions.length,
      sim_posters: posterPlan.rows.length,
      scripts: snap.scripts.length,
      scenes: snap.scenes.length,
      camera_plans: snap.cameraPlans.length,
      corpora: snap.corpora.length,
      avatar_visuals: snap.avatarVisuals.length,
    };

    const excluded: DuplicationPlan['excluded'] = {};
    for (const [table, why] of Object.entries(EXCLUSIONS)) {
      // `?? null`, not `?? 0`: a table nobody queried has NOT been observed to be empty.
      excluded[table] = { rows: snap.excludedCounts[table] ?? null, why };
    }
    const skippedPosters = snap.posters.length - posterPlan.rows.length;
    if (skippedPosters > 0) {
      excluded['sim_posters (retired revisions)'] = {
        rows: skippedPosters,
        why: 'captured against a package revision this copy does not carry',
      };
    }
    // `avatar_profiles` is keyed by session, not by project (no project_id column at all), so there
    // is nothing project-scoped to copy. Named explicitly rather than silently absent, because the
    // matrix asks for it and "we did not copy it" and "there was nothing to copy" read the same in
    // a diff.
    warnings.push('avatar_profiles is session-scoped (session_key UNIQUE, no project_id) — nothing project-scoped exists to copy');

    return {
      ids,
      posters: posterPlan.rows,
      plan: {
        sourceProjectId: src.id,
        targetProjectId,
        idMap: ids.toJSON(),
        rowCounts,
        excluded,
        storage,
        estimatedBytes,
        oversize,
        warnings,
      },
    };
  }

  /**
   * The refusal an object beyond the copy path's reach earns, or null when the plan is copyable.
   *
   * One derivation, used by BOTH gates — the synchronous one in the POST handler (so the user is
   * told before a job row exists) and the one in `run()` (so a plan that was fine at POST time and
   * grew since is still refused before any byte moves).
   *
   * WHAT THIS STILL GUARDS, now that 5 GiB is no longer a wall. `copyObject` crosses the
   * single-copy ceiling by re-issuing the copy as uniform 256 MiB `UploadPartCopy` ranges, and
   * 10,000 of those address 2.5 TiB (`MULTIPART_COPY_MAX_BYTES`). Past THAT there is no third
   * fallback: uniform part size is an R2 requirement, so the copy cannot simply use bigger parts.
   * No shipped configuration gets there — uploads cap at 10 GB, a whole duplication at 50 GB — so
   * this now fires only for a deployment that has raised both caps into the terabytes. It is kept
   * rather than deleted because it is still the honest answer to "is there anything in this plan
   * the storage cannot copy at all?", and because the alternative for such a deployment is a job
   * that runs for hours and then fails on a part-count error nobody can act on.
   */
  static oversizeRefusal(plan: DuplicationPlan): DuplicationRefused | null {
    const worst = (plan.oversize ?? []).slice().sort((a, b) => b.bytes - a.bytes)[0];
    if (!worst) return null;
    const tb = (n: number): string => (n / 1e12).toFixed(1);
    return new DuplicationRefused(
      `“${worst.what}” is ${tb(worst.bytes)} TB. Duplication copies media file by file and cannot ` +
      `copy a single file larger than ${tb(MULTIPART_COPY_MAX_BYTES)} TB, so this project cannot ` +
      'be duplicated as it stands. Splitting or re-encoding that video below the limit will let it copy.',
      413,
    );
  }

  /**
   * Re-key every poster of the active package onto the copy's identity axis.
   *
   * `packageRevisionFor` is the ONE resolver for that axis (a second derivation is the defect its
   * doc comment forbids), so the copy's revision id is fed through it exactly as `buildPlayerConfig`
   * would. Posters whose `package_revision` does not match the source's CURRENT one were captured
   * against a retired revision whose bytes this copy does not carry, so they are dropped.
   */
  private planPosters(
    snap: DuplicationSnapshot,
    ids: IdAllocator,
    idMap: ReadonlyMap<string, string>,
    warnings: string[],
  ): { copies: StorageCopy[]; rows: PlannedPoster[] } {
    const copies: StorageCopy[] = [];
    const rows: PlannedPoster[] = [];
    const revisionBySim = new Map(snap.activeRevisions.map((r) => [r.simulation_id, r]));

    for (const s of snap.sims) {
      const newSimId = ids.next(s.id);
      const oldPrefix = normalizePrefix(s.storage_prefix);
      const newPrefix = rewriteKeyByIds(oldPrefix, idMap) ?? `simulations/${ids.next(snap.project.id)}/${newSimId}`;
      const rev = revisionBySim.get(s.id);

      const currentRevision = packageRevisionFor(s, derivePackageRevision);
      const copyRevision = packageRevisionFor(
        { id: newSimId, bridge_hash: s.bridge_hash, active_revision_id: rev ? ids.next(rev.id) : null },
        derivePackageRevision,
      );

      for (const p of snap.posters.filter((x) => x.simulation_id === s.id)) {
        if (p.package_revision !== currentRevision) continue;
        // The variant key is a section id when the package is multi-section; when it is a script
        // name or a legacy literal it is not in the map and stays as it is.
        const variantKey = idMap.get(p.variant_key) ?? p.variant_key;
        const key: PosterKey = {
          packageRevision: copyRevision,
          variantKey,
          configHash: p.config_hash,
          aspectProfile: p.aspect_profile as SimAspectProfile,
          qualityProfile: p.quality_profile as SimQualityProfile,
        };
        const identity = posterIdentityString(key);
        const variants = parsePosterVariants(p.variants);
        if (variants.length === 0) {
          warnings.push(`poster ${p.identity} had no readable variants — skipped`);
          continue;
        }
        const remapped: PosterVariantRecord[] = variants.map((v) => {
          const to = posterStoragePath(newPrefix, key, v.size, v.format);
          copies.push({ kind: 'object', from: v.path, to, reason: `poster ${identity} ${v.size}.${v.format}` });
          return { ...v, path: to };
        });
        rows.push({
          id: randomUUID(),
          simulationId: newSimId,
          packageRevision: copyRevision,
          variantKey,
          configHash: p.config_hash,
          aspectProfile: p.aspect_profile,
          qualityProfile: p.quality_profile,
          identity,
          variants: remapped,
          transparent: p.transparent,
          capturedAt: p.captured_at,
        });
      }
    }
    return { copies, rows };
  }

  /** Snapshot + plan, with nothing written. The dry run, and the oracle every test compares against. */
  async dryRun(sourceProjectId: string): Promise<DuplicationPlan | null> {
    const snap = await this.loadSnapshot(sourceProjectId);
    if (!snap) return null;
    return this.buildPlan(snap).plan;
  }

  // ─── 3. Copy bytes ──────────────────────────────────────────────────────────────────────────

  /**
   * Write every planned object into its destination, then verify.
   *
   * Idempotent: destinations are overwritten, so a retry after a partial copy simply lands on top
   * of what the previous attempt wrote. That is the same property `RevisionMigration` relies on.
   */
  async copyBytes(plan: DuplicationPlan, onProgress?: (copied: number, total: number) => void): Promise<number> {
    let copied = 0;
    const total = plan.storage.length;
    for (const c of plan.storage) {
      if (c.from === c.to) {
        throw new Error(`duplication: refusing to copy ${c.from} onto itself`);
      }
      if (c.kind === 'object') {
        await this.storage.copyObject(c.from, c.to);
      } else if (c.kind === 'package-root') {
        await this.copySimulationMutablePrefix(c.from, c.to);
      } else {
        await this.storage.copyPrefix(c.from, c.to);
      }
      copied += 1;
      if (onProgress && (copied % PROGRESS_EVERY === 0 || copied === total)) onProgress(copied, total);
    }
    return copied;
  }

  /**
   * The customer bundle at a simulation's mutable prefix, WITHOUT the two system-owned subtrees.
   *
   * `revisions/` is copied one revision at a time (only the active one), and `posters/` is copied
   * per row with a rewritten identity. A blanket prefix copy would duplicate every retired revision
   * and every stale poster as unreferenced bytes — and would put posters at paths whose identity no
   * lookup will ever compute, which is worse than not copying them, because a sweep would then have
   * to distinguish them from live ones.
   */
  private async copySimulationMutablePrefix(from: string, to: string): Promise<void> {
    const keys = await this.storage.listObjects(from);
    for (const key of keys) {
      const rest = key.startsWith(`${from}/`) ? key.slice(from.length + 1) : null;
      if (rest === null) continue;
      if (PACKAGE_ROOT_EXCLUDED_SUBDIRS.includes(rest.split('/')[0])) continue;
      await this.storage.copyObject(key, `${to}/${rest}`);
    }
  }

  /**
   * Prove the bytes landed before any row is written.
   *
   * Checks EXISTENCE of every object copy and non-emptiness of every prefix copy — not checksums.
   * Server-side `CopyObject` is byte-exact by definition and the read-then-write fallback moves a
   * Buffer, so a hash pass would re-download the whole ladder to re-derive something neither path
   * can get wrong. What it CAN catch, and does, is a copy that silently wrote nothing.
   */
  async verifyBytes(plan: DuplicationPlan): Promise<void> {
    for (const c of plan.storage) {
      if (c.kind === 'object') {
        if (!(await this.storage.objectExists(c.to))) {
          throw new Error(`duplication: copied object missing at ${c.to}`);
        }
        continue;
      }
      const sourceKeys = await this.storage.listObjects(c.from);
      if (sourceKeys.length === 0) continue; // nothing to copy is not a failure
      const destKeys = await this.storage.listObjects(c.to);
      if (destKeys.length === 0) {
        throw new Error(`duplication: prefix ${c.from} copied to ${c.to} but the destination is empty`);
      }
    }
  }

  // ─── 4. Commit rows ─────────────────────────────────────────────────────────────────────────

  /**
   * Insert the whole row graph in one transaction, in FK order.
   *
   * Two forward references need a second pass inside the same transaction, because the FK exists in
   * the database and neither is deferrable: `simulations.active_revision_id` (revisions reference
   * their simulation) and `branch_choice_points.default_edge_id` (edges reference their choice
   * point). Both are written as UPDATEs after their targets exist.
   */
  async commitRows(snap: DuplicationSnapshot, planned: PlannedDuplication, requestedBy: string | null): Promise<string> {
    const { plan, ids, posters } = planned;
    const idMap = ids.snapshot();
    const copies = plan.storage;
    const key = (k: string | null | undefined): string | null => mapStorageKey(k, copies);
    const src = snap.project;
    const targetId = plan.targetProjectId;

    await db.transaction(async (tx) => {
      // 1 ─ root
      const newThumbKey = key(src.thumbnail_key);
      await tx.insert(projects).values({
        id: targetId,
        org_id: src.org_id,
        // The duplicator owns the copy. Delete is owner-only on `created_by`, so inheriting the
        // source's creator could hand someone a project they cannot delete.
        created_by: requestedBy ?? src.created_by,
        title: duplicatedTitle(src.title),
        tier: src.tier,
        topic: src.topic,
        style_preset: src.style_preset,
        // Hosts are ORG-scoped persona rows, not project-scoped: the copy references the same ones,
        // exactly as two hand-made projects in one org would.
        host_a_id: src.host_a_id,
        host_b_id: src.host_b_id,
        format: src.format,
        target_duration_min: src.target_duration_min,
        pacing: src.pacing,
        emotional_style: src.emotional_style,
        status: duplicatedProjectStatus(src.status) as typeof src.status,
        // Publication identity is never copied: one private, unshared, unlisted, unpermalinked,
        // unviewed project. The slug namespace is shared with playlists and is unique.
        visibility: 'private',
        share_token: null,
        share_enabled_at: null,
        slug: null,
        view_count: 0,
        // Monetisation is a publication decision about the original. A copy that is private and
        // unpublished but silently priced is a trap; the owner can re-price in one click.
        access_type: 'free',
        price_cents: null,
        currency: src.currency,
        thumbnail_key: newThumbKey,
        thumbnail_url: newThumbKey && src.thumbnail_key
          ? (rebaseUrl(src.thumbnail_url, src.thumbnail_key, newThumbKey) ?? this.storage.getPublicUrl(newThumbKey))
          : null,
        metadata_status: duplicatedMetadataStatus(src.metadata_status),
        seo_description: src.seo_description,
        seo_keywords: src.seo_keywords,
        // Authoring data (§8.4 Q2, answered yes): the persona, greeting and knowledge a creator
        // wrote are part of the project, not of its audience — but the face images it POINTS AT
        // live under the source's `avatar-circles/` prefix and die with it, so the URLs follow the
        // bytes this plan copied.
        avatar_config: rewriteAvatarConfig(src.avatar_config, copies),
      });

      // 2 ─ branch sequences (video_files reference them)
      if (snap.sequences.length) {
        await tx.insert(branch_sequences).values(snap.sequences.map((s) => ({
          id: ids.next(s.id), project_id: targetId, label: s.label, is_entry: s.is_entry,
          sort_order: s.sort_order, graph_x: s.graph_x, graph_y: s.graph_y,
        })));
      }

      // 3 ─ simulations, WITHOUT the revision pointer (the FK points the other way)
      if (snap.sims.length) {
        await tx.insert(simulations).values(snap.sims.map((s) => {
          const newPrefix = key(normalizePrefix(s.storage_prefix)) ?? normalizePrefix(s.storage_prefix);
          return {
            id: ids.next(s.id), project_id: targetId, name: s.name,
            storage_prefix: newPrefix,
            entry_file: rewriteEntryFile(s.entry_file, normalizePrefix(s.storage_prefix), newPrefix),
            bridge_functions: s.bridge_functions, status: s.status, error: s.error,
            guidance: s.guidance, guidance_status: s.guidance_status,
            // `guidance_meta.mdUrl` is a public URL of `{prefix}/guidance/understanding.md` with no
            // shadow key column. The BYTES come along in the package-root copy; without rebasing the
            // URL the editor's "analysis ↗" link on the COPY opens the ORIGINAL's document, and 404s
            // the moment the original is deleted.
            guidance_meta: rewriteGuidanceMeta(s.guidance_meta, copies),
            guidance_error: s.guidance_error,
            // The bytes are copied verbatim, so the hash and the verdict describe the SAME package
            // — which is exactly the condition §8.2 attaches to carrying them. `verifyBytes` has
            // already run by the time this executes; if it had not, these would have to be null.
            bridge_hash: s.bridge_hash,
            package_class: s.package_class,
            canary_report: s.canary_report,
            canary_at: s.canary_at,
            prepare_budget_ms: s.prepare_budget_ms,
            active_revision_id: null,
            active_revision_entry_key: null,
            // Restarts. The copy's history begins now; it has one revision or none.
            revision_counter: s.active_revision_id ? 1 : 0,
          };
        }));
      }

      // 4 ─ the one carried revision per simulation, and then the pointer
      for (const rev of snap.activeRevisions) {
        const newRevId = ids.next(rev.id);
        const newSimId = ids.requireInternal(rev.simulation_id, 'sim_revisions.simulation_id')!;
        const oldSim = snap.sims.find((s) => s.id === rev.simulation_id)!;
        const newPrefix = key(normalizePrefix(oldSim.storage_prefix)) ?? normalizePrefix(oldSim.storage_prefix);
        const metadata = {
          ...(typeof rev.metadata === 'object' && rev.metadata !== null ? rev.metadata as Record<string, unknown> : {}),
          duplicatedFrom: { projectId: src.id, simulationId: oldSim.id, revisionId: rev.id },
        };
        await tx.insert(sim_revisions).values({
          id: newRevId,
          simulation_id: newSimId,
          revision_number: 1,
          status: 'active',
          manifest_hash: rev.manifest_hash,
          entry_path: rev.entry_path,
          bridge_protocol_version: rev.bridge_protocol_version,
          runtime_protocol_version: rev.runtime_protocol_version,
          package_class: rev.package_class,
          canary_report: rev.canary_report,
          canary_at: rev.canary_at,
          // Never carried: it names a revision in the ORIGINAL's history, which this copy does not
          // have. A rollback marker pointing outside the project is the exact escape being guarded.
          rollback_of_revision_id: null,
          created_by: rev.created_by,
          metadata,
          activated_at: new Date(),
        });
        const entryKey = rev.entry_path ? `${newPrefix}/revisions/${newRevId}/${rev.entry_path}` : null;
        // Both columns in ONE update — simulations_active_revision_pair_chk forbids disagreement.
        //
        // AND the two capability projections, at the same moment and from the same record, because
        // this IS the copy's pointer flip. Migrations 055 and 057 both say the same thing: the fact
        // lives on the revision, and a scalar projection of it is written onto `simulations` in the
        // statement that moves the pointer, so the column always describes the bytes the pointer
        // names. The metadata came along above, so the answer is already here — leaving it
        // unprojected would silently downgrade both to NULL, which is UNKNOWN, which for
        // `requires_import_maps` means the copy spins and force-reveals a permanently blank iframe
        // on a browser where the original honestly says "needs a newer browser".
        //
        // Read through the shared accessors, never by re-parsing the JSONB here: a second reader of
        // one record is the defect `bridgeCapability`'s doc exists to prevent.
        await tx.update(simulations)
          .set({
            active_revision_id: newRevId,
            active_revision_entry_key: entryKey,
            bridge_ack_capable: bridgeAckCapableFromMetadata(metadata),
            requires_import_maps: requiresImportMapsFromMetadata(metadata),
          })
          .where(eq(simulations.id, newSimId));
      }

      // 5 ─ posters, re-keyed onto the copy's identity axis
      if (posters.length) {
        await tx.insert(sim_posters).values(posters.map((p) => ({
          id: p.id, simulation_id: p.simulationId, package_revision: p.packageRevision,
          variant_key: p.variantKey, config_hash: p.configHash, aspect_profile: p.aspectProfile,
          quality_profile: p.qualityProfile, identity: p.identity, variants: p.variants,
          transparent: p.transparent, captured_at: p.capturedAt,
        })));
      }

      // 6 ─ media rows
      if (snap.videoFiles.length) {
        await tx.insert(video_files).values(snap.videoFiles.map((v) => ({
          id: ids.next(v.id), project_id: targetId, filename: v.filename, file_size: v.file_size,
          storage_key: key(v.storage_key), status: v.status, duration_sec: v.duration_sec,
          hls_status: v.hls_status,
          hls_master_key: key(v.hls_master_key),
          hls_current_tier: v.hls_current_tier,
          hls_360p_key: key(v.hls_360p_key),
          hls_started_at: v.hls_started_at, hls_finished_at: v.hls_finished_at, hls_error: v.hls_error,
          // Derived state carried as DATA so the copy never re-runs a transcode, a crop analysis or
          // a caption pass it already has the answer to.
          waveform_peaks: v.waveform_peaks,
          is_broll: v.is_broll,
          crop_status: v.crop_status, crop_key: key(v.crop_key),
          crop_source_hash: v.crop_source_hash, crop_error: v.crop_error, crop_updated_at: v.crop_updated_at,
          captions_status: v.captions_status, captions_vtt_key: key(v.captions_vtt_key),
          captions_vtt: v.captions_vtt, captions_source_hash: v.captions_source_hash,
          captions_error: v.captions_error, captions_updated_at: v.captions_updated_at,
          sequence_id: ids.requireInternal(v.sequence_id, 'video_files.sequence_id'),
          sequence_order: v.sequence_order,
        })));
      }
      if (snap.imageFiles.length) {
        await tx.insert(image_files).values(snap.imageFiles.map((i) => {
          const k = key(i.storage_key)!;
          return {
            id: ids.next(i.id), project_id: targetId, filename: i.filename, storage_key: k,
            original_url: rebaseUrl(i.original_url, i.storage_key, k) ?? this.storage.getPublicUrl(k),
            width: i.width, height: i.height,
            crop_x: i.crop_x, crop_y: i.crop_y, crop_w: i.crop_w, crop_h: i.crop_h,
          };
        }));
      }
      if (snap.audioFiles.length) {
        await tx.insert(audio_files).values(snap.audioFiles.map((a) => {
          const k = key(a.storage_key)!;
          return {
            id: ids.next(a.id), project_id: targetId, filename: a.filename, storage_key: k,
            url: rebaseUrl(a.url, a.storage_key, k) ?? this.storage.getPublicUrl(k),
            duration_sec: a.duration_sec,
          };
        }));
      }

      // 7 ─ timeline
      if (snap.sections.length) {
        await tx.insert(timeline_sections).values(snap.sections.map((s) => ({
          id: ids.next(s.id), project_id: targetId,
          video_file_id: ids.requireInternal(s.video_file_id, 'timeline_sections.video_file_id')!,
          start_sec: s.start_sec, end_sec: s.end_sec, type: s.type, label: s.label, notes: s.notes,
          sort_order: s.sort_order,
          simulation_url: this.rewriteSimulationUrl(s, snap, ids, idMap, copies),
          simulation_id: ids.requireInternal(s.simulation_id, 'timeline_sections.simulation_id'),
          sim_script: s.sim_script, sim_prompt: s.sim_prompt, simple_ui: s.simple_ui,
          auto_script: s.auto_script, track: s.track, global_offset_sec: s.global_offset_sec,
          sim_meta: s.sim_meta,
          // The three clip sources are references too — the matrix names only video_file_id and
          // simulation_id, but a "clip" section carries its source here and an unmapped one would
          // play the ORIGINAL's media inside the copy.
          clip_source_video_id: ids.requireInternal(s.clip_source_video_id, 'timeline_sections.clip_source_video_id'),
          clip_in_sec: s.clip_in_sec,
          broll_volume: s.broll_volume,
          clip_source_image_id: ids.requireInternal(s.clip_source_image_id, 'timeline_sections.clip_source_image_id'),
          camera_movement: s.camera_movement,
          clip_source_audio_id: ids.requireInternal(s.clip_source_audio_id, 'timeline_sections.clip_source_audio_id'),
        })));
      }
      if (snap.markers.length) {
        await tx.insert(timeline_markers).values(snap.markers.map((m) => ({
          id: ids.next(m.id), project_id: targetId, at_sec: m.at_sec,
          label: m.label, notes: m.notes, color: m.color,
        })));
      }

      // 8 ─ branch graph: choice points without their default edge, then edges, then the default
      if (snap.choicePoints.length) {
        await tx.insert(branch_choice_points).values(snap.choicePoints.map((c) => ({
          id: ids.next(c.id), project_id: targetId,
          sequence_id: ids.requireInternal(c.sequence_id, 'branch_choice_points.sequence_id')!,
          lead_in_sec: c.lead_in_sec, timeout_sec: c.timeout_sec, behavior: c.behavior,
          prompt: c.prompt, layout: c.layout, default_edge_id: null,
        })));
      }
      if (snap.edges.length) {
        await tx.insert(branch_edges).values(snap.edges.map((e) => ({
          id: ids.next(e.id), project_id: targetId,
          choice_point_id: ids.requireInternal(e.choice_point_id, 'branch_edges.choice_point_id'),
          label: e.label, description: e.description, thumbnail_url: e.thumbnail_url,
          sort_order: e.sort_order, destination_type: e.destination_type,
          dest_sequence_id: ids.requireInternal(e.dest_sequence_id, 'branch_edges.dest_sequence_id'),
          // A link to ANOTHER project is content, not an internal reference, and stays pointed
          // where the author pointed it. A link to THIS project is an internal one wearing an
          // external shape — "restart into me" — and must follow the copy.
          dest_project_id: e.dest_project_id === src.id ? targetId : e.dest_project_id,
          dest_playlist_id: e.dest_playlist_id,
          dest_url: e.dest_url,
          dest_simulation_id: ids.requireInternal(e.dest_simulation_id, 'branch_edges.dest_simulation_id'),
          dest_quiz_id: e.dest_quiz_id,
          trigger_event: e.trigger_event, trigger_match: e.trigger_match,
        })));
      }
      for (const c of snap.choicePoints) {
        if (!c.default_edge_id) continue;
        await tx.update(branch_choice_points)
          .set({ default_edge_id: ids.requireInternal(c.default_edge_id, 'branch_choice_points.default_edge_id') })
          .where(eq(branch_choice_points.id, ids.next(c.id)));
      }

      // 9 ─ authoring inputs
      if (snap.corpora.length) {
        await tx.insert(corpora).values(snap.corpora.map((c) => {
          const oldKey = corpusKeyFromUrl(c.storage_url);
          const newKey = oldKey ? key(oldKey) : null;
          return {
            id: ids.next(c.id), project_id: targetId, source_type: c.source_type,
            source_url: c.source_url,
            storage_url: oldKey && newKey
              ? (rebaseUrl(c.storage_url, oldKey, newKey) ?? this.storage.getPublicUrl(newKey))
              : null,
            extracted_md: c.extracted_md, hash: c.hash, metadata: c.metadata,
            ingestion_status: c.ingestion_status, error: c.error,
          };
        }));
      }
      if (snap.scripts.length) {
        await tx.insert(scripts).values(snap.scripts.map((s) => ({
          ...s, id: ids.next(s.id), project_id: targetId, created_at: undefined,
        })));
      }
      if (snap.scenes.length) {
        await tx.insert(scenes).values(snap.scenes.map((s) => ({
          ...s, id: ids.next(s.id), project_id: targetId,
        })));
      }
      if (snap.cameraPlans.length) {
        await tx.insert(camera_plans).values(snap.cameraPlans.map((c) => ({
          ...c, id: ids.next(c.id), project_id: targetId, created_at: undefined,
        })));
      }
      if (snap.avatarVisuals.length) {
        await tx.insert(avatar_visuals).values(snap.avatarVisuals.map((v) => {
          const imageKey = key(v.image_key);
          const simPrefix = v.sim_storage_prefix ? key(normalizePrefix(v.sim_storage_prefix)) : null;
          return {
            id: ids.next(v.id), project_id: targetId, scope: v.scope, source: v.source,
            character_id: v.character_id, visual_type: v.visual_type, lookup_key: v.lookup_key,
            caption: v.caption, alt_text: v.alt_text,
            image_key: imageKey,
            image_url: imageKey && v.image_key
              ? (rebaseUrl(v.image_url, v.image_key, imageKey) ?? this.storage.getPublicUrl(imageKey))
              : null,
            dalle_prompt: v.dalle_prompt, visual_spec: v.visual_spec,
            sim_storage_prefix: simPrefix,
            sim_entry_url: simPrefix && v.sim_storage_prefix
              ? (rebaseUrl(v.sim_entry_url, normalizePrefix(v.sim_storage_prefix), simPrefix)
                 ?? this.storage.getSimPublicUrl(`${simPrefix}/index.html`))
              : null,
            // Reuse counters are the ORIGINAL's usage history.
            use_count: 0,
            created_by: v.created_by,
          };
        }));
      }

      // 10 ─ prove independence, INSIDE the transaction, against the rows just written.
      //
      // Placement is the whole point. Run after the commit, this assertion's only failure mode is
      // the one thing the design promises cannot happen: a project that exists, is corrupt, is in
      // the owner's list, and is not named by the job row — while the user is told "nothing was
      // created; you can try again", and the retry (the in-flight index having been freed) makes a
      // second one. Inside the transaction, a violation is a rollback, so the failure message stays
      // true. It costs a handful of aggregate queries on rows that are already in this transaction's
      // snapshot.
      await this.assertNoEscapingReferences(src.id, targetId, tx);
    });

    return targetId;
  }

  /**
   * The `simulation_url` a copied section should store.
   *
   * The stored value means "what THIS section published" (see `simulationUrlResolver`), so the copy
   * must store what its own first revision publishes — not the original's URL, and not a resolved
   * pointer. The query string is preserved because `?v=` is the bridge hash (unchanged: the bytes
   * are identical) and `?section=` is the variant key, which is remapped to the copied section.
   */
  private rewriteSimulationUrl(
    section: Row<typeof timeline_sections>,
    snap: DuplicationSnapshot,
    ids: IdAllocator,
    idMap: ReadonlyMap<string, string>,
    copies: readonly StorageCopy[],
  ): string | null {
    const stored = section.simulation_url;
    if (!stored) return null;
    const withSection = rewriteSectionParam(stored, idMap);

    const sim = section.simulation_id ? snap.sims.find((s) => s.id === section.simulation_id) : undefined;
    if (!sim) {
      // No owning simulation row: the URL is either external or legacy. Re-root it if any copied
      // prefix contains it; otherwise leave it exactly as it was rather than invent a target.
      return rerootUrlThroughCopies(withSection, copies) ?? withSection;
    }
    const oldPrefix = normalizePrefix(sim.storage_prefix);
    const newPrefix = mapStorageKey(oldPrefix, copies) ?? oldPrefix;
    const rev = snap.activeRevisions.find((r) => r.simulation_id === sim.id);
    if (rev?.entry_path) {
      const q = withSection.indexOf('?');
      const entryKey = `${newPrefix}/revisions/${ids.next(rev.id)}/${rev.entry_path}`;
      return this.storage.getSimPublicUrl(entryKey) + (q >= 0 ? withSection.slice(q) : '');
    }
    return rerootUrlThroughCopies(withSection, copies) ?? withSection;
  }

  // ─── 5. Assert independence ─────────────────────────────────────────────────────────────────

  /**
   * Re-read the committed copy and prove that no row references anything outside it.
   *
   * Runs against the DATABASE, not against the plan, because the plan is the thing being checked.
   * It is cheap (a handful of aggregate queries) and it runs on every duplication, not only in
   * tests — the failure it catches is silent by nature, and a copy whose branch graph points at the
   * original's rows looks completely fine until the original is deleted.
   *
   * `exec` is the TRANSACTION during a real duplication, so a violation rolls the whole copy back;
   * it defaults to `db` so a test (or an operator) can re-run the same proof against a committed
   * project afterwards.
   */
  async assertNoEscapingReferences(
    sourceProjectId: string,
    targetProjectId: string,
    exec: Pick<typeof db, 'select'> = db,
  ): Promise<void> {
        const escapes: string[] = [];
    const check = async (label: string, run: () => Promise<{ n: number | string }[]>): Promise<void> => {
      const [row] = await run();
      const n = Number(row?.n ?? 0);
      if (n > 0) escapes.push(`${label}: ${n}`);
    };
    const n = sql<number>`count(*)`.as('n');
    const t = targetProjectId;

    // Every intra-project FK, checked as "the referenced row is not in the target project".
    await check('timeline_sections.video_file_id', () => exec.select({ n }).from(timeline_sections)
      .leftJoin(video_files, eq(timeline_sections.video_file_id, video_files.id))
      .where(and(eq(timeline_sections.project_id, t), sql`${video_files.project_id} IS DISTINCT FROM ${t}`)));
    await check('timeline_sections.simulation_id', () => exec.select({ n }).from(timeline_sections)
      .leftJoin(simulations, eq(timeline_sections.simulation_id, simulations.id))
      .where(and(eq(timeline_sections.project_id, t),
        sql`${timeline_sections.simulation_id} IS NOT NULL AND ${simulations.project_id} IS DISTINCT FROM ${t}`)));
    await check('timeline_sections.clip_source_video_id', () => exec.select({ n }).from(timeline_sections)
      .leftJoin(video_files, eq(timeline_sections.clip_source_video_id, video_files.id))
      .where(and(eq(timeline_sections.project_id, t),
        sql`${timeline_sections.clip_source_video_id} IS NOT NULL AND ${video_files.project_id} IS DISTINCT FROM ${t}`)));
    await check('timeline_sections.clip_source_image_id', () => exec.select({ n }).from(timeline_sections)
      .leftJoin(image_files, eq(timeline_sections.clip_source_image_id, image_files.id))
      .where(and(eq(timeline_sections.project_id, t),
        sql`${timeline_sections.clip_source_image_id} IS NOT NULL AND ${image_files.project_id} IS DISTINCT FROM ${t}`)));
    await check('timeline_sections.clip_source_audio_id', () => exec.select({ n }).from(timeline_sections)
      .leftJoin(audio_files, eq(timeline_sections.clip_source_audio_id, audio_files.id))
      .where(and(eq(timeline_sections.project_id, t),
        sql`${timeline_sections.clip_source_audio_id} IS NOT NULL AND ${audio_files.project_id} IS DISTINCT FROM ${t}`)));
    await check('video_files.sequence_id', () => exec.select({ n }).from(video_files)
      .leftJoin(branch_sequences, eq(video_files.sequence_id, branch_sequences.id))
      .where(and(eq(video_files.project_id, t),
        sql`${video_files.sequence_id} IS NOT NULL AND ${branch_sequences.project_id} IS DISTINCT FROM ${t}`)));
    await check('branch_choice_points.sequence_id', () => exec.select({ n }).from(branch_choice_points)
      .leftJoin(branch_sequences, eq(branch_choice_points.sequence_id, branch_sequences.id))
      .where(and(eq(branch_choice_points.project_id, t), sql`${branch_sequences.project_id} IS DISTINCT FROM ${t}`)));
    await check('branch_edges.choice_point_id', () => exec.select({ n }).from(branch_edges)
      .leftJoin(branch_choice_points, eq(branch_edges.choice_point_id, branch_choice_points.id))
      .where(and(eq(branch_edges.project_id, t),
        sql`${branch_edges.choice_point_id} IS NOT NULL AND ${branch_choice_points.project_id} IS DISTINCT FROM ${t}`)));
    await check('branch_edges.dest_sequence_id', () => exec.select({ n }).from(branch_edges)
      .leftJoin(branch_sequences, eq(branch_edges.dest_sequence_id, branch_sequences.id))
      .where(and(eq(branch_edges.project_id, t),
        sql`${branch_edges.dest_sequence_id} IS NOT NULL AND ${branch_sequences.project_id} IS DISTINCT FROM ${t}`)));
    await check('branch_edges.dest_simulation_id', () => exec.select({ n }).from(branch_edges)
      .leftJoin(simulations, eq(branch_edges.dest_simulation_id, simulations.id))
      .where(and(eq(branch_edges.project_id, t),
        sql`${branch_edges.dest_simulation_id} IS NOT NULL AND ${simulations.project_id} IS DISTINCT FROM ${t}`)));
    await check('branch_choice_points.default_edge_id', () => exec.select({ n }).from(branch_choice_points)
      .leftJoin(branch_edges, eq(branch_choice_points.default_edge_id, branch_edges.id))
      .where(and(eq(branch_choice_points.project_id, t),
        sql`${branch_choice_points.default_edge_id} IS NOT NULL AND ${branch_edges.project_id} IS DISTINCT FROM ${t}`)));
    await check('sim_revisions.rollback_of_revision_id', () => exec.select({ n }).from(sim_revisions)
      .innerJoin(simulations, eq(sim_revisions.simulation_id, simulations.id))
      .where(and(eq(simulations.project_id, t), sql`${sim_revisions.rollback_of_revision_id} IS NOT NULL`)));

    // Storage: no column may still name the SOURCE project's or a source entity's namespace.
    await check('video_files storage keys pointing at the source', () => exec.select({ n }).from(video_files)
      .where(and(eq(video_files.project_id, t), sql`
        ${video_files.storage_key} LIKE ${'%' + sourceProjectId + '%'}
        OR ${video_files.hls_master_key} LIKE ${'%' + sourceProjectId + '%'}
        OR ${video_files.crop_key} LIKE ${'%' + sourceProjectId + '%'}`)));
    await check('simulations storage prefixes pointing at the source', () => exec.select({ n }).from(simulations)
      .where(and(eq(simulations.project_id, t), sql`${simulations.storage_prefix} LIKE ${'%' + sourceProjectId + '%'}`)));
    await check('timeline_sections.simulation_url pointing at the source', () => exec.select({ n }).from(timeline_sections)
      .where(and(eq(timeline_sections.project_id, t),
        sql`${timeline_sections.simulation_url} LIKE ${'%' + sourceProjectId + '%'}`)));

    // Storage references that live INSIDE JSONB rather than in a key column.
    //
    // Everything above walks column-shaped keys, which is exactly why the avatar-circle faces
    // escaped: their only pointer is a URL nested in `avatar_config.avatarCircles.faces[].imageUrl`,
    // and `guidance_meta.mdUrl` is the same shape. Checked as text against the SOURCE PROJECT ID
    // rather than by walking the document, because the property being proved is not "this field was
    // rewritten" but "nothing in this blob still names the original" — which is what survives a
    // future field being added to either document without anyone remembering this file exists.
    await check('projects.avatar_config pointing at the source', () => exec.select({ n }).from(projects)
      .where(and(eq(projects.id, t), sql`${projects.avatar_config}::text LIKE ${'%' + sourceProjectId + '%'}`)));
    await check('simulations.guidance_meta pointing at the source', () => exec.select({ n }).from(simulations)
      .where(and(eq(simulations.project_id, t),
        sql`${simulations.guidance_meta}::text LIKE ${'%' + sourceProjectId + '%'}`)));

    if (escapes.length > 0) {
      throw new Error(`duplication: copied rows reference the original — ${escapes.join('; ')}`);
    }
  }

  // ─── The run ────────────────────────────────────────────────────────────────────────────────

  /**
   * Take exclusive ownership of a duplication row for this process, or refuse to run.
   *
   * A conditional UPDATE, not a read-then-write: the row moves to `copying` only from `queued`, or
   * from an in-flight status that has gone `DUPLICATION_STALE_AFTER_MS` without a heartbeat. Zero
   * rows updated means somebody else holds it and this delivery must do nothing.
   *
   * WHY THIS EXISTS EVEN THOUGH THE DRIVER IS INLINE TODAY
   * `queue/registry.ts` asserts every handler is idempotent because the durable driver is
   * at-least-once. Without a claim, a second delivery of the same duplication would re-plan, re-copy
   * and re-commit — minting a SECOND project and overwriting `target_project_id`, so the first copy
   * becomes an orphan nothing points at. Re-entrancy is cheap to get right here and impossible to
   * detect later.
   */
  private async claim(duplicationId: string, now: Date): Promise<boolean> {
    const claimed = await db.update(project_duplications)
      .set({ status: 'copying', updated_at: now })
      .where(and(
        eq(project_duplications.id, duplicationId),
        or(
          eq(project_duplications.status, 'queued'),
          and(
            inArray(project_duplications.status, [...DUPLICATION_IN_FLIGHT_STATUSES]),
            lt(project_duplications.updated_at, duplicationStaleBefore(now)),
          ),
        ),
      ))
      .returning({ id: project_duplications.id });
    return claimed.length > 0;
  }

  /**
   * Execute one queued duplication end to end.
   *
   * The job body. Every failure path marks the row `failed` with a reason and leaves NO project:
   * the only thing written before the commit is bytes, and the commit is one transaction whose last
   * statement is the independence proof.
   */
  async run(duplicationId: string): Promise<string> {
    const [job] = await db.select().from(project_duplications).where(eq(project_duplications.id, duplicationId));
    if (!job) throw new Error(`duplication ${duplicationId} not found`);
    if (job.status === 'ready' || job.status === 'failed') {
      return job.target_project_id ?? '';
    }
    if (!(await this.claim(duplicationId, new Date()))) {
      logger.warn({ duplicationId, status: job.status }, 'duplication: already running elsewhere — not starting a second copy');
      return job.target_project_id ?? '';
    }

    // Liveness, written on a TIMER rather than only per object, so "this row has not moved in 5
    // minutes" is a sound test for "no process is running it" no matter how large one object is.
    // Unref'd: a pending beat must never hold the process open at shutdown.
    const heartbeat = setInterval(() => {
      void db.update(project_duplications)
        .set({ updated_at: new Date() })
        .where(eq(project_duplications.id, duplicationId))
        .catch((err: unknown) => logger.debug({ err, duplicationId }, 'duplication: heartbeat failed'));
    }, DUPLICATION_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      const snap = await this.loadSnapshot(job.source_project_id);
      if (!snap) throw new DuplicationRefused('Source project no longer exists', 404);

      const planned = this.buildPlan(snap);
      const { plan } = planned;
      const cap = duplicateMaxBytes();
      if (plan.estimatedBytes > cap) {
        throw new DuplicationRefused(
          `This project stores about ${Math.round(plan.estimatedBytes / 1e9)} GB of media, over the ${Math.round(cap / 1e9)} GB duplication limit.`,
          413,
        );
      }
      // Before the first byte: an object beyond even the multipart copy's reach makes this run
      // futile, and "you can try again" would be false advice for as long as the file exists.
      const tooBig = ProjectDuplicationService.oversizeRefusal(plan);
      if (tooBig) throw tooBig;

      await db.update(project_duplications).set({
        status: 'copying',
        plan: plan as unknown as Record<string, unknown>,
        objects_total: plan.storage.length,
        bytes_total: plan.estimatedBytes,
        updated_at: new Date(),
      }).where(eq(project_duplications.id, duplicationId));

      await this.copyBytes(plan, (copied) => {
        void db.update(project_duplications)
          .set({ objects_copied: copied, updated_at: new Date() })
          .where(eq(project_duplications.id, duplicationId))
          .catch((err: unknown) => logger.warn({ err }, 'duplication: progress write failed'));
      });
      await this.verifyBytes(plan);

      await db.update(project_duplications).set({
        status: 'committing', objects_copied: plan.storage.length, updated_at: new Date(),
      }).where(eq(project_duplications.id, duplicationId));

      // The independence proof runs INSIDE this call's transaction (see `commitRows` step 10), so a
      // violation rolls the copy back rather than leaving an unnamed corrupt project behind.
      const targetId = await this.commitRows(snap, planned, job.requested_by);

      await db.update(project_duplications).set({
        status: 'ready', target_project_id: targetId, finished_at: new Date(), updated_at: new Date(),
      }).where(eq(project_duplications.id, duplicationId));

      logger.info({ duplicationId, sourceProjectId: job.source_project_id, targetId }, 'project duplicated');
      return targetId;
    } catch (err) {
      const message = err instanceof DuplicationRefused
        ? err.message
        : 'Duplication failed. Nothing was created; you can try again.';
      logger.error({ err, duplicationId }, 'project duplication failed');
      await db.update(project_duplications).set({
        status: 'failed', error: message, finished_at: new Date(), updated_at: new Date(),
      }).where(eq(project_duplications.id, duplicationId)).catch((e: unknown) => {
        logger.error({ err: e, duplicationId }, 'duplication: could not record the failure');
      });
      throw err;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

// ── Reaping abandoned runs ────────────────────────────────────────────────────────────────────

/**
 * Fail duplication rows that no process is running any more, so the project they block is free.
 *
 * Bounded per pass and tolerant of a missing table, exactly like `sweepRetiredHlsRuns` — this runs
 * inside the web process. The condition is the staleness rule and nothing else: an in-flight status
 * whose `updated_at` has not moved for `DUPLICATION_STALE_AFTER_MS`, which a live run refutes every
 * `DUPLICATION_HEARTBEAT_MS`.
 *
 * `finished_at` is set for the same reason a real failure sets it: the row is terminal now.
 * Returns how many were reaped.
 */
export async function sweepAbandonedDuplications(
  limit: number = 50,
  now: Date = new Date(),
): Promise<number> {
  const abandoned = and(
    inArray(project_duplications.status, [...DUPLICATION_IN_FLIGHT_STATUSES]),
    lt(project_duplications.updated_at, duplicationStaleBefore(now)),
  );
  const reaped = await db.update(project_duplications)
    .set({ status: 'failed', error: DUPLICATION_ABANDONED_MESSAGE, finished_at: now, updated_at: now })
    // Bounded: reap the oldest few per pass rather than rewriting an unbounded set in one statement.
    // `IN (subquery … LIMIT n)` is how a bounded UPDATE is spelled in Postgres; the condition is the
    // SAME expression, embedded, so the two can never drift apart.
    .where(sql`${project_duplications.id} IN (
      SELECT ${project_duplications.id} FROM ${project_duplications}
      WHERE ${abandoned} ORDER BY ${project_duplications.updated_at} ASC LIMIT ${limit})`)
    .returning({ id: project_duplications.id });
  if (reaped.length > 0) logger.warn({ reaped: reaped.length }, 'duplication: reaped abandoned runs');
  return reaped.length;
}

/**
 * The in-flight duplication of `projectId` a new request must defer to — or null, having FAILED a
 * row that nothing is running any more.
 *
 * Here rather than in the handler so the staleness rule has exactly one implementation. The handler
 * needs it as well as the periodic reaper because the two answer different users: the reaper frees
 * the project within a sweep interval for someone who never comes back, and this frees it inside the
 * very request that wants it for someone who clicked Duplicate again — which is what a person does
 * when a copy has visibly been stuck for an hour.
 *
 * The write is a CAS on the same condition, so a run that woke up between the read and the update
 * still wins and keeps its row.
 */
export async function liveDuplicationFor(
  projectId: string,
  now: Date = new Date(),
): Promise<typeof project_duplications.$inferSelect | null> {
  const [inflight] = await db.select().from(project_duplications).where(and(
    eq(project_duplications.source_project_id, projectId),
    inArray(project_duplications.status, [...DUPLICATION_IN_FLIGHT_STATUSES]),
  ));
  if (!inflight) return null;
  if (inflight.updated_at >= duplicationStaleBefore(now)) return inflight;

  const [reaped] = await db.update(project_duplications)
    .set({ status: 'failed', error: DUPLICATION_ABANDONED_MESSAGE, finished_at: now, updated_at: now })
    .where(and(
      eq(project_duplications.id, inflight.id),
      inArray(project_duplications.status, [...DUPLICATION_IN_FLIGHT_STATUSES]),
      lt(project_duplications.updated_at, duplicationStaleBefore(now)),
    ))
    .returning({ id: project_duplications.id });
  if (!reaped) return inflight; // it moved under us — it is alive after all
  logger.warn({ projectId, duplicationId: inflight.id },
    'duplication: reaped an abandoned run so a new one can start');
  return null;
}

/** How often the reaper runs while the process is alive. Well under the poll's patience. */
export const DUPLICATION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Start the abandoned-run reaper. Returns a stop function.
 *
 * The `startHlsRetentionSweep` shape, for the same reasons: `unref` so a pending timer never holds
 * the process open, one deferred kick at start so a process that is recycled more often than the
 * interval still reaps (which is exactly the environment that STRANDS these rows), and a table that
 * is not migrated yet logged at debug rather than error.
 */
export function startDuplicationSweep(intervalMs = DUPLICATION_SWEEP_INTERVAL_MS): () => void {
  const run = (): void => {
    void sweepAbandonedDuplications().catch((err: unknown) => {
      if ((err as { code?: string } | null)?.code === '42P01') {
        logger.debug('duplication reaper: table not migrated yet, nothing to reap');
        return;
      }
      logger.error({ err }, 'duplication reaper failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const kick = setTimeout(run, 0);
  if (typeof kick.unref === 'function') kick.unref();
  return () => { clearInterval(timer); clearTimeout(kick); };
}

// ── Local helpers ─────────────────────────────────────────────────────────────────────────────

interface PlannedPoster {
  id: string;
  simulationId: string;
  packageRevision: string;
  variantKey: string;
  configHash: string;
  aspectProfile: string;
  qualityProfile: string;
  identity: string;
  variants: PosterVariantRecord[];
  transparent: boolean;
  capturedAt: Date;
}

/**
 * The storage key behind a `corpora.storage_url`, recovered exactly the way `CorpusBuilder` does —
 * one derivation, so the copier and the ingester cannot disagree about which object a corpus row
 * names. Returns null for a URL that does not look like a hosted object.
 */
export function corpusKeyFromUrl(url: string | null): string | null {
  if (!url || !/^https?:\/\//.test(url)) return null;
  const stripped = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
  // Dev origins serve objects under a route prefix; the key starts after it.
  const cleaned = stripped.replace(/^(local-storage|sim-public|hls-public|hls-proxy)\//, '');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * `simulations.entry_file` is a storage key on rows written since the simulations rewrite and a
 * full public URL on older ones. Both are rewritten by re-rooting the prefix they contain, so an
 * old row's URL keeps its original host.
 */
function rewriteEntryFile(entryFile: string, oldPrefix: string, newPrefix: string): string {
  if (!entryFile.includes(oldPrefix)) return entryFile;
  return entryFile.split(oldPrefix).join(newPrefix);
}

/**
 * The copy's `avatar_config`, with every face image pointed at the copy's own bytes.
 *
 * The persona itself — greeting, knowledge, voice — is authoring data and travels verbatim. What
 * cannot travel verbatim is `avatarCircles.faces[].imageUrl`: those objects live at
 * `avatar-circles/{sourceProjectId}/…`, the plan copies that whole prefix, and project DELETE purges
 * the source's copy of it. A face URL that is not rebased is a broken image the day the original is
 * deleted, and nothing in the schema would ever point at the cause.
 *
 * Rewritten field by field rather than by a blanket walk of the document: `knowledge` is up to 40 kB
 * of the author's prose and has no business being scanned for storage keys. Anything nested that
 * this misses is caught by `assertNoEscapingReferences`, which checks the whole blob as text and
 * fails the duplication rather than shipping a half-rebased copy.
 */
function rewriteAvatarConfig(config: unknown, copies: readonly StorageCopy[]): unknown {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const cfg = config as Record<string, unknown>;
  const circles = cfg.avatarCircles;
  if (!circles || typeof circles !== 'object' || Array.isArray(circles)) return config;
  const faces = (circles as Record<string, unknown>).faces;
  if (!Array.isArray(faces)) return config;

  const rebased = faces.map((face) => {
    if (!face || typeof face !== 'object' || Array.isArray(face)) return face;
    const f = face as Record<string, unknown>;
    if (typeof f.imageUrl !== 'string') return face;
    const moved = rerootUrlThroughCopies(f.imageUrl, copies);
    return moved === null ? face : { ...f, imageUrl: moved };
  });
  return { ...cfg, avatarCircles: { ...(circles as Record<string, unknown>), faces: rebased } };
}

/**
 * The copy's `guidance_meta`, with `mdUrl` pointed at the copy's own understanding document.
 *
 * The rest of the record (provider, model, hashes, counts) describes the ANALYSIS, which is about
 * the package bytes — identical in the copy — so it carries over unchanged. Only the URL names a
 * location, and the bytes at that location were copied to a new prefix by the package-root copy.
 */
function rewriteGuidanceMeta(meta: unknown, copies: readonly StorageCopy[]): unknown {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const m = meta as Record<string, unknown>;
  if (typeof m.mdUrl !== 'string') return meta;
  const moved = rerootUrlThroughCopies(m.mdUrl, copies);
  return moved === null ? meta : { ...m, mdUrl: moved };
}
