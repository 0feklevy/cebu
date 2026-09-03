/**
 * P3-B / A2.1 — who may hear a project's audio edition.
 *
 * One rule, and it is the whole reason this file exists: an edition is a DERIVED form of a
 * project, so it is exactly as public as that project is and never more. That sounds too obvious
 * to test, which is precisely why it is worth testing — this codebase has already made the
 * inverse mistake twice. `podcasts/` was modelled as a public storage prefix for immutable studio
 * clips; user source documents were added to it later and became readable by anyone holding the
 * URL, with no credential (security-016).
 *
 * The failure mode has no symptom. A private project whose audio is world-readable serves every
 * request successfully, logs nothing unusual, and is discovered only when someone reports it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  project: null as Record<string, unknown> | null,
  edition: null as Record<string, unknown> | null,
  enqueued: [] as Array<{ name: string; payload: unknown }>,
  rateLimitAllows: true,
  rateLimitKeys: [] as string[],
  asked: [] as Array<Record<string, unknown>>,
  askResult: { status: 'answered', answer: 'Because.' } as Record<string, unknown>,
  questions: [] as Array<Record<string, unknown>>,
  /** Rows `video_files.findMany` answers with — settable, so "no media" can be tested honestly. */
  videoFiles: [{ storage_key: 'k', duration_sec: 10, is_broll: false }] as Array<Record<string, unknown>>,
  /** Every `where` that reached `video_files.findMany`, so the PREDICATE itself is assertable. */
  videoQueries: [] as unknown[],
};

/**
 * Apply a recorded predicate to the fake rows, the way the database would.
 *
 * A mock that returns its rows regardless of the `where` cannot fail when a filter is DROPPED —
 * and a dropped filter is precisely the defect this suite now guards (the b-roll divergence of
 * 2026-08-26). So the mock evaluates: it walks the `and`/`eq` tree the drizzle mock builds, and
 * keeps only rows equal on every column named. Unknown columns are ignored rather than guessed —
 * a row that does not carry the column simply is not filtered by it.
 */
