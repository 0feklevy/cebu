// Regression: an owner viewing their own PRIVATE project must not be anonymous
// on the avatar endpoints that sit behind the optional-auth visibility gate.
// startAvatarSession without the token produced the masked 404 "Project not
// found" for the project's own owner; getPublicLibrary silently degraded to an
// empty library the same way.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('test-id-token') } },
}));

import { startAvatarSession, getPublicLibrary, analyzeVisual, analyzeImage } from '../components/avatar/avatarApi';

type Captured = { url: string; headers: Record<string, string> };

describe('avatarApi auth headers', () => {
  const captured: Captured[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    captured.length = 0;
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      captured.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ ok: true, items: [], total: 0, typeCounts: {}, type: 'none' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('startAvatarSession sends the Firebase token (private-project owners are not anonymous)', async () => {
    await startAvatarSession(undefined, 'proj-1');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/api/v1/avatar/start');
    expect(captured[0].headers.Authorization).toBe('Bearer test-id-token');
  });

  it('getPublicLibrary sends the Firebase token (private-project owners see their library)', async () => {
    await getPublicLibrary('proj-1');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/api/v1/avatar/projects/proj-1/library');
    expect(captured[0].headers.Authorization).toBe('Bearer test-id-token');
  });

  // WAS: "analyzeVisual stays anonymous (no visibility gate; IP rate-limited server-side)".
  //
  // The premise was false, and it was false at the time it was written: `/visual/analyze` and
  // `/image/analyze` became billable and picked up `allowedProjectForBillable` — the SAME
  // visibility gate the two tests above exist for — and its denial for a private project is the
  // same masked 404. `projects.visibility` defaults to `private`, so this applied to every
  // unpublished video, and avatarApi's `.catch()` turned the 404 into `{type:'none'}`, which the
  // trigger hooks read as "nothing worth showing". That is the owner's "b-rolls do not work".
  //
  // The test was not merely stale: it PINNED the bug, and would have failed the fix.
  it('analyzeVisual sends the Firebase token (private-project owners get their b-rolls)', async () => {
    await analyzeVisual('hello', 'char-1', undefined, 'proj-1');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/api/v1/avatar/visual/analyze');
    expect(captured[0].headers.Authorization).toBe('Bearer test-id-token');
  });

  it('analyzeImage sends it too — the image half of the same gate', async () => {
    await analyzeImage('hello', 'char-1', undefined, 'proj-1');
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toContain('/api/v1/avatar/image/analyze');
    expect(captured[0].headers.Authorization).toBe('Bearer test-id-token');
  });
});
