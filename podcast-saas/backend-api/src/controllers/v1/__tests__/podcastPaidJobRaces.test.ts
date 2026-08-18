/**
 * The three podcast endpoints that spend money, driven CONCURRENTLY against a real Postgres
 * engine (PGlite) through the real Fastify routes.
 *
 * THE BUG THIS SUITE EXISTS FOR (database-008 / backend-007)
 * Every "is one already running?" guard on these routes was a READ followed by a WRITE with
 * nothing between them:
 *
 *     const inflight = await db.query.podcast_renders.findFirst({ … status IN active … });
 *     if (inflight) return 202 already_running;
 *     await db.insert(podcast_renders).values({ … });   // ← a second caller is already here
 *
 * Two deliveries of the same click — a double-click, a retried fetch, two tabs — both observe an
 * empty in-flight set and both insert. Each row is then claimed by a DIFFERENT worker delivery
 * (`runPodcastRender` CAS-claims per ROW, so it cannot help), and the episode is synthesised twice
 * against ElevenLabs. The user is billed twice for one export and the second master silently wins.
 *
 * THE FIX, AND WHY IT IS THIS ONE
 * The check and the insert now happen inside ONE transaction that first takes a row lock on the
 * episode — `SELECT … FROM podcast_episodes WHERE id = $1 FOR UPDATE` — exactly the discipline
 * migration 062 documents for `video_generation_jobs` ("the job row is the serialisation point"):
 * a second delivery BLOCKS on the lock and then OBSERVES the winner instead of racing it.
 *
 *   • Not an advisory lock: production runs against Supabase's TRANSACTION pooler on 6543, where a
 *     session-scoped `pg_advisory_lock` is held by whichever backend the pool handed out and is not
 *     released with the transaction. A row lock is transaction-scoped, so it is the one that works.
 *   • Not a new partial unique index: `podcast_renders` may ALREADY hold duplicate in-flight rows
 *     from this very bug, so a non-concurrent unique build inside the transactional migration
 *     runner would fail the deploy on exactly the data the fix exists for — and 062 says as much
 *     ("never code first, index second").
 *
 * HOW THE RACE IS MADE DETERMINISTIC
 * Scheduling luck is not evidence. A latch in the DB seam holds the FIRST caller at the statement
 * that reads the in-flight set until a second caller reaches the same statement (or a short
 * timeout expires). Before the fix both callers get past the read and both insert. After the fix
 * the second caller is behind the row lock and never reaches the statement, the latch times out,
 * the winner commits, and the loser then reads the winner's row. Same harness, opposite outcome.
 *
 * WHAT THIS HARNESS CANNOT PROVE
 * PGlite is one in-process backend, so its `transaction()` serialises GLOBALLY — it cannot show
 * that the lock is on the RIGHT row, only that the check and the write are atomic. The row
 * identity is asserted separately, on the SQL the driver actually emitted (`FOR UPDATE` against
 * podcast_episodes, before any read of podcast_renders). Together those are the property real
 * Postgres gives us; separately, neither is.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';

import * as schema from '../../../db/schema.js';

const h = vi.hoisted(() => ({
  dbRef: { current: null as unknown as Record<string, unknown> },
  enqueued: [] as Array<{ name: string; payload: unknown }>,
  userId: { current: '' },
}));

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
vi.mock('../../../queue/index.js', () => ({
  enqueueJob: vi.fn((name: string, payload: unknown) => { h.enqueued.push({ name, payload }); }),
}));
// The per-user budget is a SEPARATE defence and is not what these tests are about; leaving it live
// would let a 429 masquerade as a working race guard.
vi.mock('../../../lib/rateLimit.js', () => ({ rateLimit: () => true }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPresignedDownloadUrl: vi.fn(async () => 'https://example.invalid/dl'),
    getPublicUrl: (k: string) => `https://example.invalid/${k}`,
  }),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: h.userId.current };
    done();
  },
}));
// Real ElevenLabs / LLM work hangs off these; the units under test are the claim and the job row.
vi.mock('../../../services/podcast/audio/previewTurn.js', () => ({ previewTurn: vi.fn() }));
vi.mock('../../../services/podcast/audio/revoiceTurn.js', () => ({ revoicePodcastTurn: vi.fn() }));
vi.mock('../../../services/podcast/PodcastMemory.js', () => ({ writeEpisodeMemory: vi.fn(async () => {}) }));

import { registerPodcastRenderRoutes } from '../podcast-render.controller.js';
import { registerPodcastStudioRoutes } from '../podcast-studio.controller.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');

let pg: PGlite;
let app: FastifyInstance;
let sqlLog: string[];
let showId: string;
let episodeId: string;

/**
 * Hold the first caller to reach `pattern` until `parties` callers have reached it, or
 * `timeoutMs` passes. The timeout is what lets the FIXED code through: its second caller is
 * blocked on the row lock and by construction never arrives.
 */
