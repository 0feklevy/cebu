/**
 * Process-level last resort for a promise nobody handled.
 *
 * ── Why this exists (backend-011) ─────────────────────────────────────────────────────────────
 * On Node 22 the default `unhandledRejection` mode is `throw`: one rejected promise with no
 * handler TERMINATES THE PROCESS. This codebase has genuine fire-and-forget chains — a controller
 * answers 202 and lets the work continue — and each of those is one `.catch()` body away from
 * killing the API for every tenant on it. `restart: unless-stopped` turns that into a restart
 * rather than an outage, which is why it is serious rather than fatal, but a restart drops every
 * in-flight request and every inline job with it.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────────────────────────
 * It is not permission to leave rejections unhandled. Each site still handles its own errors —
 * the two simulation publication chains were fixed at the source in the same change. This is the
 * net under them: it converts "the process vanished with no explanation" into a log line naming
 * the reason, which is the difference between a diagnosable incident and a mystery restart.
 *
 * `uncaughtException` is deliberately NOT swallowed the same way. A synchronous throw that reached
 * the top of the stack has left the process in an unknown state, and the honest response is to log
 * and exit non-zero so the supervisor restarts a clean one — the same conclusion Node reaches by
 * default, but with the reason recorded first.
 */
import { logger } from './logger.js';

/** Install the handlers. Idempotent, so a test importing it twice does not stack listeners. */
export function installProcessSafetyNet(procName: 'api' | 'worker'): void {
  if (process.listenerCount('unhandledRejection') > 0) return;

  process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    logger.error(
      {
        proc: procName,
        err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
        promise: String(promise),
      },
      '[process] unhandled promise rejection — the process survived, but a failure path went unhandled',
    );
  });

  process.on('uncaughtException', (err: Error) => {
    logger.fatal({ proc: procName, err }, '[process] uncaught exception — exiting for a clean restart');
    // Give pino its flush tick, then leave. No graceful drain: the state is already unknown.
    setTimeout(() => process.exit(1), 100).unref();
  });
}
