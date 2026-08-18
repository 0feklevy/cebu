/**
 * What a graceful shutdown actually needs — the single place the drain timeouts are declared.
 *
 * WHY THIS FILE EXISTS (job-queue-004). Docker sends SIGTERM and then SIGKILLs after
 * `stop_grace_period`, which defaults to TEN SECONDS. Our shutdown path is a sequence of bounded
 * waits that add up to far more than ten seconds, so every `docker compose up -d` on a release was
 * hard-killing the process in the middle of its own drain: a transcode measured in minutes died
 * mid-flight, on every deploy, silently.
 *
 * The compose file cannot import TypeScript, so the two live side by side and a test
 * (`__tests__/stopGracePeriod.test.ts`) asserts the compose values are >= these budgets. Change a
 * timeout here and the test tells you the compose file has to move with it — which is the only
 * thing that stops the two drifting apart again.
 *
 * These are BUDGETS, not new behaviour: each constant is the timeout the shutdown code already
 * enforced, lifted to a named export so the arithmetic is checkable.
 */

/** `drainInlineJobs()` — how long the web tier waits for in-flight INLINE jobs. */
export const INLINE_DRAIN_TIMEOUT_MS = 25_000;

/** `stopBoss()` — pg-boss's own graceful-stop timeout, on both the web tier and the worker. */
export const PGBOSS_STOP_TIMEOUT_MS = 30_000;

/**
 * Allowance for `app.close()` (in-flight HTTP requests) ahead of the two job drains.
 *
 * Deliberately an allowance and not an enforced timeout. Fastify's close waits for in-flight
 * requests with no bound of its own, and the honest upper bound on a request here is nginx's
 * `proxy_read_timeout 300s` (a 2 GB upload is a legitimately long request). No stop grace period
 * should try to cover that: the point of this number is that the JOB drains below are not entered
 * with the clock already expired. A request still running past it is cut off exactly as it is
 * today — no worse — while the drains it used to starve now get their full budget.
 */
export const HTTP_CLOSE_ALLOWANCE_MS = 20_000;

/** Web tier (`src/server.ts`): app.close() → drainInlineJobs() → stopBoss(). */
export const WEB_SHUTDOWN_BUDGET_MS =
  HTTP_CLOSE_ALLOWANCE_MS + INLINE_DRAIN_TIMEOUT_MS + PGBOSS_STOP_TIMEOUT_MS;

/** Worker (`src/worker.ts`): stopBoss() only — it serves no HTTP and runs no inline queue. */
export const WORKER_SHUTDOWN_BUDGET_MS = PGBOSS_STOP_TIMEOUT_MS;