interface Latch { pattern: RegExp; arrive(sql: string): Promise<void> }
function makeLatch(pattern: RegExp, parties = 2, timeoutMs = 500): Latch {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return {
    pattern,
    async arrive(sql: string): Promise<void> {
      if (!pattern.test(sql)) return;
      arrived += 1;
      if (arrived >= parties) { open(); return; }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([gate, new Promise<void>((r) => { timer = setTimeout(r, timeoutMs); })]);
      if (timer) clearTimeout(timer);
    },
  };
}
let latch: Latch | null = null;

/** Record every statement the driver issues — inside transactions too — and run the latch. */
function instrumentClient<T extends object>(client: T, log: string[]): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      if (prop === 'query') {
        return async (text: string, ...rest: unknown[]) => {
          log.push(text);
          if (latch) await latch.arrive(text);
          return fn.call(target, text, ...rest);
        };
      }
      if (prop === 'exec') {
        return (text: string, ...rest: unknown[]) => { log.push(text); return fn.call(target, text, ...rest); };
      }
      if (prop === 'transaction') {
        return (body: (tx: object) => unknown, ...rest: unknown[]) =>
          fn.call(target, (tx: object) => body(instrumentClient(tx, log)), ...rest);
      }
      return fn.bind(target);
    },
  }) as T;
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pg.query<T>(sql, params)).rows;
}
async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await rows<T>(sql, params);
  if (!r[0]) throw new Error(`expected a row from: ${sql}`);
  return r[0];
}

const renderRows = (): Promise<Array<{ id: string; kind: string; status: string }>> =>
  rows(`SELECT id, kind, status FROM podcast_renders ORDER BY created_at`);
const snapshotRows = (kind: string): Promise<Array<{ id: string }>> =>
  rows(`SELECT id FROM podcast_mix_snapshots WHERE kind=$1`, [kind]);

const SCRIPT_BODY = {
  turns: [
    { id: 't1', speaker: 'teacher', text: 'Hello there, this is the first line.' },
    { id: 't2', speaker: 'learner', text: 'And this is the reply.' },
  ],
};

// The engine and its schema are built ONCE: applying sixty-odd migrations per test dominated the
// suite's runtime and proved nothing that applying them once does not. Data is truncated between
// tests, which is what actually has to be isolated.
beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => /^\d{3}_[^.]+\.sql$/.test(x)).sort()) {
    await pg.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
  }
});
afterAll(async () => { await pg.close(); });

beforeEach(async () => {
  await pg.exec(`TRUNCATE podcast_shows, orgs, users RESTART IDENTITY CASCADE`);
  sqlLog = [];
  latch = null;
  h.dbRef.current = drizzle(instrumentClient(pg, sqlLog), { schema }) as unknown as Record<string, unknown>;
  h.enqueued.length = 0;

  const org = await one<{ id: string }>(`INSERT INTO orgs (name) VALUES ('Org') RETURNING id`);
  const user = await one<{ id: string }>(
    `INSERT INTO users (firebase_uid, email) VALUES ('uid-podcast', 'p@test') RETURNING id`);
  h.userId.current = user.id;
  const show = await one<{ id: string }>(
    `INSERT INTO podcast_shows (org_id, created_by, title) VALUES ($1,$2,'Show') RETURNING id`, [org.id, user.id]);
  showId = show.id;
  const ep = await one<{ id: string }>(
    `INSERT INTO podcast_episodes (show_id, title, status) VALUES ($1,'Ep','approved') RETURNING id`, [show.id]);
  episodeId = ep.id;
  // An APPROVED script with a body, so the render route goes straight to the guard under test
  // instead of detouring through the auto-approve branch.
  await pg.query(
    `INSERT INTO podcast_scripts (episode_id, version, status, body_json, content_hash)
     VALUES ($1, 1, 'approved', $2, 'hash-v1')`,
    [episodeId, JSON.stringify(SCRIPT_BODY)]);

  app = Fastify();
  await registerPodcastRenderRoutes(app);
  await registerPodcastStudioRoutes(app);
  await app.ready();
});

