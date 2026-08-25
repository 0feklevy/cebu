/**
 * Duplicate project, against a REAL Postgres engine (plan §8).
 *
 * WHY PGLITE AND NOT THE HOUSE db-FAKE
 * Every property this feature claims is a property of the row GRAPH: that a copied section's
 * `video_file_id` resolves inside the copy, that the branch edges do not point at the original,
 * that a mid-copy failure rolls back to nothing. A hand-faked `db` that stores rows in an array has
 * no foreign keys, no transaction, and no way to be wrong — so it would pass every assertion here
 * while proving none of them. This suite applies the actual migrations to PGlite and binds drizzle
 * to it, exactly as `revisionService.test.ts` does and for the same reason.
 *
 * THE FIXTURE
 * One project populated across EVERY table in the copy matrix — two videos (one with a versioned
 * HLS tree, one legacy-shaped), images, audio, a branch graph with a default edge and an edge that
 * points back at its own project, two simulations (one revisioned, one legacy), a retired revision
 * that must NOT come along, posters at both the live and a stale package revision, four kinds of
 * timeline section, markers, and every authoring table — plus rows in each excluded table so that
 * "the copy is empty there" is a real observation rather than a vacuous one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import { eq } from 'drizzle-orm';

import * as schema from '../../../db/schema.js';

/** The transaction handle `assertNoEscapingReferences` is called with, as far as a test needs it. */
type TxLike = Pick<typeof import('../../../db/index.js').db, 'update' | 'delete'>;

const h = vi.hoisted(() => ({ dbRef: { current: null as unknown as Record<string, unknown> } }));

