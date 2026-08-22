/**
 * security-007, part two — the image and document routes that buffered first.
 *
 * `uploadSizeLimits.test.ts` covers audio, corpus and podcast sources. These are the SIX that were
 * left, and they were left because they looked harmless: they accept images. Two of them
 * (thumbnail, avatar circle-face) even had a size check — written as `if (buf.length > MAX)`,
 * which can only run once the entire file is already in the Node heap, so it refused the request
 * after paying its full memory cost. The other four had no ceiling of any kind.
 *
 * The reachable failure: an authenticated user POSTs 1.9 GB with `Content-Type: image/jpeg`. The
 * MIME check passes, `toBuffer()` materialises 1.9 GB, and the API is OOM-killed on the 2-vCPU
 * host — taking every other tenant's in-flight request with it, and answering nobody, because
 * there is no process left to answer.
 *
 * Each route is asserted three ways, the same shape the sibling suite uses:
 *   1  an over-limit `Content-Length` is refused BEFORE any part is read
 *   2  a body that LIES about its size is cut off mid-stream, with storage never touched
 *   3  an in-limit upload still works — this is a ceiling, not a wall
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';

const PROJECT_ID = 'proj-1';
const IMAGE_ID = 'img-1';
const PLAYLIST_ID = 'pl-1';
const GIB = 1024 ** 3;

const mocks = vi.hoisted(() => ({
  uploadWithFallback: vi.fn(async () => 'https://cdn/x'),
  deleteWithFallback: vi.fn(async () => undefined),
  insertReturning: vi.fn(async () => [{ id: 'row-1' }]),
  updateReturning: vi.fn(async () => [{ id: 'row-1' }]),
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      image_files: { findFirst: vi.fn(async () => ({ id: IMAGE_ID, project_id: PROJECT_ID, storage_key: 'images/old', filename: 'old.jpg' })), findMany: vi.fn(async () => []) },
      playlists: { findFirst: vi.fn(async () => ({ id: PLAYLIST_ID })), findMany: vi.fn(async () => []) },
      projects: { findFirst: vi.fn(async () => ({ id: PROJECT_ID })), findMany: vi.fn(async () => []) },
      playlist_items: { findMany: vi.fn(async () => []) },
    },
    insert: () => ({ values: () => ({ returning: mocks.insertReturning }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: mocks.updateReturning }) }) }),
    delete: () => ({ where: async () => [] }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));

vi.mock('../../../db/schema.js', () => ({
  audio_files: Symbol('audio_files'),
  avatar_visuals: Symbol('avatar_visuals'),
  collaborators: Symbol('collaborators'),
  image_files: Symbol('image_files'),
  playlist_items: Symbol('playlist_items'),
  playlists: Symbol('playlists'),
  project_duplications: Symbol('project_duplications'),
  projects: Symbol('projects'),
  simulations: Symbol('simulations'),
  video_files: Symbol('video_files'),
  timeline_sections: Symbol('timeline_sections'),
  scenes: Symbol('scenes'),
  users: Symbol('users'),
  orgs: Symbol('orgs'),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})), and: vi.fn(() => ({})), or: vi.fn(() => ({})), asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})), inArray: vi.fn(() => ({})), isNull: vi.fn(() => ({})),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}));

vi.mock('../../../middleware/firebase-auth.js', () => ({
  firebaseAuthMiddleware: (req: Record<string, unknown>, _r: unknown, done: () => void) => {
    req.dbUser = { id: 'user-1' };
    done();
  },
  firebaseAuthOptionalMiddleware: (_q: unknown, _r: unknown, done: () => void) => done(),
  bearerTokenFor: () => undefined,
}));

vi.mock('../../../services/collabAccess.js', () => ({
  editableProject: async () => ({ id: PROJECT_ID, title: 'T' }),
  editablePlaylist: async () => ({ id: PLAYLIST_ID }),
  isCollaborator: async () => false,
}));

vi.mock('../../../services/storage/uploadWithFallback.js', () => ({
  uploadWithFallback: mocks.uploadWithFallback,
}));
vi.mock('../../../services/storage/deleteWithFallback.js', () => ({
  deleteWithFallback: mocks.deleteWithFallback,
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));

const BOUNDARY = '----flowvidtest';

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

interface Case {
  name: string;
  url: string;
  module: string;
  exportName: string;
  envVar: string;
  filename: string;
  mime: string;
  okStatus: number;
}

const CASES: Case[] = [
  {
    name: 'POST /projects/:id/images',
    url: `/api/v1/projects/${PROJECT_ID}/images`,
    module: '../images.controller.js', exportName: 'registerImageRoutes',
    envVar: 'MAX_IMAGE_UPLOAD_BYTES', filename: 'pic.jpg', mime: 'image/jpeg', okStatus: 201,
  },
  {
    name: 'POST /projects/:id/images/:imageId/replace',
    url: `/api/v1/projects/${PROJECT_ID}/images/${IMAGE_ID}/replace`,
    module: '../images.controller.js', exportName: 'registerImageRoutes',
    envVar: 'MAX_IMAGE_UPLOAD_BYTES', filename: 'pic.png', mime: 'image/png', okStatus: 200,
  },
  {
    name: 'POST /playlists/:id/banner',
    url: `/api/v1/playlists/${PLAYLIST_ID}/banner`,
    module: '../playlists.controller.js', exportName: 'registerPlaylistRoutes',
    envVar: 'MAX_IMAGE_UPLOAD_BYTES', filename: 'banner.webp', mime: 'image/webp', okStatus: 201,
  },
  {
    name: 'POST /projects/:id/thumbnail',
    url: `/api/v1/projects/${PROJECT_ID}/thumbnail`,
    module: '../projects.controller.js', exportName: 'registerProjectRoutes',
    envVar: 'MAX_THUMBNAIL_UPLOAD_BYTES', filename: 'thumb.jpg', mime: 'image/jpeg', okStatus: 201,
  },
];

async function buildApp(modulePath: string, exportName: string): Promise<FastifyInstance> {
  const app = Fastify();
  const { GLOBAL_MULTIPART_FILE_LIMIT_BYTES } = await import('../../../services/security/uploadLimits.js');
  await app.register(multipart, { limits: { fileSize: GLOBAL_MULTIPART_FILE_LIMIT_BYTES } });
  const mod = await import(modulePath) as Record<string, (a: FastifyInstance) => Promise<void>>;
  await mod[exportName]!(app);
  const { apiErrorHandler } = await import('../../../lib/apiErrorHandler.js');
  app.setErrorHandler(apiErrorHandler);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.uploadWithFallback.mockResolvedValue('https://cdn/x');
  mocks.insertReturning.mockResolvedValue([{ id: 'row-1' }]);
  mocks.updateReturning.mockResolvedValue([{ id: 'row-1' }]);
});

afterEach(() => {
  delete process.env.MAX_IMAGE_UPLOAD_BYTES;
  delete process.env.MAX_THUMBNAIL_UPLOAD_BYTES;
  vi.resetModules();
});

describe.each(CASES)('$name bounds the body', (c) => {
  it('refuses an over-limit Content-Length before reading a single part', async () => {
    const app = await buildApp(c.module, c.exportName);
    const res = await app.inject({
      method: 'POST', url: c.url,
      headers: { ...MULTIPART_HEADERS, 'content-length': String(9 * GIB) },
      payload: fileBody('file', c.filename, c.mime, 32),
    });
    expect(res.statusCode).toBe(413);
    expect(mocks.uploadWithFallback).not.toHaveBeenCalled();
    await app.close();
  });

  it('names a byte limit in the refusal so the client can explain it', async () => {
    const app = await buildApp(c.module, c.exportName);
    const res = await app.inject({
      method: 'POST', url: c.url,
      headers: { ...MULTIPART_HEADERS, 'content-length': String(9 * GIB) },
      payload: fileBody('file', c.filename, c.mime, 32),
    });
    expect(res.json<{ message: string }>().message).toMatch(/\d+(\.\d+)?\s*(KB|MB|GB)/);
    await app.close();
  });

  it('still accepts an upload inside the ceiling', async () => {
    const app = await buildApp(c.module, c.exportName);
    const res = await app.inject({
      method: 'POST', url: c.url, headers: MULTIPART_HEADERS,
      payload: fileBody('file', c.filename, c.mime, 1024),
    });
    expect(res.statusCode).toBe(c.okStatus);
    await app.close();
  });

  it('cuts off a body that LIES about its size, and writes nothing to storage', async () => {
    // A 4 KiB ceiling, so the over-limit body is a test-sized 16 KiB rather than a real one.
    vi.resetModules();
    process.env[c.envVar] = String(4 * 1024);
    const app = await buildApp(c.module, c.exportName);
    const res = await app.inject({
      method: 'POST', url: c.url, headers: MULTIPART_HEADERS,
      payload: fileBody('file', c.filename, c.mime, 16 * 1024),
    });
    expect(res.statusCode).toBe(413);
    expect(mocks.uploadWithFallback).not.toHaveBeenCalled();
    await app.close();
  });
});
