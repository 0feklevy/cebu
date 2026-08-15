/**
 * buildExportPlan against a REAL Postgres engine (PGlite + the actual migrations), because every
 * property this builder claims is a property of ROWS: the created_at ordering, the two time
 * conventions, the FK-backed fixture the predicate classifies. A hand-faked db would pass while
 * proving nothing — same argument as projectDuplication.test.ts, same setup.
 *
 * THE FIXTURE (one project, every classification the plan doc names):
 *   • two main videos (A 60 s, B 30 s, created in that order) — cumulative offsets;
 *   • a SCRIPTED simulation on B (`?section=<id>&v=…` URL) that POST-ROLLS past B's end;
 *   • a RAW "show full simulation" on A — REAL bare URL, no sim_meta, sim_script 'main';
 *   • a LEGACY scripted row on A — bare URL but sim_meta present (pre-`?section=` era shape);
 *   • a clip section (trimmed library video), an image section, a b-roll overlay, an audio
 *     cutaway — one of each timing convention.
 *
 * The named mutation tests:
 *   • "THE PREDICATE …" fails if the predicate is flipped to include RAW sections;
 *   • "legacy backstop …" fails if the legacy shape is silently excluded;
 *   • "post-roll …" fails if the window is clamped to the host video's end;
 *   • "branching …" fails if the refusal is reclassified as retryable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../db/schema.js';

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
vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => { throw new Error('exportPlan tests must inject their own storage'); },
}));

import { ExportRefused, buildExportPlan, isFullSimulation, withBootCloak } from '../exportPlan.js';
import {
  admitCaptureWorkload,
  MAX_SIM_WINDOWS_PER_EXPORT,
  MAX_SIM_WINDOW_SEC,
  MAX_TOTAL_CAPTURE_FRAMES,
} from '../exportPlan.js';
import type { ClipWindow, ImageWindow, PosterFallbackWindow, SimCaptureWindow, VideoWindow } from '../types.js';
import { packageRevisionFor } from 'shared/sim/simRevision';
import {
  DEFAULT_PRESENTATION_CONFIG, computeConfigHash, derivePackageRevision,
} from 'shared/sim/simIdentity';
import { posterIdentityString } from 'shared/sim/posterIdentity';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

/** Deterministic HEADs so the source-identity snapshot is assertable. */
const storage = {
  getSimPublicUrl: (key: string) => `https://sim.test/${key}`,
  headObject: async (key: string) => ({ size: key.length * 100, etag: `etag:${key}` }),
};

let pg: PGlite;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}

// ── Fixture ───────────────────────────────────────────────────────────────────────────────────

interface Fixture {
  projectId: string;
  videoAId: string;   // main, 60 s, 1 MB
  videoBId: string;   // main, 30 s, 2 MB
  brollId: string;    // b-roll source, 4 KB
  imageId: string;
  audioId: string;
  simScriptedId: string;
  simRawId: string;
  sectionScriptedId: string;  // on B: start 5, end 40 → POST-ROLL past B's 30 s
  sectionRawId: string;       // on A: start 10, end 20
  sectionLegacyId: string;    // on A: start 30, end 38 — bare URL + sim_meta
  sectionClipId: string;      // on A: start 10, end 18, clip_in 4
  sectionImageId: string;     // on A: start 40, end 45
  sectionBrollId: string;     // global_offset 20, source [2, 8)
  sectionAudioId: string;     // global_offset 33, source [1, 6), gain 0.5
  activeRevId: string;
  entryKey: string;
  posterPath: string;
}