vi.mock('../../../db/index.js', () => ({
  db: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      const target = h.dbRef.current;
      const v = target[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const storageRef = vi.hoisted(() => ({ adapter: null as unknown }));
vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => storageRef.adapter,
}));

import {
  DUPLICATION_STALE_AFTER_MS, ProjectDuplicationService, liveDuplicationFor, sweepAbandonedDuplications,
} from '../ProjectDuplicationService.js';
import { rerootUrlThroughCopies, type StorageCopy } from '../duplicationPlan.js';
import { keyFromPublicUrlAgainst } from '../../storage/publicUrlKeys.js';
import { parseSectionEntries, wrapBridgeCombined } from '../../simulation/SimulationService.js';
import { wrapGuidanceCombined } from '../../simulation/GuidanceService.js';
import { computeManifestHash, type SimManifest } from 'shared/sim/simManifest';
import { deleteWithFallback, deleteWithPrefixFallback } from '../../storage/deleteWithFallback.js';
import { deleteHlsRetirementRowsForVideo, retireHlsRun, sweepRetiredHlsRuns } from '../../video/hlsRetention.js';
import { packageRevisionFor } from 'shared/sim/simRevision';
import { derivePackageRevision } from 'shared/sim/simIdentity';
import { posterIdentityString, posterStoragePath } from 'shared/sim/posterIdentity';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

// ── Fake storage ──────────────────────────────────────────────────────────────────────────────

/**
 * In-memory object store. `copyPrefix` implements the same "is the prefix, or under prefix + '/'"
 * rule the real adapters do, so a test cannot pass on semantics production does not have.
 */
function fakeStorage() {
  const objects = new Map<string, Buffer>();
  const adapter = {
    objects,
    /** Set to make the Nth copyObject throw — the mid-copy failure case. */
    failCopyAfter: null as number | null,
    copyCount: 0,
    uploadFile: vi.fn(async (key: string, bytes: Buffer) => { objects.set(key, bytes); return `https://cdn.test/${key}`; }),
    readObject: vi.fn(async (key: string) => {
      const o = objects.get(key);
      if (!o) throw new Error(`no such object: ${key}`);
      return o;
    }),
    headObject: vi.fn(async (key: string) => {
      const o = objects.get(key);
      return o ? { contentType: 'application/octet-stream', cacheControl: null, size: o.length, etag: null } : null;
    }),
    deleteFile: vi.fn(async (key: string) => { objects.delete(key); }),
    deleteWithPrefix: vi.fn(async (prefix: string) => {
      const base = prefix.replace(/\/+$/, '');
      for (const k of [...objects.keys()]) if (k === base || k.startsWith(`${base}/`)) objects.delete(k);
    }),
    listObjects: vi.fn(async (prefix: string) => {
      const base = prefix.replace(/\/+$/, '');
      return [...objects.keys()].filter((k) => k === base || k.startsWith(`${base}/`));
    }),
    objectExists: vi.fn(async (key: string) => objects.has(key)),
    copyObject: vi.fn(async (from: string, to: string) => {
      adapter.copyCount += 1;
      if (adapter.failCopyAfter !== null && adapter.copyCount > adapter.failCopyAfter) {
        throw new Error('simulated storage failure mid-copy');
      }
      const o = objects.get(from);
      if (!o) throw new Error(`copyObject: no such object ${from}`);
      objects.set(to, o);
    }),
    copyPrefix: vi.fn(async (from: string, to: string) => {
      const base = from.replace(/\/+$/, '');
      const dest = to.replace(/\/+$/, '');
      let n = 0;
      for (const k of [...objects.keys()]) {
        if (k !== base && !k.startsWith(`${base}/`)) continue;
        await adapter.copyObject(k, `${dest}${k.slice(base.length)}`);
        n += 1;
      }
      return n;
    }),
    getPublicUrl: (key: string) => `https://cdn.test/${key}`,
    getSimPublicUrl: (key: string) => `https://sim.test/${key}`,
    /**
     * The adapter's own inverse, through the SHARED helper the real adapters use.
     *
     * SUPABASE'S BASE IS IN THE LIST DELIBERATELY. The fake used to mint only `https://cdn.test/{key}`
     * — a shape the old host-stripping heuristic inverts correctly by accident — which is exactly why
     * no test could see that a Supabase-shaped `corpora.storage_url`
     * (`{origin}/storage/v1/object/public/{bucket}/{key}`) recovered a key that does not exist, and
     * failed every duplication of every project with a corpus file on that backend.
     */
    keyFromPublicUrl: (url: string | null | undefined) =>
      keyFromPublicUrlAgainst(url, ['https://cdn.test', 'https://sim.test', SUPABASE_PUBLIC_BASE]),
  };
  return adapter;
}

/** A real Supabase public base, shaped exactly as `SupabaseStorageAdapter` composes it. */
const SUPABASE_PUBLIC_BASE = 'https://ref.supabase.co/storage/v1/object/public/media';

let adapter: ReturnType<typeof fakeStorage>;
let pg: PGlite;
let svc: ProjectDuplicationService;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}
async function count(table: string, where: string, params: unknown[]): Promise<number> {
  const r = await one<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`, params);
  return Number(r.n);
}

// ── Fixture ───────────────────────────────────────────────────────────────────────────────────

interface Fixture {
  orgId: string;
  userId: string;
  otherProjectId: string;
  projectId: string;
  videoMainId: string;
  videoBrollId: string;
  imageId: string;
  audioId: string;
  seqAId: string;
  seqBId: string;
  choiceId: string;
  edgeSeqId: string;
  edgeSelfId: string;
  edgeExternalId: string;
  simRevisionedId: string;
  simLegacyId: string;
  activeRevId: string;
  retiredRevId: string;
  sectionMainId: string;
  sectionClipId: string;
  sectionImageId: string;
  sectionAudioId: string;
  avatarImageVisualId: string;
  avatarSimVisualId: string;
  avatarProjectSimVisualId: string;
  /** The `{uuid}` of the zip-uploaded library simulation — NOT a `simulations` row id. */
  avatarZipSimId: string;
  hlsRunId: string;
  /** The avatar-circle face image the project's `avatar_config` points at, by storage key. */
  faceKey: string;
}

const HLS_RUN = 'run7';
/** A run tree the ORIGINAL has already retired: bytes still there, awaiting the sweep. */
const HLS_RETIRED_RUN = 'run6';

// ── Simulation package bytes the fixture publishes ────────────────────────────────────────────
//
// REAL artefacts, produced by the SHIPPING generators. The suite used to seed `bytes:<key>` for
// every simulation file, which is why it could assert that `?section=` was remapped and still not
// notice that the bridge those sections dispatch through had never heard of them.

/** A section body that records which section actually ran. */
const sectionBody = (tag: string): string =>
  `var g = window.__ran = window.__ran || [];\ng.push('${tag}');\nreturn function () { g.push('stop:${tag}'); };`;

/** The guidance cue's audio: a real object under the simulation's own `guidance/` subtree. */
const GUIDANCE_AUDIO_REL = 'guidance/en/g1.deadbeef.mp3';

function guidanceEntries(audioUrl: string): unknown[] {
  return [{
    id: 'g1', kind: 'feature', title: 'Press play', narration: 'Press play to start the reaction.',
    enabled: true, confidence: 0.9, warnings: [],
    trigger: { kind: 'feature', targetId: 'playBtn', events: ['pointerdown'] },
    audioUrl,
  }];
}

async function seed(): Promise<Fixture> {
  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const user = await one<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-1', 'a@test') RETURNING id`);
  const other = await one<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'Other') RETURNING id`, [org.id, user.id]);
  const project = await one<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title, topic, status, visibility, share_token,
                           share_enabled_at, slug, view_count, access_type, price_cents,
                           thumbnail_key, thumbnail_url, metadata_status, seo_description, avatar_config)
     VALUES ($1,$2,'Photosynthesis','plants','ready','public','tok-123', now(), 'photosynthesis', 4242,
             'paid', 900, $3, $4, 'ready', 'How plants eat', $5::jsonb)
     RETURNING id`,
    [org.id, user.id, 'thumbnails/PROJ/cover.jpg', 'https://cdn.test/thumbnails/PROJ/cover.jpg',
     JSON.stringify({ greeting: 'hi', voiceId: 'v1' })]);
  // The thumbnail key was seeded with a placeholder so it can carry the real project id. So is the
  // avatar-circle face image: `avatar-circles/{projectId}/…` is project-scoped storage whose ONLY
  // pointer is the URL inside `avatar_config`, and project DELETE purges that whole prefix — so a
  // fixture with `{greeting, voiceId}` alone cannot see whether the copy's faces survive.
  const faceKey = `avatar-circles/${project.id}/face-a.png`;
  await pg.query(
    `UPDATE projects SET thumbnail_key = $2, thumbnail_url = $3, avatar_config = $4::jsonb WHERE id = $1`,
    [project.id, `thumbnails/${project.id}/cover.jpg`, `https://cdn.test/thumbnails/${project.id}/cover.jpg`,
     JSON.stringify({
       greeting: 'hi',
       voiceId: 'v1',
       avatarCircles: {
         enabled: true,
         count: 2,
         faces: [
           { speaker: 'host_a', side: 'left', label: 'Ada', imageUrl: `https://cdn.test/${faceKey}` },
           { speaker: 'host_b', side: 'right' },
         ],
       },
     })]);

  const seqA = await one<{ id: string }>(
    `INSERT INTO branch_sequences (project_id, label, is_entry, sort_order) VALUES ($1,'Intro',true,0) RETURNING id`,
    [project.id]);
  const seqB = await one<{ id: string }>(
    `INSERT INTO branch_sequences (project_id, label, is_entry, sort_order) VALUES ($1,'Deep dive',false,1) RETURNING id`,
    [project.id]);

  const videoMain = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec,
                              hls_status, hls_current_tier, waveform_peaks, sequence_id, sequence_order,
                              crop_status, crop_source_hash, captions_status, captions_vtt, captions_source_hash)
     VALUES ($1,'main.mp4',1048576,$2,'ready',120,'ready','720p','[0.1,0.9]',$3,0,
             'ready','crophash','ready','WEBVTT

00:00.000 --> 00:02.000
hello','caphash')
     RETURNING id`,
    [project.id, `videos/${project.id}/main.mp4`, seqA.id]);
  await pg.query(
    `UPDATE video_files SET hls_master_key=$2, hls_360p_key=$3, crop_key=$4, captions_vtt_key=$5 WHERE id=$1`,
    [videoMain.id,
     `hls/${videoMain.id}/${HLS_RUN}/master.m3u8`,
     `hls/${videoMain.id}/${HLS_RUN}/360p/index.m3u8`,
     `crop/${videoMain.id}.json`,
     `captions/${project.id}/${videoMain.id}/cap.vtt`]);

  // A run tree the original RETIRED before this duplication: its bytes are still in storage
  // (the grace window has not elapsed) and an `hls_retired_runs` row names it. That row is
  // deliberately not copied, so a copied tree would be reachable from nothing and reapable by
  // nothing. Retired BEFORE the copy, which is the case the pre-existing test could not reach —
  // it retired afterwards, so the plan never saw a retirement at all.
  await pg.query(
    `INSERT INTO hls_retired_runs (video_file_id, prefix, retire_after) VALUES ($1,$2, now() + interval '24 hours')`,
    [videoMain.id, `hls/${videoMain.id}/${HLS_RETIRED_RUN}`]);

  // A legacy-shaped (unversioned) HLS tree, so the copy is proven to handle both layouts.
  const videoBroll = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, is_broll, hls_status)
     VALUES ($1,'broll.mp4',2048,$2,'ready',true,'ready') RETURNING id`,
    [project.id, `videos/${project.id}/broll.mp4`]);
  await pg.query(`UPDATE video_files SET hls_master_key=$2 WHERE id=$1`,
    [videoBroll.id, `hls/${videoBroll.id}/master.m3u8`]);

  const image = await one<{ id: string }>(
    `INSERT INTO image_files (project_id, filename, storage_key, original_url, width, height, crop_x, crop_w)
     VALUES ($1,'leaf.png',$2,$3,800,600,0.1,0.8) RETURNING id`,
    [project.id, `images/${project.id}/leaf.png`, `https://cdn.test/images/${project.id}/leaf.png`]);
  const audio = await one<{ id: string }>(
    `INSERT INTO audio_files (project_id, filename, storage_key, url, duration_sec)
     VALUES ($1,'vo.mp3',$2,$3,12.5) RETURNING id`,
    [project.id, `audio/${project.id}/vo.mp3`, `https://cdn.test/audio/${project.id}/vo.mp3`]);

  // ── Simulations ──
  const simRev = await one<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, status, bridge_hash,
                              package_class, canary_report, canary_at, prepare_budget_ms, guidance_status)
     VALUES ($1,'Chloroplast','PLACEHOLDER','PLACEHOLDER','ready','bh-1','managed-presentable',$2::jsonb, now(), 800,'ready')
     RETURNING id`, [project.id, JSON.stringify({ verdict: 'pass' })]);
  const simRevPrefix = `simulations/${project.id}/${simRev.id}`;
  // `guidance_meta.mdUrl` is a public URL of `{prefix}/guidance/understanding.md` with no shadow key
  // column — the editor's "analysis ↗" link. The BYTES are copied by the package-root copy; whether
  // the URL follows them is what this makes observable.
  // `guidance[].audioUrl` is a full public URL under `{prefix}/guidance/…` with NO shadow key
  // column, minted by `GuidanceService`. It is BOTH a database column and a literal baked into the
  // generated `guidance.js` overlay, and the overlay is the one that fires the cue in the viewer.
  await pg.query(
    // `canary_report` is set HERE rather than at INSERT because a realistic one embeds the storage
    // prefix, and the prefix embeds the simulation's own id. The row-level report is a separate
    // value from the revision's and needs the same realism: a two-field stub cannot contain a
    // project id, and a report that cannot contain one cannot exercise the escape scan.
    `UPDATE simulations SET storage_prefix=$2, entry_file=$3, guidance_meta=$4::jsonb,
                            guidance=$5::jsonb, guidance_status='ready', canary_report=$6::jsonb
     WHERE id=$1`,
    [simRev.id, simRevPrefix, `${simRevPrefix}/index.html`, JSON.stringify({
      provider: 'claude', model: 'm', confidence: 0.9, entryCount: 3, language: 'en',
      mdUrl: `https://sim.test/${simRevPrefix}/guidance/understanding.md`,
    }), JSON.stringify(guidanceEntries(`https://sim.test/${simRevPrefix}/${GUIDANCE_AUDIO_REL}`)),
     JSON.stringify({
       packageRevision: 'rev0123456789ab', simulationId: simRev.id, storagePrefix: simRevPrefix,
       classification: 'managed-presentable', cases: [],
       assets: [{ path: `${simRevPrefix}/index.html`, ok: true, status: 200, contentType: 'text/html' }],
       aborted: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), engine: 'chromium/1',
     })]);

  const retired = await one<{ id: string }>(
    `INSERT INTO sim_revisions (simulation_id, revision_number, status, manifest_hash, entry_path, activated_at)
     VALUES ($1,1,'retired',$2,'package/index.html', now()) RETURNING id`,
    [simRev.id, 'a'.repeat(64)]);
  const active = await one<{ id: string }>(
    `INSERT INTO sim_revisions (simulation_id, revision_number, status, manifest_hash, entry_path,
                                bridge_protocol_version, runtime_protocol_version, package_class,
                                canary_report, canary_at, rollback_of_revision_id, created_by,
                                metadata, activated_at)
     VALUES ($1,2,'active',$2,'package/index.html',3,3,'managed-presentable',$3::jsonb, now(), $4,'tester',$5::jsonb, now())
     RETURNING id`,
    [simRev.id, 'b'.repeat(64), JSON.stringify({
      // A REALISTIC canary report, not `{verdict:'pass'}`. The real contract
      // (shared/src/sim/canaryContract.ts) makes `storagePrefix` and `simulationId` required, and a
      // project-scoped prefix inside an unrewritten jsonb column is what the escape scan fails the
      // whole commit on. The old two-field stub could not contain a project id, so this entire
      // class of permanent duplication blocker was invisible to the suite.
      packageRevision: 'rev0123456789ab',
      simulationId: simRev.id,
      storagePrefix: simRevPrefix,
      classification: 'managed-presentable',
      cases: [], assets: [{ path: `${simRevPrefix}/bridge.js`, ok: true, status: 200, contentType: 'text/javascript' }],
      aborted: null, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), engine: 'chromium/1',
    }), retired.id, JSON.stringify({
      note: 'orig',
      // Written by `RevisionMigration` on every package migrated off a legacy prefix — and it is
      // `simulations/{projectId}/{simId}`, so it NAMES THE SOURCE PROJECT. Carried verbatim it made
      // any project with a migrated simulation permanently un-duplicatable.
      migratedFromLegacyPrefix: simRevPrefix,
      // The publication-time capability record (migrations 055 + 057). Both values are the NON-default
      // answer on purpose: `null` is the state a copy that forgot to project them would land in, and
      // it is indistinguishable from these two unless they disagree with it.
      bridgeCapabilities: { scriptApplied: false, requiresImportMaps: true },
    })]);
  await pg.query(
    `UPDATE simulations SET active_revision_id=$2, active_revision_entry_key=$3, revision_counter=2,
                            bridge_ack_capable=false, requires_import_maps=true WHERE id=$1`,
    [simRev.id, active.id, `${simRevPrefix}/revisions/${active.id}/package/index.html`]);

  const simLegacy = await one<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, status, bridge_hash)
     VALUES ($1,'Legacy sim','PLACEHOLDER','PLACEHOLDER','ready','bh-legacy') RETURNING id`, [project.id]);
  const simLegacyPrefix = `simulations/${project.id}/${simLegacy.id}`;
  await pg.query(`UPDATE simulations SET storage_prefix=$2, entry_file=$3 WHERE id=$1`,
    [simLegacy.id, simLegacyPrefix, `${simLegacyPrefix}/index.html`]);

  // ── Timeline ──
  const sectionMain = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, label,
                                    sort_order, simulation_id, sim_script, simple_ui, track)
     VALUES ($1,$2,0,30,'simulation','Sim bit',0,$3,'intro',true,'main') RETURNING id`,
    [project.id, videoMain.id, simRev.id]);
  await pg.query(`UPDATE timeline_sections SET simulation_url=$2 WHERE id=$1`, [
    sectionMain.id,
    `https://sim.test/${simRevPrefix}/revisions/${active.id}/package/index.html?section=${sectionMain.id}&v=bh-1`,
  ]);
  const sectionClip = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, sort_order,
                                    clip_source_video_id, clip_in_sec, track, global_offset_sec)
     VALUES ($1,$2,30,35,'clip',1,$3,2.5,'broll',30) RETURNING id`,
    [project.id, videoMain.id, videoBroll.id]);
  const sectionImage = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, sort_order,
                                    clip_source_image_id, camera_movement, track, global_offset_sec)
     VALUES ($1,$2,35,40,'clip',2,$3,'zoom_out','broll',35) RETURNING id`,
    [project.id, videoMain.id, image.id]);
  const sectionAudio = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, sort_order,
                                    clip_source_audio_id, broll_volume, track, global_offset_sec)
     VALUES ($1,$2,40,45,'clip',3,$3,0.4,'audio',40) RETURNING id`,
    [project.id, videoMain.id, audio.id]);
  await pg.query(
    `INSERT INTO timeline_markers (project_id, at_sec, label, notes) VALUES ($1, 12.5, 'Check audio', 'hiss')`,
    [project.id]);

  // ── Posters: one at the LIVE package revision, one at a stale one ──
  const livePackageRevision = packageRevisionFor(
    { id: simRev.id, bridge_hash: 'bh-1', active_revision_id: active.id }, derivePackageRevision);
  const liveKey = {
    packageRevision: livePackageRevision, variantKey: sectionMain.id, configHash: 'cfg1',
    aspectProfile: 'wide' as const, qualityProfile: 'high' as const,
  };
  const liveIdentity = posterIdentityString(liveKey);
  await pg.query(
    `INSERT INTO sim_posters (simulation_id, package_revision, variant_key, config_hash, aspect_profile,
                              quality_profile, identity, variants, transparent)
     VALUES ($1,$2,$3,'cfg1','wide','high',$4,$5::jsonb,false)`,
    [simRev.id, livePackageRevision, sectionMain.id, liveIdentity, JSON.stringify([{
      size: 'standard', format: 'webp',
      path: posterStoragePath(simRevPrefix, liveKey, 'standard', 'webp'),
      checksum: 'c'.repeat(64), contentType: 'image/webp', width: 1280, height: 720, bytes: 100,
    }])]);
  await pg.query(
    `INSERT INTO sim_posters (simulation_id, package_revision, variant_key, config_hash, aspect_profile,
                              quality_profile, identity, variants, transparent)
     VALUES ($1,'stalerev00000000',$2,'cfg1','wide','high','stale-identity',$3::jsonb,false)`,
    [simRev.id, sectionMain.id, JSON.stringify([{
      size: 'standard', format: 'webp', path: `${simRevPrefix}/posters/stale-identity/standard.webp`,
      checksum: 'd'.repeat(64), contentType: 'image/webp', width: 1280, height: 720, bytes: 100,
    }])]);

  // ── Branch graph ──
  const choice = await one<{ id: string }>(
    `INSERT INTO branch_choice_points (project_id, sequence_id, lead_in_sec, behavior, prompt, layout)
     VALUES ($1,$2,8,'pause','Which path?','cards') RETURNING id`, [project.id, seqA.id]);
  const edgeSeq = await one<{ id: string }>(
    `INSERT INTO branch_edges (project_id, choice_point_id, label, sort_order, destination_type, dest_sequence_id)
     VALUES ($1,$2,'Go deeper',0,'sequence',$3) RETURNING id`, [project.id, choice.id, seqB.id]);
  // "restart into me" — an internal reference wearing an external shape.
  const edgeSelf = await one<{ id: string }>(
    `INSERT INTO branch_edges (project_id, choice_point_id, label, sort_order, destination_type, dest_project_id)
     VALUES ($1,$2,'Start over',1,'project',$3) RETURNING id`, [project.id, choice.id, project.id]);
  // A genuine cross-project link, which must survive pointing where the author pointed it.
  const edgeExternal = await one<{ id: string }>(
    `INSERT INTO branch_edges (project_id, choice_point_id, label, sort_order, destination_type, dest_project_id)
     VALUES ($1,$2,'See the other one',2,'project',$3) RETURNING id`, [project.id, choice.id, other.id]);
  await pg.query(`UPDATE branch_choice_points SET default_edge_id=$2 WHERE id=$1`, [choice.id, edgeSeq.id]);

  // ── Authoring inputs ──
  await pg.query(
    `INSERT INTO corpora (project_id, source_type, source_url, storage_url, extracted_md, hash, ingestion_status)
     VALUES ($1,'pdf','paper.pdf',$2,'# Notes','h1','ready')`,
    [project.id, `https://cdn.test/projects/${project.id}/corpus/1_paper.pdf`]);
  // The SAME object, published under a SUPABASE public URL. The shape is
  // `{origin}/storage/v1/object/public/{bucket}/{key}`, which a host-stripping heuristic recovers
  // as `storage/v1/object/public/media/projects/{p}/corpus/…` — a string that still contains the
  // project id, so the plan maps it and commits to copying an object that does not exist.
  await pg.query(
    `INSERT INTO corpora (project_id, source_type, source_url, storage_url, extracted_md, hash, ingestion_status)
     VALUES ($1,'pdf','supabase.pdf',$2,'# Supa','h2','ready')`,
    [project.id, `${SUPABASE_PUBLIC_BASE}/projects/${project.id}/corpus/2_supabase.pdf`]);
  await pg.query(
    `INSERT INTO scripts (project_id, version, body_json, status) VALUES ($1,1,$2::jsonb,'ready')`,
    [project.id, JSON.stringify({ turns: [] })]);
  await pg.query(
    `INSERT INTO scenes (project_id, script_version, idx, speaker, start_ms, end_ms, transcript)
     VALUES ($1,1,0,'host_a',0,1000,'hello')`, [project.id]);
  await pg.query(
    `INSERT INTO camera_plans (project_id, script_version, cuts_json) VALUES ($1,1,$2::jsonb)`,
    [project.id, JSON.stringify([{ at: 0 }])]);

  // THREE library rows, because the avatar library × duplication seam has three distinct shapes and
  // the fixture used to carry only the two easy ones — with `visual_spec` NULL on both, which is
  // exactly why the pointer INSIDE that document was never observed.
  const avatarImage = await one<{ id: string }>(
    `INSERT INTO avatar_visuals (project_id, scope, source, visual_type, caption, image_key, image_url,
                                 visual_spec, use_count)
     VALUES ($1,'basic','editor','image','A leaf',$2,$3,$4::jsonb,17) RETURNING id`,
    [project.id, 'avatar/images/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.png',
     'https://cdn.test/avatar/images/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.png',
     JSON.stringify({ type: 'image', imageType: 'realistic', source: 'upload' })]);
  // (1) A ZIP-UPLOADED library simulation. `avatar.controller` mints `simulations/{projectId}/{uuid}`
  // — project-scoped storage with NO `simulations` row — and records the entry as a STORAGE KEY
  // inside `visual_spec`, beside the three columns that are already re-rooted. That key names the
  // source project, so leaving it verbatim is both a live cross-project pointer and (since the
  // generic jsonb scan) a duplication that fails inside the commit and rolls back.
  const avatarZipSimId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const avatarZipPrefix = `simulations/${project.id}/${avatarZipSimId}`;
  const avatarSim = await one<{ id: string }>(
    `INSERT INTO avatar_visuals (project_id, scope, source, visual_type, caption, sim_storage_prefix,
                                 sim_entry_url, visual_spec)
     VALUES ($1,'extended','generated','simulation','Orbit',$2,$3,$4::jsonb) RETURNING id`,
    [project.id, avatarZipPrefix, `https://sim.test/${avatarZipPrefix}/index.html`,
     JSON.stringify({
       type: 'simulation', caption: 'Orbit', source: 'zip-upload',
       entryKey: `${avatarZipPrefix}/index.html`,
     })]);
  // (2) What `syncBasicLibrary` writes for EVERY ready simulation of the project: a library row
  // pointing at the simulation's OWN prefix. Nothing about it is library-owned, so a duplication
  // that treats it as a fresh tree to copy re-copies the whole package — retired revisions and
  // stale posters included, which the package copy deliberately leaves behind.
  const avatarProjectSim = await one<{ id: string }>(
    `INSERT INTO avatar_visuals (project_id, scope, source, visual_type, lookup_key, caption,
                                 sim_storage_prefix, sim_entry_url, visual_spec)
     VALUES ($1,'basic','editor','simulation','Chloroplast','Chloroplast',$2,$3,$4::jsonb) RETURNING id`,
    [project.id, simRevPrefix,
     `https://sim.test/${simRevPrefix}/revisions/${active.id}/package/index.html`,
     JSON.stringify({ type: 'simulation', caption: 'Chloroplast' })]);

  // ── Rows in every EXCLUDED table, so "empty for the copy" is a real observation ──
  await pg.query(
    `INSERT INTO branch_path_events (project_id, session_id, event_type, sequence_id, edge_id)
     VALUES ($1,'sess','choice',$2,$3)`, [project.id, seqA.id, edgeSeq.id]);
  await pg.query(
    `INSERT INTO token_usage (user_id, project_id, provider, model, task, input_tokens, output_tokens)
     VALUES ($1,$2,'claude','m','t',10,20)`, [user.id, project.id]);
  await pg.query(`INSERT INTO jobs (type, project_id) VALUES ('transcode',$1)`, [project.id]);
  await pg.query(
    `INSERT INTO video_generation_jobs (project_id, section_id, model, original_prompt,
                                        target_duration_sec, target_global_offset_sec)
     VALUES ($1,$2,'kling','a cat',5,30)`, [project.id, sectionClip.id]);
  await pg.query(
    `INSERT INTO audio_renders (project_id, script_version, status) VALUES ($1,1,'ready')`, [project.id]);
  await pg.query(
    `INSERT INTO collaborators (content_type, content_id, invited_email) VALUES ('project',$1,'b@test')`,
    [project.id]);
  await pg.query(
    `INSERT INTO avatar_conversations (session_key, character_id, project_id, role, content)
     VALUES ('s','einstein',$1,'user','hi')`, [project.id]);
  const playlist = await one<{ id: string }>(
    `INSERT INTO playlists (org_id, title) VALUES ($1,'PL') RETURNING id`, [org.id]);
  await pg.query(
    `INSERT INTO playlist_items (playlist_id, project_id, position) VALUES ($1,$2,0)`, [playlist.id, project.id]);
  const course = await one<{ id: string }>(
    `INSERT INTO courses (org_id, kind, slug, publish_state, language) VALUES ($1,'single','a-course','draft','en') RETURNING id`,
    [org.id]);
  await pg.query(
    `INSERT INTO course_lessons (course_id, project_id, position, slug) VALUES ($1,$2,0,'lesson-one')`,
    [course.id, project.id]);

  return {
    orgId: org.id, userId: user.id, otherProjectId: other.id, projectId: project.id,
    videoMainId: videoMain.id, videoBrollId: videoBroll.id, imageId: image.id, audioId: audio.id,
    seqAId: seqA.id, seqBId: seqB.id, choiceId: choice.id,
    edgeSeqId: edgeSeq.id, edgeSelfId: edgeSelf.id, edgeExternalId: edgeExternal.id,
    simRevisionedId: simRev.id, simLegacyId: simLegacy.id, activeRevId: active.id, retiredRevId: retired.id,
    sectionMainId: sectionMain.id, sectionClipId: sectionClip.id,
    sectionImageId: sectionImage.id, sectionAudioId: sectionAudio.id,
    avatarImageVisualId: avatarImage.id, avatarSimVisualId: avatarSim.id,
    avatarProjectSimVisualId: avatarProjectSim.id, avatarZipSimId,
    hlsRunId: HLS_RUN, faceKey,
  };
}

