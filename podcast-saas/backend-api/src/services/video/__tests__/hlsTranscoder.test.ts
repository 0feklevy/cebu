/**
 * Pure units of the conformant HLS encode (P0.2): the per-tier ffmpeg argument builder and
 * its GOP maths, the profile→CODECS mapper the honest master playlist is built from, the
 * frame-rate parser behind the GOP maths, and the playlist-duration validator the
 * conformance gate runs. No ffmpeg is spawned anywhere in this file.
 */

import { describe, it, expect } from 'vitest';
import {
  TIERS,
  buildTierArgs,
  avc1CodecString,
  parseFrameRate,
  findPlaylistDurationViolations,
  DEFAULT_INPUT_FPS,
  SEGMENT_DURATION_TOLERANCE_SEC,
  type QualityTier,
  type TierEncodeContext,
} from '../HLSTranscoder.js';

const ctx = (fps: number): TierEncodeContext => ({
  fps,
  segmentSec: 4,
  inputPath: '/work/source.mp4',
  segmentPattern: '/work/360p/seg_%03d.ts',
  playlistPath: '/work/360p/index.m3u8',
});

/** value of a flag in an ffmpeg arg array */
const argOf = (args: string[], flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

describe('tier matrix', () => {
  it('gives each tier its own profile/level (no more blanket baseline@3.1)', () => {
    expect(TIERS.map((t) => [t.name, t.profile, t.level])).toEqual([
      ['360p', 'baseline', 30],
      ['480p', 'main', 31],
      ['720p', 'main', 31],
      ['1080p', 'high', 40],
    ]);
  });

  it('keeps resolutions, bitrates and bandwidths exactly as before', () => {
    expect(TIERS.map((t) => [t.name, t.width, t.height, t.videoBitrate, t.audioBitrate, t.bandwidth])).toEqual([
      ['360p', 640, 360, '500k', '96k', 700000],
      ['480p', 854, 480, '1000k', '128k', 1400000],
      ['720p', 1280, 720, '2800k', '128k', 3200000],
      ['1080p', 1920, 1080, '5500k', '192k', 6000000],
    ]);
  });
});

describe('buildTierArgs', () => {
  it('assembles the full 360p argument list (pinned end-to-end at 30 fps)', () => {
    const tier = TIERS[0]!;
    expect(buildTierArgs(tier, ctx(30))).toEqual([
      '-i', '/work/source.mp4',
      '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-profile:v', 'baseline',
      '-level', '3.0',
      '-g', '120',
      '-keyint_min', '120',
      '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*4)',
      '-flags', '+cgop',
      '-b:v', '500k',
      '-maxrate', '500k',
      '-bufsize', '1000k',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ar', '44100',
      '-hls_time', '4',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', '/work/360p/seg_%03d.ts',
      '/work/360p/index.m3u8',
    ]);
  });

  it('emits each tier\'s own profile and dotted level', () => {
    const got = TIERS.map((t) => {
      const args = buildTierArgs(t, ctx(30));
      return [t.name, argOf(args, '-profile:v'), argOf(args, '-level')];
    });
    expect(got).toEqual([
      ['360p', 'baseline', '3.0'],
      ['480p', 'main', '3.1'],
      ['720p', 'main', '3.1'],
      ['1080p', 'high', '4.0'],
    ]);
  });

  it('aligns the GOP to one segment: gop = round(fps * segmentSec)', () => {
    const tier = TIERS[1]!;
    const cases: Array<[number, string]> = [
      [30, '120'],
      [30000 / 1001, '120'],   // 29.97 → 119.88 → 120
      [24000 / 1001, '96'],    // 23.976 → 95.904 → 96
      [25, '100'],
      [60, '240'],
      [DEFAULT_INPUT_FPS, '120'],
    ];
    for (const [fps, gop] of cases) {
      const args = buildTierArgs(tier, ctx(fps));
      expect(argOf(args, '-g'), `fps=${fps}`).toBe(gop);
      expect(argOf(args, '-keyint_min'), `fps=${fps}`).toBe(gop);
    }
  });

  it('always disables scene-cut keyframes, forces the 4s cadence, and closes GOPs', () => {
    for (const tier of TIERS) {
      const args = buildTierArgs(tier, ctx(23.976));
      expect(argOf(args, '-sc_threshold')).toBe('0');
      expect(argOf(args, '-force_key_frames')).toBe('expr:gte(t,n_forced*4)');
      expect(argOf(args, '-flags')).toBe('+cgop');
      expect(argOf(args, '-hls_time')).toBe('4');
      expect(argOf(args, '-hls_playlist_type')).toBe('vod');
    }
  });

  it('keeps preset/bitrate/bufsize/audio exactly as before for every tier', () => {
    for (const tier of TIERS) {
      const args = buildTierArgs(tier, ctx(30));
      expect(argOf(args, '-preset')).toBe('fast');
      expect(argOf(args, '-b:v')).toBe(tier.videoBitrate);
      expect(argOf(args, '-maxrate')).toBe(tier.videoBitrate);
      expect(argOf(args, '-bufsize')).toBe(`${parseInt(tier.videoBitrate.replace('k', ''), 10) * 2}k`);
      expect(argOf(args, '-c:a')).toBe('aac');
      expect(argOf(args, '-b:a')).toBe(tier.audioBitrate);
      expect(argOf(args, '-ar')).toBe('44100');
    }
  });
});

describe('avc1CodecString', () => {
  it('maps the three profiles at their tier-matrix levels', () => {
    expect(avc1CodecString('Constrained Baseline', 30)).toBe('avc1.42e01e');
    expect(avc1CodecString('Baseline', 30)).toBe('avc1.42e01e');
    expect(avc1CodecString('Main', 31)).toBe('avc1.4d401f');
    expect(avc1CodecString('High', 40)).toBe('avc1.640028');
  });

  it('hex-encodes the level as exactly two lowercase digits', () => {
    expect(avc1CodecString('Main', 30)).toBe('avc1.4d401e');
    expect(avc1CodecString('High', 41)).toBe('avc1.640029');
    expect(avc1CodecString('Baseline', 9)).toBe('avc1.42e009'); // pads a single hex digit
  });

  it('throws on an unknown profile — the master must never carry a guessed CODECS', () => {
    expect(() => avc1CodecString('High 10', 40)).toThrow(/unsupported H\.264 profile/);
    expect(() => avc1CodecString('', 30)).toThrow(/unsupported H\.264 profile/);
  });

  it('throws on a level outside one byte', () => {
    expect(() => avc1CodecString('Main', 0)).toThrow(/level out of range/);
    expect(() => avc1CodecString('Main', 256)).toThrow(/level out of range/);
    expect(() => avc1CodecString('Main', 31.5)).toThrow(/level out of range/);
  });
});

describe('parseFrameRate', () => {
  it('parses plain and rational rates', () => {
    expect(parseFrameRate('30')).toBe(30);
    expect(parseFrameRate('25')).toBe(25);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('24000/1001')).toBeCloseTo(23.976, 3);
  });

  it('returns null for unknown/degenerate rates (ffprobe spells "unknown" as 0/0)', () => {
    expect(parseFrameRate('0/0')).toBeNull();
    expect(parseFrameRate('0')).toBeNull();
    expect(parseFrameRate('30/0')).toBeNull();
    expect(parseFrameRate('')).toBeNull();
    expect(parseFrameRate('abc')).toBeNull();
    expect(parseFrameRate('-30')).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
    expect(parseFrameRate(30 as unknown as string)).toBeNull(); // only strings, no coercion
  });
});

