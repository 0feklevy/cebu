/**
 * Argument parsing for the destructive one-shot scripts, in its own module so it is testable.
 *
 * ── The defect this replaces (scripts-ship-010) ───────────────────────────────────────────────
 * Both backfills read their safety ceiling as:
 *
 *     const MAX_AFFECTED = Number(argValue('--max-affected') ?? '50');
 *
 * `argValue` returns the NEXT argv element, whatever it is. So `--max-affected --apply` yields
 * `Number('--apply')` — NaN. And the ceiling test is `totalAffected > maxAffectedRows`, which is
 * FALSE against NaN. A typo therefore does not fail the run; it DISARMS the ceiling, and an
 * `--apply` run of unbounded rewrites proceeds without `--approve-unsafe`.
 *
 * It is not only a typo path. `ops/release/src/cli.ts` does `Number(flags.get('max-affected'))`
 * and the remote-command builder stringifies the result, so `--max-affected foo` reaches the VM as
 * the literal string 'NaN'.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────────────────
 * A flag that is ABSENT uses its default — that is the ordinary case and must stay ergonomic. A
 * flag that is PRESENT must carry a usable value, and anything else THROWS. Refusing to start is
 * the only safe failure for a number whose entire job is to bound a destructive write: the guard
 * that cannot be read is worse than no guard, because the run believes it is protected.
 */

/** Raised when a flag is present but its value cannot be trusted. Scripts exit non-zero on it. */
export class BadArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadArgumentError';
  }
}

/** The raw value that follows `name`, or undefined when the flag is absent. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * A positive integer flag, or its default when the flag is absent.
 *
 * Rejects, rather than silently defaulting: a present flag with no value (it was last on the line),
 * a value that is itself a flag (the swallowed-next-argument case), and anything that is not a
 * finite positive integer — including the literal 'NaN' that the release CLI can send.
 */
export function positiveIntArg(
  argv: readonly string[],
  name: string,
  fallback: number,
): number {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;

  const raw = i + 1 < argv.length ? argv[i + 1] : undefined;
  if (raw === undefined) {
    throw new BadArgumentError(`${name} was given with no value`);
  }
  if (raw.startsWith('--')) {
    throw new BadArgumentError(
      `${name} was followed by "${raw}", which is another flag — its value is missing`,
    );
  }

  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new BadArgumentError(
      `${name} must be a positive whole number, got "${raw}". `
      + 'This value bounds a destructive write; a value that cannot be read is not a ceiling.',
    );
  }
  return n;
}
