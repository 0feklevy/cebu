import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for db-201 (tq-106): the auto (un-forced) post-transcode metadata run must
// NOT clobber a description (topic) the creator already typed, while an explicit force
// regenerate is allowed to overwrite it. Title stays guarded by its own !title check.

const mocks = vi.hoisted(() => ({
  mockProjects:   { findFirst: vi.fn() },
  mockVideoFiles: { findFirst: vi.fn() },
  mockUpdateWhere: vi.fn(async () => undefined),
  mockUpdateSet:   vi.fn(() => ({ where: mocks.mockUpdateWhere })),
  mockUpdate:      vi.fn(() => ({ set: mocks.mockUpdateSet })),
  // OpenAI chat completion returns this content string
  chatCreate: vi.fn(),
}));

vi.mock('../../db/index.js', () => ({
  db: {
    query: {
      projects: mocks.mockProjects,
      video_files: mocks.mockVideoFiles,
      // systemAi gate: not paused, no quota; no admin-managed key → env fallback
      admin_settings: { findFirst: async () => ({ generation_paused: false, generation_limit_enabled: false }) },
      api_keys: { findFirst: async () => null },
    },
    update: mocks.mockUpdate,
    // usage recording (recordChatUsage → token_usage insert)
    insert: vi.fn(() => ({ values: async () => undefined })),
  },
}));

vi.mock('../../db/schema.js', () => ({
  projects: Symbol('projects'),
  video_files: Symbol('video_files'),
  admin_settings: Symbol('admin_settings'),
  api_keys: { provider: 'provider', user_id: 'user_id' },
  token_usage: { user_id: 'user_id', occurred_at: 'occurred_at', task: 'task' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, _val: unknown) => ({ type: 'eq' })),
  ne: vi.fn(() => ({ type: 'ne' })),
  and: vi.fn(() => ({ type: 'and' })),
  gte: vi.fn(() => ({ type: 'gte' })),
  isNull: vi.fn(() => ({ type: 'isNull' })),
  sql: vi.fn(() => ({ type: 'sql' })),
}));

// Run the ffmpeg-limited work inline (no real ffmpeg is spawned — see child_process mock).
vi.mock('../ffmpegLimit.js', () => ({
  runFfmpegLimited: <T>(fn: () => Promise<T>) => fn(),
}));

// Fake ffmpeg: immediately "close" with code 0 so extractFrame resolves.
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const proc = {
      stderr: { on: () => {} },
      on: (evt: string, cb: (arg?: unknown) => void) => { handlers[evt] = cb; return proc; },
    };
    // Fire close(0) on next tick after handlers are registered.
    setTimeout(() => handlers.close?.(0), 0);
    return proc;
  }),
}));

vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/vmeta-test'),
  rm:      vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from('fake-jpeg')),
}));

vi.mock('../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPublicUrl: (k: string) => `https://cdn.example.com/${k}`,
    getPresignedDownloadUrl: async (k: string) => `https://cdn.example.com/${k}?sig=x`,
    uploadFile: async () => 'https://cdn.example.com/thumb.jpg',
  }),
}));

vi.mock('../storage/LocalStorageAdapter.js', () => ({
  LocalStorageAdapter: class {
    async uploadFile() { return 'file:///local/thumb.jpg'; }
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../queue/index.js', () => ({ enqueueJob: vi.fn() }));

// Mock the OpenAI client so generateTitleAndDescription returns controlled JSON.
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: mocks.chatCreate } };
  },
}));

import { generateVideoMetadata } from '../generateVideoMetadata.js';

const PROJECT_ID = 'proj-1';
const VIDEO_ID = 'vid-1';

const AI_TITLE = 'AI Generated Title';
const AI_DESC = 'An AI generated description of the video.';

function fakeVideo() {
  return {
    id: VIDEO_ID,
    project_id: PROJECT_ID,
    storage_key: 'raw/proj-1/vid-1.mp4',
    hls_status: 'ready',
    hls_master_key: 'hls/proj-1/vid-1/master.m3u8',
    hls_360p_key: null,
    duration_sec: 60,
    filename: 'my-video.mp4',
    captions_vtt: 'WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nHello world\n',
  };
}

/** Grab the .set(...) argument of the final "persist" update (the one that includes topic/title). */
function lastPersistSetArg(): Record<string, unknown> {
  const calls = mocks.mockUpdateSet.mock.calls.map((c) => c[0] as Record<string, unknown>);
  // The persist update sets metadata_status:'ready'. (The first update sets it to 'processing'.)
  const persist = calls.find((a) => a.metadata_status === 'ready');
  return persist ?? {};
}

describe('generateVideoMetadata — description (topic) overwrite guard (db-201)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = 'test-key';
    mocks.mockUpdateWhere.mockImplementation(async () => undefined);
    mocks.mockUpdateSet.mockImplementation(() => ({ where: mocks.mockUpdateWhere }));
    mocks.mockUpdate.mockImplementation(() => ({ set: mocks.mockUpdateSet }));
    mocks.mockVideoFiles.findFirst.mockResolvedValue(fakeVideo());
    mocks.chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ title: AI_TITLE, description: AI_DESC }) } }],
    });
  });

  it('does NOT overwrite a user-set description on the un-forced auto run', async () => {
    mocks.mockProjects.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      metadata_status: 'none',
      title: null,
      topic: 'My hand-typed description',
      thumbnail_url: null,
    });

    await generateVideoMetadata(PROJECT_ID, VIDEO_ID, { force: false });

    const setArg = lastPersistSetArg();
    // Title was empty → AI title applied.
    expect(setArg.title).toBe(AI_TITLE);
    // Description was user-set and not forced → the user's own text is preserved,
    // NOT replaced by the AI description.
    expect(setArg.topic).toBe('My hand-typed description');
    expect(setArg.topic).not.toBe(AI_DESC);
  });

  it('DOES overwrite a user-set description on an explicit force regenerate', async () => {
    mocks.mockProjects.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      metadata_status: 'none',
      title: 'User Title',
      topic: 'My hand-typed description',
      thumbnail_url: null,
    });

    await generateVideoMetadata(PROJECT_ID, VIDEO_ID, { force: true });

    const setArg = lastPersistSetArg();
    // force → AI description overwrites the user's topic.
    expect(setArg.topic).toBe(AI_DESC);
  });

  it('fills the description from AI when the user has not set one (auto run)', async () => {
    mocks.mockProjects.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      metadata_status: 'none',
      title: null,
      topic: null,
      thumbnail_url: null,
    });

    await generateVideoMetadata(PROJECT_ID, VIDEO_ID, { force: false });

    const setArg = lastPersistSetArg();
    expect(setArg.topic).toBe(AI_DESC);
    expect(setArg.title).toBe(AI_TITLE);
  });
});
