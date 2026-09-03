/**
 * POST /api/v1/public/audio/:slug/voice-question/stream — the interactive answer's route.
 *
 * The same guards as the one-shot route (per-IP key and limit, public-only, no-file 400), and the
 * part that is new: the reply is hijacked into an SSE stream, every service event is written as
 * one frame, a closed socket aborts the model call, and the stream is always ended.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';

const state = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  rateLimitAllows: true,
  rateLimitCalls: [] as Array<{ key: string; limit: number; windowMs: number }>,
  streamInputs: [] as Array<Record<string, unknown>>,
  /** What the fake service does when the route calls it. */
  behaviour: 'answer' as 'answer' | 'throwTooLong' | 'throw' | 'abortAware',
  sawAbort: false,
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: async () => state.project },
      project_audio_editions: { findFirst: async () => null, findMany: async () => [] },
      listener_questions: { findMany: async () => [] },
      video_files: { findMany: async () => [] },
    },
  },
}));
vi.mock('../../../db/schema.js', () => ({
  project_audio_editions: {}, listener_questions: {}, projects: { slug: 'projects.slug' }, video_files: {},
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(), eq: vi.fn((col: unknown, val: unknown) => ({ col, val })), isNull: vi.fn(), isNotNull: vi.fn(), lt: vi.fn(), desc: vi.fn(), asc: vi.fn(),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({ firebaseAuthMiddleware: vi.fn(), firebaseAuthOptionalMiddleware: vi.fn() }));
vi.mock('../../../lib/uuidParam.js', () => ({ requireUuidParams: () => vi.fn() }));
vi.mock('../../../services/collabAccess.js', () => ({ editableProject: async () => null }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({ getStorageAdapter: () => ({ getPresignedDownloadUrl: async (k: string) => `https://signed/${k}` }) }));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: vi.fn() }));
vi.mock('../../../lib/rateLimit.js', () => ({
  rateLimit: (key: string, limit: number, windowMs: number) => { state.rateLimitCalls.push({ key, limit, windowMs }); return state.rateLimitAllows; },
}));
vi.mock('../../../services/audio/ListenerQuestionService.js', () => ({ askListenerQuestion: vi.fn() }));
vi.mock('../../../services/audio/VoiceQuestionService.js', () => ({
  answerVoiceQuestion: vi.fn(),
  answerVoiceQuestionStream: async (
    input: Record<string, unknown>,
    onEvent: (e: { type: string } & Record<string, unknown>) => void,
    _deps: unknown,
    signal?: AbortSignal,
  ) => {
    state.streamInputs.push(input);
    if (state.behaviour === 'throwTooLong') { const e = new Error('too long') as Error & { statusCode?: number }; e.statusCode = 413; throw e; }
    if (state.behaviour === 'throw') throw new Error('stt down');
    if (state.behaviour === 'abortAware') {
      await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { state.sawAbort = true; resolve(); }); });
      return;
    }
    onEvent({ type: 'heard', question: 'why is the sky blue' });
    onEvent({ type: 'audio', seq: 0, audio_base64: 'AAAA', audio_mime: 'audio/mpeg', text: 'Because it scatters.' });
    onEvent({ type: 'done', status: 'answered', question: 'why is the sky blue', answer: 'Because it scatters.', message: null, audio_chunks: 1 });
  },
}));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { registerAudioEditionRoutes } = await import('../audioEdition.controller.js');

type Handler = (req: unknown, reply: unknown) => Promise<unknown>;

/** The route's reply: hijacked, so everything goes to `raw`. */
function fakeReply() {
  const written: string[] = [];
  const headers: Record<string, string> = {};
  let ended = false;
  let hijacked = false;
  let code = 200;
  let body: unknown;
  const reply = {
    raw: {
      setHeader: (k: string, v: string) => { headers[k] = v; },
      flushHeaders: () => {},
      write: (chunk: string) => { written.push(chunk); return true; },
      end: () => { ended = true; },
    },
    hijack: () => { hijacked = true; },
    code(c: number) { code = c; return reply; },
    header(k: string, v: string) { headers[k] = v; return reply; },
    send(b: unknown) { body = b; return reply; },
  };
  return { reply, written, headers, get ended() { return ended; }, get hijacked() { return hijacked; }, get code() { return code; }, get body() { return body; } };
}

/** The SSE frames the route wrote, parsed back into events. */
function eventsOf(written: string[]): Array<Record<string, unknown>> {
  return written.join('').split('\n\n').flatMap((frame) => {
    const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    return data ? [JSON.parse(data) as Record<string, unknown>] : [];
  });
}

function part(bytes: Buffer = Buffer.from('RIFF....WAVE'), fields: Record<string, string> = {}) {
  return {
    file: Readable.from([bytes]),
    fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { value: v }])),
  };
}

async function post(opts: { file?: ReturnType<typeof part> | null; onClose?: (fire: () => void) => void; origin?: string } = {}) {
  const routes: Array<{ method: string; path: string; handler: Handler }> = [];
  const record = (m: string) => (p: string, a: unknown, b?: unknown) =>
    routes.push({ method: m, path: p, handler: (typeof a === 'function' ? a : b) as Handler });
  await registerAudioEditionRoutes({ get: record('GET'), post: record('POST'), patch: record('PATCH') } as never);
  const route = routes.find((r) => r.method === 'POST' && r.path === '/api/v1/public/audio/:slug/voice-question/stream');
  if (!route) throw new Error('the streaming route is not registered');

  const captured = fakeReply();
  const closeHandlers: Array<() => void> = [];
  const request = {
    params: { slug: 'my-lesson' },
    ip: '1.2.3.4',
    dbUser: null,
    headers: { origin: opts.origin },
    raw: { on: (event: string, fn: () => void) => { if (event === 'close') closeHandlers.push(fn); } },
    file: async () => { if (opts.file === null) throw new Error('no multipart'); return opts.file ?? part(); },
  };
  const done = route.handler(request, captured.reply);
  opts.onClose?.(() => closeHandlers.forEach((fn) => fn()));
  await done;
  return captured;
}

