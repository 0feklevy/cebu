/**
 * types-011 — GET /projects/:id/player-config answers with ONE of two shapes: a paywall stub
 * (`{ locked: true, content_id, title, price_cents, currency }`) or a full PlayerConfig. Never
 * both, and never a merge of the two.
 *
 * ViewerPage modelled it as `PlayerConfig & Partial<LockedContent>` — an INTERSECTION, which
 * claims every field of BOTH variants is present at once. That is the opposite of what the server
 * guarantees, and it costs two things:
 *
 *   1. It disables the compiler exactly where narrowing was needed. `data.segments` typechecks
 *      inside the locked branch, where it does not exist.
 *   2. It hides a real crash. The very next line is `if (!data.segments.length)`, so ANY 200 body
 *      that is neither variant — a proxy's cached JSON error page, an auth-wall body, a future
 *      third variant — throws `TypeError: Cannot read properties of undefined (reading 'length')`.
 *      That lands in the catch and is rendered to the viewer verbatim, as the error text on a
 *      black screen. A JS internal, shown to a paying customer, for a server-side problem.
 *
 * These render the REAL ViewerPage against a stubbed fetch — the shell, the paywall and the
 * avatar entry points are doubled because none of them is what is under test. The assertions are
 * about which of the three outcomes the page reaches and what a human is shown when it reaches
 * the third.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ViewerPage } from '../components/viewer/ViewerPage';
import { SharedViewerPage } from '../components/viewer/SharedViewerPage';
import { readPlayerConfigResponse } from '../components/viewer/lockedResponse';
import type { PlayerConfig } from '../components/viewer/types';

vi.mock('../components/viewer/HLSPlayerShell', () => ({
  HLSPlayerShell: ({ config }: { config: PlayerConfig }) => (
    <div data-testid="shell">{config.segments.length} segment(s)</div>
  ),
}));
vi.mock('../components/viewer/branchNavigate', () => ({ branchNavigate: vi.fn() }));
vi.mock('../components/PaywallOverlay', () => ({
  PaywallOverlay: ({ title }: { title: string | null }) => <div data-testid="paywall">{title}</div>,
}));
vi.mock('../components/avatar/AskAvatarButton', () => ({ AskAvatarButton: () => <button /> }));
vi.mock('../components/avatar/AvatarPopup', () => ({ AvatarPopup: () => null }));
vi.mock('../lib/firebase', () => ({
  useAuth: () => ({ loading: false, getIdToken: async () => 'tok-1' }),
  auth: { currentUser: { getIdToken: async () => 'tok-1' } },
}));

const fetchMock = vi.fn();

const CONFIG: PlayerConfig = {
  project_id: 'proj-1',
  title: 'A lesson',
  description: null,
  thumbnail_url: null,
  segments: [{
    id: 'vid-1', label: 'v.mp4', duration_sec: 60,
    hls_url: 'https://cdn.example.com/hls/master.m3u8', fallback_url: null,
    hls_status: 'ready', simulations: [],
  }],
  broll_clips: [],
};

const LOCKED = {
  locked: true, content_type: 'project', content_id: 'proj-1',
  title: 'A lesson', price_cents: 1900, currency: 'usd',
};

/** 200 bodies that are NEITHER variant — each one throws on `data.segments.length` today. */
const NEITHER: Array<[string, unknown]> = [
  ['an empty object', {}],
  ['an error envelope served with 200', { message: 'Project not found' }],
  ['a locked stub with locked:false and no segments', { locked: false, content_id: 'proj-1' }],
  ['null', null],
  ['an array', []],
  ['a config whose segments is not an array', { ...CONFIG, segments: 'none' }],
];

/**
 * `headers` is part of the double because it is part of a real `Response`, and both viewer pages
 * now read the D-13 `ETag` off every config response. A double without it made the pages throw a
 * TypeError inside the very `try` these tests exist to keep clean — which would have been this
 * file reporting a defect in itself.
 */
const ok = (body: unknown, etag: string | null = null) => ({
  ok: true, status: 200, statusText: 'OK',
  headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
  json: async () => body,
});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ViewerPage — the two server variants stay two', () => {
  it('renders the player for a config response', async () => {
    fetchMock.mockResolvedValue(ok(CONFIG));
    render(<ViewerPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByTestId('shell').textContent).toBe('1 segment(s)'));
  });

  it('renders the paywall for a locked response', async () => {
    fetchMock.mockResolvedValue(ok(LOCKED));
    render(<ViewerPage projectId="proj-1" />);
    await waitFor(() => expect(screen.getByTestId('paywall').textContent).toBe('A lesson'));
  });

  for (const [name, body] of NEITHER) {
    it(`shows a human error — never a raw TypeError — for ${name}`, async () => {
      fetchMock.mockResolvedValue(ok(body));
      render(<ViewerPage projectId="proj-1" />);
      const shown = await screen.findByText(/./, { selector: 'p' });
      expect(shown.textContent).not.toMatch(/undefined|TypeError|Cannot read/i);
      expect(shown.textContent).toMatch(/could not be loaded/i);
    });
  }
});

describe('SharedViewerPage — the public /v/:token page, same two variants', () => {
  it('renders the player for a config response', async () => {
    fetchMock.mockResolvedValue(ok(CONFIG));
    render(<SharedViewerPage shareToken="tok-abc" />);
    await waitFor(() => expect(screen.getByTestId('shell').textContent).toBe('1 segment(s)'));
  });

  it('renders the paywall for a locked response', async () => {
    fetchMock.mockResolvedValue(ok(LOCKED));
    render(<SharedViewerPage shareToken="tok-abc" />);
    await waitFor(() => expect(screen.getByTestId('paywall').textContent).toBe('A lesson'));
  });

  for (const [name, body] of NEITHER) {
    it(`shows a human error — never a raw TypeError — for ${name}`, async () => {
      fetchMock.mockResolvedValue(ok(body));
      render(<SharedViewerPage shareToken="tok-abc" />);
      const shown = await screen.findByText(/./, { selector: 'p' });
      expect(shown.textContent).not.toMatch(/undefined|TypeError|Cannot read/i);
      expect(shown.textContent).toMatch(/could not be loaded/i);
    });
  }
});

describe('readPlayerConfigResponse — the discriminator itself', () => {
  it('classifies a paywall stub, keeping the fields the overlay renders', () => {
    expect(readPlayerConfigResponse(LOCKED)).toEqual({
      kind: 'locked',
      locked: {
        locked: true, content_type: 'project', content_id: 'proj-1',
        title: 'A lesson', price_cents: 1900, currency: 'usd',
      },
    });
  });

  it('tolerates the nullable halves of a stub', () => {
    const r = readPlayerConfigResponse({ ...LOCKED, title: null, price_cents: null });
    expect(r.kind).toBe('locked');
  });

  it('classifies a config by its segments array — including the empty one', () => {
    expect(readPlayerConfigResponse({ ...CONFIG, segments: [] })).toEqual({
      kind: 'config',
      config: { ...CONFIG, segments: [] },
    });
  });

  it('does not read locked:true as a config even when segments happen to be present', () => {
    expect(readPlayerConfigResponse({ ...CONFIG, ...LOCKED }).kind).toBe('locked');
  });

  for (const [name, body] of NEITHER) {
    it(`reports ${name} as unusable`, () => {
      expect(readPlayerConfigResponse(body).kind).toBe('unusable');
    });
  }
});
