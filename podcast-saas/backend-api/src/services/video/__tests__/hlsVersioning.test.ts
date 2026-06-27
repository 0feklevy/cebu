import { describe, it, expect } from 'vitest';
import { previousHlsTreeToGc } from '../hlsVersioning.js';

const ID = 'abc-123-def';

describe('previousHlsTreeToGc', () => {
  it('returns null when there is no previous master key', () => {
    expect(previousHlsTreeToGc(ID, null, 'k5x9')).toBeNull();
    expect(previousHlsTreeToGc(ID, undefined, 'k5x9')).toBeNull();
  });

  it('GCs a previous versioned tree with a different run id', () => {
    expect(previousHlsTreeToGc(ID, `hls/${ID}/oldrun/master.m3u8`, 'newrun')).toBe(`hls/${ID}/oldrun`);
  });

  it('does NOT GC when the run id is unchanged (idempotent re-run of the same run)', () => {
    expect(previousHlsTreeToGc(ID, `hls/${ID}/samerun/master.m3u8`, 'samerun')).toBeNull();
  });

  it('does NOT GC a legacy unversioned key (would delete the new tree under the same parent)', () => {
    expect(previousHlsTreeToGc(ID, `hls/${ID}/master.m3u8`, 'newrun')).toBeNull();
  });

  it('ignores a master key for a different video id', () => {
    expect(previousHlsTreeToGc(ID, `hls/other-id/run/master.m3u8`, 'newrun')).toBeNull();
  });

  it('only matches the master playlist, not an arbitrary nested object', () => {
    expect(previousHlsTreeToGc(ID, `hls/${ID}/run/360p/index.m3u8`, 'newrun')).toBeNull();
  });
});
