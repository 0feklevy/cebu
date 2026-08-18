/**
 * security-007 / performance-001 / -002 / -003 — the upload routes that buffer first and ask
 * questions never.
 *
 * Audio upload, corpus source and podcast episode source all had the same shape:
 *
 *     const data = await request.file();
 *     const buf  = await data.toBuffer();     // <- the WHOLE file, into the Node heap
 *
 * with no declared-size check before it and no byte ceiling during it. The only bound was the
 * global `@fastify/multipart` registration — 10 GB. On the 2-vCPU host two concurrent uploads
 * are an out-of-memory kill of the whole API, and the caller who triggered it gets no error
 * because the process is gone.
 *
 * They are fixed as ONE shape (services/security/uploadLimits.ts), and this suite is that shape
 * stated as behaviour, once per route:
 *
 *   1  DECLARED FIRST — an over-limit `Content-Length` is refused before a single part is read,
 *      so we never start spooling a body we have already decided to reject
 *   2  THEN STREAMED — a body that lies about its size (or declares nothing) is cut off at the
 *      ceiling while it streams, not after it has landed in the heap
 *   3  the refusal is a 413 that NAMES the limit, and storage is never touched
 *   4  an in-limit upload still works — the guard is a ceiling, not a wall
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PROJECT_ID = 'proj-1';
const SHOW_ID = 'show-1';
const EPISODE_ID = 'ep-1';
const GIB = 1024 ** 3;

const mocks = vi.hoisted(() => ({
  uploadWithFallback: vi.fn(async () => 'https://cdn/x'),
  storageUploadFile: vi.fn(async () => 'https://cdn/x'),
  storageUploadStream: vi.fn(async () => 'https://cdn/x'),
  probeMediaDuration: vi.fn(async () => 12.5),
  insertReturning: vi.fn(async () => [{ id: 'row-1' }]),
  corpusIngest: vi.fn(async () => undefined),
  docExtract: vi.fn(async () => '# md'),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      audio_files: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
      corpora: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
      podcast_sources: { findFirst: vi.fn(), findMany: vi.fn(async () => []) },
    },
    insert: () => ({ values: () => ({ returning: mocks.insertReturning }) }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
    delete: () => ({ where: async () => [] }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  audio_files: Symbol('audio_files'),
  timeline_sections: Symbol('timeline_sections'),
  video_files: Symbol('video_files'),
  corpora: Symbol('corpora'),
  podcast_shows: Symbol('podcast_shows'),
  podcast_episodes: Symbol('podcast_episodes'),
  podcast_sources: Symbol('podcast_sources'),
}));
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})), and: vi.fn(() => ({})), asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})), inArray: vi.fn(() => ({})), sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
  firebaseAuthOptionalMiddleware: (_q: unknown, _r: unknown, done: () => void) => done(),
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: async () => ({ id: PROJECT_ID }),
}));
vi.mock('../../../services/podcastAccess.js', () => ({
  ownedShow: async () => ({ id: SHOW_ID }),
  ownedEpisodeInShow: async () => ({ show: { id: SHOW_ID }, episode: { id: EPISODE_ID } }),
  showsOwnedByWhere: () => ({}),
}));
vi.mock('../../../lib/rateLimit.js', () => ({ rateLimit: () => async () => undefined }));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    uploadFile: mocks.storageUploadFile,
    uploadStream: mocks.storageUploadStream,
    getPresignedDownloadUrl: async () => 'https://cdn/raw',
    deleteFile: async () => undefined,
  }),
}));
vi.mock('../../../services/storage/uploadWithFallback.js', () => ({
  uploadWithFallback: mocks.uploadWithFallback,
}));
vi.mock('../../../services/video/HLSTranscoder.js', () => ({
  probeMediaDuration: mocks.probeMediaDuration,
}));
vi.mock('../../../services/secrets/ApiKeyService.js', () => ({
  ApiKeyService: class { async getSystemKey() { return null; } },
}));
vi.mock('../../../services/ingestion/CorpusBuilder.js', () => ({
  CorpusBuilder: class { ingest = mocks.corpusIngest; },
}));
vi.mock('../../../services/ingestion/DocumentIngester.js', () => ({
  DocumentIngester: class { extract = mocks.docExtract; },
  MARKITDOWN_EXTENSIONS: new Set(['docx', 'pptx', 'xlsx', 'html', 'txt', 'md']),
}));
vi.mock('../../../services/ingestion/PDFIngester.js', () => ({
  PDFIngester: class { extract = mocks.docExtract; },
}));
vi.mock('../../../services/ingestion/WebIngester.js', () => ({
  WebIngester: class { extract = mocks.docExtract; },
}));
vi.mock('../../../services/podcast/PodcastVoiceService.js', () => ({
  PodcastVoiceService: class { async listVoices() { return []; } },
  DEFAULT_TEACHER_VOICE_ID: 'v1',
  DEFAULT_LEARNER_VOICE_ID: 'v2',
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const BOUNDARY = '----flowvidtest';

/** A single-file multipart body, in the shape @fastify/multipart's request.file() reads. */
function fileBody(fieldname: string, filename: string, mime: string, bytes: number): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="${fieldname}"; filename="${filename}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
    ),
    Buffer.alloc(bytes, 0x61),
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

