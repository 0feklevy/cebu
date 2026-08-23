/**
 * observability-008 — the health check must be able to be RED for the reason work actually dies.
 *
 * The old `/health` proved one thing: a `SELECT 1` reached Postgres. That is genuinely useful to a
 * load balancer and useless to a human at 3am, because on this system work does not die in the web
 * tier — it dies in the queue. Two failures were fully invisible and both are silent, total losses
 * of a feature:
 *
 *   • QUEUE_DRIVER left at its `inline` default. `enqueueProjectExport` refuses outright
 *     (`ExportQueueUnavailable`), so every export 503s forever, and /health said "ok".
 *   • pg-boss configured but nothing consuming the queues — no worker process, or one that died.
 *     Jobs pile up in `created` and nothing anywhere notices. /health said "ok".
 *
 * The other half of the design is the STATUS CODE, and it is deliberately narrow. The existing
 * comment in server.ts says the LB pulls an instance on 503. Returning 503 because the queue is
 * backed up would take the API — which is serving fine — out of rotation over a WORKER problem,
 * turning a background-job incident into a site outage. So `/health` keeps grading only what
 * decides whether this process can serve a request, and `/health/ready` is the strict one for
 * humans and alerting.
 */
import {describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerHealthRoutes, probeQueue, QUEUE_STALL_DEFAULT_SECONDS } = await import('../health.controller.js');

type Json = Record<string, unknown>;

async function appWith(probes: Parameters<typeof registerHealthRoutes>[1]): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerHealthRoutes(app, probes);
  await app.ready();
  return app;
}

const dbOk = async () => {};
const dbDown = async () => { throw new Error('connection refused'); };

const queueOk = async () => ({
  status: 'ok' as const, driver: 'pgboss', waiting: 2, active: 1, oldestWaitingSec: 3,
});

describe('GET /health — liveness for the load balancer', () => {
  it('is 200 and reports every subsystem, not just the database', async () => {
    const app = await appWith({ database: dbOk, queue: queueOk });
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body.status).toBe('ok');
    expect(body).toHaveProperty('timestamp');
    expect(body).toHaveProperty('version');
    const checks = body.checks as Json;
    expect(checks.database, 'the database check disappeared').toMatchObject({ status: 'ok' });
    expect(checks.queue, 'the queue is invisible — this is where work dies').toMatchObject({ status: 'ok', waiting: 2 });
    expect(checks.worker, 'nothing says whether anything is consuming the queue').toBeTruthy();
    await app.close();
  });

  it('is 503 when the database is unreachable — unchanged, the LB depends on it', async () => {
    const app = await appWith({ database: dbDown, queue: queueOk });
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Json;
    expect(body.status).toBe('degraded');
    expect((body.checks as Json).database).toMatchObject({ status: 'down' });
    await app.close();
  });

  it('reports a stalled queue as degraded in the BODY but keeps serving traffic', async () => {
    // A backed-up worker must not pull the API out of rotation: the web tier is healthy, and
    // taking it offline turns a job incident into a site outage.
    const app = await appWith({
      database: dbOk,
      queue: async () => ({ status: 'degraded' as const, driver: 'pgboss', waiting: 91, active: 0, oldestWaitingSec: 1800, reason: 'queue_stalled' }),
    });
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode, 'a queue backlog took the whole API out of the load balancer').toBe(200);
    const body = res.json() as Json;
    expect(body.status, 'the body still claims everything is fine').toBe('degraded');
    expect((body.checks as Json).queue).toMatchObject({ status: 'degraded', reason: 'queue_stalled' });
    await app.close();
  });

  it('says so when the durable queue is switched off entirely — exports cannot run at all', async () => {
    const app = await appWith({
      database: dbOk,
      // Exactly what `probeQueue({})` returns — see the probeQueue block at the bottom.
      queue: async () => ({ status: 'degraded' as const, driver: 'inline', waiting: 0, active: 0, oldestWaitingSec: 0, workerMode: 'inline' as const, reason: 'durable_queue_disabled' }),
    });
    const body = (await app.inject({ url: '/health' })).json() as Json;
    const checks = body.checks as Json;
    expect((checks.worker as Json).mode).toBe('inline');
    expect((checks.capabilities as Json).durableExport, 'exports are impossible and nothing said so').toBe(false);
    await app.close();
  });

  it('never throws its own way to a 500, even if a probe explodes', async () => {
    const app = await appWith({
      database: dbOk,
      queue: async () => { throw new Error('probe blew up'); },
    });
    const res = await app.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(((res.json() as Json).checks as Json).queue).toMatchObject({ status: 'unknown' });
    await app.close();
  });
});

