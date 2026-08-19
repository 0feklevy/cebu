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
/**
 * The conversation is doubled because this file is about the HEADER, not the stream.
 *
 * A non-empty session token is now required to get past the popup's "a 200 is not a session"
 * check, and a non-empty token mounts the real conversation, which hands the token straight to
 * the Anam SDK. The SDK decodes it as a JWT and rejects — asynchronously, as an UNHANDLED
 * REJECTION that leaves every assertion green and fails the suite at the very end with
 * "Errors 1 error". Nothing here needs a live session; stubbing the lazy SDK loader keeps the
 * test on the thing it is actually asserting.
 */
vi.mock('../components/avatar/anamSdk', () => ({
  preloadAnamSdk: () => {},
  loadAnamSdk: async () => ({
    createClient: () => ({
      streamToVideoElement: async () => {},
      addListener: () => {},
      stopStreaming: async () => {},
      muteInputAudio: () => {},
      unmuteInputAudio: () => {},
    }),
    AnamEvent: {},
  }),
}));

import { AvatarPopup } from '../components/avatar/AvatarPopup';
import { displayIdentity } from '../components/avatar/characters';

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

  /**
   * THE HOLE THE FIRST FIX LEFT, reported again by the owner as "still stuck on default".
   *
   * The old guard was `resolvedCharacter || avatarDisplay?.displayName`. `resolvedCharacter` is
   * ALWAYS truthy once the start answers — the server must route the session to some prompt, and
   * for a project that configured nothing that is the fallback 'einstein'. So the neutral branch
   * was unreachable at exactly the moment it mattered, and the fallback was rendered as though
   * the owner had picked it: "Ask Albert Einstein", the portrait, "Connecting to Einstein…".
   *
   * The server now says WHERE the id came from, and only a chosen character may be named.
   */
  /**
   * THE DEFAULT IS NAMED — because the default is now something nameable.
   *
   * An earlier version of this rule refused to name a DEFAULTED character, which was right while
   * the default was Einstein: a project that chose nothing should not be told it is talking to
   * Albert Einstein. But hiding the name only moved the dishonesty. The header read "Ask the
   * avatar" and "Connecting…" while the persona behind it opened with "Guten Tag!" and insisted
   * it was Einstein — and to a viewer that neutral copy read as a screen stuck loading, which is
   * how it was reported.
   *
   * The default is now `guide`, whose prompt claims no biography, so the interface can simply say
   * who is on the other end. What must never come back is Einstein by default.
   */
  it('a defaulted project is named as the neutral guide, never as Einstein', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" videoTitle="The Edge of Chaos" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      resolveStart({
        provider: 'anam',
        sessionToken: 'tok',
        characterId: 'guide',
        characterSource: 'default',
      });
      await Promise.resolve();
    });

    expect(screen.getByText(/Ask your guide/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/einstein/i);
    expect(portraits().some((src) => /einstein/i.test(src))).toBe(false);
  });

  it('a CONFIGURED character is named — this is a real choice, not a fallback', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" videoTitle="The Edge of Chaos" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      resolveStart({
        provider: 'anam',
        sessionToken: '',
        characterId: 'einstein',
        characterSource: 'configured',   // the owner picked Einstein
      });
      await Promise.resolve();
    });

    expect(screen.getByText(/Ask Albert Einstein/i)).toBeTruthy();
  });

  it('a server-supplied name always wins, whatever the character id routes to', async () => {
    render(<AvatarPopup open onClose={() => {}} projectId="p1" videoTitle="The Edge of Chaos" />);
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      resolveStart({
        provider: 'anam',
        sessionToken: '',
        characterId: 'einstein',
        characterSource: 'default',
        avatarDisplay: { displayName: 'Pnina' },
      });
      await Promise.resolve();
    });

    expect(screen.getByText(/Ask Pnina/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/einstein/i);
  });

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

    // The header names the persona even though the mint produced no usable token — the server
    // told us whose avatar this is, and that is true whether or not a session exists.
    expect(screen.getByText(/Ask Pnina/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/einstein/i);
    expect(portraits().some((src) => /einstein/i.test(src))).toBe(false);
  });

  /**
   * The spinner LABEL is decided by the same pure rule, and is asserted against it directly
   * rather than through a render — a render can only show the label while the popup is still
   * waiting, and an empty token is now a failure rather than a permanent wait.
   */
  it('the connecting label follows the persona, not the routed character', () => {
    expect(displayIdentity('einstein', 'default', { displayName: 'Pnina', startingLabel: 'Connecting to Pnina...' }).startingLabel)
      .toMatch(/pnina/i);
    // …and a renamed persona never inherits the routed character's face.
    expect(displayIdentity('einstein', 'default', { displayName: 'Pnina' }).portrait).toBe('');
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
