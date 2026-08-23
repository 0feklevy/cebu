/**
 * The reconnect path's denial copy — the one line #121 shipped flagged "no test".
 *
 * A viewer whose live session drops meets "Connection lost" and a Reconnect button. When the
 * budget REFUSES that reconnect (enforce mode), the old copy said "Reconnect failed. Please close
 * and try again." — and closing and trying again is the one instruction guaranteed not to work,
 * because the next open meets the same limit. The fix routes the shared, enum-generated denial
 * copy into joinError. This harness produces the live connection-lost event the in-code note said
 * no harness produced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

const anam = vi.hoisted(() => {
  const AnamEvent = {
    MESSAGE_HISTORY_UPDATED: 'MESSAGE_HISTORY_UPDATED',
    MESSAGE_STREAM_EVENT_RECEIVED: 'MESSAGE_STREAM_EVENT_RECEIVED',
    CONNECTION_ESTABLISHED: 'CONNECTION_ESTABLISHED',
    CONNECTION_CLOSED: 'CONNECTION_CLOSED',
    VIDEO_STREAM_STARTED: 'VIDEO_STREAM_STARTED',
    VIDEO_PLAY_STARTED: 'VIDEO_PLAY_STARTED',
    AUDIO_STREAM_STARTED: 'AUDIO_STREAM_STARTED',
    SERVER_WARNING: 'SERVER_WARNING',
    MIC_PERMISSION_DENIED: 'MIC_PERMISSION_DENIED',
  };
  return { AnamEvent, state: { listeners: new Map<string, Array<(...a: unknown[]) => void>>() } };
});

vi.mock('@anam-ai/js-sdk', () => ({
  AnamEvent: anam.AnamEvent,
  createClient: () => ({
    addListener: (ev: string, fn: (...a: unknown[]) => void) => {
      const list = anam.state.listeners.get(ev) ?? [];
      list.push(fn);
      anam.state.listeners.set(ev, list);
    },
    streamToVideoElement: async () => {},
    stopStreaming: async () => {},
    muteInputAudio: () => {},
    unmuteInputAudio: () => {},
  }),
}));
vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('viewer-id-token') } },
}));

import { AvatarConversation } from '../components/avatar/AvatarConversation';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** start answers per `startMode`; everything else is quietly fine. */
let startMode: 'denied' | 'plain-500' = 'denied';
function installServer() {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
    const path = new URL(String(url), 'http://localhost:8080').pathname;
    if (path === '/api/v1/avatar/start') {
      return startMode === 'denied'
        ? json({ message: 'x', reason: 'limited', retryAfterSec: 45 }, 429)
        : json({ message: 'Avatar session failed' }, 500);
    }
    if (path === '/api/v1/avatar/memory') return json({ token: null, turns: [], profile: {} });
    return json({ ok: true });
  }) as unknown as typeof fetch;
}

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };

const fire = async (ev: string, ...args: unknown[]) => {
  await act(async () => {
    for (const fn of anam.state.listeners.get(ev) ?? []) fn(...args);
    await Promise.resolve();
  });
};

describe('a REFUSED reconnect explains itself', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    anam.state.listeners.clear();
    installServer();
  });
  afterEach(() => { cleanup(); globalThis.fetch = realFetch; });

  const mountAndDrop = async () => {
    render(<AvatarConversation characterId="darwin" projectId="p1" sessionToken="tok" onLeave={() => {}} />);
    await flush();
    await fire(anam.AnamEvent.CONNECTION_CLOSED);
    expect(screen.getByText(/connection lost/i)).toBeTruthy();
  };

  it('shows the shared denial copy, not "close and try again"', async () => {
    startMode = 'denied';
    await mountAndDrop();
    await act(async () => { screen.getByRole('button', { name: /^reconnect$/i }).click(); });
    await flush();

    // The enum-generated copy — the viewer learns this is a limit with a wait, and is NOT told
    // to close and reopen into the same refusal.
    expect(screen.getByText(/reached the avatar limit/i)).toBeTruthy();
    expect(screen.queryByText(/close and try again/i)).toBeNull();
  });

  it('keeps the generic copy for a failure that is NOT an explained denial', async () => {
    startMode = 'plain-500';
    await mountAndDrop();
    await act(async () => { screen.getByRole('button', { name: /^reconnect$/i }).click(); });
    await flush();

    expect(screen.getByText(/close and try again/i)).toBeTruthy();
  });
});
