/**
 * BillingService — pay-to-unlock for locked videos (projects) and playlists.
 *
 * Adapted from the Fiji billing service to podcast-saas (Postgres/Drizzle/Fastify).
 * Uses **Stripe Checkout** (hosted) for purchases and the **Customer Portal**
 * (hosted) for payment-method management — no card UI to build or maintain, and
 * 3-D Secure / wallets are handled by Stripe.
 *
 * Flow: viewer of locked content → createCheckoutSession() → redirect to Stripe →
 * pay → webhook `checkout.session.completed` → grantPurchase() → access granted.
 */

import Stripe from 'stripe';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { users, projects, playlists, billing_transactions, user_purchases } from '../../db/schema.js';
import type { User } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

export type ContentType = 'project' | 'playlist';

const PLATFORM_FEE_PERCENT = Math.max(0, Math.min(100, parseInt(process.env.PLATFORM_FEE_PERCENT ?? '15', 10)));

let stripeClient: Stripe | null = null;

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
}

export const BillingService = {
  /** Lazily construct the Stripe client. Billing is disabled when no key is set. */
  getStripe(): Stripe | null {
    if (stripeClient) return stripeClient;
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return null;
    stripeClient = new Stripe(key, { typescript: true });
    return stripeClient;
  },

  isEnabled(): boolean {
    return !!process.env.STRIPE_SECRET_KEY;
  },

  calculateFees(amountCents: number): { platformFeeCents: number; creatorPayoutCents: number } {
    const platformFeeCents = Math.round(amountCents * (PLATFORM_FEE_PERCENT / 100));
    return { platformFeeCents, creatorPayoutCents: amountCents - platformFeeCents };
  },

  /**
   * Pricing + owner for a piece of content (or null if it does not exist).
   *
   * `preloadedProject` lets a caller that already loaded the project row hand it in
   * to skip a redundant SELECT on the hot path (loadperf-002/backend-110). It is only
   * honoured for the 'project' content type and when its id matches contentId.
   */
  async getPricing(
    contentType: ContentType,
    contentId: string,
    preloadedProject?: typeof projects.$inferSelect,
  ): Promise<{
    accessType: string; priceCents: number | null; currency: string;
    creatorUserId: string | null; title: string | null;
  } | null> {
    if (contentType === 'project') {
      const p = preloadedProject && preloadedProject.id === contentId
        ? preloadedProject
        : await db.query.projects.findFirst({ where: eq(projects.id, contentId) });
      if (!p) return null;
      return { accessType: p.access_type, priceCents: p.price_cents, currency: p.currency, creatorUserId: p.created_by, title: p.title };
    }
    const pl = await db.query.playlists.findFirst({ where: eq(playlists.id, contentId) });
    if (!pl) return null;
    return { accessType: pl.access_type, priceCents: pl.price_cents, currency: pl.currency, creatorUserId: pl.created_by, title: pl.title };
  },

  /**
   * Whether `userId` may watch the content. The owner always can; otherwise a
   * matching row in user_purchases grants access. Free content is open to all.
   *
   * `preloadedProject` is threaded into getPricing to avoid a redundant project
   * SELECT when the caller already has the row (loadperf-002/backend-110).
   */
  async hasAccess(
    userId: string | null,
    contentType: ContentType,
    contentId: string,
    preloadedProject?: typeof projects.$inferSelect,
  ): Promise<boolean> {
    const pricing = await this.getPricing(contentType, contentId, preloadedProject);
    if (!pricing) return false;
    if (pricing.accessType !== 'paid') return true;          // free → open
    if (!userId) return false;
    if (pricing.creatorUserId === userId) return true;       // owner
    const purchase = await db.query.user_purchases.findFirst({
      where: and(
        eq(user_purchases.user_id, userId),
        eq(user_purchases.content_type, contentType),
        eq(user_purchases.content_id, contentId),
      ),
    });
    return !!purchase;
  },

  /** Get or create the Stripe customer for a user, persisting the id. */
  async getOrCreateCustomer(user: User): Promise<string> {
    const stripe = this.getStripe();
    if (!stripe) throw new Error('Billing not configured');
    if (user.stripe_customer_id) return user.stripe_customer_id;
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { userId: user.id, firebaseUid: user.firebase_uid },
    });
    await db.update(users).set({ stripe_customer_id: customer.id }).where(eq(users.id, user.id));
    return customer.id;
  },

  /**
   * Create a Stripe Checkout session for unlocking content. Returns the hosted
   * payment URL. Records a pending billing_transaction keyed to the session.
   */
  async createCheckoutSession(buyer: User, contentType: ContentType, contentId: string): Promise<{ url: string }> {
    const stripe = this.getStripe();
    if (!stripe) throw new Error('Billing not configured');

    const pricing = await this.getPricing(contentType, contentId);
    if (!pricing) throw new Error('Content not found');
    if (pricing.accessType !== 'paid' || !pricing.priceCents || pricing.priceCents < 50) {
      throw new Error('Content is not for sale');
    }
    if (pricing.creatorUserId === buyer.id) throw new Error('You already own this content');

    const already = await this.hasAccess(buyer.id, contentType, contentId);
    if (already) throw new Error('Already purchased');

    const customerId = await this.getOrCreateCustomer(buyer);
    const fees = this.calculateFees(pricing.priceCents);
    const description = `${contentType === 'playlist' ? 'Playlist' : 'Video'}: ${pricing.title ?? 'Untitled'}`;

    const [tx] = await db.insert(billing_transactions).values({
      type: 'charge', status: 'pending',
      amount_cents: pricing.priceCents, currency: pricing.currency,
      platform_fee_cents: fees.platformFeeCents, creator_payout_cents: fees.creatorPayoutCents,
      payer_user_id: buyer.id, payer_email: buyer.email,
      creator_user_id: pricing.creatorUserId, content_type: contentType, content_id: contentId,
      description,
    }).returning();

    // Where the viewer returns after paying. /unlock reconciles + bounces to the viewer.
    const ret = `${appUrl()}/unlock?type=${contentType}&id=${contentId}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: pricing.currency,
          unit_amount: pricing.priceCents,
          product_data: { name: description },
        },
      }],
      payment_intent_data: { metadata: { transactionId: tx.id } },
      metadata: { transactionId: tx.id, contentType, contentId, buyerUserId: buyer.id },
      success_url: `${ret}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${ret}&canceled=1`,
    });

    await db.update(billing_transactions)
      .set({ stripe_checkout_session_id: session.id })
      .where(eq(billing_transactions.id, tx.id));

    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return { url: session.url };
  },

  /** Hosted Customer Portal for managing saved cards / receipts. */
  async createPortalSession(user: User, returnUrl: string): Promise<{ url: string }> {
    const stripe = this.getStripe();
    if (!stripe) throw new Error('Billing not configured');
    const customerId = await this.getOrCreateCustomer(user);
    const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return { url: session.url };
  },

  verifyWebhook(payload: Buffer, signature: string): Stripe.Event {
    const stripe = this.getStripe();
    if (!stripe) throw new Error('Billing not configured');
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    return stripe.webhooks.constructEvent(payload, signature, secret);
  },

  /** Idempotently grant a purchase + flip the transaction to succeeded. */
  async grantFromSession(session: Stripe.Checkout.Session): Promise<void> {
    const transactionId = session.metadata?.transactionId;
    if (!transactionId) { logger.warn('[billing] checkout session missing transactionId'); return; }

    const tx = await db.query.billing_transactions.findFirst({ where: eq(billing_transactions.id, transactionId) });
    if (!tx) { logger.warn({ transactionId }, '[billing] transaction not found'); return; }
    if (tx.status === 'succeeded') return; // already processed

    // One transaction: the 'succeeded' sentinel and the purchase grant must land
    // together. Writing the sentinel first and crashing before the grant would
    // permanently deny a paying customer — the webhook retry sees 'succeeded'
    // and early-returns without ever inserting the purchase.
    await db.transaction(async (trx) => {
      await trx.update(billing_transactions).set({
        status: 'succeeded',
        stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        completed_at: new Date(),
      }).where(eq(billing_transactions.id, tx.id));

      if (tx.payer_user_id) {
        await trx.insert(user_purchases).values({
          user_id: tx.payer_user_id, content_type: tx.content_type, content_id: tx.content_id,
          transaction_id: tx.id, amount_cents: tx.amount_cents, currency: tx.currency,
        }).onConflictDoNothing();
      }
    });
    logger.info({ transactionId, content: `${tx.content_type}:${tx.content_id}` }, '[billing] purchase granted');
  },

  async markFailed(opts: { transactionId?: string | null; paymentIntentId?: string | null; message?: string }): Promise<void> {
    // Prefer transactionId (carried in the PaymentIntent metadata). A pending Checkout row has a
    // NULL stripe_payment_intent_id until the grant, so keying only on the PI id matched ZERO rows
    // and the transaction lingered as 'pending' forever (P0 billing).
    if (opts.transactionId) {
      await db.update(billing_transactions)
        .set({ status: 'failed', error: opts.message ?? null })
        .where(eq(billing_transactions.id, opts.transactionId));
      return;
    }
    if (opts.paymentIntentId) {
      await db.update(billing_transactions)
        .set({ status: 'failed', error: opts.message ?? null })
        .where(eq(billing_transactions.stripe_payment_intent_id, opts.paymentIntentId));
    }
  },

  /**
   * Refund / dispute handling — STATUS ONLY (product decision): record the transaction status but
   * intentionally KEEP the user_purchases grant (no access revocation; grace model). Keys on the
   * PaymentIntent id, which grantFromSession reliably sets on the succeeded transaction.
   */
  async handleRefund(charge: Stripe.Charge): Promise<void> {
    const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null;
    if (!pi) return;
    const fullyRefunded = (charge.amount_refunded ?? 0) >= (charge.amount ?? 0);
    await db.update(billing_transactions)
      .set({ status: fullyRefunded ? 'refunded' : 'partially_refunded' })
      .where(eq(billing_transactions.stripe_payment_intent_id, pi));
    logger.info({ pi, fullyRefunded }, '[billing] refund recorded (access retained)');
  },

  async handleDispute(dispute: Stripe.Dispute): Promise<void> {
    const pi = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id ?? null;
    if (!pi) return;
    await db.update(billing_transactions)
      .set({ status: 'disputed' })
      .where(eq(billing_transactions.stripe_payment_intent_id, pi));
    logger.warn({ pi }, '[billing] dispute recorded');
  },

  /**
   * Reconcile a Checkout session on the buyer's return to /unlock — the safety net when the webhook
   * is delayed/missed, so a buyer who paid isn't stranded on a still-locked video. Idempotent: it
   * reuses grantFromSession, so it races the webhook safely (unique index + status short-circuit).
   * Returns whether the viewer now has access.
   */
  async reconcileCheckout(buyerUserId: string, sessionId: string): Promise<{ granted: boolean }> {
    const stripe = this.getStripe();
    if (!stripe) throw new Error('Billing not configured');
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    // Only grant on the buyer's own session — never let one user reconcile another's checkout.
    if (session.metadata?.buyerUserId && session.metadata.buyerUserId !== buyerUserId) {
      return { granted: false };
    }
    if (session.payment_status === 'paid') {
      await this.grantFromSession(session);
      return { granted: true };
    }
    return { granted: false };
  },

  get platformFeePercent(): number { return PLATFORM_FEE_PERCENT; },
};
