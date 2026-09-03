/**
 * The creator's listener-question inbox (owner ruling 2026-09-03) at the route level, in the
 * fake-app style of audioEditionAccess.test.ts: the list with its filter, its lesson context and
 * its page cursor; the summary; the reply (and clearing it); marking seen; and the public
 * replies a listener reads on the episode — only rows WITH a reply, only public projects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  editions: [] as Array<Record<string, unknown>>,
  questions: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ table: string; args: unknown }>,
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  rateLimitCalls: [] as Array<{ key: string; limit: number }>,
  rateLimitAllows: true,
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: async () => state.project },
      project_audio_editions: {
        findFirst: async () => state.editions[0] ?? null,
        findMany: async (args: unknown) => { state.queries.push({ table: 'editions', args }); return state.editions; },
      },
      listener_questions: {
        findMany: async (args: unknown) => { state.queries.push({ table: 'questions', args }); return state.questions; },
        findFirst: async (args: { where: unknown }) => {
          state.queries.push({ table: 'questions.one', args });
          // The fake `and` carries its parts; the id predicate is the first `eq` on listener_questions.id.
          const parts = (args.where as { and?: Array<{ col?: string; val?: unknown }> }).and ?? [];
          const id = parts.find((p) => p.col === 'listener_questions.id')?.val;
          return state.questions.find((q) => q.id === id) ?? null;
        },
      },
      video_files: { findMany: async () => [] },
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          state.updates.push({ set: values, where });
          const chain = {
            returning: async () => [{ id: 'q-1', creator_reply: values.creator_reply ?? null, creator_replied_at: values.creator_replied_at ?? null }],
            then: (resolve: (v: unknown) => void) => resolve(undefined),
          };
          return chain;
        },
      }),
    }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  project_audio_editions: { project_id: 'project_audio_editions.project_id', language: 'project_audio_editions.language' },
  listener_questions: {
    id: 'listener_questions.id', project_id: 'listener_questions.project_id', created_at: 'listener_questions.created_at',
    creator_reply: 'listener_questions.creator_reply', creator_replied_at: 'listener_questions.creator_replied_at',
    seen_at: 'listener_questions.seen_at', language: 'listener_questions.language', position_ms: 'listener_questions.position_ms',
  },
  projects: { id: 'projects.id', slug: 'projects.slug' },
  video_files: { project_id: 'video_files.project_id', is_broll: 'video_files.is_broll', sequence_order: 'video_files.sequence_order', created_at: 'video_files.created_at' },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...parts: unknown[]) => ({ and: parts })),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  lt: vi.fn((col: unknown, val: unknown) => ({ lt: col, val })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
  isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
  desc: vi.fn(() => ({})),
  asc: vi.fn(() => ({})),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: vi.fn(),
  firebaseAuthOptionalMiddleware: vi.fn(),
}));
vi.mock('../../../lib/uuidParam.js', () => ({ requireUuidParams: () => vi.fn() }));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: async () => (state.project?.editable ? state.project : null),
}));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getPresignedDownloadUrl: async (k: string) => `https://signed.example/${k}` }),
}));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: vi.fn() }));
vi.mock('../../../lib/rateLimit.js', () => ({
  rateLimit: (key: string, limit: number) => { state.rateLimitCalls.push({ key, limit }); return state.rateLimitAllows; },
}));
vi.mock('../../../services/audio/ListenerQuestionService.js', () => ({ askListenerQuestion: vi.fn() }));
vi.mock('../../../services/audio/VoiceQuestionService.js', () => ({ answerVoiceQuestion: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { registerAudioEditionRoutes, chapterTitleAt, CREATOR_REPLY_MAX_CHARS } = await import('../audioEdition.controller.js');

interface Captured { code: number; body: unknown; headers: Record<string, string> }
type Handler = (req: unknown, reply: unknown) => Promise<unknown>;

async function call(method: string, path: string, opts: { user?: { id: string } | null; query?: Record<string, string>; body?: unknown; params?: Record<string, string> } = {}): Promise<Captured> {
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  const record = (m: string) => (p: string, a: unknown, b?: unknown) =>
    routes.push({ method: m, path: p, handler: (typeof a === 'function' ? a : b) as Handler });
  await registerAudioEditionRoutes({ get: record('GET'), post: record('POST'), patch: record('PATCH') } as never);
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no ${method} ${path} route is registered`);
  const captured: Captured = { code: 200, body: undefined, headers: {} };
  const reply = {
    code(c: number) { captured.code = c; return reply; },
    header(k: string, v: string) { captured.headers[k] = v; return reply; },
    send(b: unknown) { captured.body = b; return reply; },
  };
  await route.handler({
    params: { id: 'p1', slug: 'my-lesson', qid: 'q-1', ...(opts.params ?? {}) },
    query: opts.query ?? {}, body: opts.body, dbUser: opts.user === undefined ? { id: 'u1' } : opts.user, ip: '1.2.3.4',
  }, reply);
  return captured;
}

const Q = (over: Record<string, unknown>) => ({
  id: 'q-1', project_id: 'p1', language: null, position_ms: 65_000, question: 'Why blue?', answer: 'Scattering.',
  status: 'answered', source: 'text', creator_reply: null, creator_replied_at: null, seen_at: null,
  created_at: new Date('2026-09-03T10:00:00Z'), ...over,
});

beforeEach(() => {
  state.project = { id: 'p1', slug: 'my-lesson', visibility: 'public', editable: true };
  state.editions = [{ project_id: 'p1', language: null, chapters_json: [{ title: 'Intro', startMs: 0, endMs: 60_000 }, { title: 'Why the sky is blue', startMs: 60_000, endMs: 120_000 }] }];
  state.questions = [Q({}), Q({ id: 'q-2', position_ms: 5_000, source: 'voice', creator_reply: 'Because of Rayleigh.', creator_replied_at: new Date('2026-09-03T11:00:00Z'), seen_at: new Date('2026-09-03T11:00:00Z'), created_at: new Date('2026-09-03T09:00:00Z') })];
  state.queries = [];
  state.updates = [];
  state.rateLimitCalls = [];
  state.rateLimitAllows = true;
});

describe('chapterTitleAt', () => {
  it('names the chapter a position falls in, null past the end or with no chapters', () => {
    const chapters = [{ title: 'A', startMs: 0, endMs: 10 }, { title: 'B', startMs: 10, endMs: 20 }];
    expect(chapterTitleAt(chapters, 0)).toBe('A');
    expect(chapterTitleAt(chapters, 10)).toBe('B');
    expect(chapterTitleAt(chapters, 20)).toBeNull();
    expect(chapterTitleAt([], 5)).toBeNull();
    expect(chapterTitleAt([{ startMs: 0, endMs: 10 }], 5)).toBeNull();
  });
});

describe('GET /api/v1/projects/:id/questions — the inbox', () => {
  it('lists every question with its source, the creator reply and the chapter it was asked in', async () => {
    const res = await call('GET', '/api/v1/projects/:id/questions');
    expect(res.code).toBe(200);
    const body = res.body as { questions: Array<Record<string, unknown>>; next_before: string | null };
    expect(body.questions.map((q) => [q.id, q.source, q.chapter, q.creator_reply])).toEqual([
      ['q-1', 'text', 'Why the sky is blue', null],
      ['q-2', 'voice', 'Intro', 'Because of Rayleigh.'],
    ]);
    expect(body.next_before).toBeNull();
  });

  it('filters unanswered / answered by the CREATOR reply, not the model answer', async () => {
    await call('GET', '/api/v1/projects/:id/questions', { query: { status: 'unanswered' } });
    const unanswered = state.queries.find((q) => q.table === 'questions')!.args as { where: { and: unknown[] } };
    expect(unanswered.where.and).toContainEqual({ isNull: 'listener_questions.creator_reply' });
    state.queries = [];
    await call('GET', '/api/v1/projects/:id/questions', { query: { status: 'answered' } });
    const answered = state.queries.find((q) => q.table === 'questions')!.args as { where: { and: unknown[] } };
    expect(answered.where.and).toContainEqual({ isNotNull: 'listener_questions.creator_reply' });
  });

  it('pages by created_at: limit+1 is asked for, the cursor is the last row shown', async () => {
    state.questions = [Q({ id: 'a' }), Q({ id: 'b', created_at: new Date('2026-09-02T00:00:00Z') }), Q({ id: 'c' })];
    const res = await call('GET', '/api/v1/projects/:id/questions', { query: { limit: '2', before: '2026-09-04T00:00:00Z' } });
    const body = res.body as { questions: Array<{ id: string }>; next_before: string | null };
    expect(body.questions.map((q) => q.id)).toEqual(['a', 'b']);
    expect(new Date(body.next_before!).toISOString()).toBe('2026-09-02T00:00:00.000Z');
    const args = state.queries.find((q) => q.table === 'questions')!.args as { limit: number; where: { and: unknown[] } };
    expect(args.limit).toBe(3);
    expect(args.where.and).toContainEqual({ lt: 'listener_questions.created_at', val: new Date('2026-09-04T00:00:00Z') });
  });

  it('needs edit rights: 401 without a user, 404 for a project the user cannot edit', async () => {
    expect((await call('GET', '/api/v1/projects/:id/questions', { user: null })).code).toBe(401);
    state.project = { ...state.project!, editable: false };
    expect((await call('GET', '/api/v1/projects/:id/questions')).code).toBe(404);
  });
});

describe('GET /api/v1/projects/:id/questions/summary', () => {
  it('counts total, unanswered (no creator reply) and unseen', async () => {
    const res = await call('GET', '/api/v1/projects/:id/questions/summary');
    expect(res.body).toEqual({ total: 2, unanswered: 1, unseen: 1 });
  });
});

describe('POST /api/v1/projects/:id/questions/seen', () => {
  it('stamps seen_at on the rows that have none, scoped to the project', async () => {
    const res = await call('POST', '/api/v1/projects/:id/questions/seen');
    expect(res.body).toEqual({ ok: true });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set.seen_at).toBeInstanceOf(Date);
    expect((state.updates[0]!.where as { and: unknown[] }).and).toEqual([
      { col: 'listener_questions.project_id', val: 'p1' }, { isNull: 'listener_questions.seen_at' },
    ]);
  });
});

describe('PATCH /api/v1/projects/:id/questions/:qid — the reply', () => {
  it('stores a trimmed, bounded reply with its timestamp, and marks the row seen', async () => {
    const res = await call('PATCH', '/api/v1/projects/:id/questions/:qid', { body: { creator_reply: '  Because of Rayleigh scattering.  ' } });
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ id: 'q-1', creator_reply: 'Because of Rayleigh scattering.' });
    const set = state.updates[0]!.set;
    expect(set.creator_reply).toBe('Because of Rayleigh scattering.');
    expect(set.creator_replied_at).toBeInstanceOf(Date);
    expect(set.seen_at).toBeInstanceOf(Date);
  });

  it('an empty reply clears it; an over-long one is cut at the ceiling', async () => {
    await call('PATCH', '/api/v1/projects/:id/questions/:qid', { body: { creator_reply: '   ' } });
    expect(state.updates[0]!.set).toEqual({ creator_reply: null, creator_replied_at: null });
    state.updates = [];
    await call('PATCH', '/api/v1/projects/:id/questions/:qid', { body: { creator_reply: 'x'.repeat(CREATOR_REPLY_MAX_CHARS + 50) } });
    expect(String(state.updates[0]!.set.creator_reply)).toHaveLength(CREATOR_REPLY_MAX_CHARS);
  });

  it('refuses a non-string body, a question outside the project, and a project the user cannot edit', async () => {
    expect((await call('PATCH', '/api/v1/projects/:id/questions/:qid', { body: { creator_reply: 42 } })).code).toBe(400);
    expect((await call('PATCH', '/api/v1/projects/:id/questions/:qid', { body: { creator_reply: 'hi' }, params: { qid: 'q-404' } })).code).toBe(404);
    state.project = { ...state.project!, editable: false };
    expect((await call('PATCH', '/api/v1/projects/:id/questions/:qid', { body: { creator_reply: 'hi' } })).code).toBe(404);
    expect(state.updates).toHaveLength(0);
  });
});

describe('GET /api/v1/public/audio/:slug/replies — what the listener sees', () => {
  it('serves only rows with a creator reply, for the language asked, ordered by position, cacheable for a minute', async () => {
    const res = await call('GET', '/api/v1/public/audio/:slug/replies', { user: null, query: { language: ' he ' } });
    expect(res.code).toBe(200);
    expect(res.headers['Cache-Control']).toMatch(/max-age=60/);
    const args = state.queries.find((q) => q.table === 'questions')!.args as { where: { and: unknown[] } };
    expect(args.where.and).toContainEqual({ isNotNull: 'listener_questions.creator_reply' });
    expect(args.where.and).toContainEqual({ col: 'listener_questions.language', val: 'he' });
    // The fake returns both rows; the shape is the contract — the reply, never the model answer.
    const body = res.body as { replies: Array<Record<string, unknown>> };
    expect(Object.keys(body.replies[0]!).sort()).toEqual(['id', 'position_ms', 'question', 'replied_at', 'reply']);
  });

  it('null language means the source edition', async () => {
    await call('GET', '/api/v1/public/audio/:slug/replies', { user: null });
    const args = state.queries.find((q) => q.table === 'questions')!.args as { where: { and: unknown[] } };
    expect(args.where.and).toContainEqual({ isNull: 'listener_questions.language' });
  });

  it('a private project is 404, and the read is rate-limited per IP', async () => {
    state.project = { ...state.project!, visibility: 'private' };
    expect((await call('GET', '/api/v1/public/audio/:slug/replies', { user: null })).code).toBe(404);
    state.project = { ...state.project!, visibility: 'public' };
    state.rateLimitAllows = false;
    expect((await call('GET', '/api/v1/public/audio/:slug/replies', { user: null })).code).toBe(429);
    expect(state.rateLimitCalls.at(-1)).toEqual({ key: 'audioreplies:1.2.3.4', limit: 60 });
  });
});
