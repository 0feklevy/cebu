import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Stripe from 'stripe';
import { BillingService } from '../../services/billing/BillingService.js';
import { logger } from '../../lib/logger.js';

/**
 * Stripe webhook. Signature verification needs the RAW request body, so this is
 * registered inside an encapsulated Fastify scope with a buffer content-type
 * parser — the rest of the app keeps the normal JSON parser.
 */
export async function registerStripeWebhookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (scoped) => {
    scoped.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );

    scoped.post('/api/v1/stripe/webhook', async (request: FastifyRequest, reply: FastifyReply) => {
      const sig = request.headers['stripe-signature'];
      if (!sig || typeof sig !== 'string') return reply.code(400).send({ message: 'Missing signature' });

      let event: Stripe.Event;
      try {
        event = BillingService.verifyWebhook(request.body as Buffer, sig);
      } catch (err) {
        logger.warn({ err }, '[billing] webhook signature verification failed');
        return reply.code(400).send({ message: `Webhook Error: ${(err as Error).message}` });
      }

      try {
        switch (event.type) {
          case 'checkout.session.completed':
          case 'checkout.session.async_payment_succeeded':
            await BillingService.grantFromSession(event.data.object as Stripe.Checkout.Session);
            break;
          case 'payment_intent.payment_failed': {
            const pi = event.data.object as Stripe.PaymentIntent;
            // Resolve by transactionId from PI metadata — the row's stripe_payment_intent_id is
            // NULL until grant, so keying on it alone never matched (stuck-'pending' P0 billing).
            await BillingService.markFailed({
              transactionId: pi.metadata?.transactionId,
              paymentIntentId: pi.id,
              message: pi.last_payment_error?.message,
            });
            break;
          }
          case 'charge.refunded':
            await BillingService.handleRefund(event.data.object as Stripe.Charge);
            break;
          case 'charge.dispute.created':
            await BillingService.handleDispute(event.data.object as Stripe.Dispute);
            break;
          default:
            break; // ignore other events
        }
      } catch (err) {
        logger.error({ err, type: event.type }, '[billing] webhook handler error');
        return reply.code(500).send({ message: 'Webhook handler error' });
      }

      return reply.send({ received: true });
    });
  });
}