beforeEach(() => {
  state.project = { id: 'p1', slug: 'my-lesson', visibility: 'public' };
  state.rateLimitAllows = true;
  state.rateLimitCalls = [];
  state.streamInputs = [];
  state.behaviour = 'answer';
  state.sawAbort = false;
});

describe('POST /api/v1/public/audio/:slug/voice-question/stream', () => {
  it('hijacks the reply, declares an unbuffered event stream, writes one frame per event, and ends', async () => {
    const r = await post({ file: part(Buffer.from('RIFF'), { position_ms: '4200.7', language: ' he ' }) });
    expect(r.hijacked).toBe(true);
    expect(r.headers['Content-Type']).toBe('text/event-stream');
    expect(r.headers['Cache-Control']).toMatch(/no-cache/);
    expect(r.headers['X-Accel-Buffering']).toBe('no');
    expect(eventsOf(r.written).map((e) => e.type)).toEqual(['heard', 'audio', 'done']);
    expect(eventsOf(r.written)[2]).toMatchObject({ status: 'answered', answer: 'Because it scatters.' });
    // Every frame names its event, so a client can dispatch on it.
    expect(r.written[0]).toMatch(/^event: heard\ndata: /);
    expect(r.ended).toBe(true);
    expect(state.streamInputs[0]).toMatchObject({ projectId: 'p1', language: 'he', positionMs: 4201, userId: null });
  });

  it('carries the same guards as the one-shot route: the per-IP key, the public-only gate, a missing file', async () => {
    state.rateLimitAllows = false;
    const limited = await post();
    expect(limited.code).toBe(429);
    expect(state.rateLimitCalls).toEqual([{ key: 'askv:1.2.3.4', limit: 6, windowMs: 60_000 }]);
    expect(limited.hijacked).toBe(false);

    state.rateLimitAllows = true;
    state.project = { ...state.project!, visibility: 'private' };
    expect((await post()).code).toBe(404);

    state.project = { ...state.project!, visibility: 'public' };
    const noFile = await post({ file: null });
    expect(noFile.code).toBe(400);
    expect(state.streamInputs).toHaveLength(0);
  });

  it('a failure inside the stream is an error EVENT, not a broken socket', async () => {
    state.behaviour = 'throw';
    const r = await post();
    expect(eventsOf(r.written)).toEqual([{ type: 'error', message: 'Could not answer right now — playback is unaffected.' }]);
    expect(r.ended).toBe(true);

    state.behaviour = 'throwTooLong';
    const tooLong = await post();
    expect(eventsOf(tooLong.written)).toEqual([{ type: 'error', message: 'That recording is too long.' }]);
  });

  it('a closed socket aborts the answer instead of finishing it into nothing', async () => {
    state.behaviour = 'abortAware';
    const r = await post({ onClose: (fire) => setTimeout(fire, 5) });
    expect(state.sawAbort).toBe(true);
    expect(r.ended).toBe(true);
  });

  // `reply.hijack()` takes this response out of Fastify's own pipeline — the one thing that would
  // otherwise have written the CORS header the global @fastify/cors plugin computed for it. This
  // is the ONE route in the app that hijacks, and on 2026-09-03 it shipped with exactly this gap:
  // every other assertion above passed, the stream itself was perfect, and a real browser refused
  // to hand any of it to the page because `Access-Control-Allow-Origin` was simply never sent.
  describe('the hijacked reply still carries CORS — the gap that broke this in production', () => {
    const ENV = { ...process.env };
    afterEach(() => { process.env = { ...ENV }; });

    it('reflects an allowed browser origin, the way @fastify/cors would have', async () => {
      process.env.NODE_ENV = 'development'; // browserOrigins() includes the dev localhost origins
      const r = await post({ origin: 'http://localhost:3000' });
      expect(r.headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
      expect(r.headers['Vary']).toBe('Origin');
    });

    it('does not reflect an origin that is not ours', async () => {
      process.env.NODE_ENV = 'development';
      const r = await post({ origin: 'https://evil.example.com' });
      expect(r.headers['Access-Control-Allow-Origin']).toBeUndefined();
      // Vary: Origin still stands — the decision depended on the Origin header either way, and a
      // shared cache must not serve this (headerless) response back for an allowed origin's request.
      expect(r.headers['Vary']).toBe('Origin');
    });

    it('reflects the real production app origin in production, not a wildcard', async () => {
      process.env.NODE_ENV = 'production';
      process.env.BACKEND_API_URL = 'https://api.flowvidco.com';
      process.env.NEXT_PUBLIC_APP_URL = 'https://flowvidco.com';
      const r = await post({ origin: 'https://flowvidco.com' });
      expect(r.headers['Access-Control-Allow-Origin']).toBe('https://flowvidco.com');
    });

    it('with no Origin header (a same-origin or non-browser caller) sends none, and still ends cleanly', async () => {
      const r = await post({ origin: undefined });
      expect(r.headers['Access-Control-Allow-Origin']).toBeUndefined();
      expect(r.ended).toBe(true);
    });
  });
});
