/**
 * An image-generation row has to say HOW MANY IMAGES, not only how many cents.
 *
 * `recordImageUsage` has always priced correctly. What it did not do was record the quantity, so
 * the row said "37 cents" and could not answer "for what". A spend surface that can only total
 * money is unreconcilable against a vendor invoice, because invoices itemise by unit — and the
 * whole point of the 22 August work is being able to put our number next to theirs.
 *
 * Migration 073 added `quantity`/`unit` for exactly this. The image path was the last one still
 * writing a bare cost.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const record = vi.fn(async () => {});
// A METHOD, not a class field: `systemAi` constructs its recorder at module scope, and a field
// initialiser would dereference `record` while the hoisted factory is still being evaluated.
vi.mock('../../usage/UsageTrackingService.js', () => ({
  UsageTrackingService: class {
    async record(...args: unknown[]) { return record(...(args as [])); }
  },
}));
vi.mock('../../../db/index.js', () => ({ db: {} }));

import { recordImageUsage } from '../systemAi.js';
import { callArg } from '../../../__tests__/helpers/mockCalls.js';

beforeEach(() => { record.mockReset(); record.mockResolvedValue(undefined); });

describe('what an image-generation row carries', () => {
  it('records the count, in images', async () => {
    await recordImageUsage({ userId: 'u1', projectId: 'p1', model: 'gpt-image-1', task: 'thumbnail_image', quality: 'high', count: 3 });

    const row = callArg(record);
    expect(row.unit).toBe('images');
    expect(row.quantity).toBe(3);
  });

  it('defaults to one image when the caller does not say', async () => {
    // Every current call site generates a single image and omits `count`. Defaulting to zero would
    // make the commonest case invisible in a per-day total.
    await recordImageUsage({ userId: 'u', projectId: 'p', model: 'dall-e-3', task: 'thumbnail_image', quality: 'standard' });
    expect(callArg(record).quantity).toBe(1);
  });

  it('still prices per image, and scales with the count', async () => {
    await recordImageUsage({ userId: 'u', projectId: 'p', model: 'gpt-image-1', task: 't', quality: 'high', count: 1 });
    const one = callArg<{ costCents: number }>(record).costCents;
    record.mockClear();

    await recordImageUsage({ userId: 'u', projectId: 'p', model: 'gpt-image-1', task: 't', quality: 'high', count: 4 });
    expect(callArg<{ costCents: number }>(record).costCents).toBeCloseTo(one * 4, 8);
  });

  it('leaves the token columns at zero — an image is not a token', async () => {
    await recordImageUsage({ userId: 'u', projectId: 'p', model: 'gpt-image-1', task: 't' });
    const row = callArg<{ inputTokens: number; outputTokens: number }>(record);
    expect(row.inputTokens).toBe(0);
    expect(row.outputTokens).toBe(0);
  });

  it('never throws — it runs after the image is already paid for', async () => {
    record.mockRejectedValueOnce(new Error('usage table unavailable'));
    await expect(
      recordImageUsage({ userId: 'u', projectId: 'p', model: 'gpt-image-1', task: 't' }),
    ).resolves.toBeUndefined();
  });
});