/** Seed the storage objects the fixture's rows name. */
function seedObjects(f: Fixture, simRevPrefix: string, simLegacyPrefix: string, activeRevId: string, liveIdentity: string): void {
  const put = (k: string): void => { adapter.objects.set(k, Buffer.from(`bytes:${k}`)); };
  put(`thumbnails/${f.projectId}/cover.jpg`);
  put(`videos/${f.projectId}/main.mp4`);
  put(`videos/${f.projectId}/broll.mp4`);
  put(`hls/${f.videoMainId}/${HLS_RUN}/master.m3u8`);
  put(`hls/${f.videoMainId}/${HLS_RUN}/360p/index.m3u8`);
  put(`hls/${f.videoMainId}/${HLS_RUN}/360p/seg_000.ts`);
  put(`hls/${f.videoMainId}/${HLS_RETIRED_RUN}/master.m3u8`);
  put(`hls/${f.videoMainId}/${HLS_RETIRED_RUN}/360p/seg_000.ts`);
  put(`hls/${f.videoBrollId}/master.m3u8`);
  put(`hls/${f.videoBrollId}/360p/seg_000.ts`);
  put(`crop/${f.videoMainId}.json`);
  put(`captions/${f.projectId}/${f.videoMainId}/cap.vtt`);
  put(`images/${f.projectId}/leaf.png`);
  put(`audio/${f.projectId}/vo.mp3`);
  put(f.faceKey);
  put(`${simRevPrefix}/index.html`);
  put(`${simRevPrefix}/assets/app.js`);
  put(`${simRevPrefix}/guidance/understanding.md`);
  put(`${simRevPrefix}/${GUIDANCE_AUDIO_REL}`);
  put(`${simRevPrefix}/revisions/retired-tree/package/index.html`);
  put(`${simRevPrefix}/posters/${liveIdentity}/standard.webp`);
  put(`${simRevPrefix}/posters/stale-identity/standard.webp`);
  put('avatar/images/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.png');
  // The ZIP-uploaded library visual: a package the library genuinely owns, living under the
  // project's simulation namespace with NO `simulations` row of its own. It gets a `revisions/`
  // subtree here on purpose — nothing writes one today, but the copy routes this through the same
  // package-root exclusion as a real package, and a fixture that cannot tell a filtered copy from
  // an unfiltered one cannot catch that exclusion regressing.
  const zipPrefix = `simulations/${f.projectId}/${f.avatarZipSimId}`;
  put(`${zipPrefix}/index.html`);
  put(`${zipPrefix}/assets/orbit.js`);
  put(`${zipPrefix}/revisions/should-not-be-copied/package/index.html`);
  put(`projects/${f.projectId}/corpus/1_paper.pdf`);
  put(`projects/${f.projectId}/corpus/2_supabase.pdf`);

  // ── The generated artefacts, produced by the shipping generators ──
  const text = (k: string, s: string): void => { adapter.objects.set(k, Buffer.from(s, 'utf-8')); };
  const revRoot = `${simRevPrefix}/revisions/${activeRevId}`;
  const entryHtml = '<html><body><div id="app"></div>\n<script src="./bridge.js?v=bh-1"></script>\n</body></html>';
  // TWO sections in ONE package — the whole point. A single-section bridge would still answer
  // `main`, and the dispatch defect would be invisible.
  const bridgeJs = wrapBridgeCombined(new Map([
    [f.sectionMainId, sectionBody('main-section')],
    [f.sectionClipId, sectionBody('clip-section')],
  ]));
  text(`${revRoot}/package/index.html`, entryHtml);
  text(`${revRoot}/package/bridge.js`, bridgeJs);
  text(`${revRoot}/manifest.json`, JSON.stringify(revisionManifest(f, activeRevId, entryHtml, bridgeJs), null, 2));
  // The overlay the VIEWER loads, assembled by the real generator so the `audioUrl` literals are
  // exactly the ones production bakes in.
  text(`${simRevPrefix}/guidance.js`,
    wrapGuidanceCombined(guidanceEntries(`https://sim.test/${simRevPrefix}/${GUIDANCE_AUDIO_REL}`) as never));
  // The legacy simulation keeps its bridge at the mutable package root — the other layout.
  text(`${simLegacyPrefix}/index.html`, entryHtml);
  text(`${simLegacyPrefix}/bridge.js`, wrapBridgeCombined(new Map([[f.sectionMainId, sectionBody('legacy-main')]])));
}

/** A real `SimManifest` for the fixture's active revision, hashed over the bytes it seeds. */
function revisionManifest(f: Fixture, revisionId: string, entryHtml: string, bridgeJs: string): SimManifest {
  const file = (path: string, role: 'entry' | 'runtime', body: string, contentType: string) => ({
    path, role: role as SimManifest['files'][number]['role'],
    hash: createHash('sha256').update(Buffer.from(body, 'utf-8')).digest('hex'),
    bytes: Buffer.byteLength(body, 'utf-8'), contentType,
    cacheControl: 'public, max-age=31536000, immutable',
  });
  return {
    manifestVersion: 1,
    simulationId: f.simRevisionedId,
    projectId: f.projectId,
    revisionId,
    revisionNumber: 2,
    bridgeProtocolVersion: 3,
    runtimeProtocolVersion: 3,
    entry: 'package/index.html',
    runtime: ['package/bridge.js'],
    files: [
      file('package/index.html', 'entry', entryHtml, 'text/html; charset=utf-8'),
      file('package/bridge.js', 'runtime', bridgeJs, 'application/javascript'),
    ],
    // The variant keys ARE section ids — the same ids the bridge dispatches on.
    variants: [
      { variantKey: f.sectionMainId, configHashes: ['cfg1'] },
      { variantKey: f.sectionClipId, configHashes: ['cfg1'] },
    ],
    posters: [],
    qualityProfiles: ['high'],
    externalDependencies: [],
    generatedFrom: {},
    canary: { classification: 'managed-presentable', ranAt: null, engine: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: null,
  };
}

let fx: Fixture;
let simRevPrefix: string;
let simLegacyPrefix: string;
let liveIdentity: string;
let sourceManifestHash: string;

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;

  fx = await seed();
  simRevPrefix = `simulations/${fx.projectId}/${fx.simRevisionedId}`;
  simLegacyPrefix = `simulations/${fx.projectId}/${fx.simLegacyId}`;
  liveIdentity = posterIdentityString({
    packageRevision: packageRevisionFor(
      { id: fx.simRevisionedId, bridge_hash: 'bh-1', active_revision_id: fx.activeRevId }, derivePackageRevision),
    variantKey: fx.sectionMainId, configHash: 'cfg1', aspectProfile: 'wide', qualityProfile: 'high',
  });

  adapter = fakeStorage();
  storageRef.adapter = adapter;
  seedObjects(fx, simRevPrefix, simLegacyPrefix, fx.activeRevId, liveIdentity);
  // The source revision's `manifest_hash` is the REAL hash of the manifest just seeded, so
  // "the copy's hash differs from the source's" is a statement about bytes rather than about a
  // placeholder string.
  sourceManifestHash = computeManifestHash(readManifest(`${simRevPrefix}/revisions/${fx.activeRevId}`));
  await pg.query(`UPDATE sim_revisions SET manifest_hash=$2 WHERE id=$1`, [fx.activeRevId, sourceManifestHash]);
  svc = new ProjectDuplicationService(adapter as never);
});

/** The manifest stored under a revision root, parsed. */
function readManifest(revisionRoot: string): SimManifest {
  return JSON.parse(adapter.objects.get(`${revisionRoot}/manifest.json`)!.toString('utf-8')) as SimManifest;
}

/** The section-id → body map a stored bridge.js dispatches on, read from the bytes. */
function bridgeSections(key: string): Map<string, string> {
  const bytes = adapter.objects.get(key);
  if (!bytes) throw new Error(`no bridge at ${key}`);
  return parseSectionEntries(bytes.toString('utf-8'));
}

afterEach(async () => { await pg.close(); vi.clearAllMocks(); });

/** Queue a duplication row and run it end to end. Returns the new project id. */
async function duplicate(): Promise<string> {
  const job = await one<{ id: string }>(
    `INSERT INTO project_duplications (source_project_id, requested_by) VALUES ($1,$2) RETURNING id`,
    [fx.projectId, fx.userId]);
  return svc.run(job.id);
}

// ── Re-rooting a URL that has no shadow key column ────────────────────────────────────────────

describe('rerootUrlThroughCopies', () => {
  // The shape a real plan has: one simulation prefix carrying THREE overlapping copies — the
  // customer bundle, the active revision tree inside it, and a poster whose destination path is not
  // a re-rooting of its source at all (its identity changes with the revision).
  const copies: StorageCopy[] = [
    { kind: 'package-root', from: 'simulations/p/s', to: 'simulations/q/t', reason: 'bundle' },
    { kind: 'prefix', from: 'simulations/p/s/revisions/r1', to: 'simulations/q/t/revisions/r2', reason: 'revision' },
    { kind: 'object', from: 'simulations/p/s/posters/old/standard.webp', to: 'simulations/q/t/posters/new/standard.webp', reason: 'poster' },
  ];

  it('resolves through the MOST SPECIFIC copy, not the first one in the list', () => {
    // A first-match substring scan answers `…/revisions/r1/…` here — the package-root copy encloses
    // it and comes first — and the copy would then point at a revision id it does not own.
    expect(rerootUrlThroughCopies('https://sim.test/simulations/p/s/revisions/r1/pkg/index.html', copies))
      .toBe('https://sim.test/simulations/q/t/revisions/r2/pkg/index.html');
    // A poster's path changes SHAPE, so the enclosing prefix copy must not claim it either.
    expect(rerootUrlThroughCopies('https://sim.test/simulations/p/s/posters/old/standard.webp', copies))
      .toBe('https://sim.test/simulations/q/t/posters/new/standard.webp');
    // And the bundle itself still resolves through the package root.
    expect(rerootUrlThroughCopies('https://sim.test/simulations/p/s/assets/app.js', copies))
      .toBe('https://sim.test/simulations/q/t/assets/app.js');
  });

  it('matches on segment boundaries only', () => {
    // The sibling whose id merely starts with the copied one. An unanchored `indexOf` rewrites it.
    expect(rerootUrlThroughCopies('https://sim.test/simulations/p/sEXTRA/index.html', copies)).toBeNull();
    expect(rerootUrlThroughCopies('https://sim.test/simulations/p/s-2/index.html', copies)).toBeNull();
  });

  it('keeps the host, any route prefix, and the query string', () => {
    // Dev origins serve objects under a route prefix; the key is the SUFFIX, not the whole path.
    expect(rerootUrlThroughCopies('http://localhost:4000/sim-public/simulations/p/s/index.html?v=bh1', copies))
      .toBe('http://localhost:4000/sim-public/simulations/q/t/index.html?v=bh1');
  });

  it('returns null when the plan copies nothing the URL names', () => {
    expect(rerootUrlThroughCopies('https://cdn.test/thumbnails/other/cover.jpg', copies)).toBeNull();
    expect(rerootUrlThroughCopies('https://example.com/', copies)).toBeNull();
  });
});

// ── The dry run ───────────────────────────────────────────────────────────────────────────────

describe('dry run', () => {
  it('names every table in the matrix, and writes nothing', async () => {
    const before = adapter.objects.size;
    const plan = await svc.dryRun(fx.projectId);
    expect(plan).not.toBeNull();
    expect(plan!.rowCounts).toMatchObject({
      projects: 1, video_files: 2, image_files: 1, audio_files: 1,
      timeline_sections: 4, timeline_markers: 1,
      branch_sequences: 2, branch_choice_points: 1, branch_edges: 3,
      simulations: 2, sim_revisions: 1, sim_posters: 1,
      scripts: 1, scenes: 1, camera_plans: 1, corpora: 2, avatar_visuals: 3,
    });
    // Nothing written, and no row created.
    expect(adapter.objects.size).toBe(before);
    expect(adapter.copyObject).not.toHaveBeenCalled();
    expect(await count('projects', 'true', [])).toBe(2);
  });

  it('reports the excluded tables with their source row counts', async () => {
    const plan = (await svc.dryRun(fx.projectId))!;
    expect(plan.excluded['branch_path_events'].rows).toBe(1);
    expect(plan.excluded['token_usage'].rows).toBe(1);
    expect(plan.excluded['video_generation_jobs'].rows).toBe(1);
    expect(plan.excluded['collaborators'].rows).toBe(1);
    expect(plan.excluded['playlist_items'].rows).toBe(1);
    expect(plan.excluded['course_lessons'].rows).toBe(1);
    expect(plan.excluded['avatar_conversations'].rows).toBe(1);
    // The poster captured against a retired revision is dropped, and says so.
    expect(plan.excluded['sim_posters (retired revisions)'].rows).toBe(1);
    for (const entry of Object.values(plan.excluded)) expect(entry.why.length).toBeGreaterThan(0);
  });

  it('counts every table it names, and reports the one it cannot count as NOT counted', async () => {
    // The plan is stored so an operator can answer "what did this copy?" months later. A table the
    // report names but nobody queried must not answer that question with a fabricated 0.
    await pg.query(
      `INSERT INTO billing_transactions (type, status, amount_cents, content_type, content_id)
       VALUES ('charge','succeeded',900,'project',$1)`, [fx.projectId]);
    await pg.query(
      `INSERT INTO user_purchases (user_id, content_type, content_id, amount_cents)
       VALUES ($1,'project',$2,900)`, [fx.userId, fx.projectId]);
    // Rows for a DIFFERENT project, so a count that ignores the filter is not mistaken for a pass.
    await pg.query(
      `INSERT INTO billing_transactions (type, status, amount_cents, content_type, content_id)
       VALUES ('charge','succeeded',100,'project',$1)`, [fx.otherProjectId]);

    const plan = (await svc.dryRun(fx.projectId))!;
    expect(plan.excluded['billing_transactions'].rows).toBe(1);
    expect(plan.excluded['user_purchases'].rows).toBe(1);
    // `sim_rum_events` is keyed by package revision and has no project dimension at all, so there is
    // no project-scoped number to report. `null` says that; `0` would claim a measurement.
    expect(plan.excluded['sim_rum_events'].rows).toBeNull();
    // Every table the exclusions name is present, none of them silently absent.
    for (const table of ['sim_rum_events', 'billing_transactions', 'user_purchases']) {
      expect(plan.excluded[table], table).toBeDefined();
    }
  });

  it('never copies an object onto itself', async () => {
    const plan = (await svc.dryRun(fx.projectId))!;
    expect(plan.storage.length).toBeGreaterThan(0);
    for (const c of plan.storage) expect(c.from).not.toBe(c.to);
  });

  it('says out loud that avatar_profiles has nothing project-scoped to copy', async () => {
    const plan = (await svc.dryRun(fx.projectId))!;
    expect(plan.warnings.join(' ')).toContain('avatar_profiles');
  });
});

