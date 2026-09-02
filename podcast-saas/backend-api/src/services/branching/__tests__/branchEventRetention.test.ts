import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/index.js', () => ({ db: {} }));
vi.mock('../../../db/schema.js', () => ({ branch_path_events: {} }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { BRANCH_EVENT_REAP_BATCH, BRANCH_EVENT_RETENTION_DAYS, reapBranchPathEvents, retentionCutoff } from '../branchEventRetention.js';

describe('branch_path_events retention', () => {
  it('keeps ninety days', () => {
    expect(BRANCH_EVENT_RETENTION_DAYS).toBe(90);
    expect(retentionCutoff(new Date('2026-09-03T00:00:00Z')).toISOString()).toBe('2026-06-05T00:00:00.000Z');
  });

  it('drains in bounded batches and stops on the first short batch', async () => {
    const sizes = [BRANCH_EVENT_REAP_BATCH, BRANCH_EVENT_REAP_BATCH, 17];
    const deleteBatch = vi.fn(async () => sizes.shift() ?? 0);
    const total = await reapBranchPathEvents(new Date('2026-09-03T00:00:00Z'), { deleteBatch });
    expect(total).toBe(BRANCH_EVENT_REAP_BATCH * 2 + 17);
    expect(deleteBatch).toHaveBeenCalledTimes(3);
    expect(deleteBatch.mock.calls[0]![0].toISOString()).toBe('2026-06-05T00:00:00.000Z');
  });

  it('never loops forever on a batch that somehow never shrinks', async () => {
    const deleteBatch = vi.fn(async () => BRANCH_EVENT_REAP_BATCH);
    await reapBranchPathEvents(new Date(), { deleteBatch });
    expect(deleteBatch.mock.calls.length).toBeLessThanOrEqual(1000);
  });
});
