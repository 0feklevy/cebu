/**
 * The proxied streaming upload route must not promise more than the reverse proxy will pass.
 *
 * Every byte of POST /api/v1/projects/:id/videos/upload crosses nginx, whose
 * `client_max_body_size` is `MAX_UPLOAD_SIZE` (deploy/.env, default `2g`; deploy/nginx/nginx.conf
 * carries the same `2g` as its http-level default). The route used to declare `bodyLimit: TEN_GB`
 * and `parts({ limits: { fileSize: TEN_GB } })`, so the application accepted — and started
 * spooling — uploads that the proxy in front of it refuses. The failure surfaced at the proxy, as
 * a 413 with no message the client could explain, after the transfer had already begun.
 *
 * The properties here are the agreement itself:
 *   1  the route's ceiling is DERIVED from the proxy limit, never larger than it
 *   2  an over-limit upload is refused with a 413 that names the real number
 *   3  it is refused BEFORE any bytes reach storage — no accepting what cannot be kept
 *   4  an in-limit upload still works (the guard is a ceiling, not a wall)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';

const PROJECT_ID = 'proj-1';

const mocks = vi.hoisted(() => ({
  uploadStream: vi.fn(async () => 'https://cdn/x'),
  insertReturning: vi.fn(async () => [{ id: 'vf-1', storage_key: 'videos/proj-1/x.mp4' }]),
  enqueueJob: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: { video_files: { findFirst: vi.fn() }, projects: { findFirst: vi.fn() } },
    insert: () => ({ values: () => ({ returning: mocks.insertReturning }) }),
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => [] }) }) }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
    delete: () => ({ where: async () => [] }),
  },
}));
vi.mock('../../../db/schema.js', () => ({ video_files: Symbol('video_files') }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})), and: vi.fn(() => ({})), desc: vi.fn(() => ({})) }));
vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
}));
vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: async () => ({ id: PROJECT_ID }),
}));
vi.mock('../../../services/storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({ getPresignedDownloadUrl: async () => 'https://cdn/raw' }),
}));
vi.mock('../../../services/storage/uploadStreamWithFallback.js', () => ({
  uploadStreamWithFallback: mocks.uploadStream,
}));
vi.mock('../../../services/storage/deleteWithFallback.js', () => ({
  deleteWithFallback: vi.fn(), deleteWithPrefixFallback: vi.fn(),
}));
vi.mock('../../../services/video/hlsRetention.js', () => ({ deleteHlsRetirementRowsForVideo: vi.fn() }));
vi.mock('../../../services/crop/runCropAnalysis.js', () => ({ enqueueCropForProject: vi.fn() }));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: mocks.enqueueJob }));
vi.mock('../../../lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { registerVideoRoutes, parseNginxSize, streamUploadMaxFileBytes } = await import('../video.controller.js');

const GIB = 1024 ** 3;
/** What the route derives when MAX_UPLOAD_SIZE is unset — nginx's documented 2g default. */
const EXPECTED_CEILING = streamUploadMaxFileBytes({ proxyBodyLimitBytes: 2 * GIB, appMaxBytes: 10 * GIB });

const BOUNDARY = '----flowvidtest';

/** A multipart body in the exact shape the client sends: file_size field, then the file. */
function multipartBody(declaredFileSize: number, fileBytes = 32): Buffer {
  const file = Buffer.alloc(fileBytes, 0x61);
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="file_size"\r\n\r\n' +
      `${declaredFileSize}\r\n` +
      `--${BOUNDARY}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="big.mp4"\r\n' +
      'Content-Type: video/mp4\r\n\r\n',
    ),
    file,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 10 * GIB } });
  await registerVideoRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  mocks.uploadStream.mockClear();
});

describe('nginx size parsing', () => {
  it('reads the suffixes nginx itself accepts', () => {
    expect(parseNginxSize('2g')).toBe(2 * GIB);
    expect(parseNginxSize('512m')).toBe(512 * 1024 ** 2);
    expect(parseNginxSize('100k')).toBe(100 * 1024);
    expect(parseNginxSize('1048576')).toBe(1048576);
    expect(parseNginxSize('2G')).toBe(2 * GIB);
  });

  it('returns null rather than a wrong number for anything it cannot parse', () => {
    for (const v of [undefined, '', 'lots', '2gb', '-1', '0', '2.5g']) {
      expect(parseNginxSize(v)).toBeNull();
    }
  });
});

describe('the streaming route ceiling', () => {
  it('is never larger than what the proxy will pass through', () => {
    const ceiling = streamUploadMaxFileBytes({ proxyBodyLimitBytes: 2 * GIB, appMaxBytes: 10 * GIB });
    expect(ceiling).toBeLessThan(2 * GIB);
  });

  it('leaves room for the multipart envelope — a file AT the proxy limit does not fit in it', () => {
    expect(streamUploadMaxFileBytes({ proxyBodyLimitBytes: 2 * GIB, appMaxBytes: 10 * GIB })).toBeLessThan(2 * GIB);
  });

  it('follows the app cap when the app is the smaller constraint', () => {
    expect(streamUploadMaxFileBytes({ proxyBodyLimitBytes: 10 * GIB, appMaxBytes: 500 * 1024 ** 2 })).toBe(500 * 1024 ** 2);
  });
});

describe('POST /videos/upload refuses what the proxy would refuse', () => {
  it('rejects a declared file_size above the ceiling with 413, before any byte reaches storage', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/videos/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody(5 * GIB),
    });

    expect(res.statusCode).toBe(413);
    expect(mocks.uploadStream).not.toHaveBeenCalled();
    await app.close();
  });

  it('names the real ceiling in the message, so the client can say what to do', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/videos/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody(5 * GIB),
    });

    const body = res.json<{ message: string }>();
    expect(body.message).toMatch(/2\.0 GB/);
    expect(body.message).not.toMatch(/10\.0 GB/);
    await app.close();
  });

  it('rejects on the declared envelope size before reading a single part', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/videos/upload`,
      headers: {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
        'content-length': String(9 * GIB),
      },
      payload: multipartBody(32),
    });

    expect(res.statusCode).toBe(413);
    expect(mocks.uploadStream).not.toHaveBeenCalled();
    await app.close();
  });

  it('still accepts an upload inside the ceiling', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${PROJECT_ID}/videos/upload`,
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody(EXPECTED_CEILING - 1),
    });

    expect(res.statusCode).toBe(201);
    expect(mocks.uploadStream).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