// ── (a) + (b): FKs resolve inside the copy, nothing escapes ───────────────────────────────────

describe('independence of the copied row graph', () => {
  it('(a) every copied FK resolves inside the new project', async () => {
    const target = await duplicate();

    // The service's own assertion runs on every duplication; re-run it explicitly so a regression
    // here fails as an assertion rather than as a mysterious downstream symptom.
    await expect(svc.assertNoEscapingReferences(fx.projectId, target)).resolves.toBeUndefined();

    expect(await count(
      `timeline_sections s JOIN video_files v ON v.id = s.video_file_id`,
      `s.project_id = $1 AND v.project_id = $1`, [target])).toBe(4);
    expect(await count(
      `timeline_sections s JOIN simulations m ON m.id = s.simulation_id`,
      `s.project_id = $1 AND m.project_id = $1`, [target])).toBe(1);
    expect(await count(
      `branch_edges e JOIN branch_choice_points c ON c.id = e.choice_point_id`,
      `e.project_id = $1 AND c.project_id = $1`, [target])).toBe(3);
    expect(await count(
      `branch_choice_points c JOIN branch_edges e ON e.id = c.default_edge_id`,
      `c.project_id = $1 AND e.project_id = $1`, [target])).toBe(1);
    expect(await count(
      `video_files v JOIN branch_sequences q ON q.id = v.sequence_id`,
      `v.project_id = $1 AND q.project_id = $1`, [target])).toBe(1);
  });

  it('(b) zero references escape to the original', async () => {
    const target = await duplicate();
    const src = fx.projectId;

    // No copied row may name an id that belongs to the source.
    expect(await count('timeline_sections', `project_id=$1 AND (
      video_file_id IN (SELECT id FROM video_files WHERE project_id=$2)
      OR simulation_id IN (SELECT id FROM simulations WHERE project_id=$2)
      OR clip_source_video_id IN (SELECT id FROM video_files WHERE project_id=$2)
      OR clip_source_image_id IN (SELECT id FROM image_files WHERE project_id=$2)
      OR clip_source_audio_id IN (SELECT id FROM audio_files WHERE project_id=$2))`,
      [target, src])).toBe(0);
    expect(await count('branch_edges', `project_id=$1 AND
      dest_sequence_id IN (SELECT id FROM branch_sequences WHERE project_id=$2)`, [target, src])).toBe(0);
    expect(await count('video_files', `project_id=$1 AND
      sequence_id IN (SELECT id FROM branch_sequences WHERE project_id=$2)`, [target, src])).toBe(0);

    // No copied storage column may name the source's namespace.
    expect(await count('video_files', `project_id=$1 AND (
      storage_key LIKE '%'||$2||'%' OR hls_master_key LIKE '%'||$2||'%'
      OR hls_360p_key LIKE '%'||$2||'%' OR crop_key LIKE '%'||$2||'%'
      OR captions_vtt_key LIKE '%'||$2||'%')`, [target, src])).toBe(0);
    expect(await count('simulations', `project_id=$1 AND storage_prefix LIKE '%'||$2||'%'`, [target, src])).toBe(0);
    expect(await count('timeline_sections', `project_id=$1 AND simulation_url LIKE '%'||$2||'%'`, [target, src])).toBe(0);
    // …nor the source's ENTITY ids, which is the subtler half: hls/ and crop/ keys are keyed on the
    // video file id, not on the project id.
    expect(await count('video_files', `project_id=$1 AND (
      hls_master_key LIKE '%'||$2||'%' OR crop_key LIKE '%'||$2||'%')`, [target, fx.videoMainId])).toBe(0);
  });

  it('keeps a genuine cross-project edge pointed where the author pointed it, and follows a self-link', async () => {
    const target = await duplicate();
    const edges = await rows<{ label: string; dest_project_id: string | null }>(
      `SELECT label, dest_project_id FROM branch_edges WHERE project_id=$1 AND destination_type='project' ORDER BY sort_order`,
      [target]);
    expect(edges.find((e) => e.label === 'Start over')!.dest_project_id).toBe(target);
    expect(edges.find((e) => e.label === 'See the other one')!.dest_project_id).toBe(fx.otherProjectId);
  });

  it('(c) every excluded table is empty for the copy', async () => {
    const target = await duplicate();
    for (const [table, col] of [
      ['branch_path_events', 'project_id'], ['token_usage', 'project_id'], ['jobs', 'project_id'],
      ['video_generation_jobs', 'project_id'], ['audio_renders', 'project_id'],
      ['avatar_conversations', 'project_id'], ['playlist_items', 'project_id'],
      ['course_lessons', 'project_id'], ['project_redirect_targets', 'project_id'],
    ] as const) {
      expect(await count(table, `${col} = $1`, [target])).toBe(0);
    }
    expect(await count('collaborators', `content_type='project' AND content_id=$1`, [target])).toBe(0);
  });
});

// ── The root row's resets ─────────────────────────────────────────────────────────────────────

describe('the copied project row', () => {
  it('resets publication identity and keeps authoring data', async () => {
    const target = await duplicate();
    const p = await one<Record<string, unknown>>(`SELECT * FROM projects WHERE id=$1`, [target]);
    expect(p.title).toBe('Photosynthesis (copy)');
    expect(p.visibility).toBe('private');
    expect(p.share_token).toBeNull();
    expect(p.share_enabled_at).toBeNull();
    expect(p.slug).toBeNull();
    expect(Number(p.view_count)).toBe(0);
    expect(p.access_type).toBe('free');
    expect(p.price_cents).toBeNull();
    // Authoring data survives (§8.4 Q2) — verbatim, EXCEPT the one field that names storage the
    // copy does not own: the circle face image, which follows the bytes onto the copy's own prefix.
    expect(p.topic).toBe('plants');
    expect(p.avatar_config).toEqual({
      greeting: 'hi',
      voiceId: 'v1',
      avatarCircles: {
        enabled: true,
        count: 2,
        faces: [
          { speaker: 'host_a', side: 'left', label: 'Ada', imageUrl: `https://cdn.test/avatar-circles/${target}/face-a.png` },
          { speaker: 'host_b', side: 'right' },
        ],
      },
    });
    expect(p.seo_description).toBe('How plants eat');
    // Same org (§8.4 Q1), owned by the requester.
    expect(p.org_id).toBe(fx.orgId);
    expect(p.created_by).toBe(fx.userId);
    // A finished project stays finished: `ready` describes data, and the data was copied.
    expect(p.status).toBe('ready');
    // The original is untouched.
    const src = await one<Record<string, unknown>>(`SELECT * FROM projects WHERE id=$1`, [fx.projectId]);
    expect(src.share_token).toBe('tok-123');
    expect(src.slug).toBe('photosynthesis');
    expect(Number(src.view_count)).toBe(4242);
  });

  it('resets a status that claims work is in flight', async () => {
    await pg.query(`UPDATE projects SET status='generating' WHERE id=$1`, [fx.projectId]);
    const target = await duplicate();
    const p = await one<{ status: string }>(`SELECT status FROM projects WHERE id=$1`, [target]);
    expect(p.status).toBe('draft');
  });
});

// ── (d) storage ───────────────────────────────────────────────────────────────────────────────

describe('(d) storage', () => {
  it('gives the copy fresh prefixes, and leaves both sets of bytes in place', async () => {
    const beforeKeys = new Set(adapter.objects.keys());
    const target = await duplicate();

    // Every original object still exists.
    for (const k of beforeKeys) expect(adapter.objects.has(k)).toBe(true);

    // Every storage column of the copy resolves to an object that exists, at a DIFFERENT key.
    const vids = await rows<Record<string, string | null>>(
      `SELECT storage_key, hls_master_key, hls_360p_key, crop_key, captions_vtt_key
       FROM video_files WHERE project_id=$1`, [target]);
    for (const v of vids) {
      for (const key of Object.values(v)) {
        if (!key) continue;
        expect(beforeKeys.has(key)).toBe(false);
        expect(adapter.objects.has(key)).toBe(true);
      }
    }
    const p = await one<{ thumbnail_key: string }>(`SELECT thumbnail_key FROM projects WHERE id=$1`, [target]);
    expect(adapter.objects.has(p.thumbnail_key)).toBe(true);
    const img = await one<{ storage_key: string; original_url: string }>(
      `SELECT storage_key, original_url FROM image_files WHERE project_id=$1`, [target]);
    expect(adapter.objects.has(img.storage_key)).toBe(true);
    expect(img.original_url.endsWith(img.storage_key)).toBe(true);
    const aud = await one<{ storage_key: string; url: string }>(
      `SELECT storage_key, url FROM audio_files WHERE project_id=$1`, [target]);
    expect(adapter.objects.has(aud.storage_key)).toBe(true);
    expect(aud.url.endsWith(aud.storage_key)).toBe(true);
  });

  it('copies the whole HLS tree, versioned and legacy layouts alike', async () => {
    const target = await duplicate();
    const vids = await rows<{ id: string; filename: string; hls_master_key: string }>(
      `SELECT id, filename, hls_master_key FROM video_files WHERE project_id=$1`, [target]);
    const main = vids.find((v) => v.filename === 'main.mp4')!;
    const broll = vids.find((v) => v.filename === 'broll.mp4')!;
    expect(main.hls_master_key).toBe(`hls/${main.id}/${HLS_RUN}/master.m3u8`);
    // Segments too — the master alone is a playlist pointing at 404s.
    expect(adapter.objects.has(`hls/${main.id}/${HLS_RUN}/360p/seg_000.ts`)).toBe(true);
    expect(broll.hls_master_key).toBe(`hls/${broll.id}/master.m3u8`);
    expect(adapter.objects.has(`hls/${broll.id}/360p/seg_000.ts`)).toBe(true);
  });

  it('copies only the ACTIVE simulation revision, not the retired tree or the stale posters', async () => {
    const target = await duplicate();
    const sim = await one<{ id: string; storage_prefix: string; active_revision_id: string; revision_counter: number }>(
      `SELECT id, storage_prefix, active_revision_id, revision_counter FROM simulations
       WHERE project_id=$1 AND name='Chloroplast'`, [target]);
    const rev = await one<{ id: string; revision_number: number; status: string; rollback_of_revision_id: string | null }>(
      `SELECT id, revision_number, status, rollback_of_revision_id FROM sim_revisions WHERE simulation_id=$1`, [sim.id]);

    expect(rev.revision_number).toBe(1);           // the counter restarts
    expect(Number(sim.revision_counter)).toBe(1);
    expect(rev.status).toBe('active');
    expect(sim.active_revision_id).toBe(rev.id);
    expect(rev.id).not.toBe(fx.activeRevId);        // never the source's revision id
    expect(rev.rollback_of_revision_id).toBeNull(); // that pointer named the ORIGINAL's history

    expect(adapter.objects.has(`${sim.storage_prefix}/revisions/${rev.id}/package/index.html`)).toBe(true);
    // `package/bridge.js` — the canonical spot (`revisionPathForLegacy` nests customer bytes and
    // the generated runtime alike under `package/`), and the file whose CONTENT the copy rewrites.
    expect(adapter.objects.has(`${sim.storage_prefix}/revisions/${rev.id}/package/bridge.js`)).toBe(true);
    expect(adapter.objects.has(`${sim.storage_prefix}/revisions/${rev.id}/manifest.json`)).toBe(true);
    // The retired tree is not carried, and no revision row claims it.
    const retiredCopies = [...adapter.objects.keys()]
      .filter((k) => k.startsWith(`${sim.storage_prefix}/revisions/retired-tree`));
    expect(retiredCopies).toEqual([]);
    expect(await count('sim_revisions', 'simulation_id=$1', [sim.id])).toBe(1);
    // The customer bundle at the mutable prefix comes too (entry_file still points into it).
    expect(adapter.objects.has(`${sim.storage_prefix}/assets/app.js`)).toBe(true);
  });

  it('re-keys posters onto the copy\'s identity axis instead of copying them verbatim', async () => {
    const target = await duplicate();
    const sim = await one<{ id: string; storage_prefix: string; active_revision_id: string }>(
      `SELECT id, storage_prefix, active_revision_id FROM simulations WHERE project_id=$1 AND name='Chloroplast'`, [target]);
    const section = await one<{ id: string }>(
      `SELECT id FROM timeline_sections WHERE project_id=$1 AND type='simulation'`, [target]);
    const posters = await rows<{ identity: string; package_revision: string; variant_key: string; variants: unknown }>(
      `SELECT identity, package_revision, variant_key, variants FROM sim_posters WHERE simulation_id=$1`, [sim.id]);

    expect(posters).toHaveLength(1);                        // the stale one is dropped
    expect(posters[0].variant_key).toBe(section.id);        // the variant key IS a section id
    const expectedRevision = packageRevisionFor(
      { id: sim.id, bridge_hash: 'bh-1', active_revision_id: sim.active_revision_id }, derivePackageRevision);
    expect(posters[0].package_revision).toBe(expectedRevision);
    // The identity is what `buildPlayerConfig` will compute for the copy — otherwise the lookup
    // (which has no fallback) simply never finds it.
    expect(posters[0].identity).toBe(posterIdentityString({
      packageRevision: expectedRevision, variantKey: section.id, configHash: 'cfg1',
      aspectProfile: 'wide', qualityProfile: 'high',
    }));
    const variants = posters[0].variants as Array<{ path: string }>;
    expect(variants[0].path).toBe(`${sim.storage_prefix}/posters/${posters[0].identity}/standard.webp`);
    expect(adapter.objects.has(variants[0].path)).toBe(true);
  });

  it('rewrites simulation_url to the copy\'s own revision AND its own section id', async () => {
    const target = await duplicate();
    const sim = await one<{ id: string; storage_prefix: string; active_revision_id: string }>(
      `SELECT id, storage_prefix, active_revision_id FROM simulations WHERE project_id=$1 AND name='Chloroplast'`, [target]);
    const section = await one<{ id: string; simulation_url: string }>(
      `SELECT id, simulation_url FROM timeline_sections WHERE project_id=$1 AND type='simulation'`, [target]);

    expect(section.simulation_url).toBe(
      `https://sim.test/${sim.storage_prefix}/revisions/${sim.active_revision_id}/package/index.html` +
      `?section=${section.id}&v=bh-1`);
    // The stale-variant trap: the ORIGINAL's section id must not survive in the query.
    expect(section.simulation_url).not.toContain(fx.sectionMainId);
    // `urlIsOwn` (sections.controller) must answer yes for the copy, or the editor regenerates
    // every bridge script it should have reused.
    expect(section.simulation_url.includes(`section=${section.id}`)).toBe(true);
  });

  it('copies the avatar library\'s images and generated simulations into fresh keys', async () => {
    const target = await duplicate();
    const visuals = await rows<{ visual_type: string; caption: string; image_key: string | null; image_url: string | null; sim_storage_prefix: string | null; sim_entry_url: string | null; visual_spec: { entryKey?: string } | null; use_count: number }>(
      `SELECT visual_type, caption, image_key, image_url, sim_storage_prefix, sim_entry_url, visual_spec, use_count
       FROM avatar_visuals WHERE project_id=$1`, [target]);
    const img = visuals.find((v) => v.visual_type === 'image')!;
    // TWO simulation-typed rows, and they must be treated differently — which is the whole point:
    // one is a package the library OWNS, the other is `syncBasicLibrary`'s pointer at a package the
    // simulation phase has already copied. Selecting "the simulation one" by type alone is what let
    // this test pass while the owned package was not being copied at all.
    const zip = visuals.find((v) => v.caption === 'Orbit')!;
    const pointer = visuals.find((v) => v.caption === 'Chloroplast')!;

    expect(img.image_key).not.toBe('avatar/images/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.png');
    expect(img.image_key!.startsWith('avatar/images/')).toBe(true);
    expect(adapter.objects.has(img.image_key!)).toBe(true);
    expect(img.image_url!.endsWith(img.image_key!)).toBe(true);

    // (a) The library-owned ZIP package: re-rooted, and its bytes actually came along.
    expect(zip.sim_storage_prefix).not.toContain(fx.projectId);
    expect(adapter.objects.has(`${zip.sim_storage_prefix}/index.html`)).toBe(true);
    expect(adapter.objects.has(`${zip.sim_storage_prefix}/assets/orbit.js`)).toBe(true);
    // Copied as a package root, so the system-owned subtree is left behind exactly as it is for a
    // real package — otherwise the copy carries bytes no row names and no sweep can reap.
    expect(adapter.objects.has(`${zip.sim_storage_prefix}/revisions/should-not-be-copied/package/index.html`)).toBe(false);
    // `visual_spec.entryKey` is a storage key with no shadow column. Left alone it is a live
    // pointer into the ORIGINAL's bytes, and the escape scan rolls the whole duplication back.
    expect(zip.visual_spec!.entryKey).toBe(`${zip.sim_storage_prefix}/index.html`);
    expect(zip.visual_spec!.entryKey).not.toContain(fx.projectId);
    expect(zip.sim_entry_url!.endsWith(`${zip.sim_storage_prefix}/index.html`)).toBe(true);

    // (b) The `syncBasicLibrary` pointer: re-rooted onto the copy's own simulation, and NOT copied
    // a second time — the simulation phase already planned that tree, in two scoped pieces.
    expect(pointer.sim_storage_prefix).not.toContain(fx.projectId);
    expect(adapter.objects.has(`${pointer.sim_storage_prefix}/index.html`)).toBe(true);
    expect(adapter.objects.has(`${pointer.sim_storage_prefix}/revisions/retired-tree/package/index.html`)).toBe(false);
    expect(adapter.objects.has(`${pointer.sim_storage_prefix}/posters/stale-identity/standard.webp`)).toBe(false);

    // Usage history belongs to the original.
    expect(Number(img.use_count)).toBe(0);
  });

  it('copies the corpus source bytes and repoints the row at them', async () => {
    const target = await duplicate();
    const c = await one<{ storage_url: string; extracted_md: string }>(
      `SELECT storage_url, extracted_md FROM corpora WHERE project_id=$1 AND source_url='paper.pdf'`, [target]);
    expect(c.extracted_md).toBe('# Notes');
    expect(c.storage_url).toBe(`https://cdn.test/projects/${target}/corpus/1_paper.pdf`);
    expect(adapter.objects.has(`projects/${target}/corpus/1_paper.pdf`)).toBe(true);
  });

  it('carries derived state as data so the copy re-runs nothing', async () => {
    const target = await duplicate();
    const v = await one<Record<string, unknown>>(
      `SELECT * FROM video_files WHERE project_id=$1 AND filename='main.mp4'`, [target]);
    expect(v.waveform_peaks).toBe('[0.1,0.9]');
    expect(v.crop_status).toBe('ready');
    expect(v.crop_source_hash).toBe('crophash');
    expect(v.captions_status).toBe('ready');
    expect(String(v.captions_vtt)).toContain('WEBVTT');
    expect(v.hls_status).toBe('ready');
    expect(v.hls_current_tier).toBe('720p');
  });
});

