/**
 * P3-B / A2.1 — the service, whose interesting behaviour is all about NOT doing work.
 *
 * Building the file is one ffmpeg call. Deciding whether to build it at all is where this feature
 * either costs nothing or costs something on every page load, and where a crashed worker either
 * recovers or leaves a creator pressing a button that silently does nothing forever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Rows the fake database hands back, and the writes it received. */
const state = {
  project: { id: 'p1' } as Record<string, unknown> | undefined,
  videos: [] as Array<Record<string, unknown>>,
  sections: [] as Array<Record<string, unknown>>,
  edition: undefined as Record<string, unknown> | undefined,
  /** Rows a claiming UPDATE/INSERT is allowed to return — empty means "someone else has it". */
  claimReturns: [{ id: 'ed1' }] as Array<{ id: string }>,
  updates: [] as Array<Record<string, unknown>>,
  inserted: [] as Array<Record<string, unknown>>,
  ffmpegCalls: 0,
  /** When set, the fake ffmpeg throws this instead of writing a file. */
  ffmpegError: null as string | null,
  uploaded: [] as string[],
};

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      projects: { findFirst: async () => state.project },
      video_files: { findMany: async () => state.videos },
      timeline_sections: { findMany: async () => state.sections },
      project_audio_editions: { findFirst: async () => state.edition },
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          state.updates.push(patch);
          return { returning: async () => (patch.status === 'processing' ? state.claimReturns : [{ id: 'ed1' }]) };
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserted.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => state.claimReturns }) };
      },
    }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  project_audio_editions: { id: 'id', project_id: 'project_id', language: 'language', claimed_at: 'claimed_at' },
  projects: { id: 'id' },
  timeline_sections: { project_id: 'project_id' },
  video_files: { project_id: 'project_id', is_broll: 'is_broll' },
}));
vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => ({})), eq: vi.fn(() => ({})), isNull: vi.fn(() => ({})),
  sql: Object.assign(vi.fn(() => ({})), { raw: vi.fn() }),
}));
const loggerWarn = vi.fn();
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => loggerWarn(...a), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../storage/getStorageAdapter.js', () => ({
  getStorageAdapter: () => ({
    readObject: async () => Buffer.from('audio'),
    uploadFile: async (key: string) => { state.uploaded.push(key); return key; },
  }),
}));
vi.mock('../audioEditionBuilder.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // The ffmpeg call itself is not exercised here; that it is CALLED, and how often, is the point.
  //
  // It still WRITES the output file, because the service reads that file back to upload it. A
  // fake that skipped the write turned every build into an ENOENT failure — which is a fake
  // testing itself, and would have made all nine assertions below meaningless while looking busy.
  joinToM4a: async (_inputs: unknown, outPath: string) => {
    state.ffmpegCalls += 1;
    if (state.ffmpegError) throw new Error(state.ffmpegError);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outPath, Buffer.from('m4a'));
  },
  probeDurationMs: async () => 10_000,
}));

const { buildAudioEdition } = await import('../AudioEditionService.js');

const video = (over: Record<string, unknown> = {}) =>
  ({ storage_key: 'k1', duration_sec: 10, captions_vtt: null, ...over });

beforeEach(() => {
  state.project = { id: 'p1' };
  state.videos = [video()];
  state.sections = [];
  state.edition = undefined;
  state.claimReturns = [{ id: 'ed1' }];
  state.updates = [];
  state.inserted = [];
  state.ffmpegCalls = 0;
  state.ffmpegError = null;
  state.uploaded = [];
  loggerWarn.mockClear();
});

