/**
 * How spend is written on the page — extracted so the rules can be tested without a browser.
 *
 * Every function here exists because there is a way to render this data that looks fine and misleads.
 * The 22 August incident was not caused by missing data; it was caused by nobody being able to see
 * it. Replacing that with a page that shows a confident wrong figure would be a worse outcome,
 * because a number on a dashboard gets believed in a way an empty screen never is.
 */

/**
 * Money, at a precision that does not pretend.
 *
 * Sub-cent totals are real — a single short preview costs a fraction of a cent — and rounding them
 * to `$0.00` tells the reader the work was free. Below a cent the figure keeps four decimals so it
 * reads as small rather than as nothing.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '—';
  if (usd === 0) return '$0.00';
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * A quantity with its unit, always together.
 *
 * The unit is not decoration. "1,400" beside "3" invites a reader to add them; "1,400 characters"
 * beside "3 images" does not. Formatting them apart is how the page would reintroduce the very
 * mistake the API shape was designed to prevent.
 */
export function formatQuantity(quantity: number, unit: string): string {
  if (!Number.isFinite(quantity)) return `— ${unit}`;
  const n = quantity >= 100 ? Math.round(quantity).toLocaleString('en-US') : String(Math.round(quantity * 10) / 10);
  return `${n} ${unit.replace(/_/g, ' ')}`;
}

/**
 * Seconds and minutes read better than raw seconds once there are a lot of them.
 *
 * `source_minutes` and `session_minutes` are already minutes and are left alone — converting a
 * unit that is already in its natural scale is how a display starts disagreeing with the invoice
 * it is meant to be compared against.
 */
export function humaniseUnit(quantity: number, unit: string): string {
  if (unit === 'seconds' && quantity >= 120) {
    return `${(quantity / 60).toFixed(1)} minutes of audio`;
  }
  if (unit === 'characters' && quantity >= 100_000) {
    return `${(quantity / 1_000).toFixed(0)}k characters`;
  }
  return formatQuantity(quantity, unit);
}

/**
 * What the page must say out loud beside a total, or null when there is nothing to warn about.
 *
 * Three separate ways a total can be misleading, and each one is silent by default:
 *
 *   • TRUNCATED — the window held more rows than one request summarises, so the figure is a
 *     partial sum wearing a total's clothes.
 *   • ALL ZERO — every row priced at nothing. That is what a misconfigured rate produces, and it
 *     renders identically to a genuinely quiet period.
 *   • MOSTLY ZERO — most rows priced at nothing while some were not, which is the shape of one
 *     provider's rate being wrong rather than the account being idle.
 */
export function spendCaveat(s: {
  rows: number;
  zeroCostRows: number;
  truncated: boolean;
  totalUsd: number;
}): string | null {
  if (s.truncated) {
    return 'This window held more rows than one request summarises — the total below is partial. Narrow the dates.';
  }
  if (s.rows === 0) return null;
  if (s.zeroCostRows === s.rows) {
    return `All ${s.rows.toLocaleString('en-US')} rows are priced at zero. That is what an unset or malformed rate looks like, not necessarily a quiet period.`;
  }
  if (s.zeroCostRows > s.rows / 2) {
    return `${s.zeroCostRows.toLocaleString('en-US')} of ${s.rows.toLocaleString('en-US')} rows are priced at zero — check the rate for the providers below.`;
  }
  return null;
}

/** `YYYY-MM-DD` for a date input, in UTC — the same boundary the API and an invoice use. */
export function toDateInput(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}
