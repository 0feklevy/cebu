import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { __test, captionPublicUrl } from '../CaptionService.js';

const { vttTimestamp, segmentsToVtt, generateVttValidate, shouldSkip, pickEngine } = __test;

describe('vttTimestamp', () => {
  it('formats seconds as HH:MM:SS.mmm', () => {
    expect(vttTimestamp(0)).toBe('00:00:00.000');
    expect(vttTimestamp(3725.5)).toBe('01:02:05.500');
    expect(vttTimestamp(9.123)).toBe('00:00:09.123');
  });
});

describe('segmentsToVtt', () => {
  it('builds valid WebVTT with cues, skipping empty text', () => {
    const vtt = segmentsToVtt([
      { start: 0, end: 2, text: 'Hello world' },
      { start: 2, end: 4, text: '   ' },
      { start: 4, end: 6, text: 'Second cue' },
    ]);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.000');
    expect(vtt).toContain('Hello world');
    expect(vtt).toContain('Second cue');
    expect((vtt.match(/-->/g) || []).length).toBe(2); // empty cue dropped
  });
  it('guards against zero-length cues', () => {
    const vtt = segmentsToVtt([{ start: 5, end: 5, text: 'x' }]);
    expect(vtt).toContain('00:00:05.000 --> 00:00:05.100');
  });
});

describe('generateVttValidate', () => {
  it('accepts valid VTT', () => {
    expect(generateVttValidate('WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nHi')).toContain('WEBVTT');
  });
  it('rejects non-VTT and cue-less VTT', () => {
    expect(() => generateVttValidate('just text')).toThrow();
    expect(() => generateVttValidate('WEBVTT\n\n')).toThrow();
  });
});

describe('shouldSkip / retry semantics', () => {
  const base = { id: 'v', captions_source_hash: 'h', captions_status: 'failed', captions_updated_at: new Date() } as never;
  it('skips a recent failure but force overrides', () => {
    expect(shouldSkip(base, 'h', false)).toBe(true);
    expect(shouldSkip(base, 'h', true)).toBe(false);
  });
  it('does not skip when the source hash changed', () => {
    expect(shouldSkip(base, 'different', false)).toBe(false);
  });
  it('retries a failure older than the cooldown', () => {
    const old = { ...base, captions_updated_at: new Date(Date.now() - 20 * 60 * 1000) } as never;
    expect(shouldSkip(old, 'h', false)).toBe(false);
  });
  it('skips ready/processing without force', () => {
    expect(shouldSkip({ ...base, captions_status: 'ready' } as never, 'h')).toBe(true);
    expect(shouldSkip({ ...base, captions_status: 'processing' } as never, 'h')).toBe(true);
  });
});

describe('pickEngine', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.CAPTIONS_ENGINE; delete process.env.GROQ_API_KEY; delete process.env.WHISPER_CPP_MODEL; delete process.env.WHISPER_MODEL_PATH; });
  afterEach(() => { process.env = { ...saved }; });
  it('prefers groq when GROQ_API_KEY is set', () => { process.env.GROQ_API_KEY = 'x'; expect(pickEngine()).toBe('groq'); });
  it('uses whisper when only WHISPER_CPP_MODEL is set', () => { process.env.WHISPER_CPP_MODEL = '/m.bin'; expect(pickEngine()).toBe('whisper'); });
  it('honors an explicit override', () => { process.env.GROQ_API_KEY = 'x'; process.env.CAPTIONS_ENGINE = 'whisper'; expect(pickEngine()).toBe('whisper'); });
  it('throws a clear error when nothing is configured', () => { expect(() => pickEngine()).toThrow(/GROQ_API_KEY/); });
});

describe('captionPublicUrl', () => {
  it('returns null for no key and never leaks storage internals beyond the public path', () => {
    expect(captionPublicUrl(null)).toBeNull();
    const url = captionPublicUrl('captions/p/v/abc.vtt');
    expect(url).toContain('/local-storage/captions/p/v/abc.vtt');
  });
});
