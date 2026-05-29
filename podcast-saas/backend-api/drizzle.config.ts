import type { Config } from 'drizzle-kit';

// Provide a minimal ambient declaration for `process` so TS doesn't require
// @types/node for this config file.
declare const process: { env: { DATABASE_URL?: string } };

export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/podcast_saas',
  },
} satisfies Config;
