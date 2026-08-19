/**
 * The sweep that finally CALLS `RevisionService.gc()`.
 *
 * gc() is the most carefully written reclaimer in this codebase — keep-floor of two so rollback
 * always has a target, an age grace so a mid-publish revision is never collected, rows deleted
 * before bytes so a crash leaves an orphan rather than a dangling pointer — and it had no
 * production caller at all. Two other files even assert that fact in comments. Every superseded
 * revision of every live simulation therefore accumulated forever; only deleting the simulation
 * or its project ever reclaimed them.
 *
 * Shape copied from the six sweeps registered beside it in server.ts: an unref'd interval plus an
 * immediate unref'd kick, errors logged and swallowed, a missing table (image booted before its
 * migration) logged at debug. Simulations are processed sequentially — this is a background
 * reclaimer on a 2-vCPU host, and a burst of parallel prefix deletes competing with live encodes
 * is exactly what it must not become.
 */
import { isNotNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { simulations } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { RevisionService, GC_MIN_KEEP } from './RevisionService.js';

export const REVISION_GC_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // four times a day is plenty

export async function sweepRevisionGc(): Promise<{ simulations: number; deleted: number }> {
  const sims = await db
    .select({ id: simulations.id, storage_prefix: simulations.storage_prefix })
    .from(simulations)
    .where(isNotNull(simulations.storage_prefix));

  let deleted = 0;
  const svc = new RevisionService();
  for (const sim of sims) {
    if (!sim.storage_prefix) continue;
    try {
      const res = await svc.gc({
        simulationId: sim.id,
        storagePrefix: sim.storage_prefix,
        keepLastN: GC_MIN_KEEP,
      });
      deleted += res.deleted.length;
    } catch (err) {
      // One simulation's failure must not starve the rest of the sweep.
      logger.warn({ err, simulationId: sim.id }, 'revision gc: simulation skipped');
    }
  }
  if (deleted > 0) logger.info({ simulations: sims.length, deleted }, 'revision gc: collected superseded revisions');
  return { simulations: sims.length, deleted };
}

export function startRevisionGcSweep(intervalMs = REVISION_GC_SWEEP_INTERVAL_MS): () => void {
  const run = (): void => {
    void sweepRevisionGc().catch((err: unknown) => {
      const code = (err as { code?: string } | null)?.code;
      if (code === '42P01') {
        logger.debug('revision gc sweep: table not migrated yet, nothing to collect');
        return;
      }
      logger.error({ err }, 'revision gc sweep failed');
    });
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  const kick = setTimeout(run, 0);
  if (typeof kick.unref === 'function') kick.unref();
  return () => { clearInterval(timer); clearTimeout(kick); };
}
