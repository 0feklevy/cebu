import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';
import { logger } from '../lib/logger.js';

const connectionString =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas';

const queryClient = postgres(connectionString, {
  max: 10,
  idle_timeout: 30,
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