describe('findPlaylistDurationViolations', () => {
  const MAX = 4 + SEGMENT_DURATION_TOLERANCE_SEC; // 4.5, as the gate computes it

  const playlist = (extinfs: string[]): string =>
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      ...extinfs.flatMap((e, i) => [`#EXTINF:${e},`, `seg_${String(i).padStart(3, '0')}.ts`]),
      '#EXT-X-ENDLIST',
    ].join('\n') + '\n';

  it('accepts a conformant VOD playlist (all EXTINF at the target, short tail allowed)', () => {
    const text = playlist(['4.000000', '4.000000', '4.000000', '2.500000']);
    expect(findPlaylistDurationViolations(text, MAX)).toEqual([]);
  });

  it('accepts an EXTINF exactly at the tolerance bound (≤, not <)', () => {
    expect(findPlaylistDurationViolations(playlist(['4.500000']), MAX)).toEqual([]);
  });

  it('flags the 8.333s segment the old un-aligned encoder actually produced', () => {
    const text = playlist(['4.000000', '8.333333', '4.000000']);
    const violations = findPlaylistDurationViolations(text, MAX);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      line: 8, // 5 header lines, then EXTINF/seg pairs — the second pair's EXTINF
      extinf: '#EXTINF:8.333333,',
      durationSec: 8.333333,
    });
  });

  it('flags every violation, not just the first', () => {
    const text = playlist(['8.333333', '4.000000', '5.100000', '12.0']);
    const violations = findPlaylistDurationViolations(text, MAX);
    expect(violations.map((v) => v.durationSec)).toEqual([8.333333, 5.1, 12]);
  });

  it('treats an unparseable EXTINF as a violation (durationSec null), never as a pass', () => {
    const text = playlist(['abc', '4.000000']);
    const violations = findPlaylistDurationViolations(text, MAX);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.durationSec).toBeNull();
    expect(violations[0]!.extinf).toBe('#EXTINF:abc,');
  });

  it('ignores non-EXTINF lines, CRLF endings, and the EXTINF title field', () => {
    const text = '#EXTM3U\r\n#EXT-X-TARGETDURATION:4\r\n#EXTINF:4.000000,some title\r\nseg_000.ts\r\n#EXT-X-ENDLIST\r\n';
    expect(findPlaylistDurationViolations(text, MAX)).toEqual([]);
  });

  it('handles an empty/whitespace playlist without violations (nothing to judge)', () => {
    expect(findPlaylistDurationViolations('', MAX)).toEqual([]);
    expect(findPlaylistDurationViolations('\n\n', MAX)).toEqual([]);
  });
});

describe('buildTierArgs is pure', () => {
  it('same inputs → same output, and it never mutates the tier', () => {
    const tier: QualityTier = { ...TIERS[3]! };
    const snapshot = { ...tier };
    const a = buildTierArgs(tier, ctx(29.97));
    const b = buildTierArgs(tier, ctx(29.97));
    expect(a).toEqual(b);
    expect(tier).toEqual(snapshot);
  });
});
