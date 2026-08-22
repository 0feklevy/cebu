import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../../db/index.js';
import {
  projects, video_files, simulations, token_usage, playlists, users, billing_transactions,
  podcast_renders, podcast_scripts,
} from '../../../db/schema.js';
import { sql, gte, and, eq } from 'drizzle-orm';
import { firebaseAdminRequired } from '../../../middleware/firebase-admin-required.js';
import { readQueueDepths } from '../../../queue/queueHealth.js';

export async function registerAdminPipelineStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/v1/pipeline-stats',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      // Queue depth, including the DEAD-LETTER queues (job-queue-009). Those queues were created
      // and never read: a job that exhausted its retries was copied there and nothing — no code
      // path, no endpoint, no log line — ever looked. A poison export just stopped existing, while
      // the user's row said "processing" forever. `readQueueDepths` returns null rather than
      // throwing (or lying with zeroes) when the durable queue is not configured or unreachable,
      // so the rest of this response still answers.
      const [
        queueDepths,
        projectTotal,
        projectRecent,
        projectViews,
        playlistViews,
        videoRows,
        simRows,
        aiRows,
        userTotal,
        userRecent,
        revenueRows,
        renderRows,
        renderDurationRows,
        renderRecentRows,
        scriptRows,
      ] = await Promise.all([
        readQueueDepths(),
        db.select({ count: sql<number>`count(*)::int` }).from(projects),
        db.select({ count: sql<number>`count(*)::int` }).from(projects).where(gte(projects.created_at, since30d)),
        db.select({ total: sql<number>`coalesce(sum(view_count), 0)::int` }).from(projects),
        db.select({ total: sql<number>`coalesce(sum(view_count), 0)::int` }).from(playlists),
        db.select({ hls_status: video_files.hls_status, count: sql<number>`count(*)::int` })
          .from(video_files)
          .groupBy(video_files.hls_status),
        db.select({ status: simulations.status, count: sql<number>`count(*)::int` })
          .from(simulations)
          .groupBy(simulations.status),
        db.select({
          input_tokens: sql<number>`sum(input_tokens)::int`,
          output_tokens: sql<number>`sum(output_tokens)::int`,
          cost_cents: sql<number>`coalesce(sum(cost_cents),0)::float8`, // fractional cents (migration 046)
          count: sql<number>`count(*)::int`,
        })
          .from(token_usage)
          .where(and(gte(token_usage.occurred_at, since30d), eq(token_usage.task, 'sim_bridge_extract'))),
        db.select({ count: sql<number>`count(*)::int` }).from(users),
        db.select({ count: sql<number>`count(*)::int` }).from(users).where(gte(users.created_at, since30d)),
        // Revenue = succeeded charges only (refunds/disputes are tracked via status, not netted here).
        db.select({
          sales:        sql<number>`count(*)::int`,
          gross_cents:  sql<number>`coalesce(sum(amount_cents),0)::int`,
          payout_cents: sql<number>`coalesce(sum(creator_payout_cents),0)::int`,
          fee_cents:    sql<number>`coalesce(sum(platform_fee_cents),0)::int`,
        })
          .from(billing_transactions)
          .where(and(eq(billing_transactions.type, 'charge'), eq(billing_transactions.status, 'succeeded'))),

        // ── PODCAST RENDERS (observability-006) ───────────────────────────────────────────────
        //
        // Nothing above the queue-depth layer said anything about the podcast. When a render
        // failed, the row went to `status: 'failed'` with its reason in `error`, and no endpoint
        // anywhere read either — so the only way to learn that renders were failing was for a
        // customer to say so. Queue depth cannot substitute: a job that ran and failed leaves the
        // queue empty, which reads as healthy.
        db.select({ status: podcast_renders.status, count: sql<number>`count(*)::int` })
          .from(podcast_renders)
          .groupBy(podcast_renders.status),

        // Duration over the renders that actually finished. Averages hide the tail that users
        // notice, so p50 and p95 come back beside the mean — a mean of 90s with a p95 of 20
        // minutes is a different product than a mean of 90s with a p95 of 2 minutes, and the
        // mean alone cannot tell them apart.
        db.select({
          count:  sql<number>`count(*)::int`,
          avg_ms: sql<number>`coalesce(avg(duration_ms), 0)::float8`,
          p50_ms: sql<number>`coalesce(percentile_cont(0.5) within group (order by duration_ms), 0)::float8`,
          p95_ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by duration_ms), 0)::float8`,
          cost_cents: sql<number>`coalesce(sum(cost_cents), 0)::int`,
        })
          .from(podcast_renders)
          .where(and(eq(podcast_renders.status, 'ready'), sql`${podcast_renders.duration_ms} is not null`)),

        // The last 30 days, separately. A lifetime failure count is dominated by whatever the
        // pipeline was doing months ago and moves too slowly to notice a regression that started
        // on Tuesday.
        db.select({ status: podcast_renders.status, count: sql<number>`count(*)::int` })
          .from(podcast_renders)
          .where(gte(podcast_renders.created_at, since30d))
          .groupBy(podcast_renders.status),

        // Scripts too: a failed writers'-room run never reaches the renderer at all, so a
        // render-only view would show a quiet, healthy pipeline producing nothing.
        db.select({ status: podcast_scripts.status, count: sql<number>`count(*)::int` })
          .from(podcast_scripts)
          .groupBy(podcast_scripts.status),
      ]);

      const videoByStatus: Record<string, number> = { pending: 0, processing: 0, ready: 0, failed: 0 };
      for (const r of videoRows) {
        videoByStatus[r.hls_status] = r.count;
      }

      const simByStatus: Record<string, number> = { processing: 0, ready: 0, failed: 0 };
      for (const r of simRows) {
        if (r.status in simByStatus) simByStatus[r.status] = r.count;
      }

      const ai = aiRows[0];

      /**
       * Counts by status, with every KNOWN status present at zero.
       *
       * A status missing from the response and a status sitting at zero read identically to a
       * dashboard, and they mean opposite things: "nothing has ever failed" versus "this build no
       * longer reports failures". Every known key is therefore always present. An UNKNOWN status —
       * one the database holds and this list does not — is passed through rather than dropped,
       * because a status nobody expected is the most interesting thing on the page.
       */
      const tally = (rows: Array<{ status: string; count: number }>, known: readonly string[]) => {
        const out: Record<string, number> = Object.fromEntries(known.map((k) => [k, 0]));
        for (const r of rows) out[r.status] = r.count;
        return out;
      };

      const RENDER_STATUSES = ['queued', 'synthesizing', 'stitching', 'encoding', 'ready', 'failed'] as const;
      const SCRIPT_STATUSES = ['drafting', 'reviewing', 'rewriting', 'compiling', 'ready', 'approved', 'failed'] as const;

      const rendersByStatus = tally(renderRows, RENDER_STATUSES);
      const rendersRecent = tally(renderRecentRows, RENDER_STATUSES);
      const renderTotal = renderRows.reduce((s, r) => s + r.count, 0);
      const recentTotal = renderRecentRows.reduce((s, r) => s + r.count, 0);
      const dur = renderDurationRows[0];

      /**
       * Failure RATE, not a failure count.
       *
       * Twelve failures is meaningless without a denominator — it is either a catastrophe or a
       * rounding error, and the number alone does not say which. The denominator counts only
       * SETTLED renders: a job still queued has not failed yet, and including it would make the
       * rate improve every time work backs up, which is precisely backwards.
       *
       * `null` when nothing has settled, never 0. A zero would claim a healthy pipeline on the
       * strength of no evidence at all.
       */
      const failureRate = (t: Record<string, number>): number | null => {
        const settled = t.ready + t.failed;
        return settled === 0 ? null : Number((t.failed / settled).toFixed(4));
      };

      return reply.send({
        // null = the durable queue is not configured here, or could not be reached. Deliberately
        // distinguishable from "nothing is dead", which is what a zero would have claimed.
        queues: queueDepths,
        projects: {
          total: projectTotal[0]?.count ?? 0,
          recent_30d: projectRecent[0]?.count ?? 0,
          total_views: projectViews[0]?.total ?? 0,
        },
        playlists: {
          total_views: playlistViews[0]?.total ?? 0,
        },
        videos: {
          total: videoRows.reduce((s, r) => s + r.count, 0),
          by_hls_status: videoByStatus,
        },
        simulations: {
          total: simRows.reduce((s, r) => s + r.count, 0),
          by_status: simByStatus,
        },
        podcast: {
          renders: {
            total: renderTotal,
            by_status: rendersByStatus,
            // null = nothing has settled yet. Distinguishable from 0, which means "settled, none
            // of them failed" — the two look the same on a dashboard and are not the same.
            failure_rate: failureRate(rendersByStatus),
            recent_30d: {
              total: recentTotal,
              by_status: rendersRecent,
              failure_rate: failureRate(rendersRecent),
            },
            duration_ms: {
              // Over completed renders only — a failed render's duration measures how long it
              // took to break, which is a different quantity and would drag the percentiles.
              completed: dur?.count ?? 0,
              avg: Math.round(dur?.avg_ms ?? 0),
              p50: Math.round(dur?.p50_ms ?? 0),
              p95: Math.round(dur?.p95_ms ?? 0),
            },
            cost_cents: dur?.cost_cents ?? 0,
          },
          scripts: {
            total: scriptRows.reduce((s, r) => s + r.count, 0),
            by_status: tally(scriptRows, SCRIPT_STATUSES),
            failure_rate: failureRate(tally(scriptRows, SCRIPT_STATUSES)),
          },
        },
        ai_extraction: {
          total_input_tokens: ai?.input_tokens ?? 0,
          total_output_tokens: ai?.output_tokens ?? 0,
          total_cost_cents: ai?.cost_cents ?? 0,
          count: ai?.count ?? 0,
        },
        users: {
          total: userTotal[0]?.count ?? 0,
          recent_30d: userRecent[0]?.count ?? 0,
        },
        revenue: {
          sales: revenueRows[0]?.sales ?? 0,
          gross_cents: revenueRows[0]?.gross_cents ?? 0,
          creator_payout_cents: revenueRows[0]?.payout_cents ?? 0,
          platform_fee_cents: revenueRows[0]?.fee_cents ?? 0,
        },
      });
    },
  );
}
