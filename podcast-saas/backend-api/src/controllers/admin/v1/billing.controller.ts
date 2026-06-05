import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { desc } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { billing_transactions } from '../../../db/schema.js';
import { firebaseAdminRequired } from '../../../middleware/firebase-admin-required.js';
import { BillingService } from '../../../services/billing/BillingService.js';

export async function registerAdminBillingRoutes(app: FastifyInstance): Promise<void> {
  // Aggregate revenue overview for the admin dashboard.
  app.get(
    '/api/admin/v1/billing/overview',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const all = await db.query.billing_transactions.findMany();
      const succeeded = all.filter((t) => t.status === 'succeeded');
      const pending = all.filter((t) => ['pending'].includes(t.status));

      const totalVolume = succeeded.reduce((s, t) => s + t.amount_cents, 0);
      const totalPlatformFees = succeeded.reduce((s, t) => s + t.platform_fee_cents, 0);
      const activeCreators = new Set(succeeded.map((t) => t.creator_user_id).filter(Boolean)).size;
      const activeBuyers = new Set(succeeded.map((t) => t.payer_user_id).filter(Boolean)).size;

      return reply.send({
        enabled: BillingService.isEnabled(),
        platformFeePercent: BillingService.platformFeePercent,
        totalTransactions: succeeded.length,
        totalVolumeCents: totalVolume,
        totalPlatformFeesCents: totalPlatformFees,
        pendingTransactions: pending.length,
        activeCreators,
        activeBuyers,
      });
    },
  );

  // Recent transactions for the admin table.
  app.get(
    '/api/admin/v1/billing/transactions',
    { preHandler: [firebaseAdminRequired] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const rows = await db.query.billing_transactions.findMany({
        orderBy: [desc(billing_transactions.created_at)],
        limit: 200,
      });
      return reply.send(rows);
    },
  );
}
