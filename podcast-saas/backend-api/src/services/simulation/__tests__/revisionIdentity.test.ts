/**
 * Immutable caching is granted on VERIFIED revision identity, never on path resemblance.
 *
 * The defect: `revisionIdFromKey` accepts any id matching `^[A-Za-z0-9_-]{8,64}$` at the canonical
 * depth, but real revision ids are database UUIDs. A customer package containing a top-level
 * `revisions/chapter01/` directory therefore classified as a revision and was served
 * `max-age=31536000, immutable` — for bytes that "Replace simulation" overwrites in place. Every
 * viewer that cached them would hold the stale copy for a year with no revalidation path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = vi.hoisted(() => ({
  rows: [] as Array<{ id: string }>,
  throws: false,
  /** Every (revisionId, simulationId) pair the identity check actually asked the database about. */
  queries: [] as Array<{ revisionId: string; simulationId: string }>,
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (w: { revisionId: string; simulationId: string }) => ({
          limit: async () => {
            if (dbMock.throws) throw new Error('connection reset');
            dbMock.queries.push(w);
            return dbMock.rows;
          },
        }),
      }),
    }),
  },
}));
vi.mock('../../../db/schema.js', () => ({
  sim_revisions: { id: 'sim_revisions.id', simulation_id: 'sim_revisions.simulation_id' },
}));
// The mocked `and`/`eq` carry the compared values through to the fake `where`, so the assertions
// below can prove BOTH halves of the predicate are applied rather than trusting the call shape.
vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: string) => ({ col, val }),
  and: (...parts: Array<{ col: string; val: string }>) => ({
    revisionId: parts.find((p) => p.col === 'sim_revisions.id')?.val ?? '',
    simulationId: parts.find((p) => p.col === 'sim_revisions.simulation_id')?.val ?? '',
  }),
}));
const logged = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: logged.warn, error: vi.fn(), debug: vi.fn() },
}));

import {
  isVerifiedRevisionKey, revisionCoordsFromKey, resetRevisionIdentityCacheForTest,
} from '../revisionIdentity.js';

const SIM = '22222222-2222-4222-a222-222222222222';
const REV = '11111111-1111-4111-a111-111111111111';
const revisionKey = (rev = REV, sim = SIM) => `simulations/proj-1/${sim}/revisions/${rev}/package/app.js`;

beforeEach(() => {
  resetRevisionIdentityCacheForTest();
  dbMock.rows = [];
  dbMock.throws = false;
  dbMock.queries = [];
  logged.warn.mockClear();
});

describe('revisionCoordsFromKey — shape gate before any query', () => {
  it('accepts a canonical revision key with UUIDs at both positions', () => {
    expect(revisionCoordsFromKey(revisionKey())).toEqual({ simulationId: SIM, revisionId: REV });
  });

  // THE REGRESSION: an ordinary customer directory name passes isValidRevisionId.
  it.each(['chapter01', 'assets-v2', 'lecture-3', 'my_bundle', 'revision1'])(
    'rejects the legacy customer directory revisions/%s/ before touching the database', (dir) => {
      expect(revisionCoordsFromKey(`simulations/proj-1/${SIM}/revisions/${dir}/app.js`)).toBeNull();
    });

  it('rejects a nested revisions/ directory inside the customer package', () => {
    expect(revisionCoordsFromKey(`simulations/proj-1/${SIM}/package/revisions/${REV}/app.js`)).toBeNull();
  });

  it('rejects a non-UUID simulation segment', () => {
    expect(revisionCoordsFromKey(`simulations/proj-1/not-a-uuid/revisions/${REV}/app.js`)).toBeNull();
  });

  it('rejects a bare revision directory with no file below it', () => {
    expect(revisionCoordsFromKey(`simulations/proj-1/${SIM}/revisions/${REV}/`)).toBeNull();
  });
});

describe('isVerifiedRevisionKey — the row must exist AND belong to this simulation', () => {
  it('verifies a real revision, querying on BOTH id and simulation_id', async () => {
    dbMock.rows = [{ id: REV }];
    expect(await isVerifiedRevisionKey(revisionKey())).toBe(true);
    expect(dbMock.queries).toEqual([{ revisionId: REV, simulationId: SIM }]);
  });

  // A real revision id borrowed onto ANOTHER simulation's prefix must not be honoured.
  it('refuses a real revision id under a different simulation prefix', async () => {
    dbMock.rows = [];
    const other = '33333333-3333-4333-a333-333333333333';
    expect(await isVerifiedRevisionKey(revisionKey(REV, other))).toBe(false);
    expect(dbMock.queries[0]).toEqual({ revisionId: REV, simulationId: other });
  });

  it('refuses a UUID that names no revision at all', async () => {
    dbMock.rows = [];
    expect(await isVerifiedRevisionKey(revisionKey())).toBe(false);
  });

  it('never queries for a legacy customer directory', async () => {
    expect(await isVerifiedRevisionKey(`simulations/proj-1/${SIM}/revisions/chapter01/app.js`)).toBe(false);
    expect(dbMock.queries, 'a legacy path reached the database').toEqual([]);
  });

  // FAIL CLOSED: a database fault must never grant a year of immutable caching.
  it('answers "not a revision" when the database throws, and does not cache that answer', async () => {
    dbMock.throws = true;
    expect(await isVerifiedRevisionKey(revisionKey())).toBe(false);
    expect(logged.warn).toHaveBeenCalled();
    // The fault is not memoised: once the database recovers the next call verifies for real.
    dbMock.throws = false;
    dbMock.rows = [{ id: REV }];
    expect(await isVerifiedRevisionKey(revisionKey())).toBe(true);
  });

  it('memoises a verified answer instead of querying per asset', async () => {
    dbMock.rows = [{ id: REV }];
    await isVerifiedRevisionKey(revisionKey());
    await isVerifiedRevisionKey(`simulations/proj-1/${SIM}/revisions/${REV}/package/other.css`);
    expect(dbMock.queries.length, 'every asset of one revision re-queried the database').toBe(1);
  });

  it('memoises a negative answer too, so legacy packages do not hammer the database', async () => {
    dbMock.rows = [];
    await isVerifiedRevisionKey(revisionKey());
    await isVerifiedRevisionKey(revisionKey());
    expect(dbMock.queries.length).toBe(1);
  });
});
