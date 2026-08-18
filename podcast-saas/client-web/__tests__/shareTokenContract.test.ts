/**
 * types-010 — the share endpoints are the one project boundary `ClientV1Api` does not cover, so
 * whatever `res.json()` returns went straight into the UI behind an `as` cast:
 *
 *   lib/api.ts          `return r.json() as Promise<{ shareToken: string; shareUrl: string }>`
 *   ProjectHeader.tsx   `const d = await r.json() as { shareToken?: string | null }`
 *
 * A cast is a promise the compiler cannot keep. `createShareToken`'s result is destructured
 * straight into component state (`const { shareToken: tok } = …; setShareToken(tok)`), and the
 * copy button then renders `${origin}/v/${shareToken}`. So a body missing the field produced
 * `/v/undefined`, and a numeric one produced a plausible-looking link to nothing — in BOTH cases
 * with the button flipped to its "shared" state and no error shown anywhere. The user copies a
 * dead link and finds out from whoever they sent it to.
 *
 * The two endpoints get deliberately different failure modes, and both are pinned here:
 *   • POST is a user-initiated action, so a bad body THROWS and the caller's catch renders it.
 *   • GET is fire-and-forget page load, so a bad body degrades to "not shared" — never to a
 *     half-real token. Silently ignoring it is what the component already did; what is new is
 *     that a non-string can no longer slip through as if it were a token.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/firebase', () => ({
  auth: { currentUser: { getIdToken: async () => 'tok-1' } },
  useAuth: () => ({ user: null, loading: false }),
}));

import { createShareToken, getShareToken } from '../lib/api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const responds = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('createShareToken — the copied link is a validated string or an error', () => {
  const MALFORMED: Array<[string, unknown]> = [
    ['an empty body', {}],
    ['a null token', { shareToken: null, shareUrl: null }],
    ['a numeric token', { shareToken: 12345, shareUrl: 'http://app/v/12345' }],
    ['an empty-string token', { shareToken: '', shareUrl: '' }],
    ['a renamed field', { share_token: 'abc', share_url: 'http://app/v/abc' }],
    ['an error envelope returned with 200', { message: 'Project not found' }],
  ];

  for (const [name, body] of MALFORMED) {
    it(`rejects ${name} instead of handing it to the share sheet`, async () => {
      fetchMock.mockResolvedValue(responds(201, body));
      await expect(createShareToken('proj-1')).rejects.toThrow();
    });
  }

  it('returns a well-formed link unchanged', async () => {
    fetchMock.mockResolvedValue(responds(201, { shareToken: 'abc123', shareUrl: 'http://app/v/abc123' }));
    await expect(createShareToken('proj-1')).resolves.toEqual({
      shareToken: 'abc123',
      shareUrl: 'http://app/v/abc123',
    });
  });

  it('still reports a non-OK status as an error', async () => {
    fetchMock.mockResolvedValue(responds(404, { message: 'Project not found' }));
    await expect(createShareToken('proj-1')).rejects.toThrow(/404/);
  });
});

describe('getShareToken — a page load never adopts a half-real token', () => {
  it('reads a real token', async () => {
    fetchMock.mockResolvedValue(responds(200, { shareToken: 'abc123', shareUrl: 'http://app/v/abc123' }));
    await expect(getShareToken('proj-1')).resolves.toEqual({
      shareToken: 'abc123',
      shareUrl: 'http://app/v/abc123',
    });
  });

  it('reads the genuine not-shared response', async () => {
    fetchMock.mockResolvedValue(responds(200, { shareToken: null, shareUrl: null }));
    await expect(getShareToken('proj-1')).resolves.toEqual({ shareToken: null, shareUrl: null });
  });

  const DEGRADES: Array<[string, unknown]> = [
    ['a numeric token', { shareToken: 999, shareUrl: 'http://app/v/999' }],
    ['a renamed field', { share_token: 'abc' }],
    ['an object token', { shareToken: { value: 'abc' }, shareUrl: null }],
  ];

  for (const [name, body] of DEGRADES) {
    it(`degrades ${name} to not-shared rather than a broken link`, async () => {
      fetchMock.mockResolvedValue(responds(200, body));
      await expect(getShareToken('proj-1')).resolves.toEqual({ shareToken: null, shareUrl: null });
    });
  }

  it('degrades a non-OK status to not-shared without throwing', async () => {
    fetchMock.mockResolvedValue(responds(404, { message: 'Project not found' }));
    await expect(getShareToken('proj-1')).resolves.toEqual({ shareToken: null, shareUrl: null });
  });

  it('degrades a network failure to not-shared without throwing', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(getShareToken('proj-1')).resolves.toEqual({ shareToken: null, shareUrl: null });
  });
});
