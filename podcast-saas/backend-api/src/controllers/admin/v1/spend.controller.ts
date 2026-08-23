/**
 * Where the money went — the admin surface the 22 August incident asked for.
 *
 * Four ElevenLabs Auto Top-Up invoices fired in three and a half hours and nothing in this product
 * could say what bought them. This endpoint is the answer to that question, and it is deliberately
 * shaped so that its answer can be put NEXT TO a vendor invoice rather than merely believed.
 *
 * ── WHY IT REPORTS UNITS AND NOT JUST MONEY ───────────────────────────────────────────────────
 * An invoice itemises: so many characters, so many minutes of audio, so many images. A page that
 * shows only dollars can be compared to a bill's total and nothing else, so a discrepancy tells
 * you there IS one and never where. `summariseSpend` keeps quantities per unit for that reason,
 * and never adds across them.
 *
 * ── WHY THE ROW AND ZERO-COST COUNTS ARE ON THE PAGE ──────────────────────────────────────────
 * "$0.00" for a busy day is what a broken rate produces, and it is the one wrong answer nobody
 * questions. Showing "1,204 rows, 900 of them priced at zero" beside the total makes the reader
 * ask the question the number alone would suppress.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, gte, lte } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { token_usage } from '../../../db/schema.js';
import { firebaseAdminRequired } from '../../../middleware/firebase-admin-required.js';
import { summariseSpend, type UsageRowLike } from '../../../services/usage/spendSummary.js';

/**
 * How many rows one request will summarise.
 *
 * A ceiling rather than pagination because the answer is an AGGREGATE: paginating it would let the
 * page render a total over the first page and call it the total, which is the confidently-wrong
 * number this whole surface exists to avoid. When the cap is hit the response says so and the
 * caller narrows the window — a smaller honest answer instead of a bigger false one.
 */
const MAX_ROWS = 20_000;

/** Default window. Long enough to contain a monthly invoice, short enough to stay cheap. */
const DEFAULT_DAYS = 31;

function parseDay(raw: unknown, fallback: Date): Date {
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  const d = new Date(raw.length <= 10 ? `${raw}T00:00:00.000Z` : raw);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

export async function registerAdminSpendRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/api/admin/v1/spend',
    { preHandler: [firebaseAdminRequired] },
    async (request: FastifyRequest<{ Querystring: { from?: string; to?: string } }>, reply: FastifyReply) => {
      const now = new Date();
      const from = parseDay(request.query.from, new Date(now.getTime() - DEFAULT_DAYS * 24 * 60 * 60 * 1000));
      const to = parseDay(request.query.to, now);

      // Ordered NEWEST first so a truncated window drops the OLDEST rows. A reader who hits the cap
      // is almost always chasing something recent, and losing the far end of the range is the less
      // damaging half to lose.
      const rows = await db
        .select({
          provider: token_usage.provider,
          task: token_usage.task,
          model: token_usage.model,
          cost_cents: token_usage.cost_cents,
          quantity: token_usage.quantity,
          unit: token_usage.unit,
          occurred_at: token_usage.occurred_at,
        })
        .from(token_usage)
        .where(and(gte(token_usage.occurred_at, from), lte(token_usage.occurred_at, to)))
        .orderBy(desc(token_usage.occurred_at))
        .limit(MAX_ROWS + 1);

      const truncated = rows.length > MAX_ROWS;
      const summary = summariseSpend(rows.slice(0, MAX_ROWS) as UsageRowLike[]);

      return reply.send({
        from: from.toISOString(),
        to: to.toISOString(),
        ...summary,
        // SAID OUT LOUD, not inferred from a row count. A truncated total is not the total, and a
        // page that renders one without saying so is worse than one that refuses.
        truncated,
        maxRows: MAX_ROWS,
      });
    },
  );
}
