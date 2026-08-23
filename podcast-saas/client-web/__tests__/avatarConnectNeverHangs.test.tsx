/**
 * OWNER-REPORTED: the popup sits on "loading avatar" — a spinner and a "Connecting…" label that
 * never resolve into anything.
 *
 * There were two ways to reach that screen and stay there forever, and neither produced an error,
 * a log line the viewer could see, or anything to press:
 *
 *   1. THE START ANSWERS USELESSLY. A 200 is not a session — the vendor mint can respond without
 *      a usable token. `setToken('')` is falsy, so the conversation never mounted and no error
 *      was set. The popup kept its spinner for the life of the tab.
 *   2. THE START NEVER ANSWERS. `fetch` has no timeout of its own. A hung vendor call, a proxy
 *      holding the connection open, or a network that disappears mid-flight left the promise
 *      pending and the spinner with it.
 *
 * Both are now bounded and both offer a way forward. This is the same rule the viewer's segment
 * poll had to learn: giving up quietly is the bug; giving up loudly is a decision the viewer can
 * act on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, screen } from '@testing-library/react';

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('test-id-token') } },
}));

import { AvatarPopup } from '../components/avatar/AvatarPopup';

describe('the connect can never spin forever', () => {
  const realFetch = globalThis.fetch;
  let resolveStart: (body: Record<string, unknown>) => void;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (!String(url).includes('/api/v1/avatar/start')) return Promise.resolve(new Response('{}'));
      return new Promise<Response>((resolve) => {
        resolveStart = (body) => resolve(new Response(JSON.stringify(body), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup(); vi.useRealTimers(); globalThis.fetch = realFetch; consoleError.mockRestore();
  });

  it('a 200 with no session token is a failure, not a permanent spinner', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      resolveStart({ provider: 'anam', sessionToken: '', characterId: 'guide', characterSource: 'default' });
      await Promise.resolve();
    });

    expect(screen.getByText(/couldn't start right now/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
    // The identity still shows: the server said whose avatar this is, and that is true even
    // though the mint gave nothing back.
    expect(screen.getByText(/Ask your guide/i)).toBeTruthy();
  });

  it('a start that never answers gives up loudly once the watchdog fires', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" />);
    await act(async () => { await Promise.resolve(); });

    // Still waiting — correct, this is the window the neutral copy exists for.
    expect(screen.queryByText(/taking longer than expected/i)).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000 + 500); });

    expect(screen.getByText(/taking longer than expected/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('"Try again" clears the error and starts over', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      resolveStart({ provider: 'anam', sessionToken: '', characterId: 'guide' });
      await Promise.resolve();
    });
    expect(screen.getByText(/couldn't start right now/i)).toBeTruthy();

    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await act(async () => { screen.getByRole('button', { name: /try again/i }).click(); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByText(/couldn't start right now/i)).toBeNull();
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length)
      .toBeGreaterThan(before);
  });

  it('a start fetch that stalls past the half-window is retried once — and the retry connects', async () => {
    // 2026-08-23, live: on a presentation-venue network one start fetch stalled past the FULL
    // 30s watchdog while the server was answering others in under a second, and the viewer got
    // the timeout screen. The watchdog window now holds two attempts. The retry reuses the same
    // startKey — the identity of the OPEN — so the server collapses it onto the same lease and
    // a first-attempt mint nobody received simply expires.
    const starts: Array<{ resolve: (b: Record<string, unknown>) => void; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).includes('/api/v1/avatar/start')) return Promise.resolve(new Response('{}'));
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      return new Promise<Response>((resolve, reject) => {
        starts.push({ resolve: (b) => resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })), body });
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }) as unknown as typeof fetch;

    render(<AvatarPopup open onClose={() => {}} projectId="p1" />);
    await act(async () => { await Promise.resolve(); });
    expect(starts.length).toBe(1);

    // Half the watchdog passes with the first fetch still hanging…
    await act(async () => { vi.advanceTimersByTime(15_000 + 50); await Promise.resolve(); });
    expect(starts.length, 'no retry was attempted').toBe(2);
    // …and the retry carries the SAME open identity, so the server dedupes instead of double-minting.
    expect(starts[1].body.startKey).toBe(starts[0].body.startKey);

    await act(async () => {
      // A STRUCTURALLY VALID JWT: resolving with a mountable token mounts AvatarConversation,
      // whose real @anam-ai/js-sdk decodes it — a plain string threw 'Invalid session token
      // format' as an unhandled rejection and failed the whole file in the full-suite run.
      starts[1].resolve({ provider: 'anam', sessionToken: 'eyJhbGciOiAiSFMyNTYiLCAidHlwIjogIkpXVCJ9.eyJ0eXBlIjogImVwaGVtZXJhbCIsICJzZXNzaW9uU3RvcmVJZCI6ICJzLTEiLCAiZXhwIjogNDEwMjQ0NDgwMH0.sig', characterId: 'guide', characterSource: 'default' });
      await Promise.resolve(); await Promise.resolve();
    });
    // The retry's token connects: no error screen, no timeout message.
    expect(screen.queryByText(/taking longer than expected/i)).toBeNull();
    expect(screen.queryByText(/couldn't start right now/i)).toBeNull();
  });
});