afterEach(async () => {
  latch = null;
  await app.close();
});

type Answer = { statusCode: number; body: Record<string, unknown> };

const postRender = (): Promise<Answer> =>
  app.inject({ method: 'POST', url: `/api/v1/podcasts/${showId}/episodes/${episodeId}/render` })
    .then((r) => ({ statusCode: r.statusCode, body: r.json() as Record<string, unknown> }));

const postStudioExport = (): Promise<Answer> =>
  app.inject({
    method: 'POST', url: `/api/v1/podcasts/${showId}/episodes/${episodeId}/studio/export`,
    payload: { format: 'mp3' },
  }).then((r) => ({ statusCode: r.statusCode, body: r.json() as Record<string, unknown> }));

const postStudioGenerate = (): Promise<Answer> =>
  app.inject({ method: 'POST', url: `/api/v1/podcasts/${showId}/episodes/${episodeId}/studio/generate` })
    .then((r) => ({ statusCode: r.statusCode, body: r.json() as Record<string, unknown> }));

/** A mix draft with one audible clip — enough for the export route's "is it audible?" gate. */
async function seedMixWithTimeline(): Promise<string> {
  const clipId = randomUUID();
  await pg.query(
    `INSERT INTO podcast_clips (id, episode_id, turn_id, take_hash, text_hash, storage_key, duration_ms)
     VALUES ($1,$2,'t1','take-1','text-1','clips/a.mp3', 4000)`, [clipId, episodeId]);
  const timeline = {
    version: 1,
    clips: [{ clipId, turnId: 't1', partIndex: 0, role: 'speech', gapBeforeMs: 0, trimStartMs: 0, trimEndMs: 0, gainDb: 0, muted: false }],
  };
  const mix = await one<{ id: string }>(
    `INSERT INTO podcast_mixes (episode_id, status, script_version, script_hash, timeline_json)
     VALUES ($1,'ready',1,'hash-v1',$2) RETURNING id`, [episodeId, JSON.stringify(timeline)]);
  return mix.id;
}

/** Exactly one of two answers may claim to have joined a running job. */
function expectOneWinner(a: Answer, b: Answer, idKey: 'render_id' | 'mix_id'): void {
  expect(a.statusCode).toBe(202);
  expect(b.statusCode).toBe(202);
  expect(a.body[idKey], 'both callers must be pointed at the same job').toBe(b.body[idKey]);
  expect([a.body.already_running, b.body.already_running].filter(Boolean),
    'exactly one caller started the job; the other joined it').toHaveLength(1);
}

