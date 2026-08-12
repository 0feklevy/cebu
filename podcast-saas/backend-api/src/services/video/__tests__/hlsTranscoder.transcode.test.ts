/**
 * transcodeToHLS with ffmpeg/ffprobe FAKED at the spawn boundary (P0.2 / P1.7a).
 *
 * What this proves that the pure-unit file cannot:
 *  - the conformance gate runs per tier BEFORE anything of that tier (or the master) is
 *    uploaded, and a violation rejects the whole transcode;
 *  - the master playlist's CODECS is assembled from what ffprobe OBSERVED in the emitted
 *    segments, per tier — not from a hard-coded string;
 *  - every object of the versioned run tree (segments, variant playlists, master) is
 *    uploaded with the immutable Cache-Control;
 *  - the probed input fps actually drives the ffmpeg GOP arguments.
 *
 * The fake ffmpeg writes real files into the real workDir (uploadDir and the gate read the
 * filesystem); the fake ffprobe answers from a per-test fixture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  // (key, data, contentType, cacheControl) — typed loose so assertions can index any arg.
  upload: vi.fn(async (...args: unknown[]) => `https://cdn.test/${args[0] as string}`),
}));

vi.mock('child_process', () => ({ spawn: h.spawn }));
vi.mock('../../storage/uploadWithFallback.js', () => ({ uploadWithFallback: h.upload }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { transcodeToHLS } from '../HLSTranscoder.js';
import { HLS_IMMUTABLE_CACHE_CONTROL } from '../hlsVersioning.js';

// ── The fixture the fake ffprobe answers from ────────────────────────────────────────────
const MATRIX: Record<string, { profile: string; level: number }> = {
  '360p': { profile: 'Constrained Baseline', level: 30 },
  '480p': { profile: 'Main', level: 31 },
  '720p': { profile: 'Main', level: 31 },
  '1080p': { profile: 'High', level: 40 },
};

let fx: {
  avgFrameRate: string;
  rFrameRate: string;
  duration: string;
  profiles: Record<string, { profile: string; level: number }>;
  keyframe: Record<string, number>;         // first-frame key_frame per tier, default 1
  extinfs: Record<string, string[]>;        // playlist EXTINF durations per tier
};

const DEFAULT_EXTINFS = ['4.000000', '4.000000', '1.500000'];

const tierOf = (path: string): string => {
  const m = path.match(/(360p|480p|720p|1080p)/);
  if (!m) throw new Error(`fake ffprobe/ffmpeg: no tier in path ${path}`);
  return m[1]!;
};

const playlistText = (extinfs: string[]): string =>
  [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    ...extinfs.flatMap((e, i) => [`#EXTINF:${e},`, `seg_${String(i).padStart(3, '0')}.ts`]),
    '#EXT-X-ENDLIST',
  ].join('\n') + '\n';

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

/** What the fake ffprobe prints for a given arg list. */
function probePayload(args: string[]): unknown {
  const target = args[args.length - 1]!;
  if (args.includes('-show_frames')) {
    return { frames: [{ key_frame: fx.keyframe[tierOf(target)] ?? 1 }] };
  }
  if (args.includes('-show_format')) {
    return {
      format: { duration: fx.duration },
      streams: [{ avg_frame_rate: fx.avgFrameRate, r_frame_rate: fx.rFrameRate }],
    };
  }
  if (args.includes('-show_streams')) {
    const tier = tierOf(target);
    return { streams: [fx.profiles[tier] ?? MATRIX[tier]] };
  }
  throw new Error(`fake ffprobe: unrecognised args ${args.join(' ')}`);
}

/** The fake ffmpeg encode: writes the segments + playlist the real one would emit. */
async function fakeEncode(args: string[]): Promise<void> {
  const segIdx = args.indexOf('-hls_segment_filename');
  if (segIdx < 0) throw new Error('fake ffmpeg: no -hls_segment_filename');
  const segPattern = args[segIdx + 1]!;
  const playlistPath = args[args.length - 1]!;
  const extinfs = fx.extinfs[tierOf(segPattern)] ?? DEFAULT_EXTINFS;
  for (let i = 0; i < extinfs.length; i++) {
    await writeFile(segPattern.replace('%03d', String(i).padStart(3, '0')), `ts-${i}`);
  }
  await writeFile(playlistPath, playlistText(extinfs));
}

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'hls-test-'));
  fx = {
    avgFrameRate: '30/1',
    rFrameRate: '30/1',
    duration: '10.000000',
    profiles: { ...MATRIX },
    keyframe: {},
    extinfs: {},
  };
  h.spawn.mockReset();
  h.upload.mockClear();
  h.spawn.mockImplementation((bin: string, args: string[]) => {
    const proc = new FakeProc();
    void (async () => {
      // Defer past the Promise executor so the caller's listeners are attached first.
      await new Promise((r) => setImmediate(r));
      try {
        if (bin === 'ffmpeg') {
          await fakeEncode(args);
        } else if (bin === 'ffprobe') {
          proc.stdout.emit('data', Buffer.from(JSON.stringify(probePayload(args))));
        } else {
          throw new Error(`fake spawn: unexpected binary ${bin}`);
        }
        proc.emit('close', 0);
      } catch (err) {
        proc.emit('error', err);
      }
    })();
    return proc;
  });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const PREFIX = 'hls/vf1/run1';

