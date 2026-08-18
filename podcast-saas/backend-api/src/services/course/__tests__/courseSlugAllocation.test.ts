/**
 * Course slug allocation against a REAL Postgres engine (PGlite), with the real
 * `uniq_courses_host_slug` index from migration 030 in place.
 *
 * THE BUG THIS SUITE EXISTS FOR (backend-004)
 * `createCourse` deduped the new slug against `CourseRepository.listByOrg(user.orgId)` — the
 * caller's OWN organization — while the unique index is
 *
 *     CREATE UNIQUE INDEX uniq_courses_host_slug ON courses (COALESCE(canonical_host,'@platform'), slug)
 *
 * which is GLOBAL across organizations for the platform host. Two tenants who both name a course
 * "Intro to Physics" therefore both allocate `intro-to-physics`, and the second one's INSERT dies
 * with a raw 23505 that no handler catches — a 500 on a first-run action, caused by a stranger's
 * data the user cannot see.
 *
 * WHICH SIDE IS WRONG — the index or the allocation?
 * THE INDEX IS RIGHT. The public URL is `/api/v1/public/courses/:slug`, resolved by
 * `CourseRepository.findByPlatformSlug` with NO tenant segment and NO org filter, so one slug on
 * one host can only ever address one course. Scoping the index per org would make that lookup
 * ambiguous — two courses, one URL — which is a worse bug than a 500, and silently wrong instead
 * of loudly wrong. The rest of the service already agrees: `validateSlugAvailability` and
 * `changeSlug` both ask `slugTaken(slug, host, …)`, which is host-global. `createCourse` was the
 * only place that believed slugs were per-tenant. So: NO MIGRATION — the allocation was fixed to
 * match the namespace that already exists.
 *
 * The second property here is the one a pure read-then-insert can never have: the global read is
 * still a read, so two creates that interleave can still pick the same slug. The insert is
 * therefore retried on 23505 against a freshly-read namespace, which is what makes the endpoint
 * correct rather than merely less likely to fail.
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
// Publishing invalidation talks to the outside world; creating a draft course must not.
vi.mock('../PublishingInvalidationService.js', () => ({ dispatchInvalidation: vi.fn(async () => {}) }));

import { CoursePublishingService, type AuthUser } from '../CoursePublishingService.js';
import { CourseRepository } from '../CourseRepository.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

let pg: PGlite;
let tenantA: AuthUser;
let tenantB: AuthUser;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}

async function seedTenant(name: string, uid: string): Promise<AuthUser> {
  const [org] = await rows<{ id: string }>(`INSERT INTO orgs (name) VALUES ($1) RETURNING id`, [name]);
  const [user] = await rows<{ id: string }>(
    `INSERT INTO users (firebase_uid, email, default_org_id) VALUES ($1,$2,$3) RETURNING id`,
    [uid, `${uid}@test`, org!.id]);
  return { id: user!.id, orgId: org!.id };
}

beforeEach(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
  h.dbRef.current = drizzle(pg, { schema }) as unknown as Record<string, unknown>;
  tenantA = await seedTenant('Tenant A', 'uid-a');
  tenantB = await seedTenant('Tenant B', 'uid-b');
});

afterEach(async () => { await pg.close(); });

describe('createCourse — the slug namespace is the one the unique index enforces', () => {
  it('a course title another TENANT already used does not 500', async () => {
    const a = await CoursePublishingService.createCourse(tenantA, { title: 'Intro to Physics' });
    expect(a.slug).toBe('intro-to-physics');

    const b = await CoursePublishingService.createCourse(tenantB, { title: 'Intro to Physics' });
    expect(b.slug).not.toBe(a.slug);
    expect(b.org_id).toBe(tenantB.orgId);
  });

  it('an author-entered slug another tenant holds is deduped, not rejected with a raw 23505', async () => {
    await CoursePublishingService.createCourse(tenantA, { title: 'Anything', slug: 'physics' });
    const b = await CoursePublishingService.createCourse(tenantB, { title: 'Anything', slug: 'physics' });
    expect(b.slug).toBe('physics-2');
  });

  it('two creates that INTERLEAVE both land, with distinct slugs', async () => {
    // Both read the namespace before either has inserted — the read-then-insert window. The
    // 23505 retry is what turns the loser into a second, distinct slug instead of a 500.
    const [a, b] = await Promise.all([
      CoursePublishingService.createCourse(tenantA, { title: 'Same Title' }),
      CoursePublishingService.createCourse(tenantB, { title: 'Same Title' }),
    ]);
    expect(new Set([a.slug, b.slug]).size, 'two courses must not share a slug').toBe(2);
    const all = await rows<{ slug: string }>(`SELECT slug FROM courses ORDER BY slug`);
    expect(all).toHaveLength(2);
  });

  it('still dedupes within one tenant (the old behaviour is not lost)', async () => {
    const first = await CoursePublishingService.createCourse(tenantA, { title: 'Deep Work' });
    const second = await CoursePublishingService.createCourse(tenantA, { title: 'Deep Work' });
    expect(first.slug).toBe('deep-work');
    expect(second.slug).toBe('deep-work-2');
  });

  it('the allocated slug is resolvable by the PUBLIC, org-blind lookup', async () => {
    const a = await CoursePublishingService.createCourse(tenantA, { title: 'Intro to Physics' });
    const b = await CoursePublishingService.createCourse(tenantB, { title: 'Intro to Physics' });
    expect((await CourseRepository.findByPlatformSlug(a.slug))!.id).toBe(a.id);
    expect((await CourseRepository.findByPlatformSlug(b.slug))!.id).toBe(b.id);
  });

  it('the index really is host-global — this suite is testing the constraint that exists', async () => {
    const [idx] = await rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname='uniq_courses_host_slug'`);
    expect(idx!.indexdef).toContain('COALESCE');
    expect(idx!.indexdef).not.toContain('org_id');
  });
});
