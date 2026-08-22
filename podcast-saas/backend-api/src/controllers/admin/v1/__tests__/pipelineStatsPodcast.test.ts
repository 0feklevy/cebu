/**
 * observability-006 — the podcast pipeline reported nothing above queue depth.
 *
 * When a render failed, its row went to `status: 'failed'` with a reason in `error`, and no
 * endpoint anywhere read either column. The only way to learn that renders were failing was for a
 * customer to say so. Queue depth cannot stand in for this: a job that ran and failed leaves the
 * queue EMPTY, which reads as a healthy system doing no work.
 *
 * These tests are about the two distinctions that make the new numbers worth trusting — a rate
 * rather than a count, and null rather than zero when there is no evidence. Both are the kind of
 * thing that looks like a detail in review and decides whether a dashboard lies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Row { status: string; count: number }

/** What each query in the Promise.all should resolve to, in order. */
let queue: unknown[] = [];

vi.mock('../../../../db/index.js', () => ({
  db: {
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        groupBy: () => chain,
        // Awaiting the builder is what actually runs it, so `then` is where a result is handed
        // back — the same shape drizzle presents.
        then: (resolve: (v: unknown) => void) => resolve(queue.shift() ?? []),
      };
      return chain;
    },
  },
}));
vi.mock('../../../../db/schema.js', () => {
  const table = (cols: string[]) => Object.fromEntries(cols.map((c) => [c, c]));
  return {
    projects: table(['created_at', 'view_count']),
    video_files: table(['hls_status']),
    simulations: table(['status']),
    token_usage: table(['occurred_at', 'task']),
    playlists: table(['view_count']),
    users: table(['created_at']),
    billing_transactions: table(['type', 'status']),
    podcast_renders: table(['status', 'created_at', 'duration_ms', 'cost_cents']),
    podcast_scripts: table(['status']),
  };
});
vi.mock('drizzle-orm', () => ({
  eq: vi.fn(() => ({})),
  and: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
  sql: Object.assign(
    vi.fn(() => ({})),
    { raw: vi.fn() },
  ),
}));
vi.mock('../../../../middleware/firebase-admin-required.js', () => ({ firebaseAdminRequired: vi.fn() }));
vi.mock('../../../../queue/queueHealth.js', () => ({ readQueueDepths: async () => null }));

const { registerAdminPipelineStatsRoutes } = await import('../pipeline-stats.controller.js');

/** The eleven pre-existing queries, then the four podcast ones this file is about. */
function withPodcast(opts: {
  renders?: Row[];
  duration?: { count: number; avg_ms: number; p50_ms: number; p95_ms: number; cost_cents: number };
  recent?: Row[];
  scripts?: Row[];
}) {
  queue = [
    [{ count: 0 }], [{ count: 0 }], [{ total: 0 }], [{ total: 0 }], [], [],
    [{ input_tokens: 0, output_tokens: 0, cost_cents: 0, count: 0 }],
    [{ count: 0 }], [{ count: 0 }],
    [{ sales: 0, gross_cents: 0, payout_cents: 0, fee_cents: 0 }],
    opts.renders ?? [],
    [opts.duration ?? { count: 0, avg_ms: 0, p50_ms: 0, p95_ms: 0, cost_cents: 0 }],
    opts.recent ?? [],
    opts.scripts ?? [],
  ];
}

/** Register the route, invoke it, and hand back the JSON it sent. */
async function callEndpoint(): Promise<Record<string, never> & { podcast: Podcast }> {
  let handler!: (req: unknown, reply: unknown) => Promise<unknown>;
  const app = { get: (_p: string, _o: unknown, h: typeof handler) => { handler = h; } };
  await registerAdminPipelineStatsRoutes(app as never);
  let body: unknown;
  await handler({}, { send: (b: unknown) => { body = b; return b; } });
  return body as never;
}

interface Podcast {
  renders: {
    total: number;
    by_status: Record<string, number>;
    failure_rate: number | null;
    recent_30d: { total: number; by_status: Record<string, number>; failure_rate: number | null };
    duration_ms: { completed: number; avg: number; p50: number; p95: number };
    cost_cents: number;
  };
  scripts: { total: number; by_status: Record<string, number>; failure_rate: number | null };
}

beforeEach(() => { queue = []; });

describe('the podcast pipeline finally says something about itself', () => {
  it('reports every render status, including the ones at zero', async () => {
    // A status ABSENT from the response and a status at zero look identical on a dashboard and
    // mean opposite things: "nothing has ever failed" versus "this build stopped reporting
    // failures". Every known status is therefore always present.
    withPodcast({ renders: [{ status: 'ready', count: 7 }] });
    const { podcast } = await callEndpoint();
    expect(Object.keys(podcast.renders.by_status).sort()).toEqual(
      ['encoding', 'failed', 'queued', 'ready', 'stitching', 'synthesizing'],
    );
    expect(podcast.renders.by_status.failed).toBe(0);
    expect(podcast.renders.total).toBe(7);
  });

  it('passes through a status nobody expected rather than dropping it', async () => {
    // A status the database holds and this code does not know about is the most interesting thing
    // on the page — usually a migration that landed without its reader. Dropping it would hide
    // exactly the surprise worth surfacing, and the totals would stop adding up with no
    // explanation visible anywhere.
    withPodcast({ renders: [{ status: 'ready', count: 2 }, { status: 'quarantined', count: 5 }] });
    const { podcast } = await callEndpoint();
    expect(podcast.renders.by_status.quarantined).toBe(5);
    expect(podcast.renders.total).toBe(7);
  });
});

