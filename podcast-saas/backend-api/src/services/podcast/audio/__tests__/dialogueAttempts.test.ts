/**
 * How many requests actually reached the vendor — the number nobody was reporting.
 *
 * `ElevenLabsDialogue.synthesize` retries transient failures internally, up to four times. Every
 * attempt that reaches ElevenLabs is billed: the text arrived, so a 500 on their side is not a
 * refund. A caller counting one synthesis per call therefore under-reports by up to 4× exactly
 * when the account is being rate-limited — which is when spend is highest and the number matters
 * most.
 *
 * The client reports `attempts` and does not record anything itself. It is shared by the renderer,
 * the preview and the re-voice paths, and it knows none of their users or projects — metering here
 * would attribute every charge to nobody.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../secrets/ApiKeyService.js', () => ({
  ApiKeyService: class { async getSystemKey() { return 'test-key'; } },
}));
vi.mock('../../../../db/index.js', () => ({ db: {} }));

import { ElevenLabsDialogue } from '../ElevenLabsDialogue.js';

const ok = () => new Response(
  JSON.stringify({ audio_base64: Buffer.from('audio').toString('base64'), voice_segments: [] }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

const realFetch = globalThis.fetch;
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); globalThis.fetch = realFetch; });

/** Runs a synthesis with fake timers, so the client's backoff sleeps do not stall the suite. */
async function synthesizeWith(responses: Array<() => Response>): Promise<{ attempts: number }> {
  let i = 0;
  globalThis.fetch = vi.fn(async () => (responses[Math.min(i++, responses.length - 1)]!)()) as typeof fetch;
  const p = new ElevenLabsDialogue().synthesize({ inputs: [{ text: 'hello' }] as never });
  await vi.runAllTimersAsync();
  return (await p) as unknown as { attempts: number };
}

describe('the attempt count the meter multiplies by', () => {
  it('is 1 when the first request succeeds', async () => {
    const r = await synthesizeWith([ok]);
    expect(r.attempts).toBe(1);
  });

  it('counts every retried request, because every one of them was billed', async () => {
    // Two 500s then success. The vendor received the text three times.
    const r = await synthesizeWith([
      () => new Response('upstream', { status: 500 }),
      () => new Response('upstream', { status: 500 }),
      ok,
    ]);
    expect(r.attempts).toBe(3);
  });

  it('counts a rate-limited run, which is the expensive case', async () => {
    // 429 is the shape of the failure that costs the most: the account is already spending fast
    // enough to be throttled, and the retries add to the bill rather than replacing it.
    const r = await synthesizeWith([
      () => new Response('slow down', { status: 429 }),
      ok,
    ]);
    expect(r.attempts).toBe(2);
  });

  it('never reports zero — a caller multiplying by it would price the call as free', async () => {
    const r = await synthesizeWith([ok]);
    expect(r.attempts).toBeGreaterThan(0);
  });
});
