import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { logger } from '../lib/logger.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas';

// postgres.js URL parser truncates usernames that contain a dot (e.g. the
// Supabase pooler format "postgres.project-ref").  Parse the URL manually and
// pass individual options so the full username is preserved.
function parseDbUrl(url: string): Parameters<typeof postgres>[1] & { host: string; port: number; database: string; username: string; password: string } {
  const u = new URL(url);
  return {
    host:     u.hostname,
    port:     u.port ? parseInt(u.port, 10) : 5432,
    database: u.pathname.replace(/^\//, ''),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl:      u.hostname.endsWith('.supabase.com') || u.hostname.endsWith('.supabase.co')
                ? 'require'
                : undefined,
  };
}

const connOpts = parseDbUrl(connectionString);

const queryClient = postgres({
  ...connOpts,
  max:             10,
  idle_timeout:    30,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema });

export type DB = typeof db;
export * from './schema.js';

export async function checkDatabaseConnection(): Promise<void> {
  try {
    await queryClient`SELECT 1`;
    logger.info('Database connected');
  } catch (err) {
    logger.error({ err }, 'Database connection failed');
    throw err;
  }
}
