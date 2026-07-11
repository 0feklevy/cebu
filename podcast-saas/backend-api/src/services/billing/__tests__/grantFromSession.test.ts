/**
 * Tests for BillingService.grantFromSession — the idempotent purchase-grant that
 * flips a billing_transaction to 'succeeded' AND inserts the user_purchases row.
 *
 * The load-bearing invariant: both writes must happen inside the SAME
 * db.transaction callback (on the `trx` handle), never on the outer `db`. Writing
 * the 'succeeded' sentinel outside the transaction and crashing before the grant
 * would permanently deny a paying customer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Stripe from 'stripe';

const mocks = vi.hoisted(() => {
  const trxWhere = vi.fn(async () => undefined);
  const trxSet = vi.fn(() => ({ where: trxWhere }));
  const trxUpdate = vi.fn(() => ({ set: trxSet }));
  const trxOnConflict = vi.fn(async () => undefined);
  const trxValues = vi.fn(() => ({ onConflictDoNothing: trxOnConflict }));
  const trxInsert = vi.fn(() => ({ values: trxValues }));

  return {
    findFirst: vi.fn(),
    // Outer-db writers — must NOT be used by grantFromSession.
    outerUpdate: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    outerInsert: vi.fn(() => ({ values: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) })) })),
    transaction: vi.fn(),
    trxUpdate, trxSet, trxWhere, trxInsert, trxValues, trxOnConflict,
  };
});

vi.mock('../../../db/index.js', () => ({
  db: {
    query: {
      billing_transactions: { findFirst: mocks.findFirst },
    },
    update: mocks.outerUpdate,
    insert: mocks.outerInsert,
    transaction: mocks.transaction,
  },
}));

vi.mock('../../../db/schema.js', () => ({
  users: Symbol('users'),
  projects: Symbol('projects'),
  playlists: Symbol('playlists'),
  billing_transactions: { id: 'id', stripe_payment_intent_id: 'stripe_payment_intent_id' },
  user_purchases: { user_id: 'user_id' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({ type: 'eq' })),
  and: vi.fn(() => ({ type: 'and' })),
}));

vi.mock('stripe', () => ({ default: class {} }));

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { BillingService } from '../BillingService.js';

function makeSession(metadata: Record<string, string> | undefined): Stripe.Checkout.Session {
  return { metadata, payment_intent: 'pi_123' } as unknown as Stripe.Checkout.Session;
}

const PENDING_TX = {
  id: 'tx-1',
  status: 'pending',
  payer_user_id: 'user-1',
  content_type: 'project',
  content_id: 'proj-1',
  amount_cents: 500,
  currency: 'usd',
};

describe('BillingService.grantFromSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The transaction runs its callback with our trx handle.
    mocks.transaction.mockImplementation(async (cb: (trx: unknown) => Promise<void>) =>
      cb({ update: mocks.trxUpdate, insert: mocks.trxInsert }),
    );
  });

  it('performs BOTH writes inside the same transaction on the trx handle', async () => {
    mocks.findFirst.mockResolvedValue(PENDING_TX);

    await BillingService.grantFromSession(makeSession({ transactionId: 'tx-1' }));

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    // Both writes went through the trx handle...
    expect(mocks.trxUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.trxInsert).toHaveBeenCalledTimes(1);
    // ...and NEVER through the outer db (which would break atomicity).
    expect(mocks.outerUpdate).not.toHaveBeenCalled();
    expect(mocks.outerInsert).not.toHaveBeenCalled();
  });

  it('returns early (no transaction) when the transaction is already succeeded', async () => {
    mocks.findFirst.mockResolvedValue({ ...PENDING_TX, status: 'succeeded' });

    await BillingService.grantFromSession(makeSession({ transactionId: 'tx-1' }));

    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.trxUpdate).not.toHaveBeenCalled();
    expect(mocks.trxInsert).not.toHaveBeenCalled();
  });

  it('returns early when the session metadata has no transactionId', async () => {
    await BillingService.grantFromSession(makeSession(undefined));

    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
