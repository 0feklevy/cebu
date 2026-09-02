/**
 * `Promise.all(items.map(fn))` with a ceiling on how many `fn` calls are in flight.
 *
 * The playlist play-config fanned `buildPlayerConfig` out N-wide with no bound — and each call
 * is 11–17 queries against a pool of 10, so one long playlist could occupy the whole pool and
 * starve every other request (night run 2026-09-03 §7). Results keep the input order; the first
 * rejection rejects the whole call, exactly as `Promise.all` does.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: { err: unknown } | null = null;
  const worker = async (): Promise<void> => {
    while (next < items.length && failure === null) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        if (failure === null) failure = { err };
      }
    }
  };
  const width = Math.max(1, Math.min(Math.floor(limit), items.length || 1));
  await Promise.all(Array.from({ length: width }, worker));
  if (failure !== null) throw (failure as { err: unknown }).err;
  return results;
}
