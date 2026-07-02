import { describe, it, expect, vi, beforeEach } from 'vitest';

// Regression test for backend-201 (item 12): auto title/description must be (re)triggered from
// the CAPTION completion path — after captions_vtt is written — not from the transcode path
// (which ran before captions landed, so the transcript was ignored). Trigger fires on both
// caption success (with captions_vtt available) and caption failure (frame/filename fallback).

const mocks = vi.hoisted(() => {
  const setCalls: Array<Record<string, unknown>> = [];
  return {
    setCalls,
    videoFindFirst: vi.fn(),
    mockUpdateReturning: vi.fn(async () => [{ id: 'vid-1' }]),
    // .where() returns a thenable (for updates awaited directly) that ALSO exposes .returning()
    // (for the claim update that reads back whether it won).
    mockUpdateWhere: vi.fn(() => {
      const p = Promise.resolve([{ id: 'vid-1' }]) as Promise<unknown> & { returning: unknown };
      p.returning = mocks.mockUpdateReturning;
      return p;
    }),
    order: [] as string[],
    mockUpdateSet: vi.fn((arg: Record<string, unknown>) => {
      setCalls.push(arg);
      if (arg.captions_status === 'ready') mocks.order.push('writeCaptionsVtt');
      return { where: mocks.mockUpdateWhere };
    }),
    mockUpdate: vi.fn(() => ({ set: mocks.mockUpdateSet })),
    enqueueVideoMetadata: vi.fn(),
    propagateTranscript: vi.fn(),
    transcribe: vi.fn(),
  };
});

vi.mock('../../../db/index.js', () => ({
  db: {
    query: { video_files: { findFirst: mocks.videoFindFirst } },
    update: mocks.mockUpdate,
  },
}));

vi.mock('../../../db/schema.js', () => ({ video_files: Symbol('video_files') }));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
  and: vi.fn(() => ({ type: 'and' })),
  or: vi.fn(() => ({ type: 'or' })),
  ne: vi.fn(() => ({ type: 'ne' })),
  lt: vi.fn(() => ({ type: 'lt' })),
  isNull: vi.fn(() => ({ type: 'isNull' })),
}));

vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    getPresignedDownloadUrl: async () => 'https://cdn.example.com/raw.mp4?sig=x',
    getPublicUrl: (k: string) => `https://cdn.example.com/${k}`,
    uploadFile: async () => 'https://cdn.example.com/captions.vtt',
  }),
}));

vi.mock('../../transcriptPropagation.js', () => ({ propagateTranscript: mocks.propagateTranscript }));
vi.mock('../../ffmpegLimit.js', () => ({ runFfmpegLimited: <T>(fn: () => Promise<T>) => fn() }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../queue/index.js', () => ({ enqueueJob: vi.fn() }));

vi.mock('../../generateVideoMetadata.js', () => ({
  enqueueVideoMetadata: (...args: unknown[]) => {
    mocks.order.push('enqueueMetadata');
    return mocks.enqueueVideoMetadata(...args);
  },
}));

// fs/promises — no real audio file work; stat under the Groq size limit.
vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn(async () => '/tmp/captions-test'),
  rm: vi.fn(async () => undefined),
  readFile: vi.fn(async () => Buffer.from('fake-audio')),
  stat: vi.fn(async () => ({ size: 1024 })),
}));

// child_process.execFile — ffmpeg audio extraction is a no-op success.
vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: unknown, _opts: unknown, cb: (err: unknown) => void) => cb(null),
}));

// Groq transcription client.
vi.mock('groq-sdk', () => ({
  default: class {
    audio = { transcriptions: { create: mocks.transcribe } };
  },
}));

import { runCaptionJobNow } from '../CaptionService.js';

const VIDEO_ID = 'vid-1';
const PROJECT_ID = 'proj-1';

function fakeVideo(overrides: Record<string, unknown> = {}) {
  return {
    id: VIDEO_ID,
    project_id: PROJECT_ID,
    is_broll: false,
    storage_key: 'raw/proj-1/vid-1.mp4',
    file_size: 1000,
    duration_sec: 30,
    filename: 'clip.mp4',
    captions_status: 'none',
    captions_source_hash: null,
    captions_updated_at: null,
    hls_master_key: 'hls/proj-1/vid-1/master.m3u8',
    hls_360p_key: null,
    ...overrides,
  };
}

describe('caption completion triggers metadata (backend-201)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setCalls.length = 0;
    mocks.order.length = 0;
    process.env.GROQ_API_KEY = 'test-key';
  });

  it('on caption SUCCESS: writes captions_vtt then enqueues a (non-forced) metadata run', async () => {
    mocks.videoFindFirst.mockResolvedValue(fakeVideo());
    mocks.transcribe.mockResolvedValue({
      segments: [{ start: 0, end: 2, text: 'Hello world' }],
    });

    await runCaptionJobNow(VIDEO_ID);

    // Metadata was enqueued for the project + video, with no force flag (composes with the
    // description-overwrite guard from item 4).
    expect(mocks.enqueueVideoMetadata).toHaveBeenCalledWith(PROJECT_ID, VIDEO_ID);
    // The ready update carried the transcript, and (per code structure) the enqueue happens
    // after it — so the metadata run finds captions_vtt available.
    const readySet = mocks.setCalls.find((s) => s.captions_status === 'ready');
    expect(readySet?.captions_vtt).toContain('WEBVTT');
    expect(readySet?.captions_vtt).toContain('Hello world');
    // Ordering: captions_vtt persisted before the metadata enqueue fired.
    expect(mocks.order).toEqual(['writeCaptionsVtt', 'enqueueMetadata']);
  });

  it('on caption FAILURE: still enqueues a metadata run (frame/filename fallback)', async () => {
    mocks.videoFindFirst.mockResolvedValue(fakeVideo());
    // Transcription throws → job hits the failure path.
    mocks.transcribe.mockRejectedValue(new Error('groq exploded'));

    await runCaptionJobNow(VIDEO_ID);

    expect(mocks.enqueueVideoMetadata).toHaveBeenCalledWith(PROJECT_ID, VIDEO_ID);
    // A failed status was written.
    expect(mocks.setCalls.some((s) => s.captions_status === 'failed')).toBe(true);
  });
});
