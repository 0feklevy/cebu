/**
 * observability-008 — a health check that can be red for the reason work actually dies.
 *
 * WHAT THE OLD ONE PROVED. `SELECT 1` reached Postgres. That is exactly the right question for a
 * load balancer and the wrong one for a human, because on this system almost nothing dies in the
 * web tier. Work dies in the queue, and two total, silent losses of a feature were invisible:
 *
 *   • QUEUE_DRIVER left at its `inline` default. `queue/index.ts` refuses to enqueue an export
 *     without the durable driver (`ExportQueueUnavailable`), so every export 503s forever — while
 *     /health answered `{"status":"ok"}`.
 *   • pg-boss configured and nothing consuming it: no worker service, WORKER_INLINE unset, or a
 *     worker that died. Jobs accumulate in `created` and no component anywhere notices.
 *
 * WHY THE STATUS CODE STILL ONLY GRADES THE DATABASE. server.ts documents that a 503 here makes
 * the platform load balancer pull the instance. A stalled queue means the WORKER is unwell; the
 * API is serving fine. Answering 503 for it would take the healthy web tier out of rotation and
 * convert a background-job incident into a site outage — and, with every instance failing the same
 * check simultaneously, into a total one. So:
 *
 *   GET /health        — liveness. 200/503 on "can this process serve a request" (the database).
 *                        The BODY reports every subsystem, including a `status` that goes
 *                        `degraded` for queue faults.
 *   GET /health/ready  — the strict aggregate: 200 only when everything is well. This is what a
 *                        human or an alerting rule should watch. It must NOT be wired to the LB.
 *
 * The queue is read with a plain SQL count rather than through pg-boss: calling `getBoss()` from a
 * health check would START pg-boss inside the web process as a side effect of being asked how it
 * is, which is not something a health check may do.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db, checkDatabaseConnection } from '../../db/index.js';
import { logger } from '../../lib/logger.js';

/**
 * How long a job may sit READY (not delayed, not backing off) before we call the queue stalled.
 * Five minutes: long enough that a normal burst of work drains, short enough that a dead worker is
 * caught inside one on-call response.
 */
export const QUEUE_STALL_DEFAULT_SECONDS = 300;

/** Only ever our own configured schema, but interpolated into SQL, so it must be an identifier. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export type SubsystemStatus = 'ok' | 'degraded' | 'down' | 'unknown';

/** Where the pg-boss consumers for this deployment run, as far as configuration can say. */
export type WorkerMode =
  | 'inline'      // no durable queue at all: jobs run in the web process via setImmediate
  | 'in_process'  // pg-boss workers started inside this process (WORKER_INLINE=1)
  | 'external';   // a separate `npm run worker` service is expected to consume the queues

export interface QueueHealth {
  status: SubsystemStatus;
  driver: string;
  waiting: number;
  active: number;
  oldestWaitingSec: number;
  workerMode?: WorkerMode;
  /** A short machine-readable cause, when not ok. */
  reason?: string;
}

/** Runs one SQL statement and returns its rows. Injectable so the aggregation can be tested. */
export type RunSql = (query: ReturnType<typeof sql>) => Promise<Array<Record<string, unknown>>>;

const defaultRunSql: RunSql = async (query) =>
  (await db.execute(query)) as unknown as Array<Record<string, unknown>>;

function workerModeFor(env: NodeJS.ProcessEnv): WorkerMode {
  if ((env.QUEUE_DRIVER ?? 'inline').toLowerCase() !== 'pgboss') return 'inline';
  return env.WORKER_INLINE === '1' ? 'in_process' : 'external';
}

/**
 * Queue depth and whether anything is draining it.
 *
 * "Waiting" deliberately means READY TO RUN — `state in ('created','retry')` AND
 * `start_after <= now()`. A job in retry backoff, or one deliberately scheduled for later, is
 * waiting by design and must not read as a stall.
 *
 * And a deep queue on its own is NOT a fault: an export burst is a busy system, not a broken one.
 * The fault condition is "the oldest ready job is old AND nothing is active", which is what a dead
 * or disconnected consumer looks like from here.
 */
