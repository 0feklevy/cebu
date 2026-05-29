import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../../../db/index.js';
import { projects, video_files, simulations, token_usage } from '../../../db/schema.js';
import { sql, gte, and, eq } from 'drizzle-orm';
import { firebaseAdminRequired } from '../../../middleware/firebase-admin-required.js';

export async function registerAdminPipelineStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/admin/v1/pipeline-stats',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const [
        projectTotal,
        projectRecent,
        videoRows,
        simRows,
        aiRows,
      ] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(projects),
        db.select({ count: sql<number>`count(*)::int` }).from(projects).where(gte(projects.created_at, since30d)),
        db.select({ hls_status: video_files.hls_status, count: sql<number>`count(*)::int` })
          .from(video_files)
          .groupBy(video_files.hls_status),
        db.select({ status: simulations.status, count: sql<number>`count(*)::int` })
          .from(simulations)
          .groupBy(simulations.status),
        db.select({
          input_tokens: sql<number>`sum(input_tokens)::int`,
          output_tokens: sql<number>`sum(output_tokens)::int`,
          cost_cents: sql<number>`sum(cost_cents)::int`,
          count: sql<number>`count(*)::int`,
        })
          .from(token_usage)
          .where(and(gte(token_usage.occurred_at, since30d), eq(token_usage.task, 'sim_bridge_extract'))),
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

      return reply.send({
        projects: {
          total: projectTotal[0]?.count ?? 0,
          recent_30d: projectRecent[0]?.count ?? 0,
        },
        videos: {
          total: videoRows.reduce((s, r) => s + r.count, 0),
          by_hls_status: videoByStatus,
        },
        simulations: {
          total: simRows.reduce((s, r) => s + r.count, 0),
          by_status: simByStatus,
        },
        ai_extraction: {
          total_input_tokens: ai?.input_tokens ?? 0,
          total_output_tokens: ai?.output_tokens ?? 0,
          total_cost_cents: ai?.cost_cents ?? 0,
          count: ai?.count ?? 0,
        },
      });
    },
  );
}