describe('not building what is already built', () => {
  it('skips when the source hash still matches a ready edition', async () => {
    // Build once to learn the hash this project produces, then present it as already stored.
    const first = await buildAudioEdition('p1');
    expect(first.status, JSON.stringify(first)).toBe('ready');
    const hash = state.updates.find((u) => u.status === 'ready')?.source_hash as string;
    expect(hash, 'the build recorded no source hash').toBeTruthy();

    // Reset the RECORD of the first build before asserting on the second — otherwise the first
    // build's own writes are still sitting in `updates` and the assertion below reads them as
    // the skip's, which would fail a correct implementation.
    state.ffmpegCalls = 0;
    state.updates = [];
    state.edition = { id: 'ed1', status: 'ready', source_hash: hash };
    const second = await buildAudioEdition('p1');

    expect(second.status).toBe('skipped');
    // The expensive-side proof: it never ran ffmpeg AND it never touched the row.
    expect(state.ffmpegCalls, 'a matching edition was rebuilt anyway').toBe(0);
    expect(state.updates, 'a skip still wrote to the row').toEqual([]);
  });

  it('rebuilds when the project has changed underneath it', async () => {
    state.edition = { id: 'ed1', status: 'ready', source_hash: 'a-hash-from-an-older-version' };
    const r = await buildAudioEdition('p1');
    expect(r.status).toBe('ready');
    expect(state.ffmpegCalls).toBe(1);
  });

  it('rebuilds on an explicit force even when the hash matches', async () => {
    const first = await buildAudioEdition('p1');
    const hash = state.updates.find((u) => u.status === 'ready')?.source_hash as string;
    expect(first.status).toBe('ready');

    state.ffmpegCalls = 0;
    state.edition = { id: 'ed1', status: 'ready', source_hash: hash };
    const r = await buildAudioEdition('p1', null, { force: true });
    expect(r.status).toBe('ready');
    expect(state.ffmpegCalls, 'force did not force anything').toBe(1);
  });

  it('rebuilds a FAILED edition whose hash still matches', async () => {
    // The hash says the inputs are unchanged, and they are — what changed is that last time it
    // broke. Treating a failed row as current would make the failure permanent, and the creator's
    // regenerate button a no-op with no explanation.
    const first = await buildAudioEdition('p1');
    const hash = state.updates.find((u) => u.status === 'ready')?.source_hash as string;
    expect(first.status).toBe('ready');

    state.ffmpegCalls = 0;
    state.edition = { id: 'ed1', status: 'failed', source_hash: hash };
    expect((await buildAudioEdition('p1')).status).toBe('ready');
    expect(state.ffmpegCalls).toBe(1);
  });
});

describe('two workers, one edition', () => {
  it('yields rather than building a second copy when the claim is lost', async () => {
    // Both would upload, both would write the row, and the loser's object would sit in the bucket
    // with nothing pointing at it — paid for, unreachable, and invisible.
    state.claimReturns = [];
    const r = await buildAudioEdition('p1');
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/already building/i);
    expect(state.ffmpegCalls).toBe(0);
    expect(state.uploaded).toEqual([]);
  });

  it('creates the row on the first ever build', async () => {
    await buildAudioEdition('p1', 'he');
    expect(state.inserted[0]).toMatchObject({ project_id: 'p1', language: 'he', status: 'processing' });
  });

  it('claims before doing any work', async () => {
    // The order matters: claiming after the download would let two workers both download the whole
    // project before either discovered the other.
    //
    // With no existing row the claim is an INSERT, so the first WRITE of any kind is the one to
    // look at — not `updates[0]`, which in that path is the completion and made this assert
    // 'ready' against a perfectly correct implementation.
    await buildAudioEdition('p1');
    const firstWrite = state.inserted[0] ?? state.updates[0];
    expect(firstWrite?.status, 'the first write was not a claim').toBe('processing');
    expect(firstWrite?.claimed_at, 'a claim with no timestamp can never go stale').toBeInstanceOf(Date);
  });

  it('claims an EXISTING row by update rather than inserting a second one', async () => {
    state.edition = { id: 'ed1', status: 'failed', source_hash: 'stale' };
    await buildAudioEdition('p1');
    expect(state.inserted, 'a duplicate row was inserted for an edition that already exists').toEqual([]);
    expect(state.updates[0]?.status).toBe('processing');
  });
});

describe('refusing, without marking anything failed', () => {
  it('refuses a project with no media and writes nothing', async () => {
    state.videos = [];
    const r = await buildAudioEdition('p1');
    expect(r.status).toBe('refused');
    expect(r.reason).toMatch(/no media/i);
    // NOT `failed`. A refusal names something the creator can act on; a failure asks them to
    // report a bug, and would also stop the retry that succeeds once transcoding finishes.
    expect(state.updates, 'a refusal wrote a status to the row').toEqual([]);
    expect(state.inserted).toEqual([]);
  });

  it('refuses a project whose segments have no audio yet', async () => {
    state.videos = [video({ storage_key: null, duration_sec: 0 })];
    expect((await buildAudioEdition('p1')).status).toBe('refused');
  });

  it('refuses a project that no longer exists', async () => {
    state.project = undefined;
    const r = await buildAudioEdition('gone');
    expect(r.status).toBe('refused');
    expect(state.ffmpegCalls).toBe(0);
  });

  it('builds from the usable segments when only SOME are ready', async () => {
    // Refusing here would make a project permanently un-derivable for a transient reason, and the
    // edition is one cheap pass to rebuild once the rest lands.
    state.videos = [video(), video({ storage_key: null, duration_sec: 0 })];
    expect((await buildAudioEdition('p1')).status).toBe('ready');
    expect(state.ffmpegCalls).toBe(1);
  });
});

