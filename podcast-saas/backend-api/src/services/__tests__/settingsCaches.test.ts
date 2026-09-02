/**
 * The two admin_settings reads on the player-config path are cached for ten seconds, and the
 * admin write invalidates them — the same contract resolveRumSampleRate already had.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));
vi.mock('../../db/index.js', () => ({ db: { query: { admin_settings: { findFirst: mocks.findFirst } } } }));
vi.mock('../../db/schema.js', () => ({}));
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { invalidateSimPoolModeCache, resolveSimPoolMode } from '../buildPlayerConfig.js';
import { invalidateSimRuntimeFlagsCache, resolveSimRuntimeFlags } from '../simulation/RumService.js';

beforeEach(() => {
  mocks.findFirst.mockReset();
  invalidateSimPoolModeCache();
  invalidateSimRuntimeFlagsCache();
  delete process.env.SIM_POOL_MODE;
  delete process.env.SIM_SCHEDULER_MODE;
});

describe('resolveSimPoolMode', () => {
  it('reads the database once per window and again after invalidation', async () => {
    mocks.findFirst.mockResolvedValue({ sim_pool_mode: 'single' });
    expect(await resolveSimPoolMode()).toBe('single');
    expect(await resolveSimPoolMode()).toBe('single');
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    mocks.findFirst.mockResolvedValue({ sim_pool_mode: 'adaptive' });
    expect(await resolveSimPoolMode(), 'still the cached value').toBe('single');
    invalidateSimPoolModeCache();
    expect(await resolveSimPoolMode()).toBe('adaptive');
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });

  it('a database fault is cached as the safe default rather than retried per request', async () => {
    mocks.findFirst.mockRejectedValue(new Error('db down'));
    expect(await resolveSimPoolMode()).toBe('adaptive');
    expect(await resolveSimPoolMode()).toBe('adaptive');
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('resolveSimRuntimeFlags', () => {
  it('reads the row once per window; invalidation re-reads', async () => {
    mocks.findFirst.mockResolvedValue({ sim_scheduler_mode: 'predictive', sim_adaptive_quality: true, sim_boundary_sentinel: false, sim_transition_coordinator: false });
    const a = await resolveSimRuntimeFlags();
    const b = await resolveSimRuntimeFlags();
    expect(a.schedulerMode).toBe('predictive');
    expect(b.adaptiveQuality).toBe(true);
    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    invalidateSimRuntimeFlagsCache();
    await resolveSimRuntimeFlags();
    expect(mocks.findFirst).toHaveBeenCalledTimes(2);
  });
});
