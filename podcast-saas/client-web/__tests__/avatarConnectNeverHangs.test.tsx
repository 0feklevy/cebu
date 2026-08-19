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
});
