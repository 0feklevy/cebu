/**
 * A wall-clock deadline for every LLM call (llm-pipeline-006).
 *
 * Several entry points hand the LLM layer `new AbortController().signal` — a
 * signal that is never aborted by anyone (PodcastMemory.writeEpisodeMemory,
 * podcast regenerateTurn, VideoGenerationService's prompt-enhance pass). Those
 * calls had NO deadline at all: a provider stream that stops producing bytes
 * without closing the socket leaves the awaiting job hung until whatever
 * stale-claim recovery notices, and the SDK's own retry/timeout does not cover a
 * stream that is technically still open.
 *
 * The backstop lives here rather than at each call site so it applies to every
 * caller, including ones added later. Callers that want a tighter bound keep
 * their own controller — whichever fires first wins.
 */

/** Backstop for a single provider call. Override with LLM_CALL_TIMEOUT_MS. */
export const LLM_CALL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.LLM_CALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
})();

export interface LinkedAbort {
  /** Aborts when the caller aborts OR the deadline elapses. */
  signal: AbortSignal;
  /** Clears the timer and unsubscribes. MUST be called in a `finally`. */
  dispose: () => void;
}

/**
 * Derive a signal that aborts when `caller` aborts or after `timeoutMs`.
 *
 * The timer is `unref`'d where the runtime supports it, so a pending deadline
 * never keeps the process alive on its own.
 */
/** Stamp the wall-clock instant a whole call must be finished by. Call ONCE per public entry. */
export function callDeadlineAt(timeoutMs: number = LLM_CALL_TIMEOUT_MS): number {
  return Date.now() + timeoutMs;
}

/**
 * @param caller     the caller's own signal, if any
 * @param deadlineAt absolute ms deadline SHARED across every retry of one logical call. Omit for a
 *                   standalone call, which then gets a fresh `LLM_CALL_TIMEOUT_MS` of its own.
 */
export function linkAbortWithDeadline(
  caller: AbortSignal | undefined,
  deadlineAt?: number,
): LinkedAbort {
  // Remaining budget, floored at 1ms: an already-expired shared deadline must abort promptly
  // rather than wrap around into a huge timeout.
  const timeoutMs = deadlineAt === undefined
    ? LLM_CALL_TIMEOUT_MS
    : Math.max(1, deadlineAt - Date.now());
  const controller = new AbortController();

  if (caller?.aborted) {
    controller.abort((caller as { reason?: unknown }).reason);
    return { signal: controller.signal, dispose: () => {} };
  }

  const onCallerAbort = () => controller.abort((caller as { reason?: unknown } | undefined)?.reason);
  caller?.addEventListener('abort', onCallerAbort, { once: true });

  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    controller.abort(new Error(`LLM call exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}