// ── (e) mid-copy failure ──────────────────────────────────────────────────────────────────────

describe('(e) a mid-copy failure', () => {
  it('leaves no project, no rows, and a failed job row', async () => {
    adapter.failCopyAfter = 3;
    const job = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id, requested_by) VALUES ($1,$2) RETURNING id`,
      [fx.projectId, fx.userId]);

    await expect(svc.run(job.id)).rejects.toThrow(/simulated storage failure/);

    expect(await count('projects', 'true', [])).toBe(2);   // the source and the unrelated one
    expect(await count('video_files', 'true', [])).toBe(2); // only the source's
    expect(await count('simulations', 'true', [])).toBe(2);
    const row = await one<{ status: string; target_project_id: string | null; error: string }>(
      `SELECT status, target_project_id, error FROM project_duplications WHERE id=$1`, [job.id]);
    expect(row.status).toBe('failed');
    expect(row.target_project_id).toBeNull();
    expect(row.error).toMatch(/Nothing was created/);
  });

  it('leaves only orphan bytes, at keys nothing references', async () => {
    adapter.failCopyAfter = 3;
    const job = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id) VALUES ($1) RETURNING id`, [fx.projectId]);
    await expect(svc.run(job.id)).rejects.toThrow();
    // Some bytes did land — that is the accepted cost of a non-transactional store. What must NOT
    // exist is a row pointing at them.
    expect(await count('projects', 'id <> $1 AND id <> $2', [fx.projectId, fx.otherProjectId])).toBe(0);
  });

  it('a duplication that fails can simply be run again', async () => {
    adapter.failCopyAfter = 3;
    const first = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id) VALUES ($1) RETURNING id`, [fx.projectId]);
    await expect(svc.run(first.id)).rejects.toThrow();

    adapter.failCopyAfter = null;
    const target = await duplicate();
    expect(await count('projects', 'id=$1', [target])).toBe(1);
    await expect(svc.assertNoEscapingReferences(fx.projectId, target)).resolves.toBeUndefined();
  });
});

// ── (f) mutual isolation ──────────────────────────────────────────────────────────────────────

describe('(f) mutating one side does not touch the other', () => {
  it('edits and deletes on the copy leave the original intact', async () => {
    const target = await duplicate();

    await pg.query(`UPDATE projects SET title='Renamed copy' WHERE id=$1`, [target]);
    await pg.query(`DELETE FROM timeline_sections WHERE project_id=$1 AND type='clip'`, [target]);
    await pg.query(`UPDATE timeline_sections SET label='Edited' WHERE project_id=$1`, [target]);
    await pg.query(`DELETE FROM simulations WHERE project_id=$1 AND name='Legacy sim'`, [target]);
    await pg.query(`DELETE FROM video_files WHERE project_id=$1 AND filename='broll.mp4'`, [target]);

    expect(await one<{ title: string }>(`SELECT title FROM projects WHERE id=$1`, [fx.projectId]))
      .toEqual({ title: 'Photosynthesis' });
    expect(await count('timeline_sections', 'project_id=$1', [fx.projectId])).toBe(4);
    expect(await count('simulations', 'project_id=$1', [fx.projectId])).toBe(2);
    expect(await count('video_files', 'project_id=$1', [fx.projectId])).toBe(2);
    expect(await count('sim_revisions', `simulation_id=$1`, [fx.simRevisionedId])).toBe(2);
    const label = await one<{ label: string | null }>(
      `SELECT label FROM timeline_sections WHERE id=$1`, [fx.sectionMainId]);
    expect(label.label).toBe('Sim bit');
  });

  it('edits and deletes on the original leave the copy intact', async () => {
    const target = await duplicate();

    await pg.query(`UPDATE projects SET title='Renamed original' WHERE id=$1`, [fx.projectId]);
    await pg.query(`DELETE FROM timeline_sections WHERE project_id=$1 AND type='clip'`, [fx.projectId]);
    await pg.query(`DELETE FROM simulations WHERE id=$1`, [fx.simRevisionedId]);
    await pg.query(`DELETE FROM video_files WHERE id=$1`, [fx.videoBrollId]);
    await pg.query(`DELETE FROM branch_sequences WHERE id=$1`, [fx.seqBId]);

    expect(await one<{ title: string }>(`SELECT title FROM projects WHERE id=$1`, [target]))
      .toEqual({ title: 'Photosynthesis (copy)' });
    expect(await count('timeline_sections', 'project_id=$1', [target])).toBe(4);
    expect(await count('simulations', 'project_id=$1', [target])).toBe(2);
    expect(await count('video_files', 'project_id=$1', [target])).toBe(2);
    expect(await count('branch_sequences', 'project_id=$1', [target])).toBe(2);
    // The section that pointed at the deleted simulation still points at the COPY's simulation —
    // the ON DELETE SET NULL cascade fired on the original's side only.
    const s = await one<{ simulation_id: string | null }>(
      `SELECT simulation_id FROM timeline_sections WHERE project_id=$1 AND type='simulation'`, [target]);
    expect(s.simulation_id).not.toBeNull();
    await expect(svc.assertNoEscapingReferences(fx.projectId, target)).resolves.toBeUndefined();
  });
});

// ── (g) the P0.3 interaction ──────────────────────────────────────────────────────────────────

/** The storage key behind one of this product's public URLs (`https://host/{key}`). */
const keyFromUrl = (url: string | null | undefined): string | null =>
  (url && /^https?:\/\//.test(url) ? url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '') : null);

/**
 * The DELETE /projects/:id body, verbatim in the helpers it calls — the point of these tests is the
 * interaction with the REAL retention machinery, so it must be the real machinery.
 */
async function deleteProjectLikeTheEndpointDoes(projectId: string): Promise<void> {
  const videos = await rows<{ id: string; storage_key: string | null }>(
    `SELECT id, storage_key FROM video_files WHERE project_id=$1`, [projectId]);
  const sims = await rows<{ storage_prefix: string }>(
    `SELECT storage_prefix FROM simulations WHERE project_id=$1`, [projectId]);
  const audios = await rows<{ storage_key: string }>(`SELECT storage_key FROM audio_files WHERE project_id=$1`, [projectId]);
  const images = await rows<{ storage_key: string }>(`SELECT storage_key FROM image_files WHERE project_id=$1`, [projectId]);
  const proj = await one<{ thumbnail_key: string | null }>(`SELECT thumbnail_key FROM projects WHERE id=$1`, [projectId]);

  await pg.query(`DELETE FROM projects WHERE id=$1`, [projectId]);
  await pg.query(`DELETE FROM collaborators WHERE content_type='project' AND content_id=$1`, [projectId]);
  await Promise.all([
    ...videos.flatMap((v) => [
      v.storage_key ? deleteWithFallback(v.storage_key) : Promise.resolve(),
      deleteWithPrefixFallback(`hls/${v.id}`),
      deleteHlsRetirementRowsForVideo(v.id),
    ]),
    ...sims.map((s) => deleteWithPrefixFallback(s.storage_prefix)),
    ...audios.map((a) => deleteWithFallback(a.storage_key)),
    ...images.map((i) => deleteWithFallback(i.storage_key)),
    ...(proj.thumbnail_key ? [deleteWithFallback(proj.thumbnail_key)] : []),
    deleteWithPrefixFallback(`avatar-circles/${projectId}`),
  ]);
}

describe('(g) deleting the ORIGINAL, retirement sweep included, leaves the copy playable', () => {
  /**
   * Every storage key the copy's rows name.
   *
   * COLUMNS AND THE JSONB THAT SHADOWS THEM. Walking only key-shaped columns is precisely how the
   * avatar-circle faces escaped review: their only pointer is a URL nested in `avatar_config`, and
   * `guidance_meta.mdUrl` is the same shape. Both are pulled in here, so "the copy still resolves
   * everything it names" means all of what it names.
   */
  async function keysReferencedBy(projectId: string): Promise<string[]> {
    const keys: string[] = [];
    const push = (k: string | null | undefined): void => { if (k) keys.push(k); };
    const p = await one<{ thumbnail_key: string | null; avatar_config: { avatarCircles?: { faces?: Array<{ imageUrl?: string }> } } | null }>(
      `SELECT thumbnail_key, avatar_config FROM projects WHERE id=$1`, [projectId]);
    push(p.thumbnail_key);
    for (const face of p.avatar_config?.avatarCircles?.faces ?? []) push(keyFromUrl(face.imageUrl));
    for (const s of await rows<{ guidance_meta: { mdUrl?: string } | null }>(
      `SELECT guidance_meta FROM simulations WHERE project_id=$1`, [projectId])) {
      push(keyFromUrl(s.guidance_meta?.mdUrl));
    }
    for (const v of await rows<Record<string, string | null>>(
      `SELECT storage_key, hls_master_key, hls_360p_key, crop_key, captions_vtt_key FROM video_files WHERE project_id=$1`,
      [projectId])) Object.values(v).forEach(push);
    for (const i of await rows<{ storage_key: string }>(`SELECT storage_key FROM image_files WHERE project_id=$1`, [projectId])) push(i.storage_key);
    for (const a of await rows<{ storage_key: string }>(`SELECT storage_key FROM audio_files WHERE project_id=$1`, [projectId])) push(a.storage_key);
    for (const s of await rows<{ active_revision_entry_key: string | null }>(
      `SELECT active_revision_entry_key FROM simulations WHERE project_id=$1`, [projectId])) push(s.active_revision_entry_key);
    for (const po of await rows<{ variants: Array<{ path: string }> }>(
      `SELECT variants FROM sim_posters po JOIN simulations m ON m.id = po.simulation_id WHERE m.project_id=$1`, [projectId])) {
      for (const v of po.variants) push(v.path);
    }
    return keys;
  }

  it('survives the original being re-transcoded, swept, and deleted', async () => {
    const target = await duplicate();
    const needed = await keysReferencedBy(target);
    expect(needed.length).toBeGreaterThan(8);

    // 1. The ORIGINAL is re-transcoded: its old run tree is retired, not deleted.
    await retireHlsRun(fx.videoMainId, `hls/${fx.videoMainId}/${HLS_RUN}`);
    await pg.query(`UPDATE video_files SET hls_master_key=$2 WHERE id=$1`,
      [fx.videoMainId, `hls/${fx.videoMainId}/run8/master.m3u8`]);

    // 2. The grace window passes and the sweep runs. THIS is the step that would delete the copy's
    //    HLS tree out from under it if the copy referenced the source's prefix instead of owning
    //    its own — the interaction plan §8.3 calls the single most important regression here.
    // Two: the run just retired, and the one the fixture had already retired before the copy.
    const swept = await sweepRetiredHlsRuns(20, new Date(Date.now() + 72 * 3_600_000));
    expect(swept).toBe(2);
    expect(adapter.objects.has(`hls/${fx.videoMainId}/${HLS_RUN}/master.m3u8`)).toBe(false);

    // 3. The original project is deleted outright.
    await deleteProjectLikeTheEndpointDoes(fx.projectId);
    expect(await count('projects', 'id=$1', [fx.projectId])).toBe(0);

    // 4. The copy is intact: rows AND bytes.
    expect(await count('projects', 'id=$1', [target])).toBe(1);
    expect(await count('video_files', 'project_id=$1', [target])).toBe(2);
    expect(await count('timeline_sections', 'project_id=$1', [target])).toBe(4);
    expect(await count('simulations', 'project_id=$1', [target])).toBe(2);
    for (const k of needed) {
      expect(adapter.objects.has(k), `copy references a deleted object: ${k}`).toBe(true);
    }
    // And the HLS ladder is complete, not just the master.
    const main = await one<{ id: string }>(
      `SELECT id FROM video_files WHERE project_id=$1 AND filename='main.mp4'`, [target]);
    expect(adapter.objects.has(`hls/${main.id}/${HLS_RUN}/360p/seg_000.ts`)).toBe(true);
    await expect(svc.assertNoEscapingReferences(fx.projectId, target)).resolves.toBeUndefined();
  });

  it('does not inherit the original\'s HLS retirement bookkeeping', async () => {
    const target = await duplicate();
    await retireHlsRun(fx.videoMainId, `hls/${fx.videoMainId}/${HLS_RUN}`);
    const main = await one<{ id: string }>(
      `SELECT id FROM video_files WHERE project_id=$1 AND filename='main.mp4'`, [target]);
    // The retirement row is keyed on the SOURCE video id; the copy's tree lives under its own id
    // and no row names it. `deleteHlsRetirementRowsForVideo(sourceId)` must therefore not touch it.
    expect(await count('hls_retired_runs', 'video_file_id=$1', [main.id])).toBe(0);
    expect(await count('hls_retired_runs', `prefix LIKE 'hls/'||$1||'%'`, [main.id])).toBe(0);
  });
});

// ── (h) the references that hide inside JSONB ─────────────────────────────────────────────────
//
// Every check in (a)/(b) walks a key-shaped COLUMN, and every one of them passed while three
// project-scoped references sat inside JSONB documents pointing straight back at the original.
// These are the same independence question asked of those three.

describe('(h) references stored inside JSONB survive the original\'s deletion', () => {
  it('gives the copy its own avatar-circle face image', async () => {
    const target = await duplicate();

    const before = await one<{ avatar_config: { avatarCircles: { faces: Array<{ imageUrl?: string }> } } }>(
      `SELECT avatar_config FROM projects WHERE id=$1`, [target]);
    const copyFaceKey = keyFromUrl(before.avatar_config.avatarCircles.faces[0].imageUrl)!;
    // Its own key, its own bytes — and the source's are still there, untouched.
    expect(copyFaceKey).toBe(`avatar-circles/${target}/face-a.png`);
    expect(copyFaceKey).not.toBe(fx.faceKey);
    expect(adapter.objects.has(copyFaceKey)).toBe(true);
    expect(adapter.objects.has(fx.faceKey)).toBe(true);

    // DELETE /projects/:id purges `avatar-circles/{projectId}` wholesale. A copy that kept the
    // original's URL loses its presenter's face here, permanently, with nothing naming the cause.
    await deleteProjectLikeTheEndpointDoes(fx.projectId);
    expect(adapter.objects.has(fx.faceKey)).toBe(false);

    const after = await one<{ avatar_config: { avatarCircles: { faces: Array<{ imageUrl?: string }> } } }>(
      `SELECT avatar_config FROM projects WHERE id=$1`, [target]);
    const face = after.avatar_config.avatarCircles.faces[0];
    expect(face.imageUrl).toBe(`https://cdn.test/avatar-circles/${target}/face-a.png`);
    expect(adapter.objects.has(keyFromUrl(face.imageUrl)!)).toBe(true);
    // The rest of the persona is authoring data and comes across verbatim.
    expect(after.avatar_config.avatarCircles.faces[1]).toEqual({ speaker: 'host_b', side: 'right' });
  });

  it('re-roots guidance_meta.mdUrl onto the copy\'s own understanding document', async () => {
    const target = await duplicate();
    const sim = await one<{ id: string; storage_prefix: string; guidance_meta: Record<string, unknown> }>(
      `SELECT id, storage_prefix, guidance_meta FROM simulations WHERE project_id=$1 AND name='Chloroplast'`, [target]);

    expect(sim.guidance_meta.mdUrl).toBe(`https://sim.test/${sim.storage_prefix}/guidance/understanding.md`);
    // Everything else in the record describes the ANALYSIS, which is about bytes that are identical.
    expect(sim.guidance_meta.provider).toBe('claude');
    expect(sim.guidance_meta.entryCount).toBe(3);

    await deleteProjectLikeTheEndpointDoes(fx.projectId);
    expect(adapter.objects.has(`${simRevPrefix}/guidance/understanding.md`)).toBe(false);
    // The editor's "analysis ↗" link on the COPY still opens a document that exists.
    expect(adapter.objects.has(keyFromUrl(sim.guidance_meta.mdUrl as string)!)).toBe(true);
  });

  it('projects both published-bytes capability flags from the revision metadata it copied', async () => {
    const target = await duplicate();
    const sim = await one<{ bridge_ack_capable: boolean | null; requires_import_maps: boolean | null; active_revision_id: string }>(
      `SELECT bridge_ack_capable, requires_import_maps, active_revision_id FROM simulations
       WHERE project_id=$1 AND name='Chloroplast'`, [target]);

    // NOT null. Null is UNKNOWN, and the two consumers treat unknown as its own case: the copy would
    // spin for the whole budget and then force-reveal a guaranteed-blank iframe on a browser without
    // import maps, where the original honestly reports "needs a newer browser".
    expect(sim.requires_import_maps).toBe(true);
    expect(sim.bridge_ack_capable).toBe(false);

    // The information came from the revision this copy carries, so it is still true of it once the
    // original is gone — and it agrees with the metadata the copy holds.
    const rev = await one<{ metadata: { bridgeCapabilities?: Record<string, unknown> } }>(
      `SELECT metadata FROM sim_revisions WHERE id=$1`, [sim.active_revision_id]);
    expect(rev.metadata.bridgeCapabilities).toEqual({ scriptApplied: false, requiresImportMaps: true });

    await deleteProjectLikeTheEndpointDoes(fx.projectId);
    const after = await one<{ bridge_ack_capable: boolean | null; requires_import_maps: boolean | null }>(
      `SELECT bridge_ack_capable, requires_import_maps FROM simulations WHERE project_id=$1 AND name='Chloroplast'`,
      [target]);
    expect(after).toEqual({ bridge_ack_capable: false, requires_import_maps: true });

    // A simulation with no revision has nothing to project FROM, and says so rather than guessing.
    const legacy = await one<{ bridge_ack_capable: boolean | null; requires_import_maps: boolean | null }>(
      `SELECT bridge_ack_capable, requires_import_maps FROM simulations WHERE project_id=$1 AND name='Legacy sim'`,
      [target]);
    expect(legacy).toEqual({ bridge_ack_capable: null, requires_import_maps: null });
  });
});

// ── The job row ───────────────────────────────────────────────────────────────────────────────

describe('the duplication job row', () => {
  it('records progress and ends ready with the target', async () => {
    const job = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id, requested_by) VALUES ($1,$2) RETURNING id`,
      [fx.projectId, fx.userId]);
    const target = await svc.run(job.id);
    const row = await one<{ status: string; target_project_id: string; objects_total: number; objects_copied: number; plan: { rowCounts: Record<string, number> } }>(
      `SELECT status, target_project_id, objects_total, objects_copied, plan FROM project_duplications WHERE id=$1`,
      [job.id]);
    expect(row.status).toBe('ready');
    expect(row.target_project_id).toBe(target);
    expect(Number(row.objects_total)).toBeGreaterThan(0);
    expect(Number(row.objects_copied)).toBe(Number(row.objects_total));
    expect(row.plan.rowCounts.timeline_sections).toBe(4);
  });

  it('refuses a second in-flight duplication of the same source', async () => {
    await pg.query(
      `INSERT INTO project_duplications (source_project_id, status) VALUES ($1,'copying')`, [fx.projectId]);
    await expect(pg.query(
      `INSERT INTO project_duplications (source_project_id, status) VALUES ($1,'queued')`, [fx.projectId],
    )).rejects.toThrow();
    // …but a second one AFTER the first finished is fine.
    await pg.query(`UPDATE project_duplications SET status='failed' WHERE source_project_id=$1`, [fx.projectId]);
    await expect(pg.query(
      `INSERT INTO project_duplications (source_project_id, status) VALUES ($1,'queued')`, [fx.projectId],
    )).resolves.toBeTruthy();
  });

  it('is idempotent once terminal', async () => {
    const target = await duplicate();
    const row = await one<{ id: string }>(
      `SELECT id FROM project_duplications WHERE source_project_id=$1`, [fx.projectId]);
    expect(await svc.run(row.id)).toBe(target);
    expect(await count('projects', 'true', [])).toBe(3); // no second copy
  });
});

// ── An interrupted run ────────────────────────────────────────────────────────────────────────
//
// The copy takes minutes on a driver with no durability and a 25-second shutdown drain, so a deploy
// or a crash mid-copy is ordinary, not exotic. Migration 056's partial unique index then turns the
// stranded row into a PERMANENT block on ever duplicating that project again, and the POST hands the
// client the dead row with `already_running: true`, which the poll follows forever at frozen
// progress. So the row has to be able to be recognised as dead.

describe('a duplication whose process died', () => {
  const staleStamp = (): string => new Date(Date.now() - DUPLICATION_STALE_AFTER_MS - 60_000).toISOString();

  async function strandedRun(): Promise<string> {
    const job = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id, status, updated_at) VALUES ($1,'copying',$2)
       RETURNING id`, [fx.projectId, staleStamp()]);
    return job.id;
  }

  it('blocks every future attempt until it is reaped, and then blocks none', async () => {
    const jobId = await strandedRun();
    // The index is what makes this fatal rather than untidy: nobody can start a new copy.
    await expect(pg.query(
      `INSERT INTO project_duplications (source_project_id, status) VALUES ($1,'queued')`, [fx.projectId],
    )).rejects.toThrow();

    expect(await sweepAbandonedDuplications()).toBe(1);
    const row = await one<{ status: string; error: string; finished_at: string | null }>(
      `SELECT status, error, finished_at FROM project_duplications WHERE id=$1`, [jobId]);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/start it again/);
    expect(row.finished_at).not.toBeNull();

    // And the project is duplicable again — which is the whole point.
    const target = await duplicate();
    expect(await count('projects', 'id=$1', [target])).toBe(1);
  });

  it('is left alone while it is still beating', async () => {
    await pg.query(
      `INSERT INTO project_duplications (source_project_id, status) VALUES ($1,'copying')`, [fx.projectId]);
    expect(await sweepAbandonedDuplications()).toBe(0);
    expect(await count('project_duplications', `status='copying'`, [])).toBe(1);
  });

  it('a second delivery of a LIVE run copies nothing and mints no second project', async () => {
    const job = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id, status) VALUES ($1,'copying') RETURNING id`,
      [fx.projectId]);
    // pg-boss is at-least-once and `registry.ts` asserts handlers are idempotent. Without the claim
    // this would re-plan, re-copy and re-commit — a SECOND project, with `target_project_id`
    // overwritten so the first one is an orphan nothing points at.
    expect(await svc.run(job.id)).toBe('');
    expect(adapter.copyObject).not.toHaveBeenCalled();
    expect(await count('projects', 'true', [])).toBe(2);
    expect(await one<{ status: string }>(
      `SELECT status FROM project_duplications WHERE id=$1`, [job.id])).toEqual({ status: 'copying' });
  });

  it('is what POST /duplicate answers `already_running` about — until it is not running', async () => {
    // The endpoint's in-flight branch, through the one function that decides it. A LIVE run is
    // deferred to (a double-click must not start a second full media copy)…
    const live = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id, status) VALUES ($1,'copying') RETURNING id`,
      [fx.projectId]);
    expect((await liveDuplicationFor(fx.projectId))?.id).toBe(live.id);

    // …but a row nothing is running is not something to defer to. Answering `already_running` for
    // it is what made a stranded copy permanent: the client polls a dead row forever, and the
    // partial unique index refuses every replacement.
    await pg.query(`UPDATE project_duplications SET updated_at=$2 WHERE id=$1`, [live.id, staleStamp()]);
    expect(await liveDuplicationFor(fx.projectId)).toBeNull();
    expect(await one<{ status: string; error: string }>(
      `SELECT status, error FROM project_duplications WHERE id=$1`, [live.id]))
      .toEqual({ status: 'failed', error: expect.stringMatching(/start it again/) });

    // The slot is free, and the next click actually copies the project.
    const target = await duplicate();
    expect(await count('projects', 'id=$1', [target])).toBe(1);
  });

  it('but a delivery DOES take over a run nothing is executing any more', async () => {
    const jobId = await strandedRun();
    const target = await svc.run(jobId);
    expect(await count('projects', 'id=$1', [target])).toBe(1);
    const row = await one<{ status: string; target_project_id: string }>(
      `SELECT status, target_project_id FROM project_duplications WHERE id=$1`, [jobId]);
    expect(row).toEqual({ status: 'ready', target_project_id: target });
  });
});

