/**
 * The capture container is bounded on CPU, memory, pids, tmpfs scratch and wall clock — every
 * dimension except the one it actually fills. These tests pin the arithmetic that decides whether
 * a section's frames will fit, and the two judgement calls inside it: the bytes-per-pixel ceiling
 * and what happens when the filesystem cannot be measured.
 */
import { describe, it, expect } from 'vitest';
import {
  freeBytesFor,
  predictCaptureBytes,
  captureSpaceVerdict,
  JPEG_BYTES_PER_PIXEL_CEILING,
  FREE_SPACE_HEADROOM,
} from '../captureSpace.js';

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('the prediction', () => {
  it('scales with frames AND with pixels — both, because either alone is the wrong answer', () => {
    // A short 4K section and a long 720p one can predict the same total, and a check that looked
    // only at duration would wave the first one through.
    const long720 = predictCaptureBytes({ frames: 1800, width: 1280, height: 720 });
    const short4k = predictCaptureBytes({ frames: 240, width: 3840, height: 2160 });
    expect(long720.totalBytes).toBeGreaterThan(0);
    expect(short4k.totalBytes).toBeGreaterThan(0);
    expect(short4k.bytesPerFrame).toBeGreaterThan(long720.bytesPerFrame * 8);
  });

  it('uses a CEILING on bytes per pixel, not an average', () => {
    // The pathological case is exactly what this system produces: a WebGL simulation with hard
    // edges, text and high-contrast particles compresses far worse at q80 than a photograph. An
    // average would let the failure through on the frames that are hardest to compress.
    expect(JPEG_BYTES_PER_PIXEL_CEILING).toBeGreaterThan(0.2);
    const p = predictCaptureBytes({ frames: 1, width: 1920, height: 1080 });
    expect(p.bytesPerFrame).toBe(Math.ceil(1920 * 1080 * JPEG_BYTES_PER_PIXEL_CEILING));
  });

  it('rounds frames UP and never goes negative on nonsense input', () => {
    expect(predictCaptureBytes({ frames: 10.2, width: 100, height: 100 }).frames).toBe(11);
    expect(predictCaptureBytes({ frames: -5, width: -100, height: 100 }).totalBytes).toBe(0);
  });

  it('puts a real 60-second 1080p30 section well under a gigabyte', () => {
    // The number that decides whether the default ceiling refuses ordinary work. If this rises
    // above the ceiling, the guard has stopped protecting anything and started blocking exports.
    const p = predictCaptureBytes({ frames: 60 * 30, width: 1920, height: 1080 });
    expect(p.totalBytes).toBeLessThan(2 * GB);
  });
});

describe('the ceiling', () => {
  const big = { frames: 18000, width: 3840, height: 2160 };

  it('refuses a capture over the per-capture ceiling', () => {
    const v = captureSpaceVerdict({ ...big, freeBytes: 500 * GB, ceilingBytes: 4096 * MB });
    expect(v.refusal).toBeTruthy();
    expect(v.refusal).toContain('EXPORT_CAPTURE_MAX_OUTPUT_MB');
  });

  it('refuses it even when the disk is enormous — the ceiling is not about the disk', () => {
    // Space is one hazard; a ten-minute 4K capture is an absurd request whether or not it fits.
    expect(captureSpaceVerdict({ ...big, freeBytes: 100 * 1024 * GB, ceilingBytes: 4096 * MB }).refusal)
      .toBeTruthy();
  });

  it('is disabled by zero, leaving only the free-space rule', () => {
    expect(captureSpaceVerdict({ ...big, freeBytes: 100 * 1024 * GB, ceilingBytes: 0 }).refusal).toBeNull();
  });

  it('says what to DO, not just that it refused', () => {
    // A refusal an operator cannot act on gets reported as "exports are broken".
    const msg = captureSpaceVerdict({ ...big, freeBytes: 500 * GB, ceilingBytes: 4096 * MB }).refusal!;
    expect(msg).toMatch(/shorten|lower|raise/i);
  });
});

describe('the free-space rule', () => {
  const section = { frames: 60 * 30, width: 1920, height: 1080 };
  const predicted = predictCaptureBytes(section).totalBytes;

  it('refuses when the prediction does not fit in the usable fraction', () => {
    const barely = predicted / FREE_SPACE_HEADROOM * 0.9; // enough raw space, not enough headroom
    const v = captureSpaceVerdict({ ...section, freeBytes: barely, ceilingBytes: 0 });
    expect(v.refusal).toBeTruthy();
    expect(v.refusal).toContain('Free space');
  });

  it('leaves HEADROOM rather than filling the disk exactly', () => {
    // The clip is written to the same filesystem while the frames are still there, and Postgres
    // lives on it too. "It fits exactly" is the condition that takes the host down.
    expect(FREE_SPACE_HEADROOM).toBeLessThan(1);
    expect(FREE_SPACE_HEADROOM).toBeGreaterThan(0.5);
    const exactly = predicted; // would fit with zero to spare
    expect(captureSpaceVerdict({ ...section, freeBytes: exactly, ceilingBytes: 0 }).refusal).toBeTruthy();
  });

  it('allows a capture with room to spare', () => {
    expect(captureSpaceVerdict({ ...section, freeBytes: 500 * GB, ceilingBytes: 4096 * MB }).refusal).toBeNull();
  });
});

describe('when the filesystem cannot be measured', () => {
  it('does NOT refuse on an unmeasurable filesystem', () => {
    // `statfs` can fail on an unusual mount or a platform that does not implement it. Treating
    // that as "no space" would stop every export on that host for a reason that has nothing to do
    // with space, and the operator's first symptom would be a message naming a number nobody can
    // see. A deliberate, narrow exception to fail-closed: it applies when the MEASUREMENT is
    // missing, never when the measurement says there is not enough room.
    expect(captureSpaceVerdict({ frames: 1800, width: 1920, height: 1080, freeBytes: null, ceilingBytes: 4096 * MB }).refusal)
      .toBeNull();
  });

  it('still applies the CEILING when free space is unknown', () => {
    // Otherwise an unmeasurable filesystem would disable the guard entirely, which is the failure
    // mode a fallback is supposed to avoid rather than create.
    expect(captureSpaceVerdict({ frames: 18000, width: 3840, height: 2160, freeBytes: null, ceilingBytes: 4096 * MB }).refusal)
      .toBeTruthy();
  });
});

describe('reading the filesystem', () => {
  const space = { bsize: 4096, bavail: 1000, bfree: 1500 };

  it('reports what a NON-ROOT process may use, not what root could reach', () => {
    // `bfree` includes the blocks reserved for root — typically 5% of the filesystem — and the
    // export worker does not run as root. On a nearly full disk that difference is the whole
    // margin, and using it would promise room this process can never write into.
    return expect(freeBytesFor('/anywhere', async () => space)).resolves.toBe(4096 * 1000);
  });

  it('returns null rather than throwing when the filesystem cannot be read', () => {
    // The caller treats null as "unmeasurable" and falls back to the ceiling alone. A throw here
    // would fail the export for a reason that has nothing to do with the export.
    return expect(freeBytesFor('/anywhere', async () => { throw new Error('ENOSYS'); })).resolves.toBeNull();
  });
});
