/**
 * How the podcast pipeline's numbers are turned into something a person reads.
 *
 * These are here, as pure functions, rather than inline in the dashboard because they encode a
 * DISTINCTION that is easy to erase and expensive to erase: the API deliberately returns `null`
 * for a failure rate when nothing has settled, precisely so it can be shown as different from
 * `0`. Rendering `null` as "0%" puts a green, reassuring number on a pipeline that has never
 * completed a single render — the one situation where a reassuring number does actual harm.
 *
 * A rule worth arguing about is a rule worth testing, and a rule buried in JSX gets neither.
 */

export interface RateDisplay {
  /** What to show. `null` means "render the no-data state", not "render nothing". */
  text: string;
  /** A secondary line explaining WHY there is no number, or null when there is one. */
  hint: string | null;
  tone: 'good' | 'bad' | 'neutral' | 'unknown';
}

/**
 * The threshold above which a failure rate is shown as a problem.
 *
 * A judgement, not a measurement, and stated here so it is arguable in one place. Renders are
 * long, expensive and user-visible; one in twenty failing is already something the owner should
 * be looking at rather than discovering from a support message.
 */
export const FAILURE_RATE_BAD_ABOVE = 0.05;

export function formatFailureRate(rate: number | null): RateDisplay {
  if (rate === null) {
    return { text: '—', hint: 'nothing has finished yet', tone: 'unknown' };
  }
  const pct = rate * 100;
  return {
    // One decimal below 10%, whole numbers above. "0.4%" and "0%" are different facts; "23.7%"
    // and "24%" are not, and the extra digit only adds noise once the number is large.
    text: `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`,
    hint: null,
    tone: rate === 0 ? 'good' : rate > FAILURE_RATE_BAD_ABOVE ? 'bad' : 'neutral',
  };
}

/** Milliseconds as something readable at a glance — a render runs seconds to tens of minutes. */
export function formatMs(ms: number): string {
  // Not 0 → "0ms". A zero here means "no completed renders to measure", and a duration of zero
  // is not a fact the pipeline can produce.
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  // 3m 60s is wrong and looks like a bug; carry it.
  return sec === 60 ? `${min + 1}m 00s` : `${min}m ${String(sec).padStart(2, '0')}s`;
}