// ── (i) where the independence proof runs ─────────────────────────────────────────────────────

describe('(i) an independence violation rolls the copy back rather than orphaning it', () => {
  it('leaves no project, and the retry then makes exactly one', async () => {
    // The assertion's ONLY failure mode is a copy whose rows point at the original. Run AFTER the
    // commit it produces the one outcome the whole design says cannot happen: a corrupt project in
    // the owner's list, not named by the job row, while the user is told "nothing was created" —
    // and the freed in-flight index lets the retry add a second one beside it. Forced rather than
    // constructed, because what is under test is WHERE the proof runs, not what it proves.
    const boom = vi.spyOn(svc, 'assertNoEscapingReferences')
      .mockRejectedValueOnce(new Error('duplication: copied rows reference the original — forced'));

    const job = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id, requested_by) VALUES ($1,$2) RETURNING id`,
      [fx.projectId, fx.userId]);
    await expect(svc.run(job.id)).rejects.toThrow(/reference the original/);
    expect(boom).toHaveBeenCalled();

    // "Nothing was created" is TRUE: no project row, and none of its graph.
    expect(await count('projects', 'true', [])).toBe(2);
    expect(await count('video_files', 'true', [])).toBe(2);
    expect(await count('timeline_sections', 'true', [])).toBe(4);
    expect(await count('simulations', 'true', [])).toBe(2);
    expect(await count('sim_revisions', 'true', [])).toBe(2);
    expect(await count('sim_posters', 'true', [])).toBe(2);
    const row = await one<{ status: string; target_project_id: string | null; error: string }>(
      `SELECT status, target_project_id, error FROM project_duplications WHERE id=$1`, [job.id]);
    expect(row.status).toBe('failed');
    expect(row.target_project_id).toBeNull();

    boom.mockRestore();
    const target = await duplicate();
    expect(await count('projects', 'true', [])).toBe(3); // one copy, not two
    expect(await count('projects', 'id=$1', [target])).toBe(1);
  });
});

// ── An object the storage cannot copy at all ──────────────────────────────────────────────────

/**
 * WHERE THE LINE IS, now that `copyObject` crosses the 5 GiB single-copy wall for itself.
 *
 * The adapters re-issue an over-the-wall copy as uniform 256 MiB `UploadPartCopy` ranges, so the
 * only sizes the PLAN still has to refuse are the ones no arrangement of those parts can reach:
 * 10,000 × 256 MiB = `MULTIPART_COPY_MAX_BYTES`. Everything below it — including the 6–10 GB
 * masters `MAX_UPLOAD_BYTES` freely accepts — must now duplicate rather than be told it cannot.
 */
describe('a file above the single-object copy ceiling', () => {
  const SIX_GIB = 6 * 1024 * 1024 * 1024;
  /** Past what uniform 256 MiB parts can address. Only reachable with the byte cap raised too. */
  const THREE_TIB = 3 * 1024 * 1024 * 1024 * 1024;

  it('is duplicated, not refused: 6 GiB is a ranged multipart copy, not a dead end', async () => {
    await pg.query(`UPDATE video_files SET file_size=$2 WHERE id=$1`, [fx.videoMainId, SIX_GIB]);

    const plan = (await svc.dryRun(fx.projectId))!;
    // Naming it here would refuse a copy that in fact succeeds — the regression this replaced.
    expect(plan.oversize).toEqual([]);
    expect(plan.estimatedBytes).toBeGreaterThanOrEqual(SIX_GIB);

    const target = await duplicate();
    expect(await count('projects', 'id=$1', [target])).toBe(1);
    expect(adapter.copyObject).toHaveBeenCalledWith(`videos/${fx.projectId}/main.mp4`, expect.any(String));
  });

  it('does not refuse a project whose files are merely large', async () => {
    await pg.query(`UPDATE video_files SET file_size=$2 WHERE id=$1`, [fx.videoMainId, 4 * 1024 * 1024 * 1024]);
    const plan = (await svc.dryRun(fx.projectId))!;
    expect(plan.oversize).toEqual([]);
    expect(await count('projects', 'id=$1', [await duplicate()])).toBe(1);
  });

  it('names and refuses a file beyond what the multipart copy can address', async () => {
    // The whole-project byte cap would otherwise refuse first, with a different (and, for this
    // file, wrong) reason: raising it is what makes the remaining ceiling observable at all.
    const savedCap = process.env.PROJECT_DUPLICATE_MAX_BYTES;
    process.env.PROJECT_DUPLICATE_MAX_BYTES = String(10 * 1024 * 1024 * 1024 * 1024);
    try {
      await pg.query(`UPDATE video_files SET file_size=$2 WHERE id=$1`, [fx.videoMainId, THREE_TIB]);

      const plan = (await svc.dryRun(fx.projectId))!;
      expect(plan.oversize).toEqual([
        { key: `videos/${fx.projectId}/main.mp4`, bytes: THREE_TIB, what: 'main.mp4' },
      ]);

      const job = await one<{ id: string }>(
        `INSERT INTO project_duplications (source_project_id, requested_by) VALUES ($1,$2) RETURNING id`,
        [fx.projectId, fx.userId]);
      await expect(svc.run(job.id)).rejects.toThrow(/main\.mp4/);

      // Nothing attempted: uniform part size is an R2 requirement, so there is no bigger-parts
      // escape, and the run could only have spent hours to reach an error no retry can pass.
      expect(adapter.copyObject).not.toHaveBeenCalled();
      expect(await count('projects', 'true', [])).toBe(2);
      const row = await one<{ status: string; error: string }>(
        `SELECT status, error FROM project_duplications WHERE id=$1`, [job.id]);
      expect(row.status).toBe('failed');
      expect(row.error).toContain('main.mp4');
      expect(row.error).toContain('3.3 TB');
      // The advice has to be one the user can act on. "You can try again" never was.
      expect(row.error).not.toMatch(/try again/);
    } finally {
      if (savedCap === undefined) delete process.env.PROJECT_DUPLICATE_MAX_BYTES;
      else process.env.PROJECT_DUPLICATE_MAX_BYTES = savedCap;
    }
  });
});

// ── Existing flows ────────────────────────────────────────────────────────────────────────────

describe('existing project flows still behave', () => {
  it('creating, renaming and deleting a project is unaffected by the new table', async () => {
    const p = await one<{ id: string; status: string }>(
      `INSERT INTO projects (org_id, created_by, topic) VALUES ($1,$2,'x') RETURNING id, status`,
      [fx.orgId, fx.userId]);
    expect(p.status).toBe('draft');
    await pg.query(`UPDATE projects SET title='Renamed' WHERE id=$1`, [p.id]);
    await pg.query(`DELETE FROM projects WHERE id=$1`, [p.id]);
    expect(await count('projects', 'id=$1', [p.id])).toBe(0);
  });

  it('deleting a source project cascades its duplication history away, but not the copy', async () => {
    const target = await duplicate();
    await pg.query(`DELETE FROM projects WHERE id=$1`, [fx.projectId]);
    expect(await count('project_duplications', 'true', [])).toBe(0);
    expect(await count('projects', 'id=$1', [target])).toBe(1);
  });

  it('deleting the COPY leaves the duplication record, with a null target', async () => {
    const target = await duplicate();
    await pg.query(`DELETE FROM projects WHERE id=$1`, [target]);
    const row = await one<{ status: string; target_project_id: string | null }>(
      `SELECT status, target_project_id FROM project_duplications WHERE source_project_id=$1`, [fx.projectId]);
    expect(row.target_project_id).toBeNull();
    expect(row.status).toBe('ready');
  });
});

// ── (j) the bytes a copied simulation package is MADE of ──────────────────────────────────────
//
// Everything above this point asks whether the copy's ROWS point inside the copy. A simulation
// package is the one thing a project owns whose CONTENT encodes those ids, and a verbatim byte copy
// of it is not a copy at all — it is a package that talks about a different project.

describe('(j) a copied simulation package dispatches on the COPY\'s section ids', () => {
  /** The copy's ids, keyed by the source id they replace. */
  async function mapping(target: string): Promise<{
    simRev: { id: string; storage_prefix: string; active_revision_id: string };
    simLegacy: { id: string; storage_prefix: string };
    sectionMain: string; sectionClip: string;
  }> {
    const simRev = await one<{ id: string; storage_prefix: string; active_revision_id: string }>(
      `SELECT id, storage_prefix, active_revision_id FROM simulations WHERE project_id=$1 AND name='Chloroplast'`,
      [target]);
    const simLegacy = await one<{ id: string; storage_prefix: string }>(
      `SELECT id, storage_prefix FROM simulations WHERE project_id=$1 AND name='Legacy sim'`, [target]);
    const sectionMain = await one<{ id: string }>(
      `SELECT id FROM timeline_sections WHERE project_id=$1 AND type='simulation'`, [target]);
    const sectionClip = await one<{ id: string }>(
      `SELECT id FROM timeline_sections WHERE project_id=$1 AND sort_order=1`, [target]);
    return { simRev, simLegacy, sectionMain: sectionMain.id, sectionClip: sectionClip.id };
  }

  it('re-keys __SECTIONS__ so every copied section resolves to the body it had', async () => {
    const target = await duplicate();
    const m = await mapping(target);
    const revRoot = `${m.simRev.storage_prefix}/revisions/${m.simRev.active_revision_id}`;

    const copySections = bridgeSections(`${revRoot}/package/bridge.js`);
    // THE DEFECT, stated as an assertion: the copy's URL asks for `?section=<copy id>`, and the
    // bridge has to have a body under exactly that key. With the bytes copied verbatim these keys
    // are the ORIGINAL's, `startScript` falls through to `_sectionBody(name)` → null → the bridge
    // posts SCRIPT_MISSING and runs nothing, in every simulation section of the copy.
    expect([...copySections.keys()].sort()).toEqual([m.sectionMain, m.sectionClip].sort());
    expect(copySections.has(fx.sectionMainId)).toBe(false);
    expect(copySections.has(fx.sectionClipId)).toBe(false);

    // The right body under the right key — not merely two keys and two bodies.
    const source = bridgeSections(`${simRevPrefix}/revisions/${fx.activeRevId}/package/bridge.js`);
    expect(copySections.get(m.sectionMain)).toBe(source.get(fx.sectionMainId));
    expect(copySections.get(m.sectionClip)).toBe(source.get(fx.sectionClipId));

    // And the section URL the copy stores agrees with the bridge it points at — the two halves
    // that have to move together.
    const url = (await one<{ simulation_url: string }>(
      `SELECT simulation_url FROM timeline_sections WHERE id=$1`, [m.sectionMain])).simulation_url;
    expect(new URL(url).searchParams.get('section')).toBe(m.sectionMain);
    expect(copySections.has(new URL(url).searchParams.get('section')!)).toBe(true);
  });

  it('re-keys the LEGACY layout too — a bridge at the mutable package root', async () => {
    const target = await duplicate();
    const m = await mapping(target);
    const copySections = bridgeSections(`${m.simLegacy.storage_prefix}/bridge.js`);
    expect([...copySections.keys()]).toEqual([m.sectionMain]);
  });

  it('leaves the ORIGINAL\'s bridge byte-for-byte untouched', async () => {
    const before = adapter.objects.get(`${simRevPrefix}/revisions/${fx.activeRevId}/package/bridge.js`)!.toString();
    await duplicate();
    expect(adapter.objects.get(`${simRevPrefix}/revisions/${fx.activeRevId}/package/bridge.js`)!.toString())
      .toBe(before);
    expect(bridgeSections(`${simRevPrefix}/revisions/${fx.activeRevId}/package/bridge.js`).has(fx.sectionMainId))
      .toBe(true);
  });

  it('changes nothing but the ids: every body, and every other byte of the wrapper, survives', async () => {
    const target = await duplicate();
    const m = await mapping(target);
    const src = adapter.objects.get(`${simRevPrefix}/revisions/${fx.activeRevId}/package/bridge.js`)!.toString();
    const copy = adapter.objects.get(
      `${m.simRev.storage_prefix}/revisions/${m.simRev.active_revision_id}/package/bridge.js`)!.toString();
    // Substituting the ids back must reproduce the source exactly. That is a much stronger claim
    // than "it parses": a re-wrap through today's template would pass a parse and fail this.
    const back = copy.split(m.sectionMain).join(fx.sectionMainId).split(m.sectionClip).join(fx.sectionClipId);
    expect(back).toBe(src);
  });

  it('gives the copy its OWN manifest, and its own manifest_hash', async () => {
    const target = await duplicate();
    const m = await mapping(target);
    const revRoot = `${m.simRev.storage_prefix}/revisions/${m.simRev.active_revision_id}`;
    const manifest = readManifest(revRoot);

    // The manifest describes the COPY: its ids, its variant keys, its revision number.
    expect(manifest.simulationId).toBe(m.simRev.id);
    expect(manifest.projectId).toBe(target);
    expect(manifest.revisionId).toBe(m.simRev.active_revision_id);
    expect(manifest.revisionNumber).toBe(1);
    expect(manifest.variants.map((v) => v.variantKey).sort()).toEqual([m.sectionMain, m.sectionClip].sort());

    // And it describes the BYTES that are actually stored — the bridge's hash moved with its
    // content, which is what `SimManifestFile.hash` is defined to mean.
    const storedBridge = adapter.objects.get(`${revRoot}/package/bridge.js`)!;
    const bridgeEntry = manifest.files.find((f) => f.path === 'package/bridge.js')!;
    expect(bridgeEntry.hash).toBe(createHash('sha256').update(storedBridge).digest('hex'));
    expect(bridgeEntry.bytes).toBe(storedBridge.length);

    // Different bytes are a different revision, so the row carries its own hash — recomputed by
    // the SAME function `RevisionService.validate` uses, not inherited from the source.
    const row = await one<{ manifest_hash: string }>(
      `SELECT manifest_hash FROM sim_revisions WHERE id=$1`, [m.simRev.active_revision_id]);
    expect(row.manifest_hash).toBe(computeManifestHash(manifest));
    expect(row.manifest_hash).not.toBe(sourceManifestHash);
    // The original's revision row is untouched.
    expect((await one<{ manifest_hash: string }>(
      `SELECT manifest_hash FROM sim_revisions WHERE id=$1`, [fx.activeRevId])).manifest_hash)
      .toBe(sourceManifestHash);
  });

  it('leaves a package with no parseable section map alone, and says so', async () => {
    // A hand-written / pre-combined bridge: no `@@SIM_BRIDGE@@` markers, nothing to re-key.
    const raw = ';(function(){ window.SimAPI = { start: function(){}, stop: function(){} }; })();';
    adapter.objects.set(`${simLegacyPrefix}/bridge.js`, Buffer.from(raw, 'utf-8'));
    const target = await duplicate();
    const legacy = await one<{ storage_prefix: string }>(
      `SELECT storage_prefix FROM simulations WHERE project_id=$1 AND name='Legacy sim'`, [target]);

    expect(adapter.objects.get(`${legacy.storage_prefix}/bridge.js`)!.toString()).toBe(raw);
    const job = await one<{ plan: { warnings: string[] } }>(
      `SELECT plan FROM project_duplications WHERE target_project_id=$1`, [target]);
    expect(job.plan.warnings.some((w) => w.includes('no @@SIM_BRIDGE@@ section map'))).toBe(true);
  });
});

// ── (k) guidance narration follows the copy ───────────────────────────────────────────────────

describe('(k) the copy\'s guidance narration survives the original\'s deletion', () => {
  it('re-roots audioUrl in the DATABASE COLUMN and in the OVERLAY the viewer loads', async () => {
    const target = await duplicate();
    const sim = await one<{ id: string; storage_prefix: string; guidance: Array<{ audioUrl: string }> }>(
      `SELECT id, storage_prefix, guidance FROM simulations WHERE project_id=$1 AND name='Chloroplast'`, [target]);
    const expected = `https://sim.test/${sim.storage_prefix}/${GUIDANCE_AUDIO_REL}`;

    // (1) the column — what the editor reads
    expect(sim.guidance[0].audioUrl).toBe(expected);
    // (2) the overlay bytes — what actually FIRES the cue. `_fire` posts the URL it finds HERE,
    // so rebasing the column alone leaves the viewer playing the original's audio.
    const overlay = adapter.objects.get(`${sim.storage_prefix}/guidance.js`)!.toString('utf-8');
    expect(overlay).toContain(expected);
    expect(overlay).not.toContain(simRevPrefix);
    // (3) the bytes exist under the copy's own prefix
    expect(adapter.objects.has(`${sim.storage_prefix}/${GUIDANCE_AUDIO_REL}`)).toBe(true);

    // And the original's overlay is untouched.
    expect(adapter.objects.get(`${simRevPrefix}/guidance.js`)!.toString('utf-8'))
      .toContain(`https://sim.test/${simRevPrefix}/${GUIDANCE_AUDIO_REL}`);
  });

  it('still plays after the original project is deleted', async () => {
    const target = await duplicate();
    const sim = await one<{ storage_prefix: string; guidance: Array<{ audioUrl: string }> }>(
      `SELECT storage_prefix, guidance FROM simulations WHERE project_id=$1 AND name='Chloroplast'`, [target]);
    await deleteProjectLikeTheEndpointDoes(fx.projectId);
    expect(adapter.objects.has(keyFromUrl(sim.guidance[0].audioUrl)!)).toBe(true);
  });

  it('the escape scan is generic: ANY jsonb column still naming the source fails the copy', async () => {
    // Not "guidance is checked" — that would be one more hand-added column. This proves the check
    // is over the SCHEMA's jsonb columns, by planting an escape in one nobody has ever listed.
    const target = await duplicate();
    await pg.query(`UPDATE camera_plans SET cuts_json = $2::jsonb WHERE project_id = $1`,
      [target, JSON.stringify([{ note: `see projects/${fx.projectId}/corpus/1_paper.pdf` }])]);
    await expect(svc.assertNoEscapingReferences(fx.projectId, target))
      .rejects.toThrow(/camera_plans\.cuts_json/);
  });

  it('does not mistake the deliberate `duplicatedFrom` provenance for an escape', async () => {
    const target = await duplicate();
    const rev = await one<{ metadata: { duplicatedFrom: { projectId: string } } }>(
      `SELECT r.metadata FROM sim_revisions r JOIN simulations s ON s.id = r.simulation_id
       WHERE s.project_id = $1`, [target]);
    // It genuinely names the original — that is the point of it.
    expect(rev.metadata.duplicatedFrom.projectId).toBe(fx.projectId);
    await expect(svc.assertNoEscapingReferences(fx.projectId, target)).resolves.toBeUndefined();
  });
});

