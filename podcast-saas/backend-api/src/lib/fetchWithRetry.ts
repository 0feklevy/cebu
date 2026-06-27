/**
 * Resilient fetch for transient network failures talking to object storage / external
 * hosts — e.g. HTTP/2 "GOAWAY" frames (undici reuses an HTTP/2 connection the server
 * has decided to close), connection resets, or transient 5xx. Retries with backoff;
 * never retries deterministic 4xx.
 */
export async function fetchWithRetry(
  input: string | URL,
  init?: RequestInit,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const baseDelay = opts.baseDelayMs ?? 250;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init);
      if (res.status >= 500 && attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastErr;
}
