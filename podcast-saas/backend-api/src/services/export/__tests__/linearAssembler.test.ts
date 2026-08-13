/**
 * Pure LinearAssembler tests — no ffmpeg, always run.
 *
 * The progress parser and the mp4 atom walker are the two pieces of the runner
 * whose failure modes are silent (a 1000×-fast progress bar; a "faststart" master
 * that is not), so they are pinned here deterministically.
 */

import { describe, it, expect } from 'vitest';

import {
  ProgressParser,
  findMoovMdatOffsets,
  parseFfmpegFilters,
  ExportGateError,
  ExportCancelledError,
  type ReadAt,
} from '../LinearAssembler.js';
import { REQUIRED_FILTERS } from '../ffmpegGraph.js';

describe('ProgressParser', () => {
  const collect = (plannedSec: number) => {
    const out: number[] = [];
    const parser = new ProgressParser(plannedSec, (p) => out.push(p));
    return { out, parser };
  };

  it('reads out_time_us as MICROSECONDS and ignores the mislabelled out_time_ms key', () => {
    const { out, parser } = collect(10);
    // A realistic -progress block: out_time_ms carries the SAME microsecond value
    // as out_time_us (measured, plan §6). A parser treating it as milliseconds
    // would compute 5000000/1000 = 5000s → 50000% → clamp 100. Correct answer: 50.
    parser.feed(
      'frame=150\nfps=30.0\nout_time_us=5000000\nout_time_ms=5000000\n' +
      'out_time=00:00:05.000000\ndup_frames=0\nprogress=continue\n',
    );
    expect(out).toEqual([50]);
  });

  it('reassembles lines split across chunk boundaries', () => {
    const { out, parser } = collect(10);
    parser.feed('out_time_u');
    parser.feed('s=2500000\nprogress=continue\n');
    expect(out).toEqual([25]);
  });

  it('is strictly monotonic — a lower or equal reading emits nothing', () => {
    const { out, parser } = collect(10);
    parser.feed('out_time_us=3000000\nout_time_us=1000000\nout_time_us=3000000\n');
    expect(out).toEqual([30]);
  });

  it('clamps beyond-planned readings to 100 and emits 100 once on progress=end', () => {
    const { out, parser } = collect(10);
    parser.feed('out_time_us=11000000\nprogress=end\n');
    expect(out).toEqual([100]);
  });

  it('emits nothing for out_time_us when the planned duration is zero, but still ends', () => {
    const { out, parser } = collect(0);
    parser.feed('out_time_us=1000000\nprogress=end\n');
    expect(out).toEqual([100]);
  });

  it('ignores N/A and malformed readings', () => {
    const { out, parser } = collect(10);
    parser.feed('out_time_us=N/A\nout_time=N/A\nout_time_us=\nprogress=continue\n');
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mp4 atom walker
// ---------------------------------------------------------------------------

function box(type: string, bodyLen: number): Buffer {
  const b = Buffer.alloc(8 + bodyLen);
  b.writeUInt32BE(8 + bodyLen, 0);
  b.write(type, 4, 'latin1');
  return b;
}

function box64(type: string, bodyLen: number): Buffer {
  const b = Buffer.alloc(16 + bodyLen);
  b.writeUInt32BE(1, 0); // largesize marker
  b.write(type, 4, 'latin1');
  b.writeBigUInt64BE(BigInt(16 + bodyLen), 8);
  return b;
}

function readerFor(file: Buffer): ReadAt {
  return async (position, length) => file.subarray(position, Math.min(position + length, file.length));
}

describe('findMoovMdatOffsets', () => {
  it('finds moov before mdat in a faststart layout', async () => {
    const file = Buffer.concat([box('ftyp', 8), box('moov', 100), box('free', 0), box('mdat', 50)]);
    const { moov, mdat } = await findMoovMdatOffsets(readerFor(file), file.length);
    expect(moov).toBe(16);
    expect(mdat).toBe(16 + 108 + 8);
    expect(moov! < mdat!).toBe(true);
  });

  it('finds mdat before moov in a non-faststart layout', async () => {
    const file = Buffer.concat([box('ftyp', 8), box('mdat', 50), box('moov', 100)]);
    const { moov, mdat } = await findMoovMdatOffsets(readerFor(file), file.length);
    expect(mdat).toBe(16);
    expect(moov).toBe(16 + 58);
    expect(moov! > mdat!).toBe(true);
  });

  it('walks 64-bit largesize boxes', async () => {
    const file = Buffer.concat([box('ftyp', 8), box64('mdat', 300), box('moov', 20)]);
    const { moov, mdat } = await findMoovMdatOffsets(readerFor(file), file.length);
    expect(mdat).toBe(16);
    expect(moov).toBe(16 + 316);
  });

  it('treats size=0 as to-end-of-file', async () => {
    const last = Buffer.alloc(8 + 40);
    last.writeUInt32BE(0, 0);
    last.write('mdat', 4, 'latin1');
    const file = Buffer.concat([box('ftyp', 8), box('moov', 24), last]);
    const { moov, mdat } = await findMoovMdatOffsets(readerFor(file), file.length);
    expect(moov).toBe(16);
    expect(mdat).toBe(16 + 32);
  });

  it('throws the faststart gate on a corrupt size', async () => {
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(4, 0); // smaller than its own header
    bad.write('mdat', 4, 'latin1');
    const file = Buffer.concat([box('ftyp', 8), bad]);
    await expect(findMoovMdatOffsets(readerFor(file), file.length)).rejects.toMatchObject({
      name: 'ExportGateError',
      gate: 'faststart',
    });
  });

  it('returns nulls (does not throw) on a truncated header', async () => {
    const file = Buffer.concat([box('ftyp', 8), Buffer.from([0, 0])]);
    const { moov, mdat } = await findMoovMdatOffsets(readerFor(file), file.length);
    expect(moov).toBeNull();
    expect(mdat).toBeNull();
  });
});

describe('parseFfmpegFilters (the fail-fast job-start probe)', () => {
  // Both flag-column widths: ffmpeg 8 prints two characters (' .. scale'),
  // older builds three (' T.C scale'). The parser must read both.
  const sample = [
    'Filters:',
    '  T. = Timeline support',
    '  .S = Slice threading',
    ' TS scale            V->V       Scale the input video size and/or convert the image format.',
    ' T.C pad              V->V       Pad the input video.',
    ' .. concat           N->N       Concatenate audio and video streams.',
    ' .. color            |->V       Provide an uniformly colored input.',
    ' .. anullsrc         |->A       Null audio source, return empty audio frames.',
    ' .. loudnorm         A->A       EBU R128 loudness normalization',
    ' not-a-filter-line',
  ].join('\n');

  it('parses filter and source names out of the listing', () => {
    const names = parseFfmpegFilters(sample);
    expect(names.has('scale')).toBe(true);
    expect(names.has('concat')).toBe(true);
    expect(names.has('color')).toBe(true);
    expect(names.has('anullsrc')).toBe(true);
    expect(names.has('loudnorm')).toBe(true);
    expect(names.has('Filters:')).toBe(false);
    expect(names.has('=')).toBe(false);
  });

  it('detects a deficient build by name', () => {
    const have = parseFfmpegFilters(sample);
    const missing = REQUIRED_FILTERS.filter((f) => !have.has(f));
    // the sample lists only 6 of the required set — the rest must be reported missing
    expect(missing).toContain('amix');
    expect(missing).toContain('settb');
    expect(missing).not.toContain('scale');
    expect(missing).not.toContain('loudnorm');
  });
});

describe('typed errors', () => {
  it('ExportGateError names its gate', () => {
    const e = new ExportGateError('duration', 'off by a lot');
    expect(e.gate).toBe('duration');
    expect(e.name).toBe('ExportGateError');
    expect(e.message).toContain('duration');
    expect(e).toBeInstanceOf(Error);
  });

  it('ExportCancelledError is distinguishable and classifiable', () => {
    const e = new ExportCancelledError();
    // 'AbortError' is what classifyExportFailure (ProjectExportService) recognises
    // as an honoured AbortSignal — any other spelling turns a clean cancellation
    // into an 'unknown' failure on the export row.
    expect(e.name).toBe('AbortError');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ExportCancelledError);
    expect(e).not.toBeInstanceOf(ExportGateError);
  });
});