function applyWhere(rows: Array<Record<string, unknown>>, where: unknown): Array<Record<string, unknown>> {
  const clauses: Array<{ col: string; val: unknown }> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { and?: unknown[]; col?: unknown; val?: unknown };
    if (Array.isArray(n.and)) { n.and.forEach(walk); return; }
    if (typeof n.col === 'string') clauses.push({ col: n.col, val: n.val });
  };
  walk(where);
  return rows.filter((row) => clauses.every(({ col, val }) => {
    const key = col.replace(/^video_files\./, '');
    if (!(key in row)) return true;
    return row[key] === val;
  }));
}

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: async () => state.project },
      project_audio_editions: { findFirst: async () => state.edition },
      listener_questions: { findMany: async () => state.questions },
      video_files: {
        findMany: async (args: { where?: unknown }) => {
          state.videoQueries.push(args?.where);
          return applyWhere(state.videoFiles, args?.where);
        },
      },
    },
  },
}));
// Column identities are FULLY QUALIFIED here on purpose. The previous mock gave both
// `projects.id` and `video_files.project_id` the bare string 'project_id'/'id', so a predicate
// naming the wrong table was indistinguishable from the right one — which is exactly how the
// production defect below stayed invisible to this suite.
vi.mock('../../../db/schema.js', () => ({
  project_audio_editions: { project_id: 'project_audio_editions.project_id', language: 'project_audio_editions.language' },
  listener_questions: { id: 'listener_questions.id', project_id: 'listener_questions.project_id', created_at: 'listener_questions.created_at' },
  projects: { id: 'projects.id', slug: 'projects.slug' },
  video_files: {
    project_id: 'video_files.project_id',
    is_broll: 'video_files.is_broll',
    sequence_order: 'video_files.sequence_order',
    created_at: 'video_files.created_at',
  },
}));
// `eq` CARRIES its arguments through instead of discarding them. A mock that returns `{}` makes
// every predicate look identical, so no assertion downstream can tell which column was compared.
vi.mock('drizzle-orm', () => ({
  and: vi.fn((...parts: unknown[]) => ({ and: parts })),
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  isNull: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
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
vi.mock('../../../queue/index.js', () => ({
  enqueueJob: (name: string, payload: unknown) => { state.enqueued.push({ name, payload }); },
}));
vi.mock('../../../lib/rateLimit.js', () => ({
  rateLimit: (key: string) => { state.rateLimitKeys.push(key); return state.rateLimitAllows; },
}));
vi.mock('../../../services/audio/ListenerQuestionService.js', () => ({
  askListenerQuestion: async (input: Record<string, unknown>) => {
    state.asked.push(input);
    return state.askResult;
  },
}));

const { registerAudioEditionRoutes } = await import('../audioEdition.controller.js');

interface Captured { code: number; body: unknown; headers: Record<string, string> }

/** Register the routes, then invoke one by method+path. */
async function call(
  method: 'GET' | 'POST',
  path: string,
  opts: { user?: { id: string } | null; query?: Record<string, string>; body?: unknown } = {},
): Promise<Captured> {
  type Handler = (req: unknown, reply: unknown) => Promise<unknown>;
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  // Fastify allows BOTH `(path, opts, handler)` and `(path, handler)`, and this controller uses
  // each — the public route needs no preHandler. A harness that assumed three arguments recorded
  // the options object as the handler and failed with "route.handler is not a function", which
  // reads like a routing bug rather than a fake that cannot see half the routes.
  const record = (method: string) => (p: string, a: unknown, b?: unknown) =>
    routes.push({ method, path: p, handler: (typeof a === 'function' ? a : b) as Handler });
  const app = { get: record('GET'), post: record('POST') };
  await registerAudioEditionRoutes(app as never);

  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no ${method} ${path} route is registered`);

  const captured: Captured = { code: 200, body: undefined, headers: {} };
  const reply = {
    code(c: number) { captured.code = c; return reply; },
    header(k: string, v: string) { captured.headers[k] = v; return reply; },
    send(b: unknown) { captured.body = b; return reply; },
  };
  await route.handler(
    { params: { id: 'p1', slug: 'my-lesson' }, query: opts.query ?? {}, body: opts.body, dbUser: opts.user ?? null, ip: '1.2.3.4' },
    reply,
  );
  return captured;
}

const READY_EDITION = {
  status: 'ready', m4a_key: 'editions/p1/source-abc.m4a', duration_ms: 1000,
  chapters_json: [], captions_vtt: 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n',
  language: null, error: null, updated_at: new Date(0),
};

beforeEach(() => {
  state.project = null;
  state.edition = null;
  state.enqueued = [];
  state.rateLimitAllows = true;
  state.rateLimitKeys = [];
  state.asked = [];
  state.askResult = { status: 'answered', answer: 'Because.' };
  state.questions = [];
  state.videoFiles = [{ storage_key: 'k', duration_sec: 10, is_broll: false }];
  state.videoQueries = [];
});

/**
 * The pre-flight refusal query — the one that decided every "Create podcast" click.
 *
 * OBSERVED IN PRODUCTION 2026-08-25: three 409s and "This project has no media to derive audio
 * from." on a project full of media. The cause was one identifier: the query ran
 * `db.query.video_files.findMany({ where: eq(projects.id, project.id) })` — a predicate naming a
 * column from a table the query does not select from. Postgres refuses that outright, and the
 * `.catch(() => [])` beside it turned the refusal into an empty list, which `editionRefusalReason`
 * reads as "no media". Every podcast build, on every project, was refused for a reason that was
 * never true.
 *
 * WHY THIS SUITE COULD NOT SEE IT. Its `video_files.findMany` mock ignored the `where` entirely
 * and always returned one segment, and its `eq` mock returned `{}` — discarding the arguments, so
 * every predicate looked identical. Both are now fixed: the mock records what it was asked, and
 * `eq` carries the column through. These tests assert on the predicate, not on the fact that a
 * query happened.
 */
describe('the pre-flight refusal asks about THIS project\'s media', () => {
  it('filters on video_files.project_id, not on projects.id', async () => {
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
    await call('POST', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' }, body: {} });
    expect(state.videoQueries).toHaveLength(1);
    expect(state.videoQueries[0]).toEqual({
      and: [
        { col: 'video_files.project_id', val: 'p1' },
        { col: 'video_files.is_broll', val: false },
      ],
    });
  });

  // THE GATE AND THE WORKER MUST ASK THE SAME QUESTION.
  //
  // Until 2026-08-26 they did not. This pre-flight selected every `video_files` row of the
  // project; the job's `loadInputs` selected only the non-b-roll ones. So a project whose only
  // footage is b-roll passed here (rows exist → 202 accepted) and was then refused by the worker
  // minutes later — the delayed, unexplained failure this whole pre-flight exists to prevent, and
  // the same shape as the defect fixed the day before. Both callers now share one query
  // (`editionSegments.ts`); this test is what stops them drifting apart a third time.
  it('refuses a b-roll-only project HERE, not asynchronously in the worker', async () => {
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
    state.videoFiles = [
      { storage_key: 'broll-a', duration_sec: 12, is_broll: true },
      { storage_key: 'broll-b', duration_sec: 8, is_broll: true },
    ];
    const r = await call('POST', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' }, body: {} });
    expect(r.code).toBe(409);
    expect(String((r.body as { message?: string }).message)).toContain('no media');
    expect(state.enqueued).toHaveLength(0);
  });

  it('queues a project whose b-roll sits BESIDE real narration', async () => {
    // The filter must exclude b-roll, not projects that happen to contain some.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
    state.videoFiles = [
      { storage_key: 'broll', duration_sec: 12, is_broll: true },
      { storage_key: 'narration', duration_sec: 30, is_broll: false },
    ];
    const r = await call('POST', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' }, body: {} });
    expect(r.code).toBe(202);
    expect(state.enqueued).toHaveLength(1);
  });

  it('queues the build when the project HAS playable media', async () => {
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
    const r = await call('POST', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' }, body: {} });
    expect(r.code).toBe(202);
    expect(state.enqueued).toHaveLength(1);
  });

  it('still refuses, with the reason, when the project genuinely has none', async () => {
    // The refusal is a real product answer and must survive the fix — the defect was that it
    // fired ALWAYS, not that it existed.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
    state.videoFiles = [];
    const r = await call('POST', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' }, body: {} });
    expect(r.code).toBe(409);
    expect(String((r.body as { message?: string }).message)).toContain('no media');
    expect(state.enqueued).toHaveLength(0);
  });

  it('refuses when media exists but none of it has playable audio', async () => {
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
    state.videoFiles = [{ storage_key: null, duration_sec: 0, is_broll: false }];
    const r = await call('POST', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' }, body: {} });
    expect(r.code).toBe(409);
    expect(state.enqueued).toHaveLength(0);
  });
});

/**
 * THE STATUS THE CREATOR ACTUALLY RECEIVES.
 *
 * Owner-reported 2026-08-26: the podcast row said "Building — this takes a few minutes", reverted
 * to "Create podcast" a second later, and stayed there while the build ran fine on the server.
 *
 * This route returned the DATABASE's status verbatim. The database says `processing`; the client
 * contract declares `none | queued | building | ready | failed`. `processing` is in neither the
 * client's in-flight set nor its ready set nor its failed set, so the row rendered as idle and the
 * poll — which only runs while in flight — stopped on its first tick.
 *
 * The type could not catch it: `status` was declared `… | string`, which collapses the union to
 * `string`. This suite is what catches it instead.
 */
describe('the wire status is the CLIENT\'s vocabulary, not the database\'s', () => {
  it('reports a build in progress as building, never as processing', async () => {
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
    state.edition = { status: 'processing', error: null, m4a_key: null, language: null };
    const r = await call('GET', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' } });
    expect(r.code).toBe(200);
    expect((r.body as { status?: string }).status).toBe('building');
  });

  it('reports no row as none', async () => {
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
    state.edition = null;
    const r = await call('GET', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' } });
    expect((r.body as { status?: string }).status).toBe('none');
  });

  it('carries a failure through with its reason', async () => {
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
    state.edition = { status: 'failed', error: 'ffmpeg exploded', m4a_key: null, language: null };
    const r = await call('GET', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' } });
    const body = r.body as { status?: string; error?: string };
    expect(body.status).toBe('failed');
    expect(body.error).toBe('ffmpeg exploded');
  });

  it('never emits a status the client contract does not declare', async () => {
    // The general form of the defect. Any stored value the mapping has not been taught about must
    // still leave here as something the client can render — never as raw database vocabulary.
    const DECLARED = ['none', 'queued', 'building', 'ready', 'failed'];
    for (const stored of ['none', 'processing', 'ready', 'failed', 'a-status-from-the-future']) {
      state.project = { id: 'p1', visibility: 'private', created_by: 'owner', editable: true };
      state.edition = { status: stored, error: null, m4a_key: stored === 'ready' ? 'k' : null, language: null };
      const r = await call('GET', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' } });
      expect(DECLARED, `stored "${stored}" left the route as "${(r.body as { status?: string }).status}"`)
        .toContain((r.body as { status?: string }).status);
    }
  });
});

describe('an edition is exactly as public as its project', () => {
  it('serves a PUBLIC project’s audio to an anonymous listener', () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    state.edition = READY_EDITION;
    return call('GET', '/api/v1/projects/:id/audio-edition').then((r) => {
      expect(r.code).toBe(200);
      expect((r.body as { audio_url: string }).audio_url).toContain('editions/p1/');
    });
  });

  it('does NOT serve a private project’s audio to a stranger', async () => {
    // The whole file. This request succeeding is the security-016 shape exactly: a successful
    // response, a normal log line, and a customer's content readable by anyone with the URL.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner' };
    state.edition = READY_EDITION;
    const r = await call('GET', '/api/v1/projects/:id/audio-edition', { user: { id: 'someone-else' } });
    expect(r.code, 'a private project’s audio was served to a stranger').toBe(404);
    expect((r.body as { audio_url?: string }).audio_url).toBeUndefined();
  });

  it('answers 404, not 403, so existence is not leaked', async () => {
    // To an unauthorised requester, "there IS audio here but you may not have it" is itself
    // information about a private project.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner' };
    state.edition = READY_EDITION;
    expect((await call('GET', '/api/v1/projects/:id/audio-edition', { user: { id: 'x' } })).code).toBe(404);
  });

  it('serves the owner their own private project’s audio', async () => {
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner' };
    state.edition = READY_EDITION;
    const r = await call('GET', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' } });
    expect(r.code).toBe(200);
  });

  it('honours the same share token the rest of the mini-site does', async () => {
    // A shared-but-private project's audio link has to work for the people the creator gave it
    // to, or "share" means something different on this surface than everywhere else.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner', share_token: 'tok' };
    state.edition = READY_EDITION;
    expect((await call('GET', '/api/v1/projects/:id/audio-edition', { query: { share: 'tok' } })).code).toBe(200);
    expect((await call('GET', '/api/v1/projects/:id/audio-edition', { query: { share: 'wrong' } })).code).toBe(404);
  });

  it('applies the identical rule to the captions track', async () => {
    // A caption file is a transcript. Leaking it leaks the lesson's content just as surely as
    // leaking the audio, and it is the kind of route that gets access checks added last.
    state.project = { id: 'p1', visibility: 'private', created_by: 'owner' };
    state.edition = READY_EDITION;
    const r = await call('GET', '/api/v1/projects/:id/audio-edition/captions.vtt', { user: { id: 'stranger' } });
    expect(r.code, 'the transcript was served to a stranger').toBe(404);
  });

  it('serves captions as text/vtt, or the browser silently ignores the track', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    state.edition = READY_EDITION;
    const r = await call('GET', '/api/v1/projects/:id/audio-edition/captions.vtt');
    expect(r.headers['content-type']).toContain('text/vtt');
  });
});

describe('an edition that is not ready yet', () => {
  // THIS TEST USED TO ASSERT THE BUG. It required `status: 'processing'` — the database's word —
  // and so it passed for as long as the route leaked the stored value to a client that has never
  // recognised it. A test can only protect the behaviour it names, and this one named the wrong
  // side of the translation.
  it('reports a status the CLIENT understands rather than a broken URL', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    state.edition = { status: 'processing', m4a_key: null, error: null };
    const r = await call('GET', '/api/v1/projects/:id/audio-edition');
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ status: 'building', audio_url: null, chapters: [] });
  });

  it('reports "none" when no edition has ever been built', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    const r = await call('GET', '/api/v1/projects/:id/audio-edition');
    expect(r.body).toMatchObject({ status: 'none', audio_url: null });
  });

  it('never hands out a URL for a FAILED edition', async () => {
    // The key may still be set from a previous successful build; the status is what decides.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    state.edition = { status: 'failed', m4a_key: 'editions/p1/old.m4a', error: 'ffmpeg exploded' };
    const r = await call('GET', '/api/v1/projects/:id/audio-edition');
    expect((r.body as { audio_url: null }).audio_url).toBeNull();
    expect((r.body as { error: string }).error).toBe('ffmpeg exploded');
  });
});

describe('building costs money, so building needs edit rights', () => {
  it('refuses a viewer who is not an editor', async () => {
    // A route any viewer could trigger is a route any viewer could use to spend the owner's
    // compute by reloading a page.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: false };
    const r = await call('POST', '/api/v1/projects/:id/audio-edition', { user: { id: 'viewer' }, body: {} });
    expect(r.code).toBe(404);
    expect(state.enqueued, 'a non-editor queued work').toEqual([]);
  });

  it('refuses an anonymous caller outright', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: true };
    const r = await call('POST', '/api/v1/projects/:id/audio-edition', { user: null, body: {} });
    expect(r.code).toBe(401);
    expect(state.enqueued).toEqual([]);
  });

  it('queues the work for an editor and answers 202, not 200', async () => {
    // 202 is the honest code: the work is accepted, not done. A 200 with no artifact behind it
    // is what makes a client stop polling and show a broken player.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: true };
    const r = await call('POST', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' }, body: { language: 'he' } });
    expect(r.code).toBe(202);
    expect(state.enqueued).toEqual([
      { name: 'audio_edition', payload: { projectId: 'p1', language: 'he', force: false } },
    ]);
  });

  it('normalises a blank language to null — the source edition', async () => {
    // `''` and `null` must not become two different editions of the same audio, each with its own
    // row and its own object in the bucket.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: true };
    await call('POST', '/api/v1/projects/:id/audio-edition', { user: { id: 'owner' }, body: { language: '  ' } });
    expect((state.enqueued[0].payload as { language: null }).language).toBeNull();
  });
});

describe('the public mini-site route resolves a slug, and only a public one', () => {
  const PUBLIC = { id: 'p1', slug: 'my-lesson', visibility: 'public', created_by: 'owner', title: 'A Lesson', seo_description: 'about it' };

  it('serves a public project’s edition by slug', async () => {
    state.project = PUBLIC;
    state.edition = READY_EDITION;
    const r = await call('GET', '/api/v1/public/audio/:slug');
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ title: 'A Lesson', duration_ms: 1000 });
  });

  it('404s a PRIVATE project even when the slug is correct', async () => {
    // A slug is guessable, which makes this a different threat from following a link someone was
    // given: the authenticated route honours share tokens because the holder was handed one, and
    // this route must not, because nobody handed anything to a guesser.
    state.project = { ...PUBLIC, visibility: 'private' };
    state.edition = READY_EDITION;
    expect((await call('GET', '/api/v1/public/audio/:slug')).code).toBe(404);
  });

  it('ignores a share token on the public route', async () => {
    // Sharing is a capability granted per-project through the authenticated surface. Honouring it
    // here would make the ISR-cached mini-site serve private audio from a shared cache entry.
    state.project = { ...PUBLIC, visibility: 'private', share_token: 'tok' };
    state.edition = READY_EDITION;
    expect((await call('GET', '/api/v1/public/audio/:slug', { query: { share: 'tok' } })).code).toBe(404);
  });

  it('404s when no edition is ready, rather than rendering an empty player', async () => {
    state.project = PUBLIC;
    state.edition = { status: 'processing', m4a_key: null };
    expect((await call('GET', '/api/v1/public/audio/:slug')).code).toBe(404);
  });

  it('refuses when the rate limit is exhausted', async () => {
    // An endpoint that resolves a guessable slug cheaply is one somebody will enumerate.
    state.project = PUBLIC;
    state.edition = READY_EDITION;
    state.rateLimitAllows = false;
    expect((await call('GET', '/api/v1/public/audio/:slug')).code).toBe(429);
  });

  it('never exposes the storage key, only a signed URL', async () => {
    // The key is the object's address in a private bucket. Leaking it turns a time-limited
    // capability into a permanent one for anyone who later gets bucket-level access.
    state.project = PUBLIC;
    state.edition = READY_EDITION;
    const body = (await call('GET', '/api/v1/public/audio/:slug')).body as Record<string, unknown>;
    expect(JSON.stringify(body)).not.toContain('m4a_key');
    expect(String(body.audio_url)).toMatch(/^https:\/\/signed\.example\//);
  });
});

describe('the typed-question routes are GONE, and their absence is the assertion', () => {
  // Removed 2026-09-03 with the feature (owner ruling). What was here was a large, careful suite
  // about an anonymous stranger spending the project owner's LLM budget through a public,
  // unauthenticated POST — a risk that only existed because the route did. The route is the fix.
  //
  // These two cases stay because a route is easy to reinstate by accident: a merge that restores
  // a deleted block, a revert taken too wide. Registering either path again fails here.
  it('POST …/audio/:slug/questions is not registered', async () => {
    await expect(call('POST', '/api/v1/public/audio/:slug/questions', { body: { question: 'Why?' } }))
      .rejects.toThrow(/no POST .* route is registered/);
  });

  it('GET /projects/:id/questions is not registered', async () => {
    await expect(call('GET', '/api/v1/projects/:id/questions', { user: { id: 'owner' } }))
      .rejects.toThrow(/no GET .* route is registered/);
  });

  it('the voice question route, which writes through the SAME service and table, is untouched', async () => {
    // The removal must not be read as "listener questions are gone". Every spoken question still
    // lands in `listener_questions` through `askListenerQuestion`; only the typed doors closed.
    await expect(call('POST', '/api/v1/public/audio/:slug/voice-question', { body: {} }))
      .resolves.toBeTruthy();
  });
});