describe('GET /health/ready — the strict one, for humans and alerting', () => {
  it('is 200 only when everything is ok', async () => {
    const app = await appWith({ database: dbOk, queue: queueOk });
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(200);
    await app.close();
  });

  it('is 503 when the queue is stalled, even though the API itself is fine', async () => {
    const app = await appWith({
      database: dbOk,
      queue: async () => ({ status: 'degraded' as const, driver: 'pgboss', waiting: 91, active: 0, oldestWaitingSec: 1800, reason: 'queue_stalled' }),
    });
    const res = await app.inject({ url: '/health/ready' });
    expect(res.statusCode, 'readiness is green while nothing is consuming the queue').toBe(503);
    expect((res.json() as Json).status).toBe('degraded');
    await app.close();
  });

  it('is 503 when the database is down', async () => {
    const app = await appWith({ database: dbDown, queue: queueOk });
    expect((await app.inject({ url: '/health/ready' })).statusCode).toBe(503);
    await app.close();
  });
});

describe('probeQueue', () => {
  const rows = (waiting: number, active: number, oldest: number) =>
    vi.fn(async () => [{ waiting, active, oldest_waiting_sec: oldest }]);

  it('reports the inline default as a DISABLED durable queue, not as healthy', async () => {
    // The single most likely production misconfiguration: QUEUE_DRIVER simply unset.
    const run = vi.fn();
    const out = await probeQueue({}, run as never);
    expect(out.driver).toBe('inline');
    expect(out.status).toBe('degraded');
    expect(out.reason).toBe('durable_queue_disabled');
    expect(run, 'it queried the pg-boss tables even though pg-boss is not in use').not.toHaveBeenCalled();
  });

  it('reads waiting/active depth for pg-boss', async () => {
    const out = await probeQueue({ QUEUE_DRIVER: 'pgboss' }, rows(4, 2, 9) as never);
    expect(out).toMatchObject({ status: 'ok', driver: 'pgboss', waiting: 4, active: 2, oldestWaitingSec: 9 });
  });

  it('calls a queue whose oldest READY job has aged past the threshold stalled', async () => {
    const out = await probeQueue({ QUEUE_DRIVER: 'pgboss' }, rows(12, 0, QUEUE_STALL_DEFAULT_SECONDS + 1) as never);
    expect(out.status).toBe('degraded');
    expect(out.reason).toBe('queue_stalled');
  });

  it('does NOT call a deep queue stalled while the worker is visibly chewing through it', async () => {
    // Backlog alone is not a fault — a big export burst is a busy system, not a broken one. The
    // fault is "ready jobs are old AND nothing is running".
    const out = await probeQueue({ QUEUE_DRIVER: 'pgboss' }, rows(500, 3, QUEUE_STALL_DEFAULT_SECONDS + 1) as never);
    expect(out.status).toBe('ok');
  });

  it('honours QUEUE_STALL_SECONDS', async () => {
    const out = await probeQueue({ QUEUE_DRIVER: 'pgboss', QUEUE_STALL_SECONDS: '10' }, rows(1, 0, 11) as never);
    expect(out.status).toBe('degraded');
  });

  it('reports an unreachable queue as down rather than pretending it is empty', async () => {
    const out = await probeQueue({ QUEUE_DRIVER: 'pgboss' }, (async () => { throw new Error('relation "pgboss.job" does not exist'); }) as never);
    expect(out.status).toBe('down');
    expect(out.reason).toBe('queue_unreadable');
  });

  it('refuses a schema name that is not an identifier instead of interpolating it', async () => {
    const run = vi.fn();
    const out = await probeQueue({ QUEUE_DRIVER: 'pgboss', QUEUE_PGBOSS_SCHEMA: 'pgboss"; DROP TABLE users; --' }, run as never);
    expect(out.status).toBe('down');
    expect(out.reason).toBe('queue_schema_invalid');
    expect(run).not.toHaveBeenCalled();
  });

  it('describes where the worker runs, because that is the first question asked', async () => {
    expect((await probeQueue({ QUEUE_DRIVER: 'pgboss', WORKER_INLINE: '1' }, rows(0, 0, 0) as never)).workerMode).toBe('in_process');
    expect((await probeQueue({ QUEUE_DRIVER: 'pgboss' }, rows(0, 0, 0) as never)).workerMode).toBe('external');
    expect((await probeQueue({}, vi.fn() as never)).workerMode).toBe('inline');
  });
});
