import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { billing_transactions, user_purchases, projects, playlists } from '../../db/schema.js';
import { firebaseAuthMiddleware, firebaseAuthOptionalMiddleware } from '../../middleware/firebase-auth.js';
import { BillingService, type ContentType } from '../../services/billing/BillingService.js';

const ContentParam = z.object({
  contentType: z.enum(['project', 'playlist']),
  contentId: z.string().uuid(),
});

async function contentTitle(type: ContentType, id: string): Promise<string | null> {
  if (type === 'project') return (await db.query.projects.findFirst({ where: eq(projects.id, id) }))?.title ?? null;
  return (await db.query.playlists.findFirst({ where: eq(playlists.id, id) }))?.title ?? null;
}

export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  // ── Public: is billing configured? (drives whether the lock UI shows) ──────
  app.get('/api/v1/billing/status', async (_req, reply: FastifyReply) => {
    return reply.send({
      enabled: BillingService.isEnabled(),
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? null,
      platformFeePercent: BillingService.platformFeePercent,
    });
  });

  // ── Access check (optional auth — free content is open) ────────────────────
  app.get<{ Params: { contentType: string; contentId: string } }>(
    '/api/v1/billing/access/:contentType/:contentId',
    { preHandler: [firebaseAuthOptionalMiddleware] },
    async (request, reply: FastifyReply) => {
      const parsed = ContentParam.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ message: 'Bad content reference' });
      const { contentType, contentId } = parsed.data;

      const pricing = await BillingService.getPricing(contentType, contentId);
      if (!pricing) return reply.code(404).send({ message: 'Content not found' });

      const userId = request.dbUser?.id ?? null;
      const hasAccess = await BillingService.hasAccess(userId, contentType, contentId);
      return reply.send({
        accessType: pricing.accessType,
        priceCents: pricing.priceCents,
        currency: pricing.currency,
        title: pricing.title,
        hasAccess,
        isOwner: !!userId && pricing.creatorUserId === userId,
        locked: pricing.accessType === 'paid' && !hasAccess,
      });
    },
  );

  // ── Start a Checkout session to unlock content ─────────────────────────────
  app.post(
    '/api/v1/billing/checkout',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!BillingService.isEnabled()) return reply.code(503).send({ message: 'Billing is not configured' });
      const body = z.object({
        content_type: z.enum(['project', 'playlist']),
        content_id: z.string().uuid(),
      }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });

      try {
        const { url } = await BillingService.createCheckoutSession(request.dbUser!, body.data.content_type, body.data.content_id);
        return reply.send({ url });
      } catch (err) {
        return reply.code(400).send({ message: (err as Error).message });
      }
    },
  );

  // ── Reconcile a Checkout session on return (webhook backstop) ──────────────
  // The /unlock page calls this so a buyer who paid gets access even if the Stripe webhook is
  // delayed or missed. Idempotent (reuses grantFromSession) — safe to race the webhook.
  app.post(
    '/api/v1/billing/checkout/reconcile',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!BillingService.isEnabled()) return reply.code(503).send({ message: 'Billing is not configured' });
      const body = z.object({ session_id: z.string().min(1) }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });
      try {
        const { granted } = await BillingService.reconcileCheckout(request.dbUser!.id, body.data.session_id);
        return reply.send({ granted });
      } catch (err) {
        return reply.code(400).send({ message: (err as Error).message });
      }
    },
  );

  // ── Hosted Customer Portal (manage cards / receipts) ───────────────────────
  app.post(
    '/api/v1/billing/portal',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!BillingService.isEnabled()) return reply.code(503).send({ message: 'Billing is not configured' });
      const body = z.object({ returnUrl: z.string().url().optional() }).safeParse(request.body ?? {});
      const returnUrl = (body.success && body.data.returnUrl) || `${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/settings`;
      try {
        const { url } = await BillingService.createPortalSession(request.dbUser!, returnUrl);
        return reply.send({ url });
      } catch (err) {
        return reply.code(400).send({ message: (err as Error).message });
      }
    },
  );

  // ── My purchases ───────────────────────────────────────────────────────────
  app.get(
    '/api/v1/billing/purchases',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rows = await db.query.user_purchases.findMany({
        where: eq(user_purchases.user_id, request.dbUser!.id),
        orderBy: [desc(user_purchases.purchased_at)],
      });
      const out = await Promise.all(rows.map(async (r) => ({
        id: r.id,
        content_type: r.content_type,
        content_id: r.content_id,
        title: await contentTitle(r.content_type as ContentType, r.content_id),
        amount_cents: r.amount_cents,
        currency: r.currency,
        purchased_at: r.purchased_at,
      })));
      return reply.send(out);
    },
  );

  // ── My transactions (payment history) ──────────────────────────────────────
  app.get(
    '/api/v1/billing/transactions',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rows = await db.query.billing_transactions.findMany({
        where: eq(billing_transactions.payer_user_id, request.dbUser!.id),
        orderBy: [desc(billing_transactions.created_at)],
        limit: 100,
      });
      return reply.send(rows);
    },
  );

  // ── Creator earnings (content I sold) ──────────────────────────────────────
  app.get(
    '/api/v1/billing/earnings',
    { preHandler: [firebaseAuthMiddleware] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.dbUser!.id;
      const sales = await db.query.billing_transactions.findMany({
        where: and(eq(billing_transactions.creator_user_id, userId), eq(billing_transactions.status, 'succeeded')),
        orderBy: [desc(billing_transactions.completed_at)],
        limit: 200,
      });
      const totalGross = sales.reduce((s, t) => s + t.amount_cents, 0);
      const totalNet = sales.reduce((s, t) => s + t.creator_payout_cents, 0);
      const recent = await Promise.all(sales.slice(0, 50).map(async (t) => ({
        id: t.id,
        content_type: t.content_type,
        title: await contentTitle(t.content_type as ContentType, t.content_id),
        amount_cents: t.amount_cents,
        creator_payout_cents: t.creator_payout_cents,
        currency: t.currency,
        completed_at: t.completed_at,
      })));
      return reply.send({ salesCount: sales.length, totalGrossCents: totalGross, totalNetCents: totalNet, currency: 'usd', recent });
    },
  );

  // ── Owner: set pricing / lock a video or playlist ──────────────────────────
  app.patch<{ Params: { contentType: string; contentId: string } }>(
    '/api/v1/billing/pricing/:contentType/:contentId',
    { preHandler: [firebaseAuthMiddleware] },
    async (request, reply: FastifyReply) => {
      const parsed = ContentParam.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ message: 'Bad content reference' });
      const { contentType, contentId } = parsed.data;

      const body = z.object({
        access_type: z.enum(['free', 'paid']),
        price_cents: z.number().int().min(50).max(100000).nullable().optional(),
        // Single-currency platform (product decision): reject non-USD so earnings aggregates can't
        // silently sum mixed currencies. Revisit if multi-currency is ever needed.
        currency: z.literal('usd').optional(),
      }).safeParse(request.body);
      if (!body.success) return reply.code(400).send({ message: body.error.message });
      if (body.data.access_type === 'paid' && (!body.data.price_cents || body.data.price_cents < 50)) {
        return reply.code(400).send({ message: 'A price of at least $0.50 is required to lock content' });
      }

      const userId = request.dbUser!.id;
      const set = {
        access_type: body.data.access_type,
        price_cents: body.data.access_type === 'paid' ? (body.data.price_cents ?? null) : null,
        currency: body.data.currency ?? 'usd',
      };

      if (contentType === 'project') {
        const owned = await db.query.projects.findFirst({ where: and(eq(projects.id, contentId), eq(projects.created_by, userId)) });
        if (!owned) return reply.code(404).send({ message: 'Project not found' });
        const [row] = await db.update(projects).set(set).where(eq(projects.id, contentId)).returning();
        return reply.send({ access_type: row.access_type, price_cents: row.price_cents, currency: row.currency });
      } else {
        const owned = await db.query.playlists.findFirst({ where: and(eq(playlists.id, contentId), eq(playlists.created_by, userId)) });
        if (!owned) return reply.code(404).send({ message: 'Playlist not found' });
        const [row] = await db.update(playlists).set(set).where(eq(playlists.id, contentId)).returning();
        return reply.send({ access_type: row.access_type, price_cents: row.price_cents, currency: row.currency });
      }
    },
  );
}
