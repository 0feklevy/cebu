import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import postgres from 'postgres';
import { logger } from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas';
  const sql = postgres(connectionString, { max: 1 });

  try {
    logger.info('Running migrations...');

    // Ensure tracking table exists
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;

    const migrations = ['001_initial.sql', '002_audio_scenes.sql', '003_document_type.sql', '004_video_editor.sql', '005_hls_transcoding.sql', '006_hls_tier_progress.sql', '007_waveform_peaks.sql', '008_simulations.sql', '009_section_sim_ref.sql', '010_broll_generation.sql', '011_sim_prompt.sql', '012_broll_source_flag.sql', '013_sim_meta.sql', '014_clip_source.sql', '015_bridge_plan_prompt.sql', '016_share_token.sql', '017_broll_audio.sql', '018_image_clips.sql'];

    for (const file of migrations) {
      const [row] = await sql`
        SELECT filename FROM schema_migrations WHERE filename = ${file}
      `;
      if (row) {
        logger.info({ file }, 'Migration already applied — skipping');
        continue;
      }

      logger.info({ file }, 'Applying migration');
      const sql_text = readFileSync(join(__dirname, 'migrations', file), 'utf-8');
      try {
        await sql.unsafe(sql_text);
      } catch (err: unknown) {
        const pg = err as { code?: string; message?: string };
        // 42701 = column already exists, 42P07 = relation already exists, 23505 = unique violation
        // These mean the migration was previously applied outside the tracker — mark it and continue.
        if (pg.code === '42701' || pg.code === '42P07' || pg.code === '23505') {
          logger.warn({ file, code: pg.code }, 'Migration DDL already applied (tracking catch-up) — marking as done');
        } else {
          throw err;
        }
      }
      await sql`INSERT INTO schema_migrations (filename) VALUES (${file})`;
      logger.info({ file }, 'Migration applied');
    }

    logger.info('Migrations complete');
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    process.exit(1);
  } finally {
    await sql.end();
  }
}

migrate();
