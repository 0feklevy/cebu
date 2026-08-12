/**
 * Rolling back migration 056 under an image that still serves the duplication routes.
 *
 * `056_project_duplication.rollback.sql`'s header promises the endpoint "returns a clean
 * 503-shaped failure rather than corrupting anything if the table is gone". It did not: the
 * in-flight read ran BEFORE the handler's try/catch, so a missing `project_duplications` threw
 * `42P01` unhandled and Fastify answered 500.
 *
 * Why 503 and not 500, and why it is worth a test:
 *   • 500 says "we broke". This is a deployed-feature-removed state — the operator did it on
 *     purpose, and the honest answer is "unavailable", which is also what the rollback notes
 *     already told them to expect.
 *   • The GET is POLLED. `useProjectDuplication` bounds CONSECUTIVE failures and then reports
 *     "Lost contact with the copy — it may still be running". Reaching that through five
 *     unhandled 500s and reaching it through five 503s look the same to the user, but only one of
 *     them is a state the server understands, and only one keeps the log clean enough to see a
 *     real fault next to it.
 *
 * Both call sites are covered because the table can vanish at either: the POST reads it once
 * before the insert and again inside it, and the GET reads it on every poll tick.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/** Postgres `undefined_table`. The one code that means "this migration is not applied". */
const UNDEFINED_TABLE = '42P01';
const missingTable = (): Error => Object.assign(new Error('relation "project_duplications" does not exist'), { code: UNDEFINED_TABLE });

const PROJECT_ID = 'proj-1';
const DUP_ID = 'dup-1';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  select: vi.fn(),
  insert: vi.fn(),
  liveDuplicationFor: vi.fn(),
  dryRun: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: { projects: { findFirst: mocks.findFirst } },
    select: () => ({ from: () => ({ where: mocks.select }) }),
    insert: () => ({ values: () => ({ returning: mocks.insert }) }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  projects: Symbol('projects'), hosts: Symbol('hosts'), video_files: Symbol('video_files'),
  simulations: Symbol('simulations'), audio_files: Symbol('audio_files'),
  image_files: Symbol('image_files'), collaborators: Symbol('collaborators'),
  project_duplications: Symbol('project_duplications'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})), and: vi.fn(() => ({})), inArray: vi.fn(() => ({})),
  asc: vi.fn(() => ({})), desc: vi.fn(() => ({})), sql: vi.fn(() => ({})),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
}));
vi.mock('../../../services/project/ProjectDuplicationService.js', () => ({
  ProjectDuplicationService: class {
    dryRun = mocks.dryRun;
    static oversizeRefusal = () => null;
  },
  duplicateMaxBytes: () => Number.MAX_SAFE_INTEGER,
  liveDuplicationFor: mocks.liveDuplicationFor,
}));
// Everything below is imported by the controller but irrelevant to these two routes.
vi.mock('../../../services/collabAccess.js', () => ({ editableProject: vi.fn(), projectsEditableByWhere: vi.fn(() => ({})) }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: () => ({}) }));
vi.mock('../../../services/storage/uploadWithFallback.js', () => ({ uploadWithFallback: vi.fn() }));
vi.mock('../../../services/storage/deleteWithFallback.js', () => ({ deleteWithFallback: vi.fn(), deleteWithPrefixFallback: vi.fn() }));
vi.mock('../../../services/video/hlsRetention.js', () => ({ deleteHlsRetirementRowsForVideo: vi.fn() }));
vi.mock('../../../services/llm/systemAi.js', () => ({ getOpenAIClient: () => ({}) }));
vi.mock('../../../services/llm/ContentModerationService.js', () => ({ moderateGenerationInput: vi.fn() }));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let app: FastifyInstance;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.findFirst.mockResolvedValue({ id: PROJECT_ID, created_by: 'user-1' });
  mocks.dryRun.mockResolvedValue({ storage: [], estimatedBytes: 0, oversize: [] });
  mocks.liveDuplicationFor.mockResolvedValue(null);
  mocks.select.mockResolvedValue([{ id: DUP_ID, status: 'ready', target_project_id: 'copy-1', objects_total: 1, objects_copied: 1, error: null }]);
  mocks.insert.mockResolvedValue([{ id: DUP_ID }]);

  const { registerProjectRoutes } = await import('../projects.controller.js');
  app = Fastify();
  await registerProjectRoutes(app);
  await app.ready();
});

const post = () => app.inject({ method: 'POST', url: `/api/v1/projects/${PROJECT_ID}/duplicate` });
const get = () => app.inject({ method: 'GET', url: `/api/v1/projects/${PROJECT_ID}/duplications/${DUP_ID}` });

describe('migration 056 rolled back under a serving image', () => {
  it('POST answers 503, not 500, when the in-flight read finds no table', async () => {
    mocks.liveDuplicationFor.mockRejectedValue(missingTable());
    const res = await post();
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/temporarily unavailable/i);
  });

  it('POST answers 503 when the table vanishes between the read and the insert', async () => {
    // The narrow window the second guard exists for: the read succeeded, the DROP landed, the
    // insert failed. Without its own arm this fell through to the generic 500.
    mocks.insert.mockRejectedValue(missingTable());
    const res = await post();
    expect(res.statusCode).toBe(503);
  });

  it('GET answers 503, so a poll ends on a true statement instead of five unexplained 500s', async () => {
    mocks.select.mockRejectedValue(missingTable());
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.json().message).toMatch(/temporarily unavailable/i);
  });

  it('a REAL failure is still a 500 — the guard is scoped to 42P01 and nothing else', async () => {
    // The guard must not become a blanket "any DB error is unavailable": that would hide a genuine
    // fault behind a message telling the operator to wait for something that will never happen.
    mocks.liveDuplicationFor.mockRejectedValue(Object.assign(new Error('connection reset'), { code: '08006' }));
    const res = await post();
    expect(res.statusCode).toBe(500);
  });

  it('leaves the healthy paths exactly as they were', async () => {
    expect((await post()).statusCode).toBe(202);
    expect((await get()).statusCode).toBe(200);
    mocks.liveDuplicationFor.mockResolvedValue({ id: DUP_ID, status: 'copying' });
    const busy = await post();
    expect(busy.statusCode).toBe(202);
    expect(busy.json().already_running).toBe(true);
  });
});