export async function probeQueue(
  env: NodeJS.ProcessEnv = process.env,
  runSql: RunSql = defaultRunSql,
): Promise<QueueHealth> {
  const driver = (env.QUEUE_DRIVER ?? 'inline').toLowerCase();
  const workerMode = workerModeFor(env);
  const base = { driver, waiting: 0, active: 0, oldestWaitingSec: 0, workerMode };

  if (driver !== 'pgboss') {
    // Not "ok". Exports are impossible in this configuration and the whole point of this check is
    // that the system used to answer "ok" while a headline feature could not run at all.
    return { ...base, status: 'degraded', reason: 'durable_queue_disabled' };
  }

  const schema = env.QUEUE_PGBOSS_SCHEMA ?? 'pgboss';
  if (!IDENTIFIER_RE.test(schema)) {
    return { ...base, status: 'down', reason: 'queue_schema_invalid' };
  }

  const stallAfter = Number(env.QUEUE_STALL_SECONDS ?? QUEUE_STALL_DEFAULT_SECONDS);
  const stallSeconds = Number.isFinite(stallAfter) && stallAfter > 0 ? stallAfter : QUEUE_STALL_DEFAULT_SECONDS;

  try {
    const rows = await runSql(sql`
      SELECT
        count(*) FILTER (WHERE state IN ('created', 'retry') AND start_after <= now())::int AS waiting,
        count(*) FILTER (WHERE state = 'active')::int AS active,
        COALESCE(
          EXTRACT(EPOCH FROM (now() - min(created_on) FILTER (WHERE state IN ('created', 'retry') AND start_after <= now())))::int,
          0
        ) AS oldest_waiting_sec
      FROM ${sql.identifier(schema)}.job
    `);
    const row = rows[0] ?? {};
    const waiting = Number(row.waiting ?? 0);
    const active = Number(row.active ?? 0);
    const oldestWaitingSec = Number(row.oldest_waiting_sec ?? 0);
    const stalled = oldestWaitingSec > stallSeconds && active === 0;
    return {
      ...base,
      waiting,
      active,
      oldestWaitingSec,
      status: stalled ? 'degraded' : 'ok',
      ...(stalled ? { reason: 'queue_stalled' } : {}),
    };
  } catch (err) {
    // Cannot read the queue at all — a missing pgboss schema, a permissions problem, a dead
    // connection. Reporting 0/0/ok here would be the single most dangerous answer available.
    logger.warn({ err, evt: 'health_queue_probe_failed' }, '[Health] could not read queue depth');
    return { ...base, status: 'down', reason: 'queue_unreadable' };
  }
}

export interface HealthProbes {
  database: () => Promise<void>;
  queue: () => Promise<QueueHealth>;
}

const defaultProbes: HealthProbes = {
  database: checkDatabaseConnection,
  queue: () => probeQueue(),
};

interface Report {
  liveStatus: number;
  readyStatus: number;
  body: Record<string, unknown>;
}

async function collect(probes: HealthProbes): Promise<Report> {
  const startedAt = performance.now();
  let database: Record<string, unknown>;
  let dbOk = false;
  try {
    await probes.database();
    dbOk = true;
    database = { status: 'ok', latencyMs: Math.round(performance.now() - startedAt) };
  } catch {
    database = { status: 'down' };
  }

  let queue: QueueHealth;
  try {
    queue = await probes.queue();
  } catch (err) {
    // A health check may never fail because its own instrumentation failed.
    logger.warn({ err, evt: 'health_queue_probe_threw' }, '[Health] queue probe threw');
    queue = { status: 'unknown', driver: 'unknown', waiting: 0, active: 0, oldestWaitingSec: 0 };
  }

  const { workerMode, ...queueFields } = queue;
  const mode: WorkerMode | 'unknown' = workerMode ?? 'unknown';
  const worker = {
    mode,
    // The web process can only see a worker it hosts itself. For an external worker the queue
    // depth IS the observation — hence `queue_stalled` above rather than a fabricated ping.
    status: queue.status === 'ok' ? 'ok' : queue.status,
    ...(queue.reason ? { reason: queue.reason } : {}),
  };

  const everythingOk = dbOk && queue.status === 'ok';
  const body = {
    status: everythingOk ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    // APP_VERSION is the image tag the deploy started this container from (docker-compose.yml).
    // `npm_package_version` is set ONLY when a process is started through npm/pnpm, and production
    // runs `node dist/server.js` directly — so this field reported the literal fallback forever,
    // before and after every release, and the only way to confirm a deploy had landed was to probe
    // a route added by it. First real value wins; the fallback stays for local runs.
    version: process.env.APP_VERSION || process.env.npm_package_version || '0.1.0',
    checks: {
      database,
      queue: queueFields,
      worker,
      capabilities: {
        // Named because its absence is silent: `enqueueProjectExport` throws
        // ExportQueueUnavailable whenever the durable driver is off, so every export fails and
        // nothing else in the system reports it.
        durableExport: queue.driver === 'pgboss',
      },
    },
  };

  return {
    // Liveness: only what decides whether THIS process can serve a request.
    liveStatus: dbOk ? 200 : 503,
    // Readiness: the strict aggregate.
    readyStatus: everythingOk ? 200 : 503,
    body,
  };
}

/** Register `/health` (liveness) and `/health/ready` (strict). */
export function registerHealthRoutes(app: FastifyInstance, probes: HealthProbes = defaultProbes): void {
  app.get('/health', async (_req, reply) => {
    const report = await collect(probes);
    return reply.code(report.liveStatus).send(report.body);
  });

  app.get('/health/ready', async (_req, reply) => {
    const report = await collect(probes);
    return reply.code(report.readyStatus).send(report.body);
  });
}
