/**
 * `CROP_ALGO=v2` selects a label with no algorithm behind it — and honouring it costs a full
 * catalogue recompute for zero change.
 *
 * `algoVersion()` feeds `sourceHash`, deliberately, so a genuine algorithm fix reaches videos that
 * already have a crop. That makes the version stamp expensive: flipping the flag would alter every
 * `crop_source_hash`, mark every `ready` row stale, and reprocess the entire catalogue — producing
 * byte-identical output, because nothing in the pipeline reads the selection. The flag is
 * documented as a cheap rollback lever. It is the opposite.
 *
 * Demonstrated rather than assumed: the field eval scored v1 and v2 at an identical mIoU of
 * 0.5089 across 390 hand-labelled frames.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cropAlgo, algoVersion, cropAlgoMisconfigured } from '../algo.js';

const prev = process.env.CROP_ALGO;
afterEach(() => {
  if (prev === undefined) delete process.env.CROP_ALGO;
  else process.env.CROP_ALGO = prev;
});

describe('an algorithm that does not exist is not selected', () => {
  it('ignores CROP_ALGO=v2 while no v2 is implemented', () => {
    process.env.CROP_ALGO = 'v2';
    expect(cropAlgo()).toBe('v1');
  });

  it('keeps the version stamp on v1, which is what protects the catalogue', () => {
    // THE ASSERTION THAT MATTERS. The stamp is what invalidates stored crop hashes; if it moved,
    // every ready row would go stale and reprocess to produce the same bytes.
    process.env.CROP_ALGO = 'v2';
    expect(algoVersion()).toBe(algoVersion('v1'));
  });

  it('still honours an explicit v1', () => {
    process.env.CROP_ALGO = 'v1';
    expect(cropAlgo()).toBe('v1');
  });

  it('defaults to v1 with nothing set', () => {
    delete process.env.CROP_ALGO;
    expect(cropAlgo()).toBe('v1');
  });
});

describe('the misconfiguration is reportable, so it is not silent', () => {
  it('reports when v2 is asked for and does not exist', () => {
    process.env.CROP_ALGO = 'v2';
    const msg = cropAlgoMisconfigured();
    expect(msg).toBeTruthy();
    // It has to say what to DO. "Misconfigured" alone sends the reader to the source.
    expect(msg).toMatch(/unset the variable/i);
    // ...and why ignoring it is the safe answer, or someone will "fix" it by honouring it.
    expect(msg).toMatch(/recompute the entire catalogue/i);
  });

  it('says nothing when the configuration is fine', () => {
    delete process.env.CROP_ALGO;
    expect(cropAlgoMisconfigured()).toBeNull();
    process.env.CROP_ALGO = 'v1';
    expect(cropAlgoMisconfigured()).toBeNull();
  });

  it('is separate from cropAlgo(), which must stay quiet', () => {
    // `cropAlgo()` runs inside `sourceHash` on every crop. A log line there would be one per
    // video; the report belongs at startup, once.
    process.env.CROP_ALGO = 'v2';
    expect(() => cropAlgo()).not.toThrow();
  });
});
