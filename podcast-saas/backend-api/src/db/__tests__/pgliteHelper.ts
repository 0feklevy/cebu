/**
 * Test helper: an in-process Postgres (PGlite, real Postgres compiled to WASM)
 * with the minimal legacy parent tables plus migration 030 applied. Used by the
 * constraint and backfill-integration tests so we exercise the ACTUAL DDL and
 * constraints rather than mocks.
 *
 * Not a *.test.ts file, so vitest does not collect it as a suite.
 */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
// Course-publishing migrations applied in order: 030 creates the tables, 032
// hardens them (tightened archive checks, composite unique, redirect targets).
const COURSE_MIGRATIONS = ['030_course_publishing.sql', '032_course_publishing_hardening.sql'];

// Minimal projections of the legacy parent tables that migration 030 references.
// Only the columns the FKs and the backfill touch — kept deliberately small.
const PREREQ_DDL = `
  CREATE TABLE orgs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES orgs(id),
    created_by UUID REFERENCES users(id),
    title TEXT,
    topic TEXT,
    thumbnail_url TEXT,
    share_token TEXT UNIQUE,
    share_enabled_at TIMESTAMPTZ,
    view_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE playlists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES orgs(id),
    created_by UUID REFERENCES users(id),
    title TEXT,
    description TEXT,
    banner_url TEXT,
    share_token TEXT UNIQUE,
    share_enabled_at TIMESTAMPTZ,
    view_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE playlist_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    playlist_id UUID NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (playlist_id, project_id)
  );
`;

export interface TestDb {
  pg: PGlite;
  /** Seed an org and return its id. */
  seedOrg(name?: string): Promise<string>;
  /** Seed a project; returns its id. */
  seedProject(orgId: string, opts?: { title?: string; topic?: string; shareToken?: string | null }): Promise<string>;
  /** Insert a minimal valid course; returns its id. Overrides merge over defaults. */
  insertCourse(orgId: string, overrides?: Record<string, unknown>): Promise<string>;
  /** A driver-agnostic Querier (matches the backfill runner's seam). */
  querier(): { query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]> };
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pg = new PGlite();
  await pg.exec(PREREQ_DDL);
  for (const file of COURSE_MIGRATIONS) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'));
  }

  async function seedOrg(name = 'Org'): Promise<string> {
    const r = await pg.query<{ id: string }>(`INSERT INTO orgs (name) VALUES ($1) RETURNING id`, [name]);
    return r.rows[0].id;
  }

  async function seedProject(orgId: string, opts: { title?: string; topic?: string; shareToken?: string | null } = {}): Promise<string> {
    const r = await pg.query<{ id: string }>(
      `INSERT INTO projects (org_id, title, topic, share_token) VALUES ($1,$2,$3,$4) RETURNING id`,
      [orgId, opts.title ?? 'Project', opts.topic ?? null, opts.shareToken ?? null],
    );
    return r.rows[0].id;
  }

  async function insertCourse(orgId: string, overrides: Record<string, unknown> = {}): Promise<string> {
    const cols: Record<string, unknown> = {
      org_id: orgId,
      kind: 'single',
      slug: 'a-course',
      publish_state: 'draft',
      language: 'en',
      indexable: true,
      ...overrides,
    };
    const keys = Object.keys(cols);
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const r = await pg.query<{ id: string }>(
      `INSERT INTO courses (${keys.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      keys.map((k) => cols[k]),
    );
    return r.rows[0].id;
  }

  function querier() {
    return {
      async query<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
        const r = await pg.query<T>(text, params);
        return r.rows;
      },
    };
  }

  return { pg, seedOrg, seedProject, insertCourse, querier, close: () => pg.close() };
}

/** Assert that a thunk rejects (a constraint fired). Returns the error message. */
export async function expectReject(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected the operation to be rejected by a constraint, but it succeeded');
}
