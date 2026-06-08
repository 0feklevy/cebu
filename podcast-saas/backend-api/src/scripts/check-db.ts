/**
 * Data integrity check script.
 * Run with: pnpm --filter backend-api run db:check
 *
 * Verifies:
 *  1. All migrations have been applied (no pending ones)
 *  2. Core tables are readable and return sane counts
 *  3. No orphaned references (sections without videos, etc.)
 *  4. User data is intact — projects, videos, sections, simulations
 */

import postgres from 'postgres';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '../db/migrations');

const MIGRATION_FILES = [
  '001_initial.sql',
  '002_audio_scenes.sql',
  '003_document_type.sql',
  '004_video_editor.sql',
  '005_hls_transcoding.sql',
  '006_hls_tier_progress.sql',
  '007_waveform_peaks.sql',
  '008_simulations.sql',
  '009_section_sim_ref.sql',
  '010_broll_generation.sql',
  '011_sim_prompt.sql',
  '012_broll_source_flag.sql',
  '013_sim_meta.sql',
  '014_clip_source.sql',
  '015_bridge_plan_prompt.sql',
  '016_share_token.sql',
  '017_broll_audio.sql',
  '018_image_clips.sql',
  '019_guidance.sql',
  '020_audio_files.sql',
  '021_playlists.sql',
  '022_smart_crop.sql',
  '023_playlist_banners.sql',
  '024_billing.sql',
  '025_video_metadata.sql',
  '026_crop_updated_at.sql',
  '027_view_counts.sql',
  '028_avatar.sql',
  '029_avatar_persona.sql',
  '030_course_publishing.sql',
  '031_captions.sql',
  '032_course_publishing_hardening.sql',
  '033_captions_vtt.sql',
];

type Row = Record<string, unknown>;

function ok(msg: string)   { console.log(`  ✓  ${msg}`); }
function warn(msg: string) { console.warn(`  ⚠  ${msg}`); }
function fail(msg: string) { console.error(`  ✗  ${msg}`); }

async function run() {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas';
  const sql = postgres(connectionString, { max: 1 });

  let hasFailure = false;

  try {
    console.log('\n═══════════════════════════════════════════');
    console.log(' DB Integrity Check — podcast-saas');
    console.log('═══════════════════════════════════════════\n');

    // ── 1. Migrations ────────────────────────────────────────────────────────
    console.log('1. Migrations');
    const applied: Row[] = await sql`SELECT filename FROM schema_migrations ORDER BY filename`;
    const appliedSet = new Set(applied.map((r) => r.filename as string));

    for (const f of MIGRATION_FILES) {
      if (appliedSet.has(f)) {
        ok(f);
      } else {
        fail(`MISSING: ${f} — run pnpm --filter backend-api run db:migrate`);
        hasFailure = true;
      }
    }
    // Verify migration files exist on disk
    for (const f of MIGRATION_FILES) {
      try {
        readFileSync(join(MIGRATIONS_DIR, f));
      } catch {
        warn(`Migration file not found on disk: ${f}`);
      }
    }

    // ── 2. Table counts ──────────────────────────────────────────────────────
    console.log('\n2. Table row counts');
    const tables = [
      'orgs', 'users', 'projects', 'video_files', 'timeline_sections',
      'simulations', 'video_generation_jobs',
    ];
    for (const t of tables) {
      const [{ count }] = await sql`SELECT COUNT(*) AS count FROM ${sql(t)}`;
      ok(`${t}: ${count} rows`);
    }

    // ── 3. Orphan checks ─────────────────────────────────────────────────────
    console.log('\n3. Orphan / referential integrity checks');

    const [{ orphan_sections }] = await sql`
      SELECT COUNT(*) AS orphan_sections
      FROM timeline_sections ts
      LEFT JOIN video_files vf ON ts.video_file_id = vf.id
      WHERE vf.id IS NULL
    `;
    if (Number(orphan_sections) > 0) {
      warn(`${orphan_sections} timeline_sections reference missing video_files`);
    } else {
      ok('No orphaned timeline_sections');
    }

    const [{ orphan_jobs }] = await sql`
      SELECT COUNT(*) AS orphan_jobs
      FROM video_generation_jobs j
      LEFT JOIN projects p ON j.project_id = p.id
      WHERE p.id IS NULL
    `;
    if (Number(orphan_jobs) > 0) {
      warn(`${orphan_jobs} video_generation_jobs reference missing projects`);
    } else {
      ok('No orphaned video_generation_jobs');
    }

    // ── 4. Per-user data snapshot ────────────────────────────────────────────
    console.log('\n4. User data snapshot (per project)');
    const projects: Row[] = await sql`
      SELECT p.id, p.title, p.created_at,
             COUNT(DISTINCT vf.id)   AS videos,
             COUNT(DISTINCT ts.id)   AS sections,
             COUNT(DISTINCT s.id)    AS simulations
      FROM projects p
      LEFT JOIN video_files vf       ON vf.project_id = p.id AND NOT vf.is_broll
      LEFT JOIN timeline_sections ts ON ts.project_id = p.id
      LEFT JOIN simulations s        ON s.project_id  = p.id
      GROUP BY p.id, p.title, p.created_at
      ORDER BY p.created_at DESC
      LIMIT 20
    `;

    if (projects.length === 0) {
      warn('No projects found — this may be expected for a fresh install');
    } else {
      for (const p of projects) {
        console.log(
          `  • ${p.title ?? '(untitled)'} [${(p.id as string).slice(0, 8)}…]` +
          `  videos=${p.videos}  sections=${p.sections}  sims=${p.simulations}`,
        );
      }
    }

    // ── 5. is_broll column check ─────────────────────────────────────────────
    console.log('\n5. Broll source flag integrity');
    const [{ broll_count }] = await sql`
      SELECT COUNT(*) AS broll_count
      FROM video_files vf
      INNER JOIN video_generation_jobs j ON j.video_file_id = vf.id
      WHERE NOT vf.is_broll
    `;
    if (Number(broll_count) > 0) {
      warn(`${broll_count} AI-generated video_files still have is_broll=false — re-run migration 012`);
    } else {
      ok('All AI-generated video_files correctly marked is_broll=true');
    }

    // ── Result ───────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════');
    if (hasFailure) {
      console.error(' RESULT: FAILED — fix the issues above\n');
      process.exit(1);
    } else {
      console.log(' RESULT: OK — data looks healthy\n');
    }
  } catch (err) {
    console.error('\nFATAL:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

run();
