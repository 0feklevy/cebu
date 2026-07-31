/**
 * Reproducible test fixture for the adaptive simulation pool (feat/sim-pool-adaptive).
 *
 * The production project (Edge of Chaos) has only 2 sim packages and no branching, so it
 * can't exercise: a 3rd distinct package, a LEGACY (non-dynamic) bridge, or branch paths that
 * must NOT preload unrelated sims. This seeds a project that does — reusing REAL, already-
 * generated sim URLs + a REAL playable HLS video, so it plays end-to-end on staging.
 *
 * Structure (fixed project id — idempotent: re-running deletes + recreates it):
 *   Entry sequence  "Main path"   (video, plays 0..≈90s):
 *     • §A1 boids-3d      (simple_ui ON)   — package A, dynamic v2 bridge
 *     • §A2 boids-3d      (simple_ui OFF)  — SAME package A, DIFFERENT section config
 *     • §B  murmuration   (simple_ui OFF)  — package B, dynamic v2 bridge
 *     • choice point → "Deep dive" sequence
 *   Branch sequence "Deep dive"  (video):
 *     • §C  pluck-boids   — package C, LEGACY bridge (no combined dispatch) → nav fallback
 *
 * Package C lives ONLY on the branch, so a viewer on the main path must NOT pool it until the
 * branch is entered — the "branching paths don't preload unrelated sims" test.
 *
 * This is a MANUAL test tool — it is never invoked by the app/production path. It creates a
 * PUBLIC project so a phone can reach it without auth during device testing; DELETE it from
 * any shared database when done.
 *
 *   Seed:   tsx --env-file=../.env src/scripts/seed-sim-pool-fixture.ts
 *   Delete: tsx --env-file=../.env src/scripts/seed-sim-pool-fixture.ts --delete
 *   URL:    /projects/00000000-0000-4000-a000-0000000f1c7e/view   (printed on success)
 */
import { db } from '../db/index.js';
import {
  projects, video_files, timeline_sections, simulations,
  branch_sequences, branch_choice_points, branch_edges,
} from '../db/schema.js';
import { eq, and, like } from 'drizzle-orm';
import { getStorageAdapter } from '../services/storage/getStorageAdapter.js';

const FIXTURE_ID = '00000000-0000-4000-a000-0000000f1x7e'.replace('x', 'c'); // valid uuid
const SOURCE_PROJECT = 'd8e7557a-6efd-4458-ab20-a391a0ee6b52';   // Edge of Chaos (real sim URLs + video)