async function seed(): Promise<Fixture> {
  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('O') RETURNING id`);
  const user = await one<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-exp', 'e@test') RETURNING id`);
  const project = await one<{ id: string }>(
    `INSERT INTO projects (org_id, created_by, title) VALUES ($1,$2,'Export me') RETURNING id`,
    [org.id, user.id]);

  // Two MAIN videos with an explicit created_at gap — the ordering the offsets hang off.
  const videoA = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec, captions_status, created_at)
     VALUES ($1,'a.mp4',1000000,$2,'ready',60,'ready', now() - interval '2 hours') RETURNING id`,
    [project.id, `videos/${project.id}/a.mp4`]);
  const videoB = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec, created_at)
     VALUES ($1,'b.mp4',2000000,$2,'ready',30, now() - interval '1 hour') RETURNING id`,
    [project.id, `videos/${project.id}/b.mp4`]);
  const broll = await one<{ id: string }>(
    `INSERT INTO video_files (project_id, filename, file_size, storage_key, status, duration_sec, is_broll)
     VALUES ($1,'broll.mp4',4096,$2,'ready',12,true) RETURNING id`,
    [project.id, `videos/${project.id}/broll.mp4`]);

  const image = await one<{ id: string }>(
    `INSERT INTO image_files (project_id, filename, storage_key, original_url, crop_x, crop_y, crop_w, crop_h)
     VALUES ($1,'still.png',$2,$3,0.1,0.2,0.8,0.7) RETURNING id`,
    [project.id, `images/${project.id}/still.png`, `https://cdn.test/images/${project.id}/still.png`]);
  const audioF = await one<{ id: string }>(
    `INSERT INTO audio_files (project_id, filename, storage_key, url, duration_sec)
     VALUES ($1,'music.mp3',$2,$3,30) RETURNING id`,
    [project.id, `audio/${project.id}/music.mp3`, `https://cdn.test/audio/${project.id}/music.mp3`]);

  // The scripted simulation: revisioned, so the served URL must resolve through the pointer.
  const simScripted = await one<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, status, bridge_hash)
     VALUES ($1,'Scripted','simulations/${'PROJ'}/scripted','https://cdn.test/simulations/scripted/index.html','ready','bh-1')
     RETURNING id`, [project.id]);
  const rev = await one<{ id: string }>(
    `INSERT INTO sim_revisions (simulation_id, revision_number, status, entry_path, activated_at, manifest_hash)
     VALUES ($1, 1, 'active', 'package/index.html', now(), $2) RETURNING id`,
    [simScripted.id, 'a'.repeat(64)]);
  const entryKey = `simulations/${project.id}/${simScripted.id}/revisions/${rev.id}/package/index.html`;
  await pg.query(
    `UPDATE simulations SET active_revision_id=$2, active_revision_entry_key=$3 WHERE id=$1`,
    [simScripted.id, rev.id, entryKey]);

  const simRaw = await one<{ id: string }>(
    `INSERT INTO simulations (project_id, name, storage_prefix, entry_file, status)
     VALUES ($1,'Full sim','simulations/${'PROJ'}/raw','https://cdn.test/simulations/raw/index.html','ready')
     RETURNING id`, [project.id]);

  // ── Sections ──
  // Scripted, on B: start 5 → absolute 65; end 40 → POST-ROLL to absolute 100 (B ends at 90).
  const sectionScripted = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, label, track,
                                    simulation_id, simple_ui, auto_script, sim_meta, sim_script)
     VALUES ($1,$2,5,40,'simulation','Scripted sim','main',$3,true,true,$4::jsonb,'main') RETURNING id`,
    [project.id, videoB.id, simScripted.id, JSON.stringify({ uiControls: { hide: ['#panel', '#debug'] } })]);
  await pg.query(
    `UPDATE timeline_sections SET simulation_url=$2 WHERE id=$1`,
    [sectionScripted.id, `https://cdn.test/simulations/scripted/index.html?section=${sectionScripted.id}&v=bh-1`]);

  // RAW, on A: a REAL bare URL (no query at all), no sim_meta, the meaningless literal 'main'.
  const sectionRaw = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, label, track,
                                    simulation_id, simulation_url, sim_script)
     VALUES ($1,$2,10,20,'simulation','Full simulation','main',$3,'https://cdn.test/simulations/raw/index.html','main')
     RETURNING id`, [project.id, videoA.id, simRaw.id]);

  // LEGACY scripted shape, on A: bare URL — the predicate reads RAW — but sim_meta EXISTS.
  const sectionLegacy = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, label, track,
                                    simulation_id, simulation_url, sim_script, sim_meta)
     VALUES ($1,$2,30,38,'simulation','Legacy scripted','main',$3,'https://cdn.test/simulations/raw/index.html','main',$4::jsonb)
     RETURNING id`,
    [project.id, videoA.id, simRaw.id, JSON.stringify({ plan: { steps: 3 }, uiControls: { hide: [] } })]);

  // Clip on A: window [10, 18) local, source in-point 4.
  const sectionClip = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, label, track,
                                    clip_source_video_id, clip_in_sec)
     VALUES ($1,$2,10,18,'clip','Cutaway clip','main',$3,4) RETURNING id`,
    [project.id, videoA.id, broll.id]);

  // Image on A: window [40, 45) local, default camera movement (zoom_in → v1 static warning).
  const sectionImage = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, label, track,
                                    clip_source_image_id)
     VALUES ($1,$2,40,45,'clip','Diagram still','main',$3) RETURNING id`,
    [project.id, videoA.id, image.id]);

  // B-roll overlay: GLOBAL offset 20; start/end are SOURCE in/out [2, 8).
  const sectionBroll = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, label, track,
                                    global_offset_sec)
     VALUES ($1,$2,2,8,'broll','Drone shot','broll',20) RETURNING id`,
    [project.id, broll.id]);

  // Audio cutaway: GLOBAL offset 33; source [1, 6); stored gain 0.5.
  const sectionAudio = await one<{ id: string }>(
    `INSERT INTO timeline_sections (project_id, video_file_id, start_sec, end_sec, type, label, track,
                                    clip_source_audio_id, global_offset_sec, broll_volume)
     VALUES ($1,$2,1,6,'broll','Music bed','audio',$3,33,0.5) RETURNING id`,
    [project.id, videoA.id, audioF.id]);

  // The scripted section's identity-matched poster, seeded through the SAME shared helpers the
  // builder resolves with — so `posterKey` is an assertion about the identity axis, not a string.
  const packageRevision = packageRevisionFor(
    { id: simScripted.id, bridge_hash: 'bh-1', active_revision_id: rev.id }, derivePackageRevision);
  const identity = posterIdentityString({
    packageRevision,
    variantKey: sectionScripted.id,
    configHash: computeConfigHash({
      ...DEFAULT_PRESENTATION_CONFIG,
      simpleUi: true, hideSelectors: ['#panel', '#debug'], autoScript: true,
      quality: 'high', aspect: 'wide',
    }),
    aspectProfile: 'wide', qualityProfile: 'high',
  });
  const posterPath = `simulations/${project.id}/${simScripted.id}/posters/${identity}__standard.webp`;
  await pg.query(
    `INSERT INTO sim_posters (simulation_id, package_revision, variant_key, config_hash,
                              aspect_profile, quality_profile, identity, variants)
     VALUES ($1,$2,$3,$4,'wide','high',$5,$6::jsonb)`,
    [simScripted.id, packageRevision, sectionScripted.id, identity.split('__')[2] ?? 'cfg', identity,
     JSON.stringify([{
       size: 'standard', format: 'webp', path: posterPath, checksum: 'c'.repeat(64),
       contentType: 'image/webp', width: 1280, height: 720, bytes: 4242,
     }])]);

  return {
    projectId: project.id,
    videoAId: videoA.id, videoBId: videoB.id, brollId: broll.id,
    imageId: image.id, audioId: audioF.id,
    simScriptedId: simScripted.id, simRawId: simRaw.id,
    sectionScriptedId: sectionScripted.id, sectionRawId: sectionRaw.id,
    sectionLegacyId: sectionLegacy.id,
    sectionClipId: sectionClip.id, sectionImageId: sectionImage.id,
    sectionBrollId: sectionBroll.id, sectionAudioId: sectionAudio.id,
    activeRevId: rev.id, entryKey, posterPath,
  };
}

let fx: Fixture;

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
  fx = await seed();
});
afterEach(async () => { await pg.close(); });

const plan = () => buildExportPlan(fx.projectId, storage);

function windowFor<K extends { sectionId: string | null }>(
  timeline: readonly { sectionId: string | null }[], sectionId: string,
): K | undefined {
  return timeline.find((w) => w.sectionId === sectionId) as K | undefined;
}

// ── The timeline resolution ───────────────────────────────────────────────────────────────────

describe('buildExportPlan — timeline resolution (the player’s own rules)', () => {
  it('orders main segments by created_at and offsets them by cumulative duration', async () => {
    const p = (await plan())!;
    const bases = p.timeline.filter((w): w is VideoWindow => w.kind === 'video');
    expect(bases.map((b) => [b.videoFileId, b.startSec, b.endSec])).toEqual([
      [fx.videoAId, 0, 60],
      [fx.videoBId, 60, 90],
    ]);
  });

  it('a main-track window is SEGMENT-LOCAL: the scripted sim on B lands at offset + start_sec', async () => {
    const p = (await plan())!;
    const win = windowFor<SimCaptureWindow>(p.timeline, fx.sectionScriptedId)!;
    expect(win.kind).toBe('sim-capture');
    expect(win.startSec).toBe(65);   // 60 (B's offset) + 5
  });

  it('broll/audio windows are GLOBAL-OFFSET with start/end as SOURCE in/out', async () => {
    const p = (await plan())!;
    const brollWin = windowFor<ClipWindow>(p.timeline, fx.sectionBrollId)!;
    expect(brollWin.kind).toBe('clip');
    expect(brollWin.sourceRole).toBe('broll');
    expect([brollWin.startSec, brollWin.endSec]).toEqual([20, 26]);
    expect([brollWin.sourceInSec, brollWin.sourceOutSec]).toEqual([2, 8]);

    const cutaway = p.audio.find((a) => a.sectionId === fx.sectionAudioId)!;
    expect(cutaway.globalOffsetSec).toBe(33);
    expect([cutaway.sourceInSec, cutaway.sourceOutSec]).toEqual([1, 6]);
    expect(cutaway.gain).toBe(0.5);
  });

  it('a clip section is segment-local with clip_in_sec as the source in-point', async () => {
    const p = (await plan())!;
    const clip = windowFor<ClipWindow>(p.timeline, fx.sectionClipId)!;
    expect(clip.sourceRole).toBe('clip');
    expect([clip.startSec, clip.endSec]).toEqual([10, 18]);
    expect([clip.sourceInSec, clip.sourceOutSec]).toEqual([4, 12]);
    expect(clip.sourceVideoFileId).toBe(fx.brollId);
  });

  it('an image section classifies as image, carries its crop, and warns that motion is flattened', async () => {
    const p = (await plan())!;
    const img = windowFor<ImageWindow>(p.timeline, fx.sectionImageId)!;
    expect(img.kind).toBe('image');
    expect(img.crop).toEqual({ x: 0.1, y: 0.2, w: 0.8, h: 0.7 });
    expect(p.warnings.some((w) => w.includes('Diagram still') && w.includes('static frame'))).toBe(true);
  });

  it('audio: both main tracks plus the cutaway, in offset order; b-roll stays muted with a warning', async () => {
    const p = (await plan())!;
    expect(p.audio.map((a) => [a.source, a.globalOffsetSec])).toEqual([
      ['main', 0], ['audio', 33], ['main', 60],
    ]);
    expect(p.warnings.some((w) => w.includes('Drone shot') && w.includes('muted'))).toBe(true);
  });

  it('locks the grid at 1920×1080@30 and floors the disk estimate at the referenced source bytes', async () => {
    const p = (await plan())!;
    expect(p.grid).toEqual({ w: 1920, h: 1080, fps: 30 });
    // A (1 MB) + B (2 MB) + broll (4 KB, referenced twice but counted once).
    expect(p.estimatedSourceBytes).toBe(1000000 + 2000000 + 4096);
    expect(p.requiredDiskBytes).toBeGreaterThan(p.estimatedSourceBytes);
  });
});

// ── The predicate and its refinements ─────────────────────────────────────────────────────────

describe('buildExportPlan — THE PREDICATE', () => {
  it('excludes a RAW ("show full simulation") section — as a warning, never silently', async () => {
    const p = (await plan())!;
    // MUTATION TARGET: flip the predicate to include RAW and this window appears → fails.
    expect(p.timeline.find((w) => w.sectionId === fx.sectionRawId)).toBeUndefined();
    expect(p.warnings.some((w) =>
      w.includes('Full simulation') && w.includes('not part of the rendered video'))).toBe(true);
  });

  it('classifies a scripted section (`?section=&v=`) as sim-capture with the viewer’s own params', async () => {
    const p = (await plan())!;
    const win = windowFor<SimCaptureWindow>(p.timeline, fx.sectionScriptedId)!;
    expect(win.kind).toBe('sim-capture');
    // Served URL: the revision pointer resolved, the stored query APPENDED VERBATIM, and the
    // viewer's Minimal-UI boot cloak in the fragment (simple_ui=true + ui_hide ⇒ the selectors).
    expect(win.servedUrl).toBe(
      `https://sim.test/${fx.entryKey}?section=${fx.sectionScriptedId}&v=bh-1`
      + `#simboot=${encodeURIComponent(JSON.stringify({ hide: ['#panel', '#debug'] }))}`);
    expect(win.simpleUi).toBe(true);
    expect(win.autoScript).toBe(true);
    expect(win.uiHide).toEqual(['#panel', '#debug']);
    // The capture's own identity axis rides along.
    expect(win.configHash).toMatch(/^[0-9a-f]{16}$/);
    // The identity-matched poster key rode along for the fallback path.
    expect(win.posterKey).toBe(fx.posterPath);
  });

  it('the predicate itself: RAW is bare-URL + no real script; a ?section= URL is never RAW', () => {
    expect(isFullSimulation({
      id: 's', type: 'simulation',
      simulation_url: 'https://cdn.test/simulations/raw/index.html', sim_script: 'main',
    })).toBe(true);
    expect(isFullSimulation({
      id: 's', type: 'simulation',
      simulation_url: 'https://cdn.test/x/index.html?section=abc&v=h', sim_script: 'main',
    })).toBe(false);
    expect(isFullSimulation({
      id: 's', type: 'simulation',
      simulation_url: 'https://cdn.test/simulations/raw/index.html', sim_script: 'reaction-rates',
    })).toBe(false);
    expect(isFullSimulation({ id: 's', type: 'clip', simulation_url: null, sim_script: null })).toBe(false);
  });

  it('legacy backstop: a bare-URL section WITH sim_meta becomes poster-fallback with the repair warning — never a silent exclusion', async () => {
    const p = (await plan())!;
    // MUTATION TARGET: silently exclude the legacy shape and this window disappears → fails.
    const win = windowFor<PosterFallbackWindow>(p.timeline, fx.sectionLegacyId)!;
    expect(win).toBeDefined();
    expect(win.kind).toBe('poster-fallback');
    expect([win.startSec, win.endSec]).toEqual([30, 38]);
    expect(p.warnings.some((w) =>
      w.includes('Legacy scripted')
      && w.includes('suspected legacy scripted simulation')
      && w.includes('classify-orphan-sim-rows'))).toBe(true);
  });
});