describe('POST …/render — a double click must not start two paid renders', () => {
  it('two concurrent requests create exactly ONE render row and enqueue ONE job', async () => {
    latch = makeLatch(/from "podcast_renders"[\s\S]*"status" in /i);

    const [a, b] = await Promise.all([postRender(), postRender()]);

    expect(await renderRows(), 'one episode, one click, one render').toHaveLength(1);
    expect(h.enqueued.filter((e) => e.name === 'podcast_render'),
      'a second delivery must not be enqueued — it is a second ElevenLabs bill').toHaveLength(1);
    expectOneWinner(a, b, 'render_id');
  });

  it('serialises on the EPISODE row, and reads the in-flight set only after taking it', async () => {
    await postRender();

    const lockAt = sqlLog.findIndex((s) => /for update/i.test(s) && /podcast_episodes/i.test(s));
    expect(lockAt, 'the claim must lock the episode row').toBeGreaterThanOrEqual(0);
    const inflightReadAt = sqlLog.findIndex((s) => /from "podcast_renders"/i.test(s));
    expect(inflightReadAt, 'the in-flight read must happen under the lock, not before it')
      .toBeGreaterThan(lockAt);
  });

  it('a sequential second click still joins the running render', async () => {
    const first = await postRender();
    const second = await postRender();
    expect(second.body.already_running).toBe(true);
    expect(second.body.render_id).toBe(first.body.render_id);
    expect(await renderRows()).toHaveLength(1);
  });

  it('a finished render does not block the next one', async () => {
    const first = await postRender();
    await pg.query(`UPDATE podcast_renders SET status='ready', script_hash='stale' WHERE id=$1`, [first.body.render_id]);
    const second = await postRender();
    expect(second.body.already_running).toBeUndefined();
    expect(second.body.render_id).not.toBe(first.body.render_id);
    expect(await renderRows()).toHaveLength(2);
  });

  it('an unchanged script reuses the ready master instead of paying again', async () => {
    const first = await postRender();
    await pg.query(`UPDATE podcast_renders SET status='ready' WHERE id=$1`, [first.body.render_id]);
    h.enqueued.length = 0;
    const second = await postRender();
    expect(second.body.unchanged).toBe(true);
    expect(second.body.render_id).toBe(first.body.render_id);
    expect(h.enqueued).toEqual([]);
  });

  it('the episode is moved to rendering by the winner', async () => {
    await postRender();
    const ep = await one<{ status: string }>(`SELECT status FROM podcast_episodes WHERE id=$1`, [episodeId]);
    expect(ep.status).toBe('rendering');
  });
});

describe('POST …/studio/export — the same race on the studio master', () => {
  it('two concurrent exports create ONE render and ONE freeze snapshot', async () => {
    await seedMixWithTimeline();
    latch = makeLatch(/from "podcast_renders"/i);

    const [a, b] = await Promise.all([postStudioExport(), postStudioExport()]);

    expect(await renderRows()).toHaveLength(1);
    expect(h.enqueued.filter((e) => e.name === 'podcast_mix_export')).toHaveLength(1);
    expect(await snapshotRows('export'),
      'a losing caller must not freeze a second export snapshot either').toHaveLength(1);
    expectOneWinner(a, b, 'render_id');
  });

  it('a finished mix export does not block the next one', async () => {
    await seedMixWithTimeline();
    const first = await postStudioExport();
    await pg.query(`UPDATE podcast_renders SET status='ready' WHERE id=$1`, [first.body.render_id]);
    const second = await postStudioExport();
    expect(second.body.already_running).toBeUndefined();
    expect(second.body.render_id).not.toBe(first.body.render_id);
    expect(await renderRows()).toHaveLength(2);
  });
});

describe('POST …/studio/generate — the same race on clip generation', () => {
  it('two concurrent rebuilds enqueue ONE clip job and take ONE pre-rebuild snapshot', async () => {
    await seedMixWithTimeline();
    latch = makeLatch(/from "podcast_mixes"/i);

    const [a, b] = await Promise.all([postStudioGenerate(), postStudioGenerate()]);

    expect(h.enqueued.filter((e) => e.name === 'podcast_clips'),
      'clip generation is a per-turn TTS bill — one rebuild, one job').toHaveLength(1);
    expect(await snapshotRows('pre_rebuild')).toHaveLength(1);
    expectOneWinner(a, b, 'mix_id');
  });

  it('two concurrent FIRST builds create one mix row, not two', async () => {
    // No mix row yet: the losing caller must adopt the winner's row rather than trip the
    // podcast_mixes(episode_id) unique constraint with a raw 23505.
    latch = makeLatch(/from "podcast_mixes"/i);

    const [a, b] = await Promise.all([postStudioGenerate(), postStudioGenerate()]);

    const mixes = await rows<{ id: string }>(`SELECT id FROM podcast_mixes`);
    expect(mixes).toHaveLength(1);
    expect(h.enqueued.filter((e) => e.name === 'podcast_clips')).toHaveLength(1);
    expectOneWinner(a, b, 'mix_id');
  });
});
