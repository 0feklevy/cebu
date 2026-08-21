/**
 * The cluster-wide dubbing concurrency gate.
 *
 * WHY THIS IS NOT `localConcurrency`. The vendor allows 3 concurrent dubbing jobs PER WORKSPACE,
 * counted per model, and this deployment is a single workspace — so every tenant's dubs contend for
 * the same three slots, and one tenant's 90-minute course must not be able to lock everyone else
 * out. pg-boss's `localConcurrency` is a PER-PROCESS number: two worker containers each set to
 * "one at a time" are two concurrent jobs, not one. Any bound that lives in a process cannot
 * express a limit that belongs to an account.
 *
 * WHY NOT "COUNT THE BUSY ONES, THEN TAKE ONE IF THERE IS ROOM". That is a read-then-write race:
 * two workers both read 2, both decide there is room, and the vendor answers the fourth request
 * with `too_many_concurrent_requests`. `FOR UPDATE SKIP LOCKED` over fixed rows has no such gap —
 * two transactions cannot select the same row, and a worker that is handed nothing knows the pool
 * is genuinely full rather than merely appearing so.
 *
 * WHY A LEASE AND NOT A LOCK. A slot released only by a happy path is not released at all: a
 * worker killed mid-dub would hold its slot forever and the pool would shrink, permanently, with
 * no error anywhere. `expires_at` means the worst case is one lease period of reduced throughput.
 * `release()` is therefore an optimisation — it returns the slot early — never the correctness
 * mechanism. The same reasoning as `avatar_session_leases`.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { logger } from '../../lib/logger.js';

/**
 * How long a claimed slot stays claimed without being renewed.
 *
 * Sized above the worst plausible end-to-end dub — vendor queue, transcription, per-language
 * dubbing, download, mux and HLS — because a lease that expires under a job that is still running
 * lets a fourth request through and earns exactly the vendor error the pool exists to prevent.
 */
export const SLOT_LEASE_MS = 90 * 60 * 1000;

export interface DubbingSlot {
  slotNo: number;
}

/**
 * Take a slot, or return null when all three are busy.
 *
 * Null is an ordinary, expected answer — it means "the workspace is at its vendor ceiling, come
 * back later" — and the caller must treat it as a deferral, never as a failure of the dub.
 */
export async function acquireDubbingSlot(holder: string): Promise<DubbingSlot | null> {
  const expiresAt = new Date(Date.now() + SLOT_LEASE_MS);
  const rows = await db.execute(sql`
    UPDATE dubbing_slots
       SET holder = ${holder}, expires_at = ${expiresAt}, updated_at = now()
     WHERE slot_no = (
       SELECT slot_no FROM dubbing_slots
        WHERE holder IS NULL OR expires_at IS NULL OR expires_at < now()
        ORDER BY slot_no
          FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING slot_no
  `);
  const row = (rows as unknown as Array<{ slot_no: number }>)[0];
  if (!row) return null;
  return { slotNo: row.slot_no };
}

/**
 * Give a slot back early.
 *
 * Guarded on `holder` so a worker whose lease already expired — and whose slot has since been
 * handed to somebody else — cannot release a job that is still running. Never throws: failing to
 * return a slot early costs at most one lease period, and turning that into a job failure would
 * trade a small delay for a lost dub.
 */
export async function releaseDubbingSlot(slot: DubbingSlot, holder: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE dubbing_slots
         SET holder = NULL, expires_at = NULL, updated_at = now()
       WHERE slot_no = ${slot.slotNo} AND holder = ${holder}
    `);
  } catch (err) {
    logger.warn(
      { slotNo: slot.slotNo, err: (err as Error).message?.slice(0, 160) },
      '[dubbing] could not release slot early — it will expire on its own',
    );
  }
}

/**
 * Push a held slot's expiry out while a long job is still running.
 *
 * Guarded on `holder` for the same reason as `release`: a worker that has already lost its lease
 * must not be able to extend somebody else's. Returns whether the lease is still ours, so a caller
 * that has lost it can stop rather than carry on believing it holds a slot it does not.
 */
export async function renewDubbingSlot(slot: DubbingSlot, holder: string): Promise<boolean> {
  const expiresAt = new Date(Date.now() + SLOT_LEASE_MS);
  const rows = await db.execute(sql`
    UPDATE dubbing_slots
       SET expires_at = ${expiresAt}, updated_at = now()
     WHERE slot_no = ${slot.slotNo} AND holder = ${holder}
     RETURNING slot_no
  `);
  return (rows as unknown as unknown[]).length > 0;
}

/**
 * Run `task` holding a slot, or return `{ deferred: true }` when the pool is full.
 *
 * The slot is released in a `finally`, so a throwing task does not hold one until expiry — but the
 * expiry is what makes that safe rather than necessary.
 */
export async function withDubbingSlot<T>(
  holder: string,
  task: (slot: DubbingSlot) => Promise<T>,
): Promise<{ deferred: true } | { deferred: false; value: T }> {
  const slot = await acquireDubbingSlot(holder);
  if (!slot) return { deferred: true };
  try {
    return { deferred: false, value: await task(slot) };
  } finally {
    await releaseDubbingSlot(slot, holder);
  }
}