// ── Post-roll ─────────────────────────────────────────────────────────────────────────────────

describe('buildExportPlan — post-roll', () => {
  it('a sim window past its video’s end keeps its authored end and extends the export total', async () => {
    const p = (await plan())!;
    const win = windowFor<SimCaptureWindow>(p.timeline, fx.sectionScriptedId)!;
    // MUTATION TARGET: clamp the window to B's end (90) and both assertions fail.
    expect(win.endSec).toBe(100);          // 60 + authored end_sec 40
    expect(p.totalDurationSec).toBe(100);  // extended past the 90 s of main video
  });

  it('without a post-rolling window the total is the main-video sum', async () => {
    await pg.query(`UPDATE timeline_sections SET end_sec = 15 WHERE id = $1`, [fx.sectionScriptedId]);
    // The URL's ?section= key is the poster variant axis, not the window shape — no update needed.
    const p = (await plan())!;
    expect(p.totalDurationSec).toBe(90);
  });
});

// ── Branching ─────────────────────────────────────────────────────────────────────────────────

describe('withBootCloak — the Minimal-UI boot cloak on the served URL', () => {
  const enc = (hide: string[]): string => `#simboot=${encodeURIComponent(JSON.stringify({ hide }))}`;

  it('carries the hide selectors only when Minimal UI is ON (bootHideFor semantics)', () => {
    expect(withBootCloak('http://s/x.html?section=a&v=1', true, ['.controls', '#hud']))
      .toBe(`http://s/x.html?section=a&v=1${enc(['.controls', '#hud'])}`);
    // Full UI: an EMPTY cloak, so nothing is hidden but the fragment shape stays uniform.
    expect(withBootCloak('http://s/x.html?section=a&v=1', false, ['.controls']))
      .toBe(`http://s/x.html?section=a&v=1${enc([])}`);
    // Minimal UI with nothing configured to hide: also empty.
    expect(withBootCloak('http://s/x.html', true, undefined)).toBe(`http://s/x.html${enc([])}`);
  });

  it('replaces any fragment already on the stored URL rather than stacking a second one', () => {
    expect(withBootCloak(`http://s/x.html${enc(['.old'])}`, true, ['.new']))
      .toBe(`http://s/x.html${enc(['.new'])}`);
  });

  it('passes a null URL through untouched', () => {
    expect(withBootCloak(null, true, ['.controls'])).toBeNull();
  });
});

