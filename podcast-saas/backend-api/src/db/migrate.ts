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

    const migrations = ['001_initial.sql', '002_audio_scenes.sql', '003_document_type.sql'];

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
      await sql.unsafe(sql_text);
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
