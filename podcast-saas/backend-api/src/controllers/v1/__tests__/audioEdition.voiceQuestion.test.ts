/**
 * POST /api/v1/public/audio/:slug/voice-question — the spoken Raise Your Hand (night run
 * 2026-09-03 §4) — at the ROUTE level. The service has its own suite; what this file pins is the
 * controller's contract, which nothing else exercised: the per-IP limit and its key, the
 * public-only gate, the "no file" refusal, the fields the multipart carries into the service,
 * the response shape, the 413 for a recording over `VOICE_QUESTION_MAX_BYTES` (through the real
 * bounded temp file, not a mock of it) and the 502 that keeps playback unaffected. Plus the
 * `artwork_url` the info route grew for the car-mode player.
 *
 * Same fake-app style as `audioEditionAccess.test.ts`: the controller registers its routes on an
 * object that records them, and one handler is invoked with a hand-built request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { VOICE_QUESTION_MAX_BYTES } from 'shared';

const state = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  edition: null as Record<string, unknown> | null,
  rateLimitAllows: true,
  rateLimitCalls: [] as Array<{ key: string; limit: number; windowMs: number }>,
  voiceInputs: [] as Array<Record<string, unknown>>,
  voiceResult: null as Record<string, unknown> | null,
  voiceError: null as Error | null,
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: async () => state.project },
      project_audio_editions: { findFirst: async () => state.edition },
      listener_questions: { findMany: async () => [] },
      video_files: { findMany: async () => [] },
    },
  },
}));
vi.mock('../../../db/schema.js', () => ({
  project_audio_editions: { project_id: 'project_audio_editions.project_id', language: 'project_audio_editions.language' },
  listener_questions: { id: 'listener_questions.id', project_id: 'listener_questions.project_id', created_at: 'listener_questions.created_at' },
  projects: { id: 'projects.id', slug: 'projects.slug' },
  video_files: { project_id: 'video_files.project_id', is_broll: 'video_files.is_broll', sequence_order: 'video_files.sequence_order', created_at: 'video_files.created_at' },
}));
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
vi.mock('../../../services/collabAccess.js', () => ({ editableProject: async () => null }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getPresignedDownloadUrl: async (k: string) => `https://signed.example/${k}` }),
}));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: vi.fn() }));
vi.mock('../../../lib/rateLimit.js', () => ({
  rateLimit: (key: string, limit: number, windowMs: number) => {
    state.rateLimitCalls.push({ key, limit, windowMs });
    return state.rateLimitAllows;
  },
}));
vi.mock('../../../services/audio/ListenerQuestionService.js', () => ({ askListenerQuestion: vi.fn() }));
vi.mock('../../../services/audio/VoiceQuestionService.js', () => ({
  answerVoiceQuestion: async (input: Record<string, unknown>) => {
    state.voiceInputs.push(input);
    if (state.voiceError) throw state.voiceError;
    return state.voiceResult;
  },
}));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { registerAudioEditionRoutes } = await import('../audioEdition.controller.js');

interface Captured { code: number; body: unknown }
type Handler = (req: unknown, reply: unknown) => Promise<unknown>;

async function routeFor(method: 'GET' | 'POST', path: string): Promise<Handler> {
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  const record = (m: string) => (p: string, a: unknown, b?: unknown) =>
    routes.push({ method: m, path: p, handler: (typeof a === 'function' ? a : b) as Handler });
  await registerAudioEditionRoutes({ get: record('GET'), post: record('POST') } as never);
  const route = routes.find((r) => r.method === method && r.path === path);
  if (!route) throw new Error(`no ${method} ${path} route is registered`);
  return route.handler;
}

/** A multipart part the way @fastify/multipart hands it over: a file stream plus text fields. */
function part(bytes: Buffer | Buffer[], fields: Record<string, string> = {}) {
  return {
    file: Readable.from(Array.isArray(bytes) ? bytes : [bytes]),
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }])),
  };
}

async function postVoice(opts: { file?: ReturnType<typeof part> | null; user?: { id: string } | null; ip?: string }): Promise<Captured> {
  const handler = await routeFor('POST', '/api/v1/public/audio/:slug/voice-question');
  const captured: Captured = { code: 200, body: undefined };
  const reply = {
    code(c: number) { captured.code = c; return reply; },
    send(b: unknown) { captured.body = b; return reply; },
  };
  await handler({
    params: { slug: 'my-lesson' },
    ip: opts.ip ?? '1.2.3.4',
    dbUser: opts.user ?? null,
    file: async () => { if (opts.file === null) throw new Error('no multipart'); return opts.file; },
  }, reply);
  return captured;
}

const WAV = Buffer.from('RIFF....WAVEfmt ', 'latin1');