function run(hooks: Partial<Parameters<typeof transcodeToHLS>[0]> = {}) {
  return transcodeToHLS({
    inputPath: join(workDir, 'source.mp4'),
    workDir,
    storageKeyPrefix: PREFIX,
    storage: {} as never, // uploads go through the mocked uploadWithFallback
    ...hooks,
  });
}

const uploadedKeys = () => h.upload.mock.calls.map((c) => c[0] as string);

describe('transcodeToHLS (fake ffmpeg/ffprobe)', () => {
  it('uploads the whole versioned run tree with the immutable Cache-Control, master included', async () => {
    const result = await run();
    expect(result).toEqual({ masterKey: `${PREFIX}/master.m3u8`, durationSec: 10 });

    // 4 tiers × (3 segments + index.m3u8) + master = 17 objects.
    expect(h.upload).toHaveBeenCalledTimes(17);
    for (const call of h.upload.mock.calls) {
      expect(call[3], `cacheControl for ${call[0]}`).toBe(HLS_IMMUTABLE_CACHE_CONTROL);
    }
    // Content types still split by extension.
    for (const call of h.upload.mock.calls) {
      const key = call[0] as string;
      expect(call[2]).toBe(key.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    }
    expect(uploadedKeys()).toContain(`${PREFIX}/360p/seg_000.ts`);
    expect(uploadedKeys()).toContain(`${PREFIX}/1080p/index.m3u8`);
  });

  it('builds the master CODECS per tier from the PROBED profile/level, not a hard-coded string', async () => {
    await run();
    const masterCall = h.upload.mock.calls.find((c) => c[0] === `${PREFIX}/master.m3u8`)!;
    const master = (masterCall[1] as Buffer).toString('utf8');
    const streamInf = master.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF'));
    expect(streamInf).toEqual([
      '#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"',
      '#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
      '#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"',
    ]);
    // The variant URIs are untouched.
    expect(master).toContain('360p/index.m3u8');
    expect(master).toContain('1080p/index.m3u8');
  });

  it('passes the probed fps into the encode: 23.976 input → -g/-keyint_min 96', async () => {
    fx.avgFrameRate = '24000/1001';
    fx.rFrameRate = '24000/1001';
    await run();
    const ffmpegCalls = h.spawn.mock.calls.filter((c) => c[0] === 'ffmpeg');
    expect(ffmpegCalls).toHaveLength(4);
    for (const [, args] of ffmpegCalls) {
      const a = args as string[];
      expect(a[a.indexOf('-g') + 1]).toBe('96');
      expect(a[a.indexOf('-keyint_min') + 1]).toBe('96');
      expect(a[a.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*4)');
      expect(a[a.indexOf('-hls_time') + 1]).toBe('4');
    }
  });

  it('falls back to 30 fps GOP maths when ffprobe cannot name a rate (0/0)', async () => {
    fx.avgFrameRate = '0/0';
    fx.rFrameRate = '0/0';
    await run();
    const [, args] = h.spawn.mock.calls.find((c) => c[0] === 'ffmpeg')!;
    const a = args as string[];
    expect(a[a.indexOf('-g') + 1]).toBe('120');
  });

  it('gate (i): a tier probing back the wrong profile/level rejects BEFORE any upload', async () => {
    fx.profiles['360p'] = { profile: 'Main', level: 31 }; // encoder disobeyed the matrix
    const onTierComplete = vi.fn(async () => {});
    await expect(run({ onTierComplete })).rejects.toThrow(
      /HLS conformance \(360p\): encoded as Main@L31 but the tier matrix requires baseline@L30/,
    );
    expect(h.upload).not.toHaveBeenCalled();      // gate runs before the tier uploads
    expect(onTierComplete).not.toHaveBeenCalled(); // and before the tier is reported done
  });

  it('gate (ii): a segment whose first frame is not a keyframe rejects the transcode', async () => {
    fx.keyframe['480p'] = 0;
    await expect(run()).rejects.toThrow(/HLS conformance \(480p\).*not a keyframe/);
    // 360p passed and uploaded (3 segs + index); nothing of 480p+, and NO master.
    const keys = uploadedKeys();
    expect(keys).toHaveLength(4);
    expect(keys.every((k) => k.startsWith(`${PREFIX}/360p/`))).toBe(true);
    expect(keys.some((k) => k.endsWith('master.m3u8'))).toBe(false);
  });

  it('gate (iii): an 8.333s segment in the tier playlist rejects the transcode', async () => {
    fx.extinfs['720p'] = ['4.000000', '8.333333', '4.000000'];
    await expect(run()).rejects.toThrow(/HLS conformance \(720p\).*exceed 4\.5s.*8\.333333/s);
    expect(uploadedKeys().some((k) => k.endsWith('master.m3u8'))).toBe(false);
  });

  it('reports tier lifecycle in order and only for conformant tiers', async () => {
    const events: string[] = [];
    await run({
      onTierStart: async (t) => { events.push(`start:${t}`); },
      onTierComplete: async (t, key) => { events.push(`done:${t}:${key}`); },
    });
    expect(events).toEqual([
      'start:360p', `done:360p:${PREFIX}/360p/index.m3u8`,
      'start:480p', `done:480p:${PREFIX}/480p/index.m3u8`,
      'start:720p', `done:720p:${PREFIX}/720p/index.m3u8`,
      'start:1080p', `done:1080p:${PREFIX}/1080p/index.m3u8`,
    ]);
  });
});
