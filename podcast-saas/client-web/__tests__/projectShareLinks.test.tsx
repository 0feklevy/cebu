/**
 * One place that lists every public address a project has — and how the podcast gets made.
 *
 * ── WHAT THE OWNER ACTUALLY REPORTED ──────────────────────────────────────────────────────────
 * "All the links are terribly confusing" and "how do I export a podcast? does it have its own
 * link?" Both had the same cause: a project is reachable at `/{slug}`, `/{slug}/audio` and
 * `/{slug}/library`, offered from three unrelated places — and the audio one from NOWHERE. The
 * derivation route existed and nothing in the product called it.
 *
 * ── THE RULE THAT MATTERS MOST HERE ───────────────────────────────────────────────────────────
 * A link is shown only when there is something behind it. A creator who is handed a URL shares it
 * before opening it, so offering `/{slug}/audio` while the edition is still building — or was
 * never built — costs a listener a 404 and costs the creator their credibility. That is the first
 * test below, and it is the one that must never be relaxed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { ProjectShareLinks } from '../components/ProjectShareLinks';

const state = {
  status: 'none' as string, built: 0, buildThrows: null as string | null,
  library: null as { cleanUrl: string | null; url: string | null } | null,
  libraryThrows: false,
};

vi.mock('@/lib/api', () => ({
  api: {
    getAudioEdition: vi.fn(async () => ({
      status: state.status, error: state.status === 'failed' ? 'No playable audio yet.' : null,
      audio_url: state.status === 'ready' ? 'https://cdn/a.m4a' : null,
      duration_ms: null, chapters: [],
    })),
    getLibraryShare: vi.fn(async () => {
      if (state.libraryThrows) throw new Error('unreachable');
      return {
        slug: null, includeTypes: null, expiresAt: null, createdAt: null, title: null,
        cleanUrl: state.library?.cleanUrl ?? null, url: state.library?.url ?? null,
      };
    }),
    buildAudioEdition: vi.fn(async () => {
      if (state.buildThrows) throw Object.assign(new Error(state.buildThrows), { status: 409 });
      state.built += 1;
      return { status: 'queued', language: null };
    }),
  },
}));

const PERMALINK = 'https://flowvidco.com/my-lesson';

beforeEach(() => {
  state.status = 'none'; state.built = 0; state.buildThrows = null;
  state.library = null; state.libraryThrows = false;
});
afterEach(() => cleanup());

const renderLinks = async (over: Partial<React.ComponentProps<typeof ProjectShareLinks>> = {}) => {
  render(<ProjectShareLinks projectId="p1" permalinkUrl={PERMALINK} {...over} />);
  // let the initial status read settle
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};

describe('the links it shows', () => {
  it('always shows the video link', async () => {
    await renderLinks();
    expect(screen.getByText(PERMALINK)).toBeTruthy();
  });

  it('does NOT show a podcast link until the edition is READY', async () => {
    // The rule the whole component turns on: a creator hands out a URL before opening it.
    state.status = 'building';
    await renderLinks();
    expect(screen.queryByText(`${PERMALINK}/audio`), 'offered a link to an unbuilt podcast').toBeNull();
  });

  it('shows the podcast link once it is ready — and it is the /audio address', async () => {
    state.status = 'ready';
    await renderLinks();
    expect(screen.getByText(`${PERMALINK}/audio`)).toBeTruthy();
  });

  it('shows NO library row when the project has no live share', async () => {
    // `cleanUrl` and `url` are both null exactly when there is nothing to link — a revoked or
    // expired share included. Building `${permalink}/library` from a string would offer all three.
    await renderLinks();
    expect(screen.queryByText(`${PERMALINK}/library`), 'offered a library nobody shared').toBeNull();
    expect(screen.queryByText('Library')).toBeNull();
  });

  it('shows the library link when a live share exists, using the server\'s clean form', async () => {
    state.library = { cleanUrl: `${PERMALINK}/library`, url: 'https://flowvidco.com/my-lesson-abc123def4567/library' };
    await renderLinks();
    expect(screen.getByText(`${PERMALINK}/library`)).toBeTruthy();
  });

  it('falls back to the CODED url when the clean form is not available', async () => {
    // A live share on a project whose permalink is not public has no clean form. Showing nothing
    // would hide a working link; the coded one always resolves.
    const coded = 'https://flowvidco.com/my-lesson-abc123def4567/library';
    state.library = { cleanUrl: null, url: coded };
    await renderLinks();
    expect(screen.getByText(coded)).toBeTruthy();
  });

  it('a failed library read hides only that row', async () => {
    state.libraryThrows = true;
    await renderLinks();
    expect(screen.queryByText('Library')).toBeNull();
    expect(screen.getByText(PERMALINK), 'a failed library read broke the video row').toBeTruthy();
  });

  it('renders nothing at all without a permalink — there are no addresses yet', async () => {
    const { container } = render(<ProjectShareLinks projectId="p1" permalinkUrl={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('creating the podcast — the answer to "how do I export one"', () => {
  it('offers a build button when no edition exists, and starts one', async () => {
    await renderLinks();
    const btn = screen.getByRole('button', { name: /create podcast/i });
    await act(async () => { fireEvent.click(btn); await Promise.resolve(); });
    expect(state.built, 'the button did not start a build').toBe(1);
  });

  it('shows a REASON when the server refuses, not a dead button', async () => {
    // The server checks up front that there is playable audio and answers 409 with why — the
    // whole point being that the creator is told rather than watching a job fail later.
    state.buildThrows = 'This project has no playable audio yet.';
    await renderLinks();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /create podcast/i }));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toMatch(/no playable audio/i);
  });

  it('says the last build FAILED, with the reason, and offers a retry', async () => {
    state.status = 'failed';
    await renderLinks();
    expect(screen.getByText(/no playable audio yet/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('while building, the button is disabled and says so', async () => {
    state.status = 'building';
    await renderLinks();
    const btn = screen.getByRole('button', { name: /building/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('offers no build button once the podcast exists', async () => {
    state.status = 'ready';
    await renderLinks();
    expect(screen.queryByRole('button', { name: /create podcast|try again/i })).toBeNull();
  });
});