beforeEach(() => {
  state.project = { id: 'p1', slug: 'my-lesson', visibility: 'public', title: 'Lesson', thumbnail_url: 'https://cdn/thumb.jpg', seo_description: null };
  state.edition = { status: 'ready', m4a_key: 'editions/p1/x.m4a', duration_ms: 1000, chapters_json: [], captions_vtt: null, language: null, updated_at: new Date(0) };
  state.rateLimitAllows = true;
  state.rateLimitCalls = [];
  state.voiceInputs = [];
  state.voiceResult = { status: 'answered', question: 'Why is the sky blue?', answer: 'Rayleigh scattering.', message: null, audio: Buffer.from('mp3'), audioMime: 'audio/mpeg' };
  state.voiceError = null;
});

describe('POST /api/v1/public/audio/:slug/voice-question', () => {
  it('carries the recording, the position and the language into the service and answers with the audio base64-encoded', async () => {
    const res = await postVoice({ file: part(WAV, { position_ms: '12345.6', language: ' he ' }), user: { id: 'u1' } });
    expect(res.code).toBe(200);
    expect(res.body).toEqual({
      status: 'answered', question: 'Why is the sky blue?', answer: 'Rayleigh scattering.', message: null,
      audio_base64: Buffer.from('mp3').toString('base64'), audio_mime: 'audio/mpeg',
    });
    expect(state.voiceInputs).toHaveLength(1);
    const input = state.voiceInputs[0]!;
    expect(input).toMatchObject({ projectId: 'p1', language: 'he', positionMs: 12346, userId: 'u1' });
    expect(String(input.audioPath)).toMatch(/\.wav$/);
  });

  it('a spoken question without an answer clip answers with a null audio field, not a crash', async () => {
    state.voiceResult = { status: 'nothing_heard', question: null, answer: null, message: 'Nothing heard', audio: null, audioMime: null };
    const res = await postVoice({ file: part(WAV) });
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ status: 'nothing_heard', audio_base64: null, audio_mime: null });
    expect(state.voiceInputs[0]).toMatchObject({ positionMs: 0, language: null, userId: null });
  });

  it('is rate-limited per IP under its own key, tighter than the typed route, before any database read', async () => {
    state.rateLimitAllows = false;
    const res = await postVoice({ file: part(WAV), ip: '9.9.9.9' });
    expect(res.code).toBe(429);
    expect(state.rateLimitCalls).toEqual([{ key: 'askv:9.9.9.9', limit: 6, windowMs: 60_000 }]);
    expect(state.voiceInputs).toHaveLength(0);
  });

  it('a private or unknown project is 404, and the service is never reached', async () => {
    state.project = { ...state.project!, visibility: 'private' };
    expect((await postVoice({ file: part(WAV) })).code).toBe(404);
    state.project = null;
    expect((await postVoice({ file: part(WAV) })).code).toBe(404);
    expect(state.voiceInputs).toHaveLength(0);
  });

  it('no multipart file is 400', async () => {
    const res = await postVoice({ file: null });
    expect(res.code).toBe(400);
    expect(state.voiceInputs).toHaveLength(0);
  });

  it(`a recording over ${VOICE_QUESTION_MAX_BYTES} bytes is 413 through the real bounded temp file, and never reaches the service`, async () => {
    const chunk = Buffer.alloc(256 * 1024, 1);
    const chunks = Array.from({ length: Math.ceil(VOICE_QUESTION_MAX_BYTES / chunk.length) + 1 }, () => chunk);
    const res = await postVoice({ file: part(chunks) });
    expect(res.code).toBe(413);
    expect(res.body).toEqual({ message: 'That recording is too long.' });
    expect(state.voiceInputs).toHaveLength(0);
  });

  it('a service failure is 502 with a message that says playback is unaffected', async () => {
    state.voiceError = new Error('stt down');
    const res = await postVoice({ file: part(WAV) });
    expect(res.code).toBe(502);
    expect(res.body).toEqual({ message: 'Could not answer right now — playback is unaffected.' });
  });
});

describe('GET /api/v1/public/audio/:slug — the car-mode player’s cover art', () => {
  async function getInfo(): Promise<Captured> {
    const handler = await routeFor('GET', '/api/v1/public/audio/:slug');
    const captured: Captured = { code: 200, body: undefined };
    const reply = {
      code(c: number) { captured.code = c; return reply; },
      header() { return reply; },
      send(b: unknown) { captured.body = b; return reply; },
    };
    await handler({ params: { slug: 'my-lesson' }, query: {}, dbUser: null, ip: '1.2.3.4' }, reply);
    return captured;
  }

  it('carries the project thumbnail as artwork_url, null when there is none', async () => {
    const withArt = await getInfo();
    expect(withArt.code).toBe(200);
    expect(withArt.body).toMatchObject({ artwork_url: 'https://cdn/thumb.jpg' });

    state.project = { ...state.project!, thumbnail_url: null };
    const without = await getInfo();
    expect(without.body).toMatchObject({ artwork_url: null });
  });
});