const MULTIPART_HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

type RouteCase = {
  name: string;
  url: string;
  register: (app: FastifyInstance) => Promise<void>;
  filename: string;
  mime: string;
  okStatus: number;
  /** Everything that must NOT have been called when the request is refused. */
  storageSpies: ReturnType<typeof vi.fn>[];
};

/**
 * Build a Fastify app with the global multipart limit the SERVER uses, so these tests exercise
 * the route's own ceiling rather than a limit invented for the test.
 */
async function buildApp(register: (app: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const app = Fastify();
  const { GLOBAL_MULTIPART_FILE_LIMIT_BYTES } = await import('../../../services/security/uploadLimits.js');
  await app.register(multipart, { limits: { fileSize: GLOBAL_MULTIPART_FILE_LIMIT_BYTES } });
  await register(app);
  await app.ready();
  return app;
}

async function routeCases(): Promise<RouteCase[]> {
  const { registerAudioRoutes } = await import('../audio.controller.js');
  const { registerCorpusRoutes } = await import('../corpus.controller.js');
  const { registerPodcastRoutes } = await import('../podcast.controller.js');
  return [
    {
      name: 'POST /projects/:id/audio',
      url: `/api/v1/projects/${PROJECT_ID}/audio`,
      register: registerAudioRoutes,
      filename: 'track.mp3', mime: 'audio/mpeg', okStatus: 201,
      storageSpies: [mocks.uploadWithFallback, mocks.storageUploadFile, mocks.storageUploadStream],
    },
    {
      name: 'POST /projects/:id/corpus',
      url: `/api/v1/projects/${PROJECT_ID}/corpus`,
      register: registerCorpusRoutes,
      filename: 'source.mp4', mime: 'video/mp4', okStatus: 202,
      storageSpies: [mocks.storageUploadFile, mocks.storageUploadStream],
    },
    {
      name: 'POST /podcasts/:showId/episodes/:epId/sources/upload',
      url: `/api/v1/podcasts/${SHOW_ID}/episodes/${EPISODE_ID}/sources/upload`,
      register: registerPodcastRoutes,
      filename: 'notes.txt', mime: 'text/plain', okStatus: 201,
      storageSpies: [mocks.storageUploadFile, mocks.storageUploadStream],
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.uploadWithFallback.mockResolvedValue('https://cdn/x');
  mocks.storageUploadFile.mockResolvedValue('https://cdn/x');
  mocks.storageUploadStream.mockResolvedValue('https://cdn/x');
  mocks.probeMediaDuration.mockResolvedValue(12.5);
  mocks.insertReturning.mockResolvedValue([{ id: 'row-1' }]);
  mocks.docExtract.mockResolvedValue('# md');
});

afterEach(() => {
  delete process.env.MAX_AUDIO_UPLOAD_BYTES;
  delete process.env.MAX_CORPUS_UPLOAD_BYTES;
  delete process.env.MAX_PODCAST_SOURCE_BYTES;
  vi.resetModules();
});

describe.each(await routeCases())('$name bounds the body', (c) => {
  it('refuses an over-limit Content-Length before reading a single part', async () => {
    const app = await buildApp(c.register);
    const res = await app.inject({
      method: 'POST',
      url: c.url,
      headers: { ...MULTIPART_HEADERS, 'content-length': String(9 * GIB) },
      payload: fileBody('file', c.filename, c.mime, 32),
    });

    expect(res.statusCode).toBe(413);
    for (const spy of c.storageSpies) expect(spy).not.toHaveBeenCalled();
    await app.close();
  });

  it('names a byte limit in the refusal so the client can explain it', async () => {
    const app = await buildApp(c.register);
    const res = await app.inject({
      method: 'POST',
      url: c.url,
      headers: { ...MULTIPART_HEADERS, 'content-length': String(9 * GIB) },
      payload: fileBody('file', c.filename, c.mime, 32),
    });

    expect(res.json<{ message: string }>().message).toMatch(/\d+(\.\d+)?\s*(KB|MB|GB)/);
    await app.close();
  });

  it('still accepts an upload inside the ceiling', async () => {
    const app = await buildApp(c.register);
    const res = await app.inject({
      method: 'POST', url: c.url, headers: MULTIPART_HEADERS,
      payload: fileBody('file', c.filename, c.mime, 1024),
    });

    expect(res.statusCode).toBe(c.okStatus);
    await app.close();
  });
});

describe('a body that LIES about its size is cut off while it streams', () => {
  it.each([
    ['audio', 'MAX_AUDIO_UPLOAD_BYTES', `/api/v1/projects/${PROJECT_ID}/audio`, 'registerAudioRoutes', '../audio.controller.js', 'track.mp3', 'audio/mpeg'],
    ['corpus', 'MAX_CORPUS_UPLOAD_BYTES', `/api/v1/projects/${PROJECT_ID}/corpus`, 'registerCorpusRoutes', '../corpus.controller.js', 'source.mp4', 'video/mp4'],
    ['podcast source', 'MAX_PODCAST_SOURCE_BYTES', `/api/v1/podcasts/${SHOW_ID}/episodes/${EPISODE_ID}/sources/upload`, 'registerPodcastRoutes', '../podcast.controller.js', 'notes.txt', 'text/plain'],
  ])('%s: 413 on the streamed bytes, with nothing written to storage', async (_label, envVar, url, exportName, modulePath, filename, mime) => {
    // A 4 KiB ceiling, so the over-limit body is a test-sized 16 KiB rather than a real one.
    vi.resetModules();
    process.env[envVar] = String(4 * 1024);
    const mod = await import(modulePath) as Record<string, (app: FastifyInstance) => Promise<void>>;

    const app = Fastify();
    const { GLOBAL_MULTIPART_FILE_LIMIT_BYTES } = await import('../../../services/security/uploadLimits.js');
    await app.register(multipart, { limits: { fileSize: GLOBAL_MULTIPART_FILE_LIMIT_BYTES } });
    await mod[exportName](app);
    await app.ready();

    const res = await app.inject({
      method: 'POST', url, headers: MULTIPART_HEADERS,
      payload: fileBody('file', filename, mime, 16 * 1024),
    });

    expect(res.statusCode).toBe(413);
    expect(mocks.uploadWithFallback).not.toHaveBeenCalled();
    expect(mocks.storageUploadFile).not.toHaveBeenCalled();
    expect(mocks.storageUploadStream).not.toHaveBeenCalled();
    await app.close();
  });
});

/**
 * The global ceiling is a WIRING fact — which number reaches `app.register(multipart, …)` — and
 * server.ts cannot be imported here (module scope opens listeners and a DB connection), so this
 * reads the source, exactly as `correlationIdWiring.test.ts` and `trustProxyWiring.test.ts` do.
 */
describe('the global @fastify/multipart ceiling (performance-005)', () => {
  const serverSrc = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../server.ts'), 'utf8');
  const serverCode = serverSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('is the proxy body limit, not a number of its own', async () => {
    const { GLOBAL_MULTIPART_FILE_LIMIT_BYTES, PROXY_BODY_LIMIT_BYTES } =
      await import('../../../services/security/uploadLimits.js');
    expect(GLOBAL_MULTIPART_FILE_LIMIT_BYTES).toBe(PROXY_BODY_LIMIT_BYTES);
    expect(GLOBAL_MULTIPART_FILE_LIMIT_BYTES).toBeLessThan(10 * GIB);
  });

  it('server.ts registers multipart with that derived limit, not a literal', () => {
    const at = serverCode.indexOf('app.register(multipart');
    expect(at, 'server.ts no longer registers @fastify/multipart').toBeGreaterThan(-1);
    const registration = serverCode.slice(at, at + 220);
    expect(registration, 'the global multipart limit is a literal again — it can drift from the proxy')
      .toMatch(/fileSize:\s*GLOBAL_MULTIPART_FILE_LIMIT_BYTES/);
  });

  it('every per-route ceiling stays inside the global one', async () => {
    const { UPLOAD_MAX_BYTES, GLOBAL_MULTIPART_FILE_LIMIT_BYTES } =
      await import('../../../services/security/uploadLimits.js');
    for (const [kind, limit] of Object.entries(UPLOAD_MAX_BYTES)) {
      expect(limit, `${kind} promises more than the plugin will pass`)
        .toBeLessThanOrEqual(GLOBAL_MULTIPART_FILE_LIMIT_BYTES);
    }
  });
});