// ── (l) a corpus published under a Supabase URL ───────────────────────────────────────────────

describe('(l) recovering a storage key from a public URL', () => {
  it('duplicates a project whose corpus URL is Supabase-shaped', async () => {
    // Before the adapter answered for its own URLs, the recovered "key" was
    // `storage/v1/object/public/media/projects/{p}/corpus/2_supabase.pdf` — which still contains
    // the project id, so the plan mapped it and committed to copying it. `copyObject` then threw
    // `NoSuchKey`: not `isCopyUnsupported` (404 is excluded on purpose), not `isCopyTooLarge`, so
    // the WHOLE duplication failed. Every project with a corpus file, permanently.
    const plan = (await svc.dryRun(fx.projectId))!;
    const corpusCopies = plan.storage.filter((c) => c.reason === 'corpus source file');
    expect(corpusCopies.map((c) => c.from).sort()).toEqual([
      `projects/${fx.projectId}/corpus/1_paper.pdf`,
      `projects/${fx.projectId}/corpus/2_supabase.pdf`,
    ]);
    for (const c of corpusCopies) expect(adapter.objects.has(c.from)).toBe(true);

    const target = await duplicate();
    const supa = await one<{ storage_url: string }>(
      `SELECT storage_url FROM corpora WHERE project_id=$1 AND source_url='supabase.pdf'`, [target]);
    // Rebased on the URL AS STORED, so the copy keeps the base it was published under.
    expect(supa.storage_url).toBe(`${SUPABASE_PUBLIC_BASE}/projects/${target}/corpus/2_supabase.pdf`);
    expect(adapter.objects.has(`projects/${target}/corpus/2_supabase.pdf`)).toBe(true);
  });
});