describe('a failure RATE, because a failure count answers nothing', () => {
  it('divides failures by SETTLED renders, not by everything ever queued', async () => {
    // Twelve failures is either a catastrophe or a rounding error and the number alone cannot say
    // which. The denominator must also exclude work still in flight: counting queued jobs would
    // make the rate IMPROVE every time the pipeline backs up, which is precisely backwards.
    withPodcast({
      renders: [
        { status: 'ready', count: 6 },
        { status: 'failed', count: 2 },
        { status: 'queued', count: 92 },      // in flight — has not failed yet
        { status: 'synthesizing', count: 10 },
      ],
    });
    const { podcast } = await callEndpoint();
    // 2 failed / 8 settled — NOT 2/110, which would report 1.8% while a quarter of finished
    // renders were failing.
    expect(podcast.renders.failure_rate).toBe(0.25);
  });

  it('is null, never 0, when nothing has settled', async () => {
    // Zero would claim a healthy pipeline on the strength of no evidence at all. That is the
    // same class of lie as an audit reporting "0 failures" for a suite that never ran.
    withPodcast({ renders: [{ status: 'queued', count: 4 }] });
    const { podcast } = await callEndpoint();
    expect(podcast.renders.failure_rate).toBeNull();
  });

  it('is 0 when renders HAVE settled and none of them failed', async () => {
    // The other half of the distinction: this really is evidence of health, and must be
    // distinguishable from the absence of evidence above.
    withPodcast({ renders: [{ status: 'ready', count: 5 }] });
    const { podcast } = await callEndpoint();
    expect(podcast.renders.failure_rate).toBe(0);
  });

  it('reports the last 30 days separately from all time', async () => {
    // A lifetime rate is dominated by whatever the pipeline was doing months ago, and moves far
    // too slowly to show a regression that started on Tuesday. The two must be able to disagree.
    withPodcast({
      renders: [{ status: 'ready', count: 900 }, { status: 'failed', count: 4 }],
      recent: [{ status: 'ready', count: 1 }, { status: 'failed', count: 9 }],
    });
    const { podcast } = await callEndpoint();
    expect(podcast.renders.failure_rate).toBeLessThan(0.01);
    expect(podcast.renders.recent_30d.failure_rate).toBe(0.9);
    // The COUNTS have to come from the windowed query too, not only the rate. Wiring the recent
    // block's `by_status` to the all-time tally left the rate correct and the breakdown beside it
    // wrong — a surviving mutation, and the kind of thing a reader would trust precisely because
    // the headline number next to it is right.
    expect(podcast.renders.recent_30d.by_status).toEqual({
      queued: 0, synthesizing: 0, stitching: 0, encoding: 0, ready: 1, failed: 9,
    });
    expect(podcast.renders.recent_30d.total).toBe(10);
    expect(podcast.renders.by_status.ready).toBe(900);
  });
});

describe('duration, over the renders that actually finished', () => {
  it('reports p50 and p95 beside the mean', async () => {
    // A mean of 90s with a p95 of twenty minutes is a different product from a mean of 90s with a
    // p95 of two minutes, and the mean alone cannot tell them apart. The tail is what users
    // notice and what a mean is specifically bad at showing.
    withPodcast({ duration: { count: 20, avg_ms: 90_000, p50_ms: 61_000, p95_ms: 1_200_000, cost_cents: 350 } });
    const { podcast } = await callEndpoint();
    expect(podcast.renders.duration_ms).toEqual({ completed: 20, avg: 90_000, p50: 61_000, p95: 1_200_000 });
    expect(podcast.renders.cost_cents).toBe(350);
  });

  it('reports zeroes with a completed count of 0 rather than pretending', async () => {
    // `completed: 0` is what makes the zeroes readable. Without it, a fresh install and a broken
    // duration column look the same.
    withPodcast({});
    const { podcast } = await callEndpoint();
    expect(podcast.renders.duration_ms.completed).toBe(0);
    expect(podcast.renders.duration_ms.p95).toBe(0);
  });
});

describe('scripts, because a failed writers-room run never reaches the renderer', () => {
  it('reports script statuses and their own failure rate', async () => {
    // A render-only view would show a quiet, healthy pipeline producing nothing at all, because
    // the work died a stage earlier and left no render row to count.
    withPodcast({ scripts: [{ status: 'ready', count: 3 }, { status: 'failed', count: 1 }] });
    const { podcast } = await callEndpoint();
    expect(podcast.scripts.total).toBe(4);
    expect(podcast.scripts.by_status.approved).toBe(0);
    expect(podcast.scripts.failure_rate).toBe(0.25);
  });
});

describe('the existing metrics still answer', () => {
  it('adding the podcast block did not disturb what was already there', async () => {
    withPodcast({});
    const body = (await callEndpoint()) as unknown as Record<string, unknown>;
    for (const key of ['queues', 'projects', 'videos', 'simulations', 'ai_extraction', 'users', 'revenue']) {
      expect(body[key], `${key} disappeared from pipeline-stats`).toBeDefined();
    }
  });
});