describe('when the build breaks', () => {
  it('releases the claim, so the next attempt does not wait out the stale horizon', async () => {
    // A row left claimed after a CLEAN failure is recoverable only by the twenty-minute horizon
    // that exists for crashed workers. The creator presses regenerate, nothing happens, and
    // nothing anywhere explains the wait — which is indistinguishable from the button being
    // broken. Dropping `claimed_at: null` from the failure path was a surviving mutation.
    state.ffmpegError = 'ffmpeg exited 1: Invalid data found when processing input';
    const r = await buildAudioEdition('p1');

    expect(r.status).toBe('failed');
    const failed = state.updates.find((u) => u.status === 'failed');
    expect(failed, 'the failure was never written to the row').toBeDefined();
    expect(failed?.claimed_at, 'the claim was held after a clean failure').toBeNull();
  });

  it('records the reason, truncated, where the creator can see it', async () => {
    state.ffmpegError = 'x'.repeat(2000);
    await buildAudioEdition('p1');
    const failed = state.updates.find((u) => u.status === 'failed');
    expect(String(failed?.error).length, 'an unbounded error message went into the row').toBeLessThanOrEqual(500);
    expect(failed?.error).toBeTruthy();
  });

  it('uploads nothing when the encode failed', async () => {
    // A half-written object under a hash-addressed key would be served forever as if it were the
    // finished edition, because the key says the inputs match.
    state.ffmpegError = 'boom';
    await buildAudioEdition('p1');
    expect(state.uploaded).toEqual([]);
  });
});

describe('what a finished edition records', () => {
  it('stores the artifact under the private prefix and records the measured duration', async () => {
    await buildAudioEdition('p1');
    const done = state.updates.find((u) => u.status === 'ready');
    expect(state.uploaded[0]).toMatch(/^editions\/p1\//);
    expect(done?.m4a_key).toBe(state.uploaded[0]);
    // 10_000 is what the probe MEASURED, and the segments sum to 10_000 too — so this assertion
    // alone cannot tell the two apart, and swapping measured for summed survived as a mutation.
    // The next test makes them disagree, which is the only way to see which one is recorded.
    expect(done?.duration_ms).toBe(10_000);
    expect(done?.claimed_at, 'the claim was not released').toBeNull();
    expect(done?.error).toBeNull();
  });

  it('records what the FILE contains, not what the segments claimed', async () => {
    // The segments sum to 20s; the finished file measures 10s. That gap is what a dropped segment
    // looks like, and recording the optimistic number would hide it behind a scrubber that runs
    // twice as long as the audio — which reads to a listener as the player being broken.
    state.videos = [video({ duration_sec: 10 }), video({ storage_key: 'k2', duration_sec: 10 })];
    await buildAudioEdition('p1');
    const done = state.updates.find((u) => u.status === 'ready');
    expect(done?.duration_ms, 'the summed duration was recorded instead of the measured one').toBe(10_000);
  });

  it('warns when the measured and expected durations disagree', async () => {
    // Recording the truth is not enough on its own — nothing looks at a duration column. The
    // discrepancy has to reach a log, or a systematically dropped segment is invisible forever.
    state.videos = [video({ duration_sec: 10 }), video({ storage_key: 'k2', duration_sec: 10 })];
    await buildAudioEdition('p1');
    expect(loggerWarn, 'a 50% duration shortfall produced no warning').toHaveBeenCalled();
  });

  it('derives chapters against the MEASURED duration, not the sections’ own idea of it', async () => {
    state.sections = [
      { start_sec: 0, end_sec: 5, label: 'One', type: 't', sort_order: 0 },
      { start_sec: 5, end_sec: 999, label: 'Two', type: 't', sort_order: 1 },
    ];
    await buildAudioEdition('p1');
    const chapters = state.updates.find((u) => u.status === 'ready')?.chapters_json as Array<{ endMs: number }>;
    // The last chapter ends where the AUDIO ends. A chapter running to 999s on a 10s file is a
    // scrubber the listener can drag into nothing.
    expect(chapters[chapters.length - 1].endMs).toBe(10_000);
  });

  it('stores no captions rather than an empty track', async () => {
    const done = state.updates.find((u) => u.status === 'ready');
    expect(done).toBeUndefined();
    await buildAudioEdition('p1');
    expect(state.updates.find((u) => u.status === 'ready')?.captions_vtt).toBeNull();
  });
});
