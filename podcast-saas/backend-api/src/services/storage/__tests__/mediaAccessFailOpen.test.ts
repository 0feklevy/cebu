/**
 * security-012 — the gate used to answer TRUE for anything it could not check.
 *
 * The availability argument was real: a database blip must not take down all playback, and the
 * token path already covers every URL this product mints. But "allow anything we could not check"
 * also served a PRIVATE project's media to a caller with no token and no session, for as long as
 * the fault lasted — the one case the gate exists for.
 *
 * The ruling (owner-approved 2026-08-22) was ratify-but-bound: allow what we have SEEN to be
 * public, deny what we have never seen. Public content keeps streaming through a fault; private
 * content does not start streaming to strangers the moment the database wobbles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock('../../../db/index.js', () => ({
  db: { query: { projects: { findFirst: mocks.findFirst }, video_files: { findFirst: vi.fn() } } },
}));
vi.mock('../../../db/schema.js', () => ({ projects: { id: 'id' }, video_files: { id: 'id' } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn(() => ({})) }));
vi.mock('../../collabAccess.js', () => ({ isCollaborator: vi.fn(async () => false) }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { canServeMediaKey, _resetPublicKeyMemory } = await import('../mediaAccess.js');

const PROJECT = '11111111-2222-4333-8444-555555555555';
const KEY = `videos/${PROJECT}/master.mp4`;
const SIM_KEY = `simulations/${PROJECT}/66666666-7777-4888-8999-aaaaaaaaaaaa/index.html`;

beforeEach(() => {
  vi.clearAllMocks();
  _resetPublicKeyMemory();
});

describe('a database fault (security-012)', () => {
  it('DENIES a key it has never resolved — the hole that used to be open', () => {
    mocks.findFirst.mockRejectedValue(new Error('db down'));
    return expect(canServeMediaKey(KEY, null, null)).resolves.toBe(false);
  });

  it('allows a key it last saw PUBLIC, so an outage does not stop public playback', async () => {
    mocks.findFirst.mockResolvedValue({ id: PROJECT, visibility: 'public', created_by: 'u1' });
    expect(await canServeMediaKey(KEY, null, null)).toBe(true);   // seen public

    mocks.findFirst.mockRejectedValue(new Error('db down'));
    expect(await canServeMediaKey(KEY, null, null)).toBe(true);   // remembered
  });

  it('does NOT remember a project that was private when last checked', async () => {
    mocks.findFirst.mockResolvedValue({ id: PROJECT, visibility: 'private', created_by: 'u1' });
    expect(await canServeMediaKey(KEY, null, null)).toBe(false);

    mocks.findFirst.mockRejectedValue(new Error('db down'));
    expect(await canServeMediaKey(KEY, null, null)).toBe(false);
  });

  it('FORGETS a project that has since been unshared — the case the memory could get wrong', async () => {
    // Public, then unshared, then the database wobbles. The memory must not resurrect the old
    // answer: an unshare is exactly when someone is relying on revocation.
    mocks.findFirst.mockResolvedValue({ id: PROJECT, visibility: 'public', created_by: 'u1' });
    expect(await canServeMediaKey(KEY, null, null)).toBe(true);

    mocks.findFirst.mockResolvedValue({ id: PROJECT, visibility: 'private', created_by: 'u1' });
    expect(await canServeMediaKey(KEY, null, null)).toBe(false);

    mocks.findFirst.mockRejectedValue(new Error('db down'));
    expect(await canServeMediaKey(KEY, null, null), 'the stale public memory must be gone').toBe(false);
  });

  it('is not a cache on the success path — an unshare takes effect immediately', async () => {
    mocks.findFirst.mockResolvedValue({ id: PROJECT, visibility: 'public', created_by: 'u1' });
    expect(await canServeMediaKey(KEY, null, null)).toBe(true);

    mocks.findFirst.mockResolvedValue({ id: PROJECT, visibility: 'private', created_by: 'u1' });
    expect(await canServeMediaKey(KEY, null, null), 'no fault, so the live answer must win').toBe(false);
  });
});

describe('the gate now understands simulation keys (security-005)', () => {
  it('resolves simulations/{projectId}/… to its project', async () => {
    mocks.findFirst.mockResolvedValue({ id: PROJECT, visibility: 'public', created_by: 'u1' });
    expect(await canServeMediaKey(SIM_KEY, null, null)).toBe(true);
    expect(mocks.findFirst, 'a simulation key must reach the projects lookup').toHaveBeenCalled();
  });

  it('refuses a private project`s simulation to an anonymous caller', async () => {
    mocks.findFirst.mockResolvedValue({ id: PROJECT, visibility: 'private', created_by: 'u1' });
    expect(await canServeMediaKey(SIM_KEY, null, null)).toBe(false);
  });

  it('serves a private project`s simulation to its owner', async () => {
    mocks.findFirst.mockResolvedValue({ id: PROJECT, visibility: 'private', created_by: 'u1' });
    expect(await canServeMediaKey(SIM_KEY, null, { id: 'u1', email: null } as never)).toBe(true);
  });
});