async function main() {
  // Teardown: remove the fixture from the (shared) database. Cascades to its videos/sections/
  // branching. Safe to run even if the fixture doesn't exist.
  if (process.argv.includes('--delete')) {
    const del = await db.delete(projects).where(eq(projects.id, FIXTURE_ID)).returning({ id: projects.id });
    console.log(del.length ? `🗑  Fixture ${FIXTURE_ID} deleted.` : `Fixture ${FIXTURE_ID} not present — nothing to delete.`);
    process.exit(0);
  }

  const storage = getStorageAdapter();

  // Reuse two DIFFERENT boids section URLs + one murmuration section URL from the real project.
  const srcSecs = await db.query.timeline_sections.findMany({
    where: and(eq(timeline_sections.project_id, SOURCE_PROJECT), eq(timeline_sections.type, 'simulation')),
  });
  const boids = srcSecs.filter((s) => s.simulation_url?.includes('/boids-3d/'));
  const murm  = srcSecs.find((s) => s.simulation_url?.includes('/murmuration-knob/'));
  if (boids.length < 2 || !murm) throw new Error('source project is missing the expected boids/murmuration sections');
  const boidsUrlA = boids[0].simulation_url!;
  const boidsUrlB = boids[1].simulation_url!;
  const murmUrl   = murm.simulation_url!;

  // Package C: pluck-boids has NO combined bridge (legacy) — its bare entry URL exercises the
  // legacy per-URL navigation fallback.
  const pluck = await db.query.simulations.findFirst({ where: like(simulations.name, 'pluck-boids') });
  if (!pluck) throw new Error('pluck-boids simulation not found');
  const pluckUrl = storage.getSimPublicUrl(pluck.entry_file.replace(/^https?:\/\/[^/]+\/sim-public\//, ''));

  // A real, playable main video (HLS ready).
  const srcVid = await db.query.video_files.findFirst({
    where: and(eq(video_files.project_id, SOURCE_PROJECT), eq(video_files.is_broll, false)),
  });
  if (!srcVid?.hls_master_key) throw new Error('source project has no playable HLS video');

  // Reuse the source project's org + owner (org_id is NOT NULL; owner makes it visible in the UI).
  const srcProj = await db.query.projects.findFirst({
    where: eq(projects.id, SOURCE_PROJECT), columns: { org_id: true, created_by: true },
  });
  if (!srcProj) throw new Error('source project not found');

  // Idempotent: wipe any prior fixture (cascades to its videos/sections/branching).
  await db.delete(projects).where(eq(projects.id, FIXTURE_ID));

  await db.insert(projects).values({
    id: FIXTURE_ID,
    org_id: srcProj.org_id,
    created_by: srcProj.created_by,
    title: '[FIXTURE] Sim Pool — 3 packages + branching',
    topic: 'Adaptive sim-pool test fixture (boids ×2 sections, murmuration, legacy pluck-boids on a branch)',
    visibility: 'public',
  } as typeof projects.$inferInsert);

  // Two sequences: entry "Main path" + branch "Deep dive".
  const [entrySeq] = await db.insert(branch_sequences).values({
    project_id: FIXTURE_ID, label: 'Main path', is_entry: true, sort_order: 0,
  }).returning();
  const [branchSeq] = await db.insert(branch_sequences).values({
    project_id: FIXTURE_ID, label: 'Deep dive', is_entry: false, sort_order: 1,
  }).returning();

  // One video row per sequence (both point at the same real HLS master → both play).
  const mkVideo = async (seqId: string, order: number) => {
    const [v] = await db.insert(video_files).values({
      project_id: FIXTURE_ID, filename: 'fixture.mp4', status: 'ready',
      duration_sec: srcVid.duration_sec, hls_status: 'ready',
      hls_master_key: srcVid.hls_master_key, hls_360p_key: srcVid.hls_360p_key,
      is_broll: false, sequence_id: seqId, sequence_order: order,
    } as typeof video_files.$inferInsert).returning();
    return v;
  };
  const entryVid  = await mkVideo(entrySeq.id, 0);
  const branchVid = await mkVideo(branchSeq.id, 0);

  const mkSim = (videoId: string, start: number, end: number, url: string, simpleUi: boolean, label: string) =>
    ({ project_id: FIXTURE_ID, video_file_id: videoId, start_sec: start, end_sec: end,
       type: 'simulation', track: 'main', simulation_url: url, sim_script: 'main',
       simple_ui: simpleUi, auto_script: true, label,
       ...(simpleUi ? { sim_meta: { uiControls: { hide: ['button'] } } } : {}) } as typeof timeline_sections.$inferInsert);

  await db.insert(timeline_sections).values([
    mkSim(entryVid.id, 20, 35, boidsUrlA, true,  'A1 boids (minimal UI)'),      // package A
    mkSim(entryVid.id, 50, 62, boidsUrlB, false, 'A2 boids (full UI)'),         // SAME package A, diff config
    mkSim(entryVid.id, 72, 88, murmUrl,   false, 'B murmuration'),              // package B
    mkSim(branchVid.id, 15, 40, pluckUrl, false, 'C pluck-boids (legacy)'),     // package C — branch only
  ]);

  // Choice point on the entry sequence → the branch (auto-advance for playthrough tests).
  const [cp] = await db.insert(branch_choice_points).values({
    project_id: FIXTURE_ID, sequence_id: entrySeq.id, lead_in_sec: 6, timeout_sec: 8,
    behavior: 'continue', prompt: 'Go deeper?', layout: 'cards',
  }).returning();
  await db.insert(branch_edges).values({
    project_id: FIXTURE_ID, choice_point_id: cp.id, label: 'Deep dive',
    destination_type: 'sequence', dest_sequence_id: branchSeq.id, sort_order: 0,
  });

  console.log('\n✅ Fixture seeded.');
  console.log(`   project id : ${FIXTURE_ID}`);
  console.log('   packages   : boids-3d (×2 sections, dynamic), murmuration-knob (dynamic), pluck-boids (LEGACY, branch-only)');
  console.log(`   view URL   : /projects/${FIXTURE_ID}/view`);
  console.log('   debug URL  : /projects/' + FIXTURE_ID + '/view?simdebug=1   (window.__SIM_TELEMETRY__.export())');
  console.log('   kill switch: append ?simpool=single to force the conservative one-frame fallback\n');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
