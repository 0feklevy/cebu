/**
 * B-ROLLS DURING A CONVERSATION — reported by the owner as "לא עובדים", and as slow.
 *
 * This suite reproduces the report from the SYMPTOM, not from a code reading: it mounts the real
 * AvatarConversation with the real useVisualTrigger / useImageTrigger / avatarApi, and puts a
 * fetch double in front of them that behaves the way the deployed server behaves.
 *
 * The server's behaviour that matters is not incidental — it is asserted, on the server, by
 * backend-api/src/controllers/v1/__tests__/avatarSpendGuard.test.ts:
 *
 *   "visual/analyze on a private project: 404, and the model is never called"
 *   "the owner of that private project is still served"   (that test sets request.dbUser)
 *
 * `/api/v1/avatar/visual/analyze` and `/api/v1/avatar/image/analyze` run
 * `allowedProjectForBillable`, which reads `request.dbUser` and answers 404 for a project whose
 * `visibility` is `private`. `projects.visibility` is `notNull().default('private')`
 * (backend-api/src/db/schema.ts:173), so that is EVERY project until its owner publishes it.
 *
 * `request.dbUser` is populated by firebaseAuthOptionalMiddleware from the Authorization header,
 * and avatarApi's `jsonFetch` only attaches that header when asked to (`withAuth`, default false).
 * startAvatarSession and getPublicLibrary ask for it. analyzeVisual and analyzeImage did not.
 *
 * So the avatar connected, listened, answered — and every single visual request behind it came
 * back 404, was swallowed by the `.catch(() => ({ type: 'none' }))` in avatarApi, and the viewer
 * saw nothing at all. Not late. Never.
 *
 * The second half of the report ("לוקח להם זמן להיטען") is the fresh-image path, which is
 * inherently seconds: a classify completion, then a gpt-image-1 render, then a storage upload.
 * What is NOT inherent is that the viewer is shown nothing while it runs. VisualPanel has had a
 * shimmering "Generating image…" state for `image_loading` the whole time
 * (VisualPanel.tsx:57-62, .avatar-image-shimmer in avatar.css) and NOTHING IN THE PRODUCT EVER
 * SET IT — grep for `image_loading` and the only two hits are the type declaration and the
 * renderer that consumes it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup, waitFor } from '@testing-library/react';

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

// The owner is signed in — this is them previewing their OWN video.
vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('owner-id-token') } },
}));

import { AvatarConversation } from '../components/avatar/AvatarConversation';

const PRIVATE_PROJECT = 'p1';
const IMAGE_URL = 'https://cdn.example.test/broll-finch-beaks.png';

interface Call { path: string; authed: boolean; body: Record<string, unknown> }
let calls: Call[] = [];
/** Held image responses, so "while it is still generating" is an observable state. */
let releaseImage: (() => void) | null = null;
let holdImage = false;

const authOf = (init?: RequestInit): boolean => {
  const h = (init?.headers ?? {}) as Record<string, string>;
  return typeof h.Authorization === 'string' && h.Authorization.length > 0;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * The deployed server, for a project whose visibility is `private` (the default) owned by the
 * caller: anonymous → 404 (allowedProjectForBillable), authenticated → served.
 */
function installServer() {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url), 'http://localhost:8080').pathname;
    const authed = authOf(init);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, authed, body });

    if (path === '/api/v1/avatar/memory') return json({ token: null, turns: [], profile: {} });
    if (path === '/api/v1/avatar/end') return json({ ok: true });

    if (path === '/api/v1/avatar/visual/analyze') {
      // A private project is invisible to an anonymous caller, and the denial is 404 so the
      // project's existence is not revealed by a paid endpoint.
      if (!authed) return json({ type: 'none' }, 404);
      // The classifier's default branch: "image — USE BY DEFAULT" (visualService CLASSIFY_PROMPT).
      return json({
        type: 'image',
        dallePrompt: 'finch beaks of the Galápagos, photorealistic, cinematic lighting',
        imageType: 'realistic',
        caption: 'Finch beaks vary with the food available on each island.',
        _intentRequestedType: null,
      });
    }

    if (path === '/api/v1/avatar/image/analyze') {
      if (!authed) return json({ shouldGenerate: false, imageUrl: null, altText: '', caption: '', imageType: 'realistic' }, 404);
      if (holdImage) await new Promise<void>((resolve) => { releaseImage = resolve; });
      return json({
        shouldGenerate: true,
        imageUrl: IMAGE_URL,
        altText: 'Finch beaks',
        caption: 'Finch beaks vary with the food available on each island.',
        imageType: 'realistic',
      });
    }
    return json({});
  }) as typeof fetch;
}

const emit = (ev: string, ...args: unknown[]) => (anam.state.listeners.get(ev) ?? []).forEach((fn) => fn(...args));
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); }); };

