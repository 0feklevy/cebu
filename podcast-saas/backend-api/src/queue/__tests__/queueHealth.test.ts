import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readQueueDepths } from '../queueHealth.js';
import { PGBOSS_JOB_NAMES, deadLetterName } from '../pgBoss.js';

/**
 * job-queue-009 — the dead-letter queues were created and NOTHING EVER READ THEM.
 *
 * `ensureQueues` pairs every durable queue with a `<name>-dead` queue, so a job that exhausts its
 * retries is copied there instead of vanishing. That is only half a system: no code, no endpoint
 * and no log line ever looked at those queues, so a poison job — an export that fails the same way
 * on every attempt, a transcode whose source is corrupt — left the live queue silently and sat in
 * a table nobody queried. The user's row stays "processing" forever and the operator has no way to
 * find out, short of knowing the pgboss schema by hand.
 *
 * `readQueueDepths` is the reader. It must report the dead-letter depth ALONGSIDE the live one,
 * because a dead-letter count is only meaningful next to what is still moving.
 */

vi.mock('../pgBoss.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pgBoss.js')>();
  return { ...actual, getBoss: vi.fn() };
});

const { getBoss } = await import('../pgBoss.js');
const mockGetBoss = vi.mocked(getBoss);

/**
 * pg-boss returns ONLY the queues you name. Modelling that is what makes these tests able to fail
 * for the actual bug: a reader that asks for the live queues alone gets no dead-letter rows back,
 * and a mock that ignored its argument would hand them over anyway and stay green.
 */
function onlyAsked(rows: Array<{ name: string }>) {
  return vi.fn(async (names?: string[]) =>
    names ? rows.filter((r) => names.includes(r.name)) : rows,
  );
}

function queueRow(name: string, over: Partial<Record<string, number>> = {}) {
  return {
    name,
    policy: 'standard',
    queuedCount: 0,
    deferredCount: 0,
    readyCount: 0,
    activeCount: 0,
    failedCount: 0,
    totalCount: 0,
    ...over,
  };
}

describe('readQueueDepths', () => {
  const prevDriver = process.env.QUEUE_DRIVER;
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.QUEUE_DRIVER = 'pgboss';
  });
  afterEach(() => {
    if (prevDriver === undefined) delete process.env.QUEUE_DRIVER;
    else process.env.QUEUE_DRIVER = prevDriver;
  });

  it('reports the dead-letter depth for every durable queue', async () => {
    const rows = PGBOSS_JOB_NAMES.flatMap((n) => [
      queueRow(n, { readyCount: 1, activeCount: 1 }),
      queueRow(deadLetterName(n), { readyCount: n === 'crop' ? 4 : 0 }),
    ]);
    mockGetBoss.mockResolvedValue({ getQueues: onlyAsked(rows) } as never);

    const depths = await readQueueDepths();

    expect(depths).not.toBeNull();
    expect(Object.keys(depths!.queues).sort()).toEqual([...PGBOSS_JOB_NAMES].sort());
    expect(depths!.queues.crop.dead_letter).toBe(4);
    expect(depths!.queues.crop.ready).toBe(1);
    expect(depths!.queues.crop.active).toBe(1);
    // The headline number an operator scans for: anything in ANY dead-letter queue.
    expect(depths!.dead_letter_total).toBe(4);
  });

  it('a poison job in ANY dead-letter queue shows in the total', async () => {
    const rows = PGBOSS_JOB_NAMES.flatMap((n) => [
      queueRow(n),
      queueRow(deadLetterName(n), { readyCount: n === 'project_export' ? 1 : 0 }),
    ]);
    mockGetBoss.mockResolvedValue({ getQueues: onlyAsked(rows) } as never);

    const depths = await readQueueDepths();
    expect(depths!.dead_letter_total).toBe(1);
    expect(depths!.queues.project_export.dead_letter).toBe(1);
  });

  it('asks pg-boss for the dead-letter queues by name — not just the live ones', async () => {
    const getQueues = vi.fn().mockResolvedValue([]);
    mockGetBoss.mockResolvedValue({ getQueues } as never);

    await readQueueDepths();

    const asked = getQueues.mock.calls[0][0] as string[];
    for (const n of PGBOSS_JOB_NAMES) {
      expect(asked, `${n} live queue not queried`).toContain(n);
      expect(asked, `${n} DEAD-LETTER queue not queried — the whole point`).toContain(deadLetterName(n));
    }
  });

  it('returns null rather than throwing when pg-boss is unavailable', async () => {
    // The stats endpoint must still answer for everything else; a queue we cannot reach is
    // reported as absent, not as a 500.
    mockGetBoss.mockRejectedValue(new Error('no database'));
    await expect(readQueueDepths()).resolves.toBeNull();
  });

  it('returns null on the inline driver instead of starting pg-boss to ask', async () => {
    const prev = process.env.QUEUE_DRIVER;
    process.env.QUEUE_DRIVER = 'inline';
    try {
      const depths = await readQueueDepths();
      expect(depths).toBeNull();
      expect(mockGetBoss).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.QUEUE_DRIVER;
      else process.env.QUEUE_DRIVER = prev;
    }
  });
});

describe('the operator can actually see it', () => {
  it('the admin stats endpoint returns the queue depths', async () => {
    const { readFileSync } = await import('node:fs');
    const controller = readFileSync(
      new URL('../../controllers/admin/v1/pipeline-stats.controller.ts', import.meta.url),
      'utf8',
    );
    expect(controller, 'nothing surfaces the dead-letter depth to an operator')
      .toMatch(/readQueueDepths\(\)/);
    // …and it has to reach the RESPONSE, not just be imported and dropped.
    const body = controller.slice(controller.indexOf('return reply.send('));
    expect(body, 'the depths are read but never sent to the operator')
      .toMatch(/queues:\s*queueDepths/);
  });
});
