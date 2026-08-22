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
};

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: async () => state.project },
      project_audio_editions: { findFirst: async () => state.edition },
      listener_questions: { findMany: async () => state.questions },
      video_files: { findMany: async () => [{ storage_key: 'k', duration_sec: 10 }] },
    },
  },
}));
vi.mock('../../../db/schema.js', () => ({
  project_audio_editions: { project_id: 'project_id', language: 'language' },
  listener_questions: { id: 'id', project_id: 'project_id', created_at: 'created_at' },
  projects: { id: 'id' },
  video_files: { project_id: 'project_id' },
}));
vi.mock('drizzle-orm', () => ({ and: vi.fn(() => ({})), eq: vi.fn(() => ({})), isNull: vi.fn(() => ({})), desc: vi.fn(() => ({})) }));
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
  it('reports a status rather than a broken URL', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner' };
    state.edition = { status: 'processing', m4a_key: null, error: null };
    const r = await call('GET', '/api/v1/projects/:id/audio-edition');
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ status: 'processing', audio_url: null, chapters: [] });
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

describe('Raise Your Hand — an anonymous stranger, the owner’s bill', () => {
  const PUBLIC = { id: 'p1', slug: 'my-lesson', visibility: 'public', created_by: 'owner', title: 'A Lesson', seo_description: null };

  it('lets an anonymous listener ask, because the listener is driving', async () => {
    // Requiring an account to ask about the thing they are already hearing would make the feature
    // unusable for the person it exists for.
    state.project = PUBLIC;
    const r = await call('POST', '/api/v1/public/audio/:slug/questions', {
      user: null, body: { question: 'Why?', position_ms: 1000, intent: 'answer' },
    });
    expect(r.code).toBe(200);
    expect((r.body as { answer: string }).answer).toBe('Because.');
  });

  it('defaults an unknown intent to SAVE, never to answer', async () => {
    // Defaulting the other way would make a malformed client spend the owner's money by omission.
    state.project = PUBLIC;
    await call('POST', '/api/v1/public/audio/:slug/questions', { body: { question: 'Why?', position_ms: 0 } });
    expect(state.asked[0].intent).toBe('save');
    await call('POST', '/api/v1/public/audio/:slug/questions', { body: { question: 'Why?', intent: 'nonsense' } });
    expect(state.asked[1].intent).toBe('save');
  });

  it('rate-limits asking far more tightly than reading', async () => {
    // A read is cheap and idempotent; this one can cost real money.
    state.project = PUBLIC;
    state.rateLimitAllows = false;
    const r = await call('POST', '/api/v1/public/audio/:slug/questions', { body: { question: 'Why?', intent: 'answer' } });
    expect(r.code).toBe(429);
    expect(state.asked, 'a rate-limited question still reached the service').toEqual([]);
  });

  it('uses a DIFFERENT rate-limit bucket from the read route', async () => {
    // Sharing one bucket would let a listener reading the page exhaust their own ability to ask,
    // and would let a script asking questions lock everyone out of reading.
    state.project = PUBLIC;
    state.edition = READY_EDITION;
    await call('GET', '/api/v1/public/audio/:slug');
    await call('POST', '/api/v1/public/audio/:slug/questions', { body: { question: 'Why?' } });
    const [readKey, askKey] = state.rateLimitKeys;
    expect(readKey.split(':')[0]).not.toBe(askKey.split(':')[0]);
  });

  it('refuses a question on a PRIVATE lesson without reaching the service', async () => {
    state.project = { ...PUBLIC, visibility: 'private' };
    const r = await call('POST', '/api/v1/public/audio/:slug/questions', { body: { question: 'Why?', intent: 'answer' } });
    expect(r.code).toBe(404);
    expect(state.asked).toEqual([]);
  });

  it('passes the refusal REASON back, so a withheld answer is not a silent non-response', async () => {
    state.project = PUBLIC;
    state.askResult = { status: 'saved', reason: 'This lesson has answered all its questions for today.' };
    const r = await call('POST', '/api/v1/public/audio/:slug/questions', { body: { question: 'Why?', intent: 'answer' } });
    expect(r.code).toBe(200);
    expect((r.body as { status: string }).status).toBe('saved');
    expect((r.body as { message: string }).message).toMatch(/today/);
  });

  it('400s a malformed question rather than pretending it was saved', async () => {
    state.project = PUBLIC;
    state.askResult = { status: 'refused', reason: 'A question needs some words in it.' };
    expect((await call('POST', '/api/v1/public/audio/:slug/questions', { body: { question: '' } })).code).toBe(400);
  });
});

describe('the creator’s view of what listeners asked', () => {
  it('requires EDIT rights — audience data is not viewer data', async () => {
    // A viewer of a public lesson has no more claim on its questions than a reader of a blog has
    // on its analytics.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: false };
    expect((await call('GET', '/api/v1/projects/:id/questions', { user: { id: 'viewer' } })).code).toBe(404);
  });

  it('refuses an anonymous caller', async () => {
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: true };
    expect((await call('GET', '/api/v1/projects/:id/questions', { user: null })).code).toBe(401);
  });

  it('returns the questions to an editor, including the ones never answered', async () => {
    // The capped and failed ones are exactly the list's value: they are where a lesson's confusing
    // passage becomes visible, and the demand signal A2.5 is waiting on.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: true };
    state.questions = [
      { id: 'q1', position_ms: 1000, question: 'Why?', answer: 'Because.', status: 'answered', language: null, created_at: new Date(0) },
      { id: 'q2', position_ms: 2000, question: 'And this?', answer: null, status: 'saved', language: null, created_at: new Date(0) },
    ];
    const r = await call('GET', '/api/v1/projects/:id/questions', { user: { id: 'owner' } });
    expect(r.code).toBe(200);
    expect((r.body as { questions: unknown[] }).questions).toHaveLength(2);
  });

  it('never exposes who asked', async () => {
    // `asked_by` is a user id. The creator needs the QUESTION, not the identity of an anonymous
    // listener who was told nothing about being identified.
    state.project = { id: 'p1', visibility: 'public', created_by: 'owner', editable: true };
    state.questions = [{ id: 'q1', position_ms: 0, question: 'Why?', answer: null, status: 'saved', language: null, created_at: new Date(0), asked_by: 'user-42' }];
    const r = await call('GET', '/api/v1/projects/:id/questions', { user: { id: 'owner' } });
    expect(JSON.stringify(r.body)).not.toContain('user-42');
  });
});