// ── (m) retired HLS run trees are left behind ─────────────────────────────────────────────────

describe('(o) duplicating MID-JOB does not hand the copy a job that will never run', () => {
  /**
   * Every one of these statuses is a claim about a RUNNING job — a transcode, a crop, a caption
   * pass, a package ingest, a corpus extraction. The copy has none of those jobs: nothing was
   * enqueued for it, and nothing ever will be. Copied verbatim they are a lie that never resolves:
   * the tile spins on `processing` forever, and for a simulation the next backend boot sweeps it to
   * `failed — please re-upload` over a process restart that never happened to it.
   *
   * The reset rules already existed for `projects.status` and the thumbnail pipeline. This asserts
   * they reach the CHILD rows too, and that each one's leftovers (the started-at stamp, the error
   * text from the source's own run) go with them — a reset status beside a stale `hls_error` is
   * still a copy that reports a failure it never had.
   */
  const IN_FLIGHT = 'processing';

  beforeEach(async () => {
    // Each status column is its own enum, so one shared placeholder cannot be type-deduced —
    // bind them separately rather than letting the driver guess.
    await pg.query(`UPDATE video_files SET hls_status=$1, hls_started_at=now(), hls_error='source boom',
                    crop_status=$2, crop_error='crop boom', captions_status=$3, captions_error='cap boom'
                    WHERE project_id=$4`, [IN_FLIGHT, IN_FLIGHT, IN_FLIGHT, fx.projectId]);
    await pg.query(`UPDATE simulations SET status=$1, error='sim boom' WHERE project_id=$2`, [IN_FLIGHT, fx.projectId]);
    await pg.query(`UPDATE corpora SET ingestion_status=$1, error='corpus boom' WHERE project_id=$2`, [IN_FLIGHT, fx.projectId]);
  });

  it('resets every in-flight child status, and clears the leftovers with it', async () => {
    const target = await duplicate();

    const vids = await rows<{ hls_status: string; hls_started_at: string | null; hls_error: string | null;
                              crop_status: string; crop_error: string | null;
                              captions_status: string; captions_error: string | null }>(
      `SELECT hls_status, hls_started_at, hls_error, crop_status, crop_error, captions_status, captions_error
       FROM video_files WHERE project_id=$1`, [target]);
    expect(vids.length).toBeGreaterThan(0);
    for (const v of vids) {
      expect(v.hls_status).toBe('pending');       // the enum's "no transcode has run"
      expect(v.hls_started_at).toBeNull();
      expect(v.hls_error).toBeNull();
      expect(v.crop_status).toBe('none');
      expect(v.crop_error).toBeNull();
      expect(v.captions_status).toBe('none');
      expect(v.captions_error).toBeNull();
    }

    // A package row cannot exist without bytes, so there is no "not ingested yet" to reset to —
    // the honest answer for one captured mid-ingest is the terminal one, reached deliberately here
    // rather than by a boot sweep blaming a restart that never happened to this project.
    const sims = await rows<{ status: string; error: string | null }>(
      `SELECT status, error FROM simulations WHERE project_id=$1`, [target]);
    for (const s of sims) expect(s.status).toBe('failed');

    const corp = await rows<{ ingestion_status: string; error: string | null }>(
      `SELECT ingestion_status, error FROM corpora WHERE project_id=$1`, [target]);
    expect(corp.length).toBeGreaterThan(0);
    for (const c of corp) {
      expect(c.ingestion_status).toBe('pending');
      expect(c.error).toBeNull();
    }
  });

  it('leaves the ORIGINAL mid-job exactly as it was', async () => {
    // The reset belongs to the copy. Reaching back and clearing the source would abandon a job that
    // IS running, which is a far worse failure than the one being fixed.
    await duplicate();
    const [v] = await rows<{ hls_status: string; hls_error: string | null }>(
      `SELECT hls_status, hls_error FROM video_files WHERE project_id=$1 LIMIT 1`, [fx.projectId]);
    expect(v.hls_status).toBe(IN_FLIGHT);
    expect(v.hls_error).toBe('source boom');
  });

  it('does NOT rewrite a status that is a fact rather than a claim', async () => {
    // `ready`/`none` describe work that genuinely produced the bytes being copied, so the copy
    // inherits them. A blanket "reset all statuses" would make every duplicate look untranscoded
    // and re-run the entire ladder for nothing.
    await pg.query(`UPDATE video_files SET hls_status='ready', hls_error=NULL WHERE project_id=$1`, [fx.projectId]);
    const target = await duplicate();
    const [v] = await rows<{ hls_status: string }>(
      `SELECT hls_status FROM video_files WHERE project_id=$1 LIMIT 1`, [target]);
    expect(v.hls_status).toBe('ready');
  });
});

describe('(m) the copy does not inherit unreapable retired HLS trees', () => {
  it('copies the live run tree and skips the retired one', async () => {
    const target = await duplicate();
    const main = await one<{ id: string }>(
      `SELECT id FROM video_files WHERE project_id=$1 AND filename='main.mp4'`, [target]);

    // The live ladder came along, complete.
    expect(adapter.objects.has(`hls/${main.id}/${HLS_RUN}/master.m3u8`)).toBe(true);
    expect(adapter.objects.has(`hls/${main.id}/${HLS_RUN}/360p/seg_000.ts`)).toBe(true);
    // The retired one did not. Nothing would ever have deleted it: `hls_retired_runs` rows are
    // (correctly) not copied, so the copied tree would be named by no row and referenced by no
    // column, for the life of the deployment.
    expect(adapter.objects.has(`hls/${main.id}/${HLS_RETIRED_RUN}/master.m3u8`)).toBe(false);
    expect(adapter.objects.has(`hls/${main.id}/${HLS_RETIRED_RUN}/360p/seg_000.ts`)).toBe(false);
    // The ORIGINAL's retired tree is still there, still awaiting its own sweep.
    expect(adapter.objects.has(`hls/${fx.videoMainId}/${HLS_RETIRED_RUN}/master.m3u8`)).toBe(true);
    expect(await count('hls_retired_runs', `prefix LIKE 'hls/'||$1||'%'`, [main.id])).toBe(0);
  });

  it('says what it left behind, and does not count it', async () => {
    const plan = (await svc.dryRun(fx.projectId))!;
    const ladder = plan.storage.find((c) => c.from === `hls/${fx.videoMainId}`)!;
    expect(ladder.exclude).toEqual([`hls/${fx.videoMainId}/${HLS_RETIRED_RUN}`]);
    expect(plan.warnings.some((w) => w.includes('retired HLS run tree'))).toBe(true);
  });
});

// ── (n) the commit and the job row's outcome are one fact ─────────────────────────────────────

describe('(n) a run that loses its claim commits nothing', () => {
  /** Run a duplication, doing `sabotage` to the job row from inside the commit transaction. */
  async function duplicateWith(
    sabotage: (tx: TxLike, jobId: string) => Promise<unknown>,
  ): Promise<{ err: unknown; jobId: string }> {
    const job = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id, requested_by) VALUES ($1,$2) RETURNING id`,
      [fx.projectId, fx.userId]);
    // The seam is the independence proof, which runs INSIDE the commit transaction immediately
    // before the row is finalised — the exact window a failover, a pool stall or a reaper occupies.
    // Sabotage goes through the TRANSACTION HANDLE it is passed: a second connection would be a
    // different session, and against PGlite's single session it simply deadlocks.
    const real = svc.assertNoEscapingReferences.bind(svc);
    vi.spyOn(svc, 'assertNoEscapingReferences').mockImplementation(async (src, tgt, exec) => {
      await real(src, tgt, exec);
      await sabotage(exec as unknown as TxLike, job.id);
    });
    let err: unknown = null;
    try { await svc.run(job.id); } catch (e) { err = e; }
    vi.restoreAllMocks();
    return { err, jobId: job.id };
  }

  it('rolls back when a reaper declared the run abandoned mid-commit', async () => {
    const projectsBefore = await count('projects', 'true', []);
    const { err, jobId } = await duplicateWith((tx, id) => tx.update(schema.project_duplications)
      .set({ status: 'failed', error: 'reaped' })
      .where(eq(schema.project_duplications.id, id)));

    expect(err).toBeInstanceOf(Error);
    // NOTHING was created — which is what makes the message the user sees true.
    expect(await count('projects', 'true', [])).toBe(projectsBefore);
    const row = await one<{ status: string; target_project_id: string | null; error: string }>(
      `SELECT status, target_project_id, error FROM project_duplications WHERE id=$1`, [jobId]);
    expect(row.target_project_id).toBeNull();
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/taken over by another attempt|deleted while it ran/);
  });

  it('rolls back when the source project was deleted and took the job row with it', async () => {
    // `source_project_id` is ON DELETE CASCADE (migration 056), so the row simply vanishes and both
    // the `ready` write and the failure write no-op. Committing the project anyway would leave one
    // that exists, is in the owner's list, and is named by nothing.
    const projectsBefore = await count('projects', 'true', []);
    const { err, jobId } = await duplicateWith((tx, id) => tx.delete(schema.project_duplications)
      .where(eq(schema.project_duplications.id, id)));

    expect(err).toBeInstanceOf(Error);
    expect(await count('projects', 'true', [])).toBe(projectsBefore);
    // The delete rolled back with everything else, so the row is here and honestly failed.
    const row = await one<{ status: string; target_project_id: string | null }>(
      `SELECT status, target_project_id FROM project_duplications WHERE id=$1`, [jobId]);
    expect(row.status).toBe('failed');
    expect(row.target_project_id).toBeNull();
  });

  it('a losing run touches nothing on a row that has already finished', async () => {
    // The other half of the fence, and the one the user sees. A run whose row was taken over — by a
    // reaper plus a retry that got there first — throws at the commit and lands in the catch. Every
    // write it makes from that point is over a row that records a project which really exists:
    // unfenced, the `committing` update drags a terminal row back in flight and the catch then
    // stamps `failed` over `ready`, so the poll follows a finished copy forever and reports failure.
    //
    // Sabotage here happens OUTSIDE the commit transaction (a spy on `verifyBytes`), because a write
    // made inside it would simply roll back with everything else and prove nothing.
    const projectsBefore = await count('projects', 'true', []);
    const winner = fx.otherProjectId;                       // stands in for the run that got there first
    const job = await one<{ id: string }>(
      `INSERT INTO project_duplications (source_project_id, requested_by) VALUES ($1,$2) RETURNING id`,
      [fx.projectId, fx.userId]);
    const realVerify = svc.verifyBytes.bind(svc);
    vi.spyOn(svc, 'verifyBytes').mockImplementation(async (plan) => {
      await realVerify(plan);
      await pg.query(
        `UPDATE project_duplications SET status='ready', target_project_id=$2, finished_at=now() WHERE id=$1`,
        [job.id, winner]);
    });
    await expect(svc.run(job.id)).rejects.toThrow();
    vi.restoreAllMocks();

    const row = await one<{ status: string; target_project_id: string; error: string | null }>(
      `SELECT status, target_project_id, error FROM project_duplications WHERE id=$1`, [job.id]);
    expect(row.status).toBe('ready');
    expect(row.target_project_id).toBe(winner);
    expect(row.error).toBeNull();
    // And it committed nothing of its own.
    expect(await count('projects', 'true', [])).toBe(projectsBefore);
  });
});

describe('a duplicated project SHARES deduplicated bytes instead of copying them', () => {
  // The interaction bug this pins, found while wiring uploads to the blob store: duplication
  // rewrites every media key to a project-scoped one. Applied to a row backed by a shared blob
  // that is wrong twice over — it copies the blob's bytes into the new project, re-creating the
  // exact duplication migration 078 removes, AND it produces a `blobs/<digest>`-derived key whose
  // name no longer matches its content, which is the one property the whole design rests on.
  //
  // Worse still if `blob_id` is not carried: the new row serves bytes it does not reference, so
  // the sweeper sees the blob as unheld and collects it out from under a live row.

  it('plans NO copy for a blob-backed image or audio row', async () => {
    const blob = await one<{ id: string }>(
      `INSERT INTO media_blobs (sha256, byte_size, storage_key)
       VALUES (repeat('a',64), 10, 'blobs/aa/aa/' || repeat('a',64)) RETURNING id`, []);
    await pg.query(
      `UPDATE image_files SET blob_id=$1, storage_key='blobs/aa/aa/' || repeat('a',64) WHERE project_id=$2`,
      [blob.id, fx.projectId]);

    const plan = (await svc.dryRun(fx.projectId))!;
    const imageCopies = plan.storage.filter((c) => /leaf\.png|blobs\//.test(c.from));
    expect(imageCopies, `planned a copy of shared bytes: ${JSON.stringify(imageCopies)}`).toEqual([]);
  });

  it('still plans a copy for a row that is NOT blob-backed', async () => {
    // The other half: a guard that skipped everything would pass the test above and silently stop
    // duplicating ordinary media.
    const plan = (await svc.dryRun(fx.projectId))!;
    expect(plan.storage.some((c) => c.from.includes('vo.mp3')), 'an unshared audio row was not copied').toBe(true);
  });
});
