/**
 * The public library mini-site, and the share control that mints its link.
 *
 * Five properties are pinned here, and each one is a bug this page could plausibly ship:
 *
 *   1. the four filter pills are real anchors to the four sub-routes, with `aria-current="page"`
 *      on the active one — that is what makes "the filter is the URL" true rather than aspirational;
 *   2. opening a simulation mounts exactly ONE SimSurface and closing UNMOUNTS it. The assertion is
 *      that the iframe is GONE from the DOM, not merely hidden, because an in-viewport iframe at
 *      opacity 0 is not throttled: hiding it would keep the WebGL context alive and the audio
 *      playing. This is the single most expensive mistake available on this page;
 *   3. Escape closes and focus returns to the tile that opened it;
 *   4. the share button resolves through the accessibility tree BY NAME (the ui-ux-003 rule) — its
 *      whole visible content is an aria-hidden icon, so without a name it is an anonymous "button";
 *   5. nothing in the rendered tree hardcodes a hex colour or `text-black/`. The `/c/` pages do
 *      exactly that and are unreadable in dark mode; this is the guard against repeating it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { LibraryMaterial, LibraryView } from 'shared/src/types/library-view';

// next/link renders a plain anchor here — routing is Next's job, not this suite's.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));
// The editor's share button reads Firebase on mount; nothing here signs in.
vi.mock('../lib/firebase', () => ({ auth: { currentUser: null } }));
// The button READS its state on mount. The project's title rides on that state — the editor has
// only a projectId in scope — so this mock is what proves the title reaches the dialog at all.
vi.mock('../lib/libraryShareClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/libraryShareClient')>()),
  getLibraryShare: vi.fn(async () => ({
    slug: null, url: null, cleanUrl: null, includeTypes: null,
    expiresAt: null, createdAt: null, title: 'The Edge of Chaos',
  })),
}));

import { LibraryMiniSite } from '../components/library/LibraryMiniSite';
import { LibraryShareButton } from '../components/library/LibraryShareButton';

afterEach(cleanup);

const SIM_URL = 'http://localhost:8080/sim-public/simulations/proj/pkg/index.html';

const material = (over: Partial<LibraryMaterial> & Pick<LibraryMaterial, 'id' | 'type' | 'name' | 'url'>): LibraryMaterial => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const MATERIALS: LibraryMaterial[] = [
  material({ id: 'sim-1', type: 'simulation', name: 'Boids', url: SIM_URL }),
  material({ id: 'img-1', type: 'image', name: 'diagram.png', url: 'https://cdn.test/diagram.png', width: 900, height: 600, crop: { x: 0, y: 0, w: 1, h: 1 } }),
  material({ id: 'vid-1', type: 'video', name: 'intro.mp4', url: 'https://cdn.test/master.m3u8', durationSec: 75 }),
  material({ id: 'aud-1', type: 'audio', name: 'theme.mp3', url: 'https://cdn.test/theme.mp3', durationSec: 12 }),
];

const view = (over: Partial<LibraryView> = {}): LibraryView => ({
  title: 'The Edge of Chaos',
  direction: 'ltr',
  counts: { simulation: 1, image: 1, video: 1, audio: 1 },
  materials: MATERIALS,
  canonicalUrl: 'https://flowvidco.test/chaos-abc/library',
  indexable: false,
  ...over,
});

// ────────────────────────────────────────────────────────────────────────────────────────────────

describe('8. the filter pills are the URL', () => {
  it('renders the four sub-route hrefs plus All, and marks only the active one', () => {
    render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType="image" />);
    const nav = screen.getByRole('navigation', { name: 'Filter by material type' });

    const hrefs = within(nav).getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      '/chaos-abc/library',
      '/chaos-abc/library/simulation',
      '/chaos-abc/library/images',
      '/chaos-abc/library/videos',
      '/chaos-abc/library/sounds',
    ]);

    const current = within(nav).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('href')).toBe('/chaos-abc/library/images');
  });

  it('marks All as current on the top-level page', () => {
    render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType={null} />);
    const nav = screen.getByRole('navigation', { name: 'Filter by material type' });
    const current = within(nav).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current[0].getAttribute('href')).toBe('/chaos-abc/library');
  });

  it('shows an honest empty state for an empty bucket, keeping the pills and their real counts', () => {
    render(<LibraryMiniSite view={view({ materials: [] })} slug="chaos-abc" activeType="video" />);
    expect(screen.getByText(/No videos in this library yet/i)).toBeTruthy();
    // The pills stay, with real totals, so the visitor can move to a bucket that has something.
    expect(screen.getAllByRole('link')).toHaveLength(5);
  });
});

describe('9. exactly one simulation mounts, and closing UNMOUNTS it', () => {
  it('mounts no iframe in the grid, one on open, and none again after close', () => {
    const { container } = render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType={null} />);

    // No live simulation in the grid, ever — the tiles are static.
    expect(container.querySelectorAll('iframe')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Boids/ }));
    expect(container.querySelectorAll('iframe')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // GONE, not hidden. An opacity-0 in-viewport iframe keeps its WebGL context and its audio.
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('routes the simulation through SimSurface rather than a hand-rolled iframe', () => {
    const { container } = render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Boids/ }));

    const frame = container.querySelector('iframe') as HTMLIFrameElement;
    // The #simboot fragment and the sandbox token set are SimSurface's contract; a raw <iframe>
    // would have neither, and dropping #simboot turns a hash change into a full sim reload.
    expect(frame.getAttribute('src')).toContain('simboot=');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
    // Full-screen on a phone is a delegated permission, not a sandbox token.
    expect(frame.getAttribute('allow')).toBe('fullscreen');
    // Hidden until it reports load — the same reveal gate every other sim surface honours.
    expect(frame.hasAttribute('inert')).toBe(true);
  });
});

describe('10. Escape closes and focus returns to the invoking tile', () => {
  it('restores focus to the tile that opened the overlay', () => {
    const { container } = render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType={null} />);
    const tile = screen.getByRole('button', { name: /Boids/ });
    fireEvent.click(tile);
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(document.activeElement).toBe(tile);
  });
});

describe('11. the share button resolves by its accessible name (ui-ux-003)', () => {
  it('is reachable through the accessibility tree and opens the dialog', async () => {
    render(<LibraryShareButton projectId="p1" />);

    // Its entire visible content is an aria-hidden icon. Without the aria-label this query fails,
    // which is exactly the regression the rule exists to catch.
    const button = await screen.findByRole('button', { name: 'Share this library' });
    fireEvent.click(button);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Close share dialog' })).toBeTruthy();
    // Unshared state offers minting; it never mutates on the first click.
    expect(within(dialog).getByRole('button', { name: /Create the link/i })).toBeTruthy();
    // The title came from the fetched state, not from a prop: the dialog names the real video
    // instead of falling back to "this project".
    expect(within(dialog).getByText('The Edge of Chaos')).toBeTruthy();
  });
});

describe('13. banners come from stored artifacts, with the gradient as the honest fallback', () => {
  it('renders a simulation poster as the tile image, and falls back to the gradient on error', () => {
    const withBanner = material({
      id: 'sim-b', type: 'simulation', name: 'Waves', url: SIM_URL,
      bannerUrl: 'https://cdn.test/sim-poster/standard.webp',
    });
    const { container } = render(
      <LibraryMiniSite view={view({ materials: [withBanner] })} slug="chaos-abc" activeType={null} />,
    );

    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://cdn.test/sim-poster/standard.webp');

    // Bytes gone (poster invalidated between ISR renders) → the gradient, never a broken image.
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toMatch(/from-primary|from-secondary|from-muted|from-accent/);
  });

  it('a video with a stored thumbnail shows it; one without keeps the gradient', () => {
    const withBanner = material({
      id: 'vid-b', type: 'video', name: 'lecture.mp4', url: 'https://cdn.test/master.m3u8',
      bannerUrl: 'https://cdn.test/thumbnails/frame.jpg', durationSec: 30,
    });
    const { container } = render(
      <LibraryMiniSite view={view({ materials: [withBanner, MATERIALS[2]] })} slug="chaos-abc" activeType={null} />,
    );

    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['https://cdn.test/thumbnails/frame.jpg']);
  });

  it('a simulation without a bannerUrl renders no img at all — the payload field is load-bearing', () => {
    const { container } = render(
      <LibraryMiniSite view={view({ materials: [MATERIALS[0]] })} slug="chaos-abc" activeType="simulation" />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toMatch(/from-primary|from-secondary|from-muted|from-accent/);
  });
});

describe('14. search filters as you type', () => {
  const tile = (name: RegExp) => screen.queryByRole('button', { name });

  it('narrows tiles by name, announces the count, and restores on clear', () => {
    render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType={null} />);
    const input = screen.getByRole('searchbox', { name: 'Search this library' });

    fireEvent.change(input, { target: { value: 'boids' } });
    expect(tile(/Boids/)).toBeTruthy();
    expect(tile(/diagram\.png/)).toBeNull();
    expect(tile(/intro\.mp4/)).toBeNull();
    expect(screen.getByText(/1 of 4 items match/)).toBeTruthy();

    fireEvent.change(input, { target: { value: '' } });
    for (const name of [/Boids/, /diagram\.png/, /intro\.mp4/, /theme\.mp3/]) {
      expect(tile(name)).toBeTruthy();
    }
  });

  it('matches on the type label, not only the name', () => {
    render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType={null} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search this library' }), {
      target: { value: 'video' },
    });
    expect(tile(/intro\.mp4/)).toBeTruthy();
    expect(tile(/Boids/)).toBeNull();
    expect(tile(/theme\.mp3/)).toBeNull();
  });

  it('shows a no-match state whose Clear search button restores the grid', () => {
    render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType={null} />);
    const input = screen.getByRole('searchbox', { name: 'Search this library' });

    fireEvent.change(input, { target: { value: 'zzz-nothing' } });
    expect(screen.getByText(/No materials match/)).toBeTruthy();
    expect(tile(/Boids/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect((input as HTMLInputElement).value).toBe('');
    expect(tile(/Boids/)).toBeTruthy();
    expect(screen.queryByText(/No materials match/)).toBeNull();
  });

  it('renders no search box over an empty bucket — there is nothing to narrow', () => {
    render(<LibraryMiniSite view={view({ materials: [] })} slug="chaos-abc" activeType="video" />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.getByText(/No videos in this library yet/i)).toBeTruthy();
  });
});

describe('12. the dark-mode guard: token-only styling', () => {
  /** Hex literals in class names or inline styles — `#fff`, `#6366f1`, `rgb(...)`. */
  const HEX = /#[0-9a-fA-F]{3,8}\b/;

  function assertTokenOnly(html: string, where: string) {
    expect(html.match(HEX)?.[0] ?? null, `${where} hardcodes a hex colour`).toBeNull();
    expect(html, `${where} uses text-black/ — broken in dark mode`).not.toMatch(/text-black\//);
    expect(html, `${where} uses text-white/ — broken in light mode`).not.toMatch(/text-white\//);
    expect(html, `${where} hardcodes an rgb()/rgba() colour`).not.toMatch(/rgba?\(/);
  }

  it('the grid, the pills and the header use only palette tokens', () => {
    const { container } = render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType={null} />);
    assertTokenOnly(container.innerHTML, 'the mini-site');
  });

  it('the overlay uses only palette tokens', () => {
    render(<LibraryMiniSite view={view()} slug="chaos-abc" activeType={null} />);
    fireEvent.click(screen.getByRole('button', { name: /theme.mp3/ }));
    assertTokenOnly(screen.getByRole('dialog').outerHTML, 'the overlay');
  });

  it('the gradient tiles are token gradients, not the hex CARD_GRADIENTS palette', () => {
    const { container } = render(
      <LibraryMiniSite view={view({ materials: [MATERIALS[0]] })} slug="chaos-abc" activeType="simulation" />,
    );
    // A tile with no still image of its own still has to survive both themes.
    expect(container.innerHTML).toMatch(/from-primary|from-secondary|from-muted|from-accent/);
    assertTokenOnly(container.innerHTML, 'a gradient tile');
  });
});
