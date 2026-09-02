import { describe, it, expect } from 'vitest';
import { mapWithLimit } from '../mapWithLimit.js';

describe('mapWithLimit', () => {
  it('keeps order, never exceeds the limit, and handles an empty list', async () => {
    let inFlight = 0, peak = 0;
    const r = await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((res) => setTimeout(res, 3));
      inFlight--;
      return n * 10;
    });
    expect(r).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
    expect(await mapWithLimit([], 4, async () => 1)).toEqual([]);
  });

  it('rejects with the first failure, like Promise.all', async () => {
    await expect(mapWithLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('two'); return n; })).rejects.toThrow('two');
  });
});
