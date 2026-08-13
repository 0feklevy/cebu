/**
 * The wire contract of lib/api.ts's `startProjectExport` — the one request in the export flow the
 * generated client cannot make, tested against a stubbed fetch because the mocked-module tests in
 * export-video.test.tsx stop at the api boundary and would let this file lie.
 *
 * Two things are load-bearing here:
 *
 * - CONSENT IS A WIRE FACT. A plain start sends NO body; only the explicit opt-in serialises
 *   `{ allow_degraded: true }`. If the flag ever leaked into the plain POST, the server would
 *   treat every export as pre-consented and the dialog upstream would be theatre.
 * - THE 409 PAYLOAD SURVIVES. `ClientV1Api.request()` throws `Error(message)` and discards the
 *   body — this function must carry `code` and `warnings` through, or the consent dialog has
 *   nothing to show.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/firebase', () => ({
  auth: { currentUser: { getIdToken: async () => 'tok-1' } },
  useAuth: () => ({ user: null, loading: false }),
}));

import { DegradedOnlyError, isDegradedOnlyRefusal, startProjectExport } from '../lib/api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const accepted = (body: unknown): unknown => ({
  ok: true, status: 202,
  json: async () => body,
});

describe('startProjectExport wire contract', () => {
  it('a plain start POSTs the export endpoint with NO body — consent is never implied', async () => {
    fetchMock.mockResolvedValue(accepted({ export_id: 'exp-1', status: 'queued' }));

    const started = await startProjectExport('proj-1');

    expect(started.export_id).toBe('exp-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('http://localhost:8080/api/v1/projects/proj-1/export');
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(init.headers.Authorization).toBe('Bearer tok-1');
  });

  it('a consented start carries exactly { allow_degraded: true }', async () => {
    fetchMock.mockResolvedValue(accepted({ export_id: 'exp-1', status: 'queued' }));

    await startProjectExport('proj-1', { allowDegraded: true });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(JSON.parse(init.body as string)).toEqual({ allow_degraded: true });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('409 degraded_only surfaces as a typed refusal that carries the warnings', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 409,
      json: async () => ({
        code: 'degraded_only',
        message: 'This export can only complete with substitutions.',
        warnings: ['Section 2: poster still.', 'Section 5: poster still.'],
      }),
    });

    const err = await startProjectExport('proj-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DegradedOnlyError);
    expect(isDegradedOnlyRefusal(err)).toBe(true);
    expect((err as DegradedOnlyError).warnings).toEqual(['Section 2: poster still.', 'Section 5: poster still.']);
    expect((err as Error).message).toBe('This export can only complete with substitutions.');
  });

  it('any other refusal throws the server message — a 409 WITHOUT the code is not a consent question', async () => {
    // The controller uses 409 for other conflicts too ("this export already finished"); only the
    // code names the consent case. Status-sniffing alone would pop the dialog on the wrong ones.
    fetchMock.mockResolvedValue({
      ok: false, status: 409,
      json: async () => ({ message: 'This export already finished (ready).' }),
    });

    const err = await startProjectExport('proj-1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(isDegradedOnlyRefusal(err)).toBe(false);
    expect((err as Error).message).toBe('This export already finished (ready).');
  });

  it('a refusal whose body is not JSON still throws something readable', async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 502, statusText: 'Bad Gateway',
      json: async () => { throw new Error('not json'); },
    });

    const err = await startProjectExport('proj-1').catch((e: unknown) => e);
    expect((err as Error).message).toBe('Bad Gateway');
  });
});