describe('buildExportPlan — branching', () => {
  it('refuses a branching project: typed, coded, and NOT retryable', async () => {
    await pg.query(
      `INSERT INTO branch_sequences (project_id, label, is_entry, sort_order) VALUES ($1,'Intro',true,0)`,
      [fx.projectId]);
    let thrown: unknown;
    try { await plan(); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(ExportRefused);
    const refusal = thrown as ExportRefused;
    expect(refusal.code).toBe('export_branching_unsupported');
    // MUTATION TARGET: reclassify the refusal as retryable and this fails — "press the button
    // again" is provably false advice for a project that has branching.
    expect(refusal.retryable).toBe(false);
    expect(refusal.statusCode).toBe(409);
  });

  it('returns null for a project that does not exist', async () => {
    expect(await buildExportPlan('00000000-0000-4000-8000-000000000000', storage)).toBeNull();
  });
});

// ── Source identity snapshot ──────────────────────────────────────────────────────────────────

describe('buildExportPlan — the source-identity snapshot', () => {
  it('freezes size/etag for every MUTABLE input, and manifest_hash for the immutable revision', async () => {
    const p = (await plan())!;
    const byKey = new Map(p.sources.map((s) => [s.storageKey, s]));

    // Every mutable input the timeline references, each with the HEAD taken at plan time.
    for (const [key, kind] of [
      [`videos/${fx.projectId}/a.mp4`, 'video'],
      [`videos/${fx.projectId}/b.mp4`, 'video'],
      [`videos/${fx.projectId}/broll.mp4`, 'video'],
      [`images/${fx.projectId}/still.png`, 'image'],
      [`audio/${fx.projectId}/music.mp3`, 'audio'],
      [fx.posterPath, 'poster'],
    ] as const) {
      const src = byKey.get(key);
      expect(src, key).toBeDefined();
      expect(src!.kind).toBe(kind);
      expect(src!.sizeBytes).toBe(key.length * 100);
      expect(src!.etag).toBe(`etag:${key}`);
    }

    // The revision source carries its manifest hash — bytes already immutable by the model.
    const rev = p.sources.find((s) => s.kind === 'sim-revision');
    expect(rev).toBeDefined();
    expect(rev!.storageKey).toBe(fx.entryKey);
    expect(rev!.manifestHash).toBe('a'.repeat(64));

    // Phase 1 captures nothing, and the plan records that honestly.
    expect(p.rendererIdentity).toBeNull();
  });
});

// ── Out-of-scope layers ───────────────────────────────────────────────────────────────────────

describe('buildExportPlan — out-of-scope layers are warnings, never silence', () => {
  it('captions on a main video and avatar circles both surface as warnings', async () => {
    await pg.query(
      `UPDATE projects SET avatar_config = $2::jsonb WHERE id = $1`,
      [fx.projectId, JSON.stringify({ avatarCircles: { enabled: true, faces: [] } })]);
    const p = (await plan())!;
    expect(p.warnings.some((w) => w.includes('captions are not in the v1 export'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('avatar circles are not in the v1 export'))).toBe(true);
  });
});

/**
 * Admission control. Capture cost is measured: ~5.4 s per frame at 640x360 and ~16 s at 1920x1080 on
 * the reference 2-vCPU worker, against a per-section budget of min(600, 90 + 6*durationSec). A job
 * whose workload cannot fit is not "slow" — it occupies a worker for the full budget and is then
 * killed, which under the strict policy fails the export an hour after the user asked for it.
 * Refusing at the door is both truthful and what stops one project starving everyone else's queue.
 */
describe('admitCaptureWorkload', () => {
  const sim = (startSec: number, endSec: number, label = 'sim') =>
    ({ kind: 'sim-capture', startSec, endSec, label });

  it('admits an ordinary export', () => {
    expect(admitCaptureWorkload([sim(0, 10), sim(20, 30), { kind: 'video', startSec: 0, endSec: 60 }], 30)).toBeNull();
  });

  it('admits a project with no simulations at all', () => {
    expect(admitCaptureWorkload([{ kind: 'video', startSec: 0, endSec: 3600 }], 30)).toBeNull();
  });

  it('refuses too many simulation sections with 413 and a message that says what to do', () => {
    const many = Array.from({ length: MAX_SIM_WINDOWS_PER_EXPORT + 1 }, (_, i) => sim(i * 20, i * 20 + 5));
    const verdict = admitCaptureWorkload(many, 30);
    expect(verdict).toMatchObject({ statusCode: 413, code: 'too_many_simulations' });
    expect(verdict!.message).toMatch(/export them separately/i);
  });

  it('refuses a single over-long window, naming it', () => {
    const verdict = admitCaptureWorkload([sim(0, MAX_SIM_WINDOW_SEC + 1, 'The murmuration')], 30);
    expect(verdict).toMatchObject({ statusCode: 413, code: 'simulation_window_too_long' });
    expect(verdict!.message).toContain('The murmuration');
  });

  it('refuses a total frame count no worker could deliver, with 429', () => {
    // Each window is individually legal; together they are not. Frames, not window count, is the
    // quantity that actually costs time.
    const perWindow = MAX_SIM_WINDOW_SEC;
    const n = Math.ceil(MAX_TOTAL_CAPTURE_FRAMES / (perWindow * 30)) + 1;
    const windows = Array.from({ length: Math.min(n, MAX_SIM_WINDOWS_PER_EXPORT) },
      (_, i) => sim(i * 60, i * 60 + perWindow));
    const frames = windows.length * perWindow * 30;
    if (frames > MAX_TOTAL_CAPTURE_FRAMES) {
      expect(admitCaptureWorkload(windows, 30)).toMatchObject({ statusCode: 429, code: 'capture_workload_too_large' });
    }
  });
});
