/**
 * OWNER-REPORTED: "still 'connecting to einstein' by default" on a project whose configured
 * persona is Pnina.
 *
 * The popup renders its header and its spinner label from `characterMeta(resolvedCharacter,
 * avatarDisplay)`. Both inputs are empty until POST /api/v1/avatar/start comes back, and the
 * component seeded `resolvedCharacter` from a prop whose default is the client's own
 * DEFAULT_CHARACTER_ID — 'einstein'. No call site (LessonPlayer, ViewerPage, SharedViewerPage,
 * PlaylistViewer) passes that prop, so the default is what every viewer got: for the whole
 * duration of the start — the slowest call in the product — the screen said "Ask Albert Einstein"
 * and "Connecting to Einstein…" over an einstein portrait, for a video configured as Pnina.
 *
 * A client-side default may not name a persona. Until the project's own identity arrives, the
 * popup must say something true and unnamed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, screen } from '@testing-library/react';

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('test-id-token') } },
}));

import { AvatarPopup } from '../components/avatar/AvatarPopup';

type Resolver = (body: Record<string, unknown>) => void;

describe('AvatarPopup — the project persona names the popup, never the client default', () => {
  const realFetch = globalThis.fetch;
  let resolveStart: Resolver;

  beforeEach(() => {
    globalThis.fetch = vi.fn((url: RequestInfo | URL) => {
      if (!String(url).includes('/api/v1/avatar/start')) return Promise.resolve(new Response('{}'));
      return new Promise<Response>((resolve) => {
        resolveStart = (body) => resolve(new Response(JSON.stringify(body), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      });
    }) as unknown as typeof fetch;
  });

  afterEach(() => { cleanup(); globalThis.fetch = realFetch; });

  const portraits = () =>
    Array.from(document.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '');

  it('names no character while the start is still in flight', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" videoTitle="The Edge of Chaos" />);
    await act(async () => { await Promise.resolve(); });

    // The whole visible surface, not just the label: the header says "Ask <name>" too.
    expect(document.body.textContent).not.toMatch(/einstein/i);
    expect(portraits().some((src) => /einstein/i.test(src))).toBe(false);
  });

  it('shows the project persona once the start answers with it', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" videoTitle="The Edge of Chaos" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      resolveStart({
        provider: 'anam',
        sessionToken: '',            // empty → the popup keeps the spinner, so the label is assertable
        characterId: 'einstein',     // the server's normalized character — NOT the display identity
        avatarDisplay: { displayName: 'Pnina', startingLabel: 'Connecting to Pnina...', portrait: 'https://img/pnina.png' },
      });
      await Promise.resolve();
    });

    expect(screen.getByText(/connecting to pnina/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/einstein/i);
    expect(portraits().some((src) => /einstein/i.test(src))).toBe(false);
  });

  it('does not dress a renamed persona in the default character\'s face and labels', async () => {
    // The narrowest real case: the server knows the persona's NAME but has no portrait for it yet
    // (a stateful session whose avatar identity has not been resolved, or one with no image).
    // characterMeta merged that name over CHARACTER_META.einstein, so the popup showed "Pnina"
    // above Einstein's portrait and, before the label was overridden, "Connecting to Einstein…".
    render(<AvatarPopup open onClose={() => {}} projectId="p1" videoTitle="The Edge of Chaos" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      resolveStart({
        provider: 'anam',
        sessionToken: '',
        characterId: 'einstein',
        avatarDisplay: { displayName: 'Pnina' },
      });
      await Promise.resolve();
    });

    expect(document.body.textContent).toMatch(/pnina/i);
    expect(document.body.textContent).not.toMatch(/einstein/i);
    expect(portraits().some((src) => /einstein/i.test(src))).toBe(false);
  });
});
