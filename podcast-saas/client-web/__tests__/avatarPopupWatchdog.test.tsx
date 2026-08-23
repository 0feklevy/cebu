/**
 * The popup's watchdog bounds only POST /avatar/start. Once that request has returned a usable
 * token, AvatarConversation owns the connection lifecycle. A stale parent timer used to fire at
 * 30s anyway, replace the active child with "taking longer than expected", and unmount/stop it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('test-id-token') } },
}));

vi.mock('../components/avatar/AvatarConversation', () => ({
  AvatarConversation: () => <div data-testid="active-avatar">Active avatar conversation</div>,
}));

import { AvatarPopup } from '../components/avatar/AvatarPopup';
import { CONNECT_WATCHDOG_MS } from '../components/avatar/anamConnectPolicy';

describe('AvatarPopup start watchdog', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (!String(url).includes('/api/v1/avatar/start')) return Promise.resolve(new Response('{}'));
      return Promise.resolve(new Response(JSON.stringify({
        provider: 'anam',
        sessionToken: 'usable-session-token',
        characterId: 'guide',
        characterSource: 'default',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it('does not replace an active conversation when the start window elapses', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByTestId('active-avatar')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(CONNECT_WATCHDOG_MS + 1); });

    expect(screen.getByTestId('active-avatar')).toBeTruthy();
    expect(screen.queryByText(/taking longer than expected/i)).toBeNull();
  });
});