const mount = async () => {
  render(<AvatarConversation characterId="darwin" projectId={PRIVATE_PROJECT} sessionToken="tok" onLeave={() => {}} />);
  await flush();
};

/** The viewer asks a question out loud and stops speaking. */
const viewerAsks = async (text: string) => {
  await act(async () => {
    emit('MESSAGE_STREAM_EVENT_RECEIVED', { endOfSpeech: true, interrupted: false, content: text, role: 'user' });
  });
  await flush();
};

const shownImage = () => document.querySelector('.avatar-image-overlay__img') as HTMLImageElement | null;
const analyzeCalls = () => calls.filter((c) => c.path.endsWith('/analyze'));

describe('b-rolls during a conversation', () => {
  beforeEach(() => {
    calls = [];
    holdImage = false;
    releaseImage = null;
    anam.state.listeners.clear();
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true, writable: true, value: function (this: HTMLMediaElement) { return Promise.resolve(); },
    });
    installServer();
  });

  afterEach(() => { cleanup(); vi.useRealTimers(); });

  // ── 1. IS IT TRIGGERED AT ALL? ────────────────────────────────────────────────────────────
  it('shows a b-roll to the owner of their own (default-private) video', async () => {
    await mount();
    await viewerAsks('why do the finch beaks differ between the islands?');

    // The whole report, in one assertion: the viewer asked, and a visual appeared.
    await waitFor(() => expect(shownImage()).not.toBeNull());
    expect(shownImage()!.src).toBe(IMAGE_URL);
  });

  it('sends the owner credential on the analyze calls, or the server cannot know who is asking', async () => {
    // The mechanism behind the test above, asserted directly so a regression names itself.
    // Without this header request.dbUser is undefined, allowedProjectForBillable answers 404,
    // and avatarApi's .catch() turns the refusal into a silent {type:'none'}.
    await mount();
    await viewerAsks('why do the finch beaks differ between the islands?');

    await waitFor(() => expect(analyzeCalls().length).toBeGreaterThan(0));
    for (const call of analyzeCalls()) {
      expect(call.authed, `${call.path} was sent anonymously`).toBe(true);
    }
  });

  // ── 2. LATENCY: WHAT THE VIEWER SEES WHILE IT RUNS ────────────────────────────────────────
  it('shows progress while the image is still being generated, instead of nothing', async () => {
    // The fresh-image path is a classify completion plus a gpt-image-1 render plus an upload.
    // It is seconds, and no client change makes it not seconds. What the client controls is
    // whether those seconds look like a working product or a broken one.
    holdImage = true;
    await mount();
    await viewerAsks('why do the finch beaks differ between the islands?');

    await waitFor(() => expect(screen.queryByText(/Generating image/i)).not.toBeNull());
    expect(shownImage()).toBeNull(); // …and it is genuinely still in flight

    await act(async () => { releaseImage?.(); await flush(); });
    await waitFor(() => expect(shownImage()).not.toBeNull());
    // The placeholder gives way to the real thing.
    expect(screen.queryByText(/Generating image/i)).toBeNull();
  });

  // ── 3. STRUCTURAL: DO NOT PAY FOR THE SAME CLASSIFICATION TWICE ───────────────────────────
  it('asks the server exactly twice for one question, and hands it no prompt of its own', async () => {
    // /visual/analyze answers {type:'image', dallePrompt, imageType, caption} — a finished prompt
    // from a completed gpt-4.1-mini call — and /image/analyze then ran a SECOND gpt-4.1-mini
    // completion to work the same thing out again, in front of the viewer, before any pixel was
    // rendered. That duplicate is now removed, but DELIBERATELY NOT by posting the prompt back:
    // `dallePrompt` is the exact string handed to gpt-image-1, and the only thing standing
    // between a caller and arbitrary image generation is that a model writes it under a system
    // prompt forbidding faces, text and anything over 900 characters. Accepting it from the
    // request would turn this endpoint into an open image generator that happens to be metered.
    //
    // So the join happens server-side (backend-api/src/services/avatar/visualClassifyMemo.ts,
    // proved in visualImageHandoff.test.ts) and the client's contract is what is asserted here:
    // two calls, and no prompt on the wire.
    await mount();
    await viewerAsks('why do the finch beaks differ between the islands?');

    await waitFor(() => expect(calls.some((c) => c.path === '/api/v1/avatar/image/analyze')).toBe(true));
    expect(analyzeCalls().map((c) => c.path)).toEqual([
      '/api/v1/avatar/visual/analyze',
      '/api/v1/avatar/image/analyze',
    ]);
    const img = calls.find((c) => c.path === '/api/v1/avatar/image/analyze')!;
    expect(img.body.dallePrompt).toBeUndefined();
    // The message the server keys its parked classification on is the same in both calls.
    const vis = calls.find((c) => c.path === '/api/v1/avatar/visual/analyze')!;
    expect(img.body.userMessage).toBe(vis.body.message);
  });
});
