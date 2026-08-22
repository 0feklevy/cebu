/**
 * Reading an argument a mock captured, without lying to the type system or to the reader.
 *
 * ── THE PROBLEM THIS REPLACES ─────────────────────────────────────────────────────────────────
 * The drizzle chain mocks in this suite are written `vi.fn(() => ({ returning: … }))`. The
 * implementation declares NO parameters, so vitest types `mock.calls` as an array of EMPTY tuples,
 * and every `calls[0][0]` in the suite is a type error — 27 of the 129 the test typecheck froze.
 * They pass at runtime because vitest executes TypeScript without checking it.
 *
 * Typing the mock's parameters instead would work and is worse here: it means writing a plausible
 * signature for a builder nobody is modelling faithfully, in thirty places, and the next person
 * has to keep those thirty invented signatures in step with drizzle.
 *
 * ── WHAT IT ADDS BEYOND SILENCING THE ERROR ───────────────────────────────────────────────────
 * A better failure. `calls[0][0]` on a mock that was never called throws "Cannot read properties
 * of undefined (reading '0')" from inside the assertion, which says nothing about what went wrong.
 * The real finding — the code under test never reached the call at all — is exactly what you want
 * the message to say, and it is the more likely explanation when a test starts failing.
 */

interface CapturedMock {
  mock: { calls: unknown[][] };
}

/**
 * The `argIndex`-th argument of the `callIndex`-th call, or a failure that names what was missing.
 *
 * The cast is deliberate and it is the caller's claim, not this function's: a mock records
 * `unknown`, and the test is what knows the shape it passed in. Defaulting to
 * `Record<string, unknown>` covers the common case — a drizzle `values()` or `set()` payload —
 * without requiring every call site to spell it out.
 */
export function callArg<T = Record<string, unknown>>(
  fn: CapturedMock,
  callIndex = 0,
  argIndex = 0,
): T {
  const calls = fn.mock.calls;
  const call = calls[callIndex];
  if (!call) {
    throw new Error(
      `expected the mock to have been called at least ${callIndex + 1} time(s), but it was called ${calls.length} time(s)`,
    );
  }
  if (argIndex >= call.length) {
    throw new Error(
      `call ${callIndex} received ${call.length} argument(s); argument ${argIndex} was never passed`,
    );
  }
  return call[argIndex] as T;
}

/** Every first-argument value the mock captured, in call order. */
export function callArgs<T = Record<string, unknown>>(fn: CapturedMock, argIndex = 0): T[] {
  return fn.mock.calls.map((c) => c[argIndex] as T);
}
